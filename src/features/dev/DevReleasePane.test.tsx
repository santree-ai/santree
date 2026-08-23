import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DevVersion } from "../../bindings";
import { DevReleasePane } from "./DevReleasePane";

const spies = vi.hoisted(() => ({ release: vi.fn().mockResolvedValue({}), version: vi.fn() }));

vi.mock("../../lib/queries", () => ({
  useDevVersion: () => spies.version(),
  useDevRelease: () => ({ mutateAsync: spies.release, isPending: false }),
}));

function info(over: Partial<DevVersion> = {}): DevVersion {
  return {
    current: "0.1.1",
    mismatched: [],
    latestTag: "v0.1.1",
    next: { release: "0.1.2", minor: "0.2.0", major: "1.0.0", beta: "0.2.0-beta.1" },
    changelogVersions: ["0.1.1", "0.1.0"],
    branch: "main",
    dirtyFiles: 0,
    ...over,
  };
}

const pane = (over: Partial<DevVersion> = {}) => {
  spies.version.mockReturnValue({ data: info(over), isLoading: false });
  return render(<DevReleasePane repoPath="/repo" />);
};

describe("DevReleasePane", () => {
  it("defaults to the next beta", () => {
    const { getByLabelText } = pane();
    expect((getByLabelText("Version to release") as HTMLInputElement).value).toBe("0.2.0-beta.1");
  });

  it("releases a beta with no changelog notes", async () => {
    const { getByText } = pane();
    fireEvent.click(getByText("Release 0.2.0-beta.1"));
    // The push is behind a confirm — the button only opens it.
    expect(spies.release).not.toHaveBeenCalled();
    fireEvent.click(getByText("Push v0.2.0-beta.1"));
    expect(spies.release).toHaveBeenCalledWith({ version: "0.2.0-beta.1", notes: "" });
  });

  it("won't start a stable release with no notes", () => {
    const { getByText, container } = pane();
    fireEvent.click(getByText("0.1.2"));

    const button = getByText("Release 0.1.2").closest("button");
    // The release guard fails a stable tag with no `## <version>` section, so the
    // refusal belongs here rather than in a failed workflow run twenty minutes later.
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("A stable release needs changelog notes");
  });

  it("takes notes for a stable release and sends them", () => {
    const { getByText, getByPlaceholderText } = pane();
    fireEvent.click(getByText("0.1.2"));
    fireEvent.change(getByPlaceholderText(/What changed, for users/), {
      target: { value: "- Files and Release panes in the Dev tab" },
    });
    fireEvent.click(getByText("Release 0.1.2"));
    fireEvent.click(getByText("Push v0.1.2"));

    expect(spies.release).toHaveBeenCalledWith({
      version: "0.1.2",
      notes: "- Files and Release panes in the Dev tab",
    });
  });

  it("keeps a changelog section that already exists", () => {
    // 0.1.2 already written up: the box is gone, and no notes are needed.
    const { getByText, container } = pane({ changelogVersions: ["0.1.2", "0.1.1"] });
    fireEvent.click(getByText("0.1.2"));
    expect(container.textContent).toContain("Already written");
    expect(getByText("Release 0.1.2").closest("button")?.disabled).toBe(false);
  });

  it("blocks every release while the version files disagree", () => {
    const { getByText, container } = pane({ mismatched: ["Cargo.toml"] });
    expect(container.textContent).toContain("declares a different version");
    expect(getByText("Release 0.2.0-beta.1").closest("button")?.disabled).toBe(true);
  });

  it("won't re-release a version that's already tagged", () => {
    const { getByText } = pane({ latestTag: "v0.2.0-beta.1" });
    expect(getByText("Release 0.2.0-beta.1").closest("button")?.disabled).toBe(true);
  });
});
