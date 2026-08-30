import { describe, expect, it } from "vitest";

import { highlightToHtml, langForFence, langForFile } from "./highlight";

describe("langForFile", () => {
  it("maps by extension, case-insensitively", () => {
    expect(langForFile("model.tsx")).toBe("tsx");
    expect(langForFile("Cargo.TOML")).toBe("toml");
    expect(langForFile("main.rs")).toBe("rust");
  });

  it("matches Dockerfile whole — it has no extension to read", () => {
    expect(langForFile("Dockerfile")).toBe("docker");
  });

  it("returns nothing for a language it can't tokenize", () => {
    expect(langForFile("notes.xyz")).toBeUndefined();
  });
});

describe("langForFence", () => {
  it("takes the first word of the info string, ignoring fence attributes", () => {
    expect(langForFence("rust ignore")).toBe("rust");
    expect(langForFence("bash title=install")).toBe("bash");
    // `ts` is one of refractor's own aliases, so it comes back as itself rather
    // than expanded — what matters is that it tokenizes, not what it's called.
    expect(highlightToHtml("const x = 1;", langForFence("ts"))).toContain("token keyword");
  });

  it("resolves the aliases a fence uses that a filename never would", () => {
    expect(langForFence("shell")).toBe("bash");
    expect(langForFence("console")).toBe("bash");
    expect(langForFence("yml")).toBe("yaml");
  });

  it("treats an explicit plain-text fence as unhighlightable", () => {
    expect(langForFence("text")).toBeUndefined();
    expect(langForFence("")).toBeUndefined();
  });
});

describe("highlightToHtml", () => {
  /** This is the property that makes the result safe for
   *  `dangerouslySetInnerHTML`, and it has to hold on BOTH branches — the
   *  highlighted one and the unknown-language fallback. */
  it("escapes source markup whether or not it highlights", () => {
    const attack = `<img src=x onerror="alert(1)">`;

    // The highlighted branch still emits our own `<span>` chrome, so the claim
    // is narrower and exact: nothing from the SOURCE survives as markup. Prism
    // splits the tag across token spans, which is why this checks for the
    // escaped bracket and the absent attribute rather than a whole `&lt;img`.
    const highlighted = highlightToHtml(attack, "markup");
    expect(highlighted).not.toContain("<img");
    expect(highlighted).not.toContain(`onerror="alert`);
    expect(highlighted).toContain("&lt;");

    const plain = highlightToHtml(attack, undefined);
    expect(plain).toBe(`&lt;img src=x onerror="alert(1)"&gt;`);
  });

  it("emits Prism token spans for a language it knows", () => {
    expect(highlightToHtml("const x = 1;", "typescript")).toContain("token keyword");
  });

  it("falls back to escaped text for a language it doesn't", () => {
    expect(highlightToHtml("hello & goodbye", "klingon")).toBe("hello &amp; goodbye");
  });
});
