import { describe, expect, it } from "vitest";

import {
  buildExtension,
  extendsTarget,
  hasFills,
  parseExtension,
  splitAtSlots,
  takeoverIsStale,
  withTakeoverMark,
} from "./promptLayers";

const SLOTS = ["sources", "conventions", "extra"] as const;

describe("buildExtension / parseExtension", () => {
  it("round-trips what the builder wrote, filled slots only, in slot order", () => {
    const fills = {
      extra: "Run pnpm test.",
      sources: "Logs live in Loki.\nMetrics in Prom.",
      conventions: "  ",
    };
    const src = buildExtension("santree/triage", fills, SLOTS);
    expect(src).toBe(
      [
        '{% extends "santree/triage" %}',
        "{# Filled in Settings → Prompts. Each block lands at its slot in the prompt it extends; everything else is inherited. #}",
        "{% block sources %}",
        "Logs live in Loki.\nMetrics in Prom.",
        "{% endblock %}",
        "{% block extra %}",
        "Run pnpm test.",
        "{% endblock %}",
        "",
      ].join("\n"),
    );
    expect(parseExtension(src)).toEqual({
      base: "santree/triage",
      blocks: { sources: "Logs live in Loki.\nMetrics in Prom.", extra: "Run pnpm test." },
    });
    expect(buildExtension("santree/triage", parseExtension(src)?.blocks ?? {}, SLOTS)).toBe(src);
  });

  it("with nothing filled is the bare extends — a layer that changes nothing", () => {
    expect(buildExtension("project/work", { extra: "" }, ["extra"])).toBe(
      '{% extends "project/work" %}\n',
    );
    expect(hasFills({ extra: "", sources: " \n" })).toBe(false);
    expect(hasFills({ extra: "x" })).toBe(true);
  });

  it("keeps a block body verbatim — variables, tags and comments included", () => {
    const body = "Ticket {{ ticket_id }}: {% if title %}{{ title }}{% endif %} {# note #}";
    const src = buildExtension("santree/work", { extra: body }, ["extra"]);
    expect(parseExtension(src)?.blocks.extra).toBe(body);
  });

  it("keeps a nested block inside its parent's body", () => {
    const src =
      '{% extends "santree/triage" %}\n{% block gotchas %}\n{{ super() }}\n{% block pitfalls %}ids are base36{% endblock %}\n{% endblock %}\n';
    expect(parseExtension(src)).toEqual({
      base: "santree/triage",
      blocks: { gotchas: "{{ super() }}\n{% block pitfalls %}ids are base36{% endblock %}" },
    });
  });

  it("accepts whitespace-control tags and single quotes", () => {
    const src = "{%- extends 'santree/work' -%}\n{%- block extra -%}X{%- endblock -%}";
    expect(parseExtension(src)).toEqual({ base: "santree/work", blocks: { extra: "X" } });
    expect(extendsTarget(src)).toBe("santree/work");
  });

  it("reads anything else as a replacement", () => {
    // Prose, an expression, or a tag outside a block at the top level.
    expect(parseExtension("Work on {{ ticket_id }}.")).toBeNull();
    expect(parseExtension('{% extends "santree/work" %}\nstray prose')).toBeNull();
    expect(parseExtension('{% extends "santree/work" %}{{ ticket_id }}')).toBeNull();
    expect(parseExtension('{% extends "santree/work" %}{% if x %}{% endif %}')).toBeNull();
    // Extends must come first; an unclosed block is not an extension either.
    expect(parseExtension('{% block extra %}x{% endblock %}{% extends "a" %}')).toBeNull();
    expect(parseExtension('{% extends "santree/work" %}{% block extra %}x')).toBeNull();
    expect(extendsTarget("Work on {{ ticket_id }}.")).toBeNull();
  });
});

describe("splitAtSlots", () => {
  it("cuts the default at each empty slot, taking the slot's own line", () => {
    const src =
      "# Title\n\nrules\n{% block sources %}{% endblock %}\nmore\n{% block extra %}{% endblock %}\n";
    expect(splitAtSlots(src, ["sources", "extra"])).toEqual([
      { kind: "text", text: "# Title\n\nrules" },
      { kind: "slot", name: "sources" },
      { kind: "text", text: "more" },
      { kind: "slot", name: "extra" },
    ]);
  });

  it("skips a slot the default doesn't carry and keeps trailing text", () => {
    const src = "a\n{% block extra %}{% endblock %}\nb\n";
    expect(splitAtSlots(src, ["missing", "extra"])).toEqual([
      { kind: "text", text: "a" },
      { kind: "slot", name: "extra" },
      { kind: "text", text: "b\n" },
    ]);
  });
});

describe("take-over mark", () => {
  it("is stale only when the default it was copied from has changed", () => {
    const v1 = "Do the thing.\n";
    const copy = withTakeoverMark(v1);
    expect(copy.startsWith("{# santree-default: ")).toBe(true);
    expect(copy.endsWith(v1)).toBe(true);
    expect(takeoverIsStale(copy, v1)).toBe(false);
    expect(takeoverIsStale(`${copy}\nplus my edits`, v1)).toBe(false);
    expect(takeoverIsStale(copy, "Do the other thing.\n")).toBe(true);
    // Hand-written text carries no mark and is never called stale.
    expect(takeoverIsStale("my own prompt", v1)).toBe(false);
  });
});
