import { describe, expect, it } from "vitest";

import type { Repo } from "../bindings";
import { ICON_MAX_BYTES, iconSrc, workspaceOf } from "./daedalusIcon";

const b64 = (bytes: number) => "A".repeat(4 * Math.ceil(bytes / 3));

describe("iconSrc", () => {
  it("makes a data URL of each of the four types", () => {
    for (const contentType of ["image/png", "image/svg+xml", "image/x-icon", "image/webp"]) {
      expect(iconSrc({ contentType, data: "PHN2Zy8+" })).toBe(
        `data:${contentType};base64,PHN2Zy8+`,
      );
    }
  });

  it("refuses any other type, or none", () => {
    expect(iconSrc(null)).toBeNull();
    expect(iconSrc(undefined)).toBeNull();
    for (const contentType of ["text/html", "image/svg", "image/gif", "", "image/png;x=1"]) {
      expect(iconSrc({ contentType, data: "PHN2Zy8+" })).toBeNull();
    }
  });

  it("refuses data that isn't standard padded base64", () => {
    for (const data of ["", "PHN2Zy8", "PHN2Zy8+=", "PHN2-y8_", "PHN2Zy8+\n", "<svg/>", "a,b"]) {
      expect(iconSrc({ contentType: "image/png", data })).toBeNull();
    }
    expect(iconSrc({ contentType: "image/png", data: "iVBORw0KGgo=" })).not.toBeNull();
  });

  it("refuses an icon past 64 KiB decoded", () => {
    expect(ICON_MAX_BYTES).toBe(65536);
    const at = (data: string) => iconSrc({ contentType: "image/png", data });
    // Exactly the cap (65535 bytes, then one more in a padded group) draws.
    expect(at(`${b64(65535)}AA==`)).not.toBeNull();
    expect(at(`${b64(65535)}AAA=`)).toBeNull();
    expect(at(b64(65538))).toBeNull();
  });
});

describe("workspaceOf", () => {
  const repo = (location: Repo["location"], path: string | null) => ({ location, path });

  it("is the last component of a Daedalus repo's server path", () => {
    expect(workspaceOf(repo("Daedalus", "/home/santiago/projects/iris"))).toBe("iris");
    expect(workspaceOf(repo("Daedalus", "/srv/projects/web/"))).toBe("web");
  });

  it("is null for a repo on this Mac, or one with no path", () => {
    expect(workspaceOf(repo("Local", "/Users/me/iris"))).toBeNull();
    expect(workspaceOf(repo("Daedalus", null))).toBeNull();
    expect(workspaceOf(undefined)).toBeNull();
  });
});
