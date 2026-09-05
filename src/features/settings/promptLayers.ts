/**
 * How a prompt layer relates to the one below it, in the editor's terms.
 *
 * A layer's source is either an **extension** — `{% extends "…" %}` plus one
 * `{% block %}` per slot it fills and nothing else — or a **replacement**, any
 * other template. The backend doesn't care (both are Jinja, rendered by
 * minijinja's inheritance); the editor does, because an extension can be shown
 * as fields at their place in the default, and keeps receiving every other
 * change santree makes to it. These are the round trip between the fields and
 * the file, the split of the default the fields sit in, and the mark a
 * take-over copy carries so the editor can say when the default moved on.
 */

import { hashText } from "../../lib/queries";

/** A layer that extends the template below it: what it extends, and what it
 *  puts in each block, by block name. */
export interface Extension {
  base: string;
  blocks: Record<string, string>;
}

/** One piece of a default split at its slots: fixed text, or a slot to fill. */
export type SlotPart = { kind: "text"; text: string } | { kind: "slot"; name: string };

/** A delimiter-level token. `raw` is the source it came from, verbatim, so a
 *  block body can be handed back exactly as written. */
type Token = { raw: string } & (
  | { kind: "text" }
  | { kind: "tag"; body: string }
  | { kind: "comment" }
  | { kind: "expr" }
);

/** Delimiter-level tokens of a template — enough to see its top-level shape
 *  without parsing Jinja. `{%- … -%}` whitespace control is dropped. */
function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const closers: Record<string, string> = { "{%": "%}", "{{": "}}", "{#": "#}" };
  while (i < source.length) {
    const open = source.slice(i).search(/\{[%{#]/);
    if (open === -1) {
      out.push({ kind: "text", raw: source.slice(i) });
      break;
    }
    if (open > 0) out.push({ kind: "text", raw: source.slice(i, i + open) });
    const start = i + open;
    const delim = source.slice(start, start + 2);
    const closeAt = source.indexOf(closers[delim], start + 2);
    // An unterminated delimiter is text as far as the shape is concerned; the
    // compile check on save is what names it as an error.
    if (closeAt === -1) {
      out.push({ kind: "text", raw: source.slice(start) });
      break;
    }
    const inner = source.slice(start + 2, closeAt);
    const raw = source.slice(start, closeAt + 2);
    if (delim === "{%") {
      out.push({ kind: "tag", raw, body: inner.replace(/^-/, "").replace(/-$/, "").trim() });
    } else if (delim === "{#") {
      out.push({ kind: "comment", raw });
    } else {
      out.push({ kind: "expr", raw });
    }
    i = closeAt + 2;
  }
  return out;
}

const firstQuoted = (s: string): string | null => {
  const m = /["']([^"']*)["']/.exec(s);
  return m ? m[1] : null;
};

/** The template a source `{% extends %}`, if any. */
export function extendsTarget(source: string): string | null {
  for (const t of tokenize(source)) {
    if (t.kind !== "tag") continue;
    const m = /^extends\s+(.*)$/s.exec(t.body);
    if (m) return firstQuoted(m[1]);
  }
  return null;
}

/** Read `source` as an extension: one `{% extends %}` first, then only
 *  `{% block name %}…{% endblock %}` groups, with nothing but whitespace and
 *  comments between them. Anything else makes it a replacement — `null`. A
 *  block's body is kept verbatim but for the single newline the builder puts on
 *  each side, so build(parse(x)) is x for anything the builder wrote. */
export function parseExtension(source: string): Extension | null {
  const tokens = tokenize(source);
  let base: string | null = null;
  const blocks: Record<string, string> = {};
  let i = 0;
  const skipFiller = () => {
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.kind === "comment" || (t.kind === "text" && t.raw.trim() === "")) i++;
      else break;
    }
  };
  skipFiller();
  const head = tokens[i];
  if (head?.kind !== "tag") return null;
  const ext = /^extends\s+(.*)$/s.exec(head.body);
  if (!ext) return null;
  base = firstQuoted(ext[1]);
  if (!base) return null;
  i++;
  for (;;) {
    skipFiller();
    if (i >= tokens.length) break;
    const t = tokens[i];
    if (t.kind !== "tag") return null;
    const open = /^block\s+([A-Za-z_][\w-]*)$/.exec(t.body);
    if (!open) return null;
    i++;
    // The body runs to the endblock at this depth; nested blocks stay inside.
    let depth = 0;
    let body = "";
    let closed = false;
    for (; i < tokens.length; i++) {
      const u = tokens[i];
      if (u.kind === "tag") {
        if (/^block\s/.test(u.body)) depth++;
        else if (u.body === "endblock" || /^endblock\s/.test(u.body)) {
          if (depth === 0) {
            closed = true;
            i++;
            break;
          }
          depth--;
        }
      }
      body += u.raw;
    }
    if (!closed) return null;
    blocks[open[1]] = body.replace(/^\n/, "").replace(/\n$/, "");
  }
  return { base, blocks };
}

/** The source of an extension: the `extends` line, then one block per filled
 *  slot in `order`. With nothing filled it is the bare `extends` — the layer
 *  that changes nothing, which the editor previews and never saves. */
export function buildExtension(
  base: string,
  fills: Record<string, string>,
  order: readonly string[],
): string {
  const lines = [`{% extends "${base}" %}`];
  const filled = order.filter((name) => (fills[name] ?? "").trim() !== "");
  if (filled.length > 0) {
    lines.push(
      "{# Filled in Settings → Prompts. Each block lands at its slot in the prompt it extends; everything else is inherited. #}",
    );
  }
  for (const name of filled) {
    lines.push(`{% block ${name} %}`, fills[name].replace(/\n$/, ""), "{% endblock %}");
  }
  return `${lines.join("\n")}\n`;
}

/** Whether any slot has something in it. */
export const hasFills = (fills: Record<string, string>): boolean =>
  Object.values(fills).some((v) => v.trim() !== "");

/** The default split at its empty slot blocks, in order, so the editor can draw
 *  the fixed text read-only with a field at each slot. A slot the default
 *  doesn't carry (it shouldn't happen — the backend pins each one) is skipped. */
export function splitAtSlots(defaultSource: string, slots: readonly string[]): SlotPart[] {
  const parts: SlotPart[] = [];
  let rest = defaultSource;
  for (const name of slots) {
    const tag = `{% block ${name} %}{% endblock %}`;
    const at = rest.indexOf(tag);
    if (at === -1) continue;
    // Take the slot's own line, so the field replaces it rather than leaving a
    // blank line behind.
    const before = rest.slice(0, at).replace(/\n$/, "");
    if (before !== "") parts.push({ kind: "text", text: before });
    parts.push({ kind: "slot", name });
    rest = rest.slice(at + tag.length).replace(/^\n/, "");
  }
  if (rest.trim() !== "") parts.push({ kind: "text", text: rest });
  return parts;
}

/** The mark a take-over copy starts with: which default it was copied from. */
const TAKEOVER = /^\{#\s*santree-default:\s*([a-z0-9.]+)\s*#\}\n?/;

/** The default, copied to be edited freely, with its mark. */
export function withTakeoverMark(defaultSource: string): string {
  return `{# santree-default: ${hashText(defaultSource)} #}\n${defaultSource}`;
}

/** Whether `source` was taken over from a default that has since changed. A
 *  source with no mark (hand-written, or from before the mark) is never stale:
 *  there is nothing to compare it to. */
export function takeoverIsStale(source: string, defaultSource: string): boolean {
  const m = TAKEOVER.exec(source);
  return m !== null && m[1] !== hashText(defaultSource);
}
