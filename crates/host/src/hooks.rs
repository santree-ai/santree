//! The hook queue: pushed on the link where the embedder allows it,
//! delivered to the newest `hooks.subscribe`r.

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use santree_remote_proto::*;

use super::conn::{Conn, Out};
use super::*;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) struct HookQueue {
    pub(super) cap: usize,
    /// The queue's budget in bytes ([`hook_size`]), besides its count: one
    /// push can carry a 32 MiB stdin, and nobody may be subscribed for days.
    pub(super) max_bytes: usize,
    pub(super) bytes: usize,
    pub(super) last_seq: u64,
    pub(super) items: VecDeque<HookEvent>,
    /// Overflow not yet reported to a subscriber.
    pub(super) dropped: u64,
    pub(super) subscriber: Option<(u64, Out)>,
}

impl HookQueue {
    pub(crate) fn new(cap: usize, max_bytes: usize) -> Self {
        Self {
            cap,
            max_bytes,
            bytes: 0,
            last_seq: 0,
            items: VecDeque::new(),
            dropped: 0,
            subscriber: None,
        }
    }

    /// Connection `conn` is gone: stop delivering to it, if it was the
    /// subscriber.
    pub(crate) fn unsubscribe(&mut self, conn: u64) {
        if self.subscriber.as_ref().is_some_and(|(c, _)| *c == conn) {
            self.subscriber = None;
        }
    }

    fn notify(&mut self, line: String) {
        if let Some((_, out)) = &self.subscriber {
            if !out.send(line) {
                self.subscriber = None;
            }
        }
    }

    fn report_dropped(&mut self) {
        if self.dropped > 0 && self.subscriber.is_some() {
            let count = std::mem::take(&mut self.dropped);
            self.notify(Event::HooksDropped(HooksDropped { count }).encode());
        }
    }

    pub(super) fn push(
        &mut self,
        event: String,
        env: Vec<(String, String)>,
        stdin: Vec<u8>,
    ) -> u64 {
        self.last_seq += 1;
        let hook = HookEvent {
            seq: self.last_seq,
            at: now_ms(),
            event,
            env,
            stdin,
        };
        let size = hook_size(&hook);
        // The oldest go first, counted as dropped, until the new one fits
        // (one larger than the whole budget is still kept, alone).
        while !self.items.is_empty()
            && (self.items.len() >= self.cap.max(1) || self.bytes + size > self.max_bytes)
        {
            if let Some(old) = self.items.pop_front() {
                self.bytes -= hook_size(&old);
            }
            self.dropped += 1;
        }
        self.report_dropped();
        self.bytes += size;
        self.items.push_back(hook.clone());
        self.notify(Event::Hook(hook).encode());
        self.last_seq
    }

    /// `hooks.ack`: drop everything up to `up_to`.
    pub(super) fn ack(&mut self, up_to: u64) {
        self.items.retain(|h| h.seq > up_to);
        self.bytes = self.items.iter().map(hook_size).sum();
    }
}

/// What one queued hook costs, roughly its size in memory.
fn hook_size(h: &HookEvent) -> usize {
    64 + h.event.len() + h.stdin.len() + h.env.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>()
}

impl Host {
    /// Queue one hook event — what `<hookBin> hook <event>` does on the host.
    pub fn push_hook(&self, event: String, env: Vec<(String, String)>, stdin: Vec<u8>) -> u64 {
        let seq = lock(&self.hooks).push(event, env, stdin);
        self.touch();
        seq
    }

    /// The seqs of the hook events still queued (not acked), oldest first.
    pub fn queued_hooks(&self) -> Vec<u64> {
        lock(&self.hooks).items.iter().map(|h| h.seq).collect()
    }

    /// `hooks.subscribe`: the response, the dropped report, the backlog
    /// after `after`, then live events. The backlog is cloned
    /// [`BACKLOG_CHUNK`] events at a time under the queue's lock and encoded
    /// outside it; `conn` becomes the subscriber under the lock that finds
    /// nothing more to send, so no event is missed, repeated or reordered.
    pub(super) fn subscribe_hooks(&self, conn: &Conn, req_id: u64, mut after: Option<u64>) {
        if !conn
            .out
            .send(encode_ok(req_id, &Empty).expect("empty serializes"))
        {
            return;
        }
        loop {
            let (dropped, chunk) = {
                let mut hooks = lock(&self.hooks);
                let start = hooks
                    .items
                    .partition_point(|h| after.is_some_and(|after| h.seq <= after));
                let chunk: Vec<HookEvent> = hooks
                    .items
                    .range(start..)
                    .take(BACKLOG_CHUNK)
                    .cloned()
                    .collect();
                if chunk.is_empty() {
                    hooks.subscriber = Some((conn.id, conn.out.clone()));
                    hooks.report_dropped();
                    return;
                }
                (std::mem::take(&mut hooks.dropped), chunk)
            };
            if dropped > 0
                && !conn
                    .out
                    .send(Event::HooksDropped(HooksDropped { count: dropped }).encode())
            {
                return;
            }
            for hook in chunk {
                after = Some(hook.seq);
                if !conn.out.send(Event::Hook(hook).encode()) {
                    return;
                }
            }
        }
    }
}
