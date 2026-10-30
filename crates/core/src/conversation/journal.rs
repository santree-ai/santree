//! The item list a record parser maintains, with the revision bookkeeping that
//! lets a read return only what changed since the reader's cursor.
//!
//! Every push or in-place change stamps the item with the next revision, so
//! "what changed after revision `r`" is the items whose stamp is greater — in
//! `seq` order, because items are stored in the order they were first seen.

use std::collections::HashMap;
use std::mem::size_of;

use super::{ConversationItem, FileChange, ItemBody, Question, TodoItem, TokenUsage, ToolInput};

#[derive(Debug)]
struct Entry {
    item: ConversationItem,
    /// The revision that last created or changed it.
    rev: u32,
    /// [`entry_bytes`] of the item as it stands, for the cache's budget.
    bytes: usize,
}

/// An ordered, revisioned list of [`ConversationItem`]s.
#[derive(Debug, Default)]
pub struct Journal {
    entries: Vec<Entry>,
    by_id: HashMap<String, usize>,
    rev: u32,
    turn: u32,
    bytes: usize,
}

impl Journal {
    /// The latest revision: a reader holding it holds everything.
    pub fn rev(&self) -> u32 {
        self.rev
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Rough heap footprint of the items, for a cache's byte budget.
    pub fn approx_bytes(&self) -> usize {
        self.bytes
    }

    /// Every item, in `seq` order.
    pub fn items(&self) -> Vec<ConversationItem> {
        self.entries.iter().map(|e| e.item.clone()).collect()
    }

    /// The items created or changed after revision `rev`, in `seq` order.
    pub fn changed_since(&self, rev: u32) -> Vec<ConversationItem> {
        self.entries
            .iter()
            .filter(|e| e.rev > rev)
            .map(|e| e.item.clone())
            .collect()
    }

    /// A prompt the user typed: what follows belongs to the next turn.
    pub(crate) fn begin_turn(&mut self) {
        self.turn += 1;
    }

    /// Append an item at the current turn and return its index. An id already
    /// held is not appended twice; its index is returned unchanged.
    pub(crate) fn push(&mut self, id: String, at_ms: Option<f64>, body: ItemBody) -> usize {
        if let Some(&idx) = self.by_id.get(&id) {
            return idx;
        }
        self.rev += 1;
        let idx = self.entries.len();
        let bytes = entry_bytes(&id, &body);
        self.bytes += bytes;
        self.by_id.insert(id.clone(), idx);
        self.entries.push(Entry {
            item: ConversationItem {
                id,
                seq: idx as u32,
                turn: self.turn,
                at_ms,
                body,
            },
            rev: self.rev,
            bytes,
        });
        idx
    }

    pub(crate) fn body(&self, idx: usize) -> Option<&ItemBody> {
        self.entries.get(idx).map(|e| &e.item.body)
    }

    pub(crate) fn at_ms(&self, idx: usize) -> Option<f64> {
        self.entries.get(idx).and_then(|e| e.item.at_ms)
    }

    pub(crate) fn last_index(&self) -> Option<usize> {
        self.entries.len().checked_sub(1)
    }

    /// Change an item in place. `change` answers whether it changed anything;
    /// only then is the item stamped with a new revision, so a reader is not
    /// handed back an item it already holds.
    pub(crate) fn update(&mut self, idx: usize, change: impl FnOnce(&mut ItemBody) -> bool) {
        let Some(entry) = self.entries.get_mut(idx) else {
            return;
        };
        if !change(&mut entry.item.body) {
            return;
        }
        self.rev += 1;
        entry.rev = self.rev;
        let bytes = entry_bytes(&entry.item.id, &entry.item.body);
        self.bytes = self.bytes - entry.bytes + bytes;
        entry.bytes = bytes;
    }
}

/// A hash table's own cost per entry beyond its key and value: the control
/// byte and the load-factor slack, rounded up.
pub(crate) const TABLE_SLOT: usize = 16;

/// What a `String` costs: its header and its bytes.
pub(crate) fn string_bytes(s: &str) -> usize {
    size_of::<String>() + s.len()
}

/// What one item costs the journal: the entry itself (the body is inline in
/// it), the id it holds and the copy keying `by_id`, and what the body holds
/// on the heap. A rough figure, but it no longer leaves anything out.
fn entry_bytes(id: &str, body: &ItemBody) -> usize {
    size_of::<Entry>()
        + id.len()
        + string_bytes(id)
        + size_of::<usize>()
        + TABLE_SLOT
        + body_bytes(body)
}

/// The heap a body holds: its strings, and the lists of the tool inputs that
/// have them.
fn body_bytes(body: &ItemBody) -> usize {
    let opt = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    match body {
        ItemBody::User(m) => m.text.len(),
        ItemBody::Agent(m) => m.text.len(),
        ItemBody::Reasoning(r) => r.text.len(),
        ItemBody::Notice(n) => n.text.len(),
        ItemBody::TurnEnd(_) => 0,
        ItemBody::Queued(q) => q.text.len(),
        ItemBody::Tool(call) => {
            call.call_id.len()
                + call.name.len()
                + call.output.as_ref().map_or(0, |o| o.text.len())
                + call
                    .subagent
                    .as_ref()
                    .map_or(0, |l| l.agent_id.len() + opt(&l.agent_type))
                + input_bytes(&call.input)
        }
    }
}

fn input_bytes(input: &ToolInput) -> usize {
    let opt = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    match input {
        ToolInput::Command {
            command,
            description,
        } => command.len() + opt(description),
        ToolInput::Edit { files } => files
            .iter()
            .map(|f| size_of::<FileChange>() + f.path.len() + opt(&f.patch))
            .sum(),
        ToolInput::Read { path, lines } => path.len() + opt(lines),
        ToolInput::Search { pattern, scope } => pattern.len() + opt(scope),
        ToolInput::Fetch { url, prompt } => url.len() + opt(prompt),
        ToolInput::WebSearch { query } => query.len(),
        ToolInput::Agent {
            description,
            agent_type,
            prompt,
        } => opt(description) + opt(agent_type) + prompt.len(),
        ToolInput::Plan { markdown } => markdown.len(),
        ToolInput::Todos { items } => items
            .iter()
            .map(|t| size_of::<TodoItem>() + t.text.len())
            .sum(),
        ToolInput::Questions { questions } => questions
            .iter()
            .map(|q| {
                size_of::<Question>()
                    + q.question.len()
                    + opt(&q.header)
                    + opt(&q.answer)
                    + q.options.iter().map(|o| string_bytes(o)).sum::<usize>()
            })
            .sum(),
        ToolInput::Other { json } => json.len(),
    }
}

// ── Bounds ───────────────────────────────────────────────────────────────────
//
// A record's payloads are unbounded — a Bash output or a file read can be
// megabytes on one line — and everything kept here rides in a cache and across
// IPC. Each kind of text has its own ceiling, cut at a char boundary.

/// A message's prose: a prompt, a reply, a reasoning summary, a plan.
pub(crate) const MAX_TEXT: usize = 64 * 1024;
/// What a tool returned.
pub(crate) const MAX_OUTPUT: usize = 16 * 1024;
/// One file's hunks.
pub(crate) const MAX_PATCH: usize = 64 * 1024;
/// A tool's arguments when they are drawn as JSON.
pub(crate) const MAX_JSON: usize = 8 * 1024;
/// A command line, a subagent's brief, a question.
pub(crate) const MAX_INPUT: usize = 16 * 1024;
/// Anything drawn on one line: a path, a name, an id, a label.
pub(crate) const MAX_LABEL: usize = 4 * 1024;

/// What marks a cut in text that carries no `truncated` flag of its own.
const CUT_MARK: &str = "\n\n[…]";

/// A one-line value, cut at [`MAX_LABEL`]. Real ones are far shorter; this
/// only keeps a malformed record from planting megabytes in a field the view
/// never expects to be long.
pub(crate) fn label(text: &str) -> String {
    bounded(text, MAX_LABEL).0
}

/// `text`'s first `max` bytes at most, ending on a char boundary.
pub(crate) fn cut(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// `text` cut to at most `max` bytes on a char boundary, and whether it was.
pub(crate) fn bounded(text: &str, max: usize) -> (String, bool) {
    let kept = cut(text, max);
    (kept.to_string(), kept.len() < text.len())
}

/// [`bounded`], marking a cut in the text itself — for the fields the view
/// draws as prose and that have no flag to say so.
pub(crate) fn bounded_marked(text: &str, max: usize) -> String {
    match bounded(text, max) {
        (cut, true) => cut + CUT_MARK,
        (whole, false) => whole,
    }
}

// ── Token arithmetic ─────────────────────────────────────────────────────────

impl TokenUsage {
    /// Field-wise maximum: the same API message can be recorded more than once
    /// with placeholder counts, and the largest of each is the final one.
    pub(crate) fn max_of(&self, other: &TokenUsage) -> TokenUsage {
        TokenUsage {
            input: self.input.max(other.input),
            output: self.output.max(other.output),
            cache_read: self.cache_read.max(other.cache_read),
            cache_write: self.cache_write.max(other.cache_write),
            reasoning: self.reasoning.max(other.reasoning),
        }
    }

    pub(crate) fn add(&mut self, other: &TokenUsage) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.reasoning += other.reasoning;
    }

    pub(crate) fn minus(&self, other: &TokenUsage) -> TokenUsage {
        TokenUsage {
            input: self.input - other.input,
            output: self.output - other.output,
            cache_read: self.cache_read - other.cache_read,
            cache_write: self.cache_write - other.cache_write,
            reasoning: self.reasoning - other.reasoning,
        }
    }
}
