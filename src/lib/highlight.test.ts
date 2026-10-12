import { describe, expect, it } from "vitest";

import { highlightToHtml, langForFence, langForFile } from "./highlight";

describe("langForFile", () => {
  it("maps by extension case-insensitively, Dockerfile whole, and nothing it can't tokenize", () => {
    expect(langForFile("model.tsx")).toBe("tsx");
    expect(langForFile("Cargo.TOML")).toBe("toml");
    expect(langForFile("main.rs")).toBe("rust");
    expect(langForFile("Dockerfile")).toBe("docker");
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

  it("resolves fence-only aliases, and treats a plain-text fence as unhighlightable", () => {
    expect(langForFence("shell")).toBe("bash");
    expect(langForFence("console")).toBe("bash");
    expect(langForFence("yml")).toBe("yaml");
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
});
