import { describe, expect, it, vi } from "vitest";
import { skipsSkillHubScratchFolder } from "./skill-hub-scratch-folders.js";

describe("skipsSkillHubScratchFolder", () => {
  it("skips a Skill Hub scratch folder with one debug line that names only the folder", () => {
    const sink = { debug: vi.fn() };

    expect(skipsSkillHubScratchFolder(".skill-hub-0123456789abcdef01234567.backup", "installed_sources", sink)).toBe(
      true,
    );

    expect(sink.debug).toHaveBeenCalledExactlyOnceWith(
      "Skipping a Skill Hub scratch folder: .skill-hub-0123456789abcdef01234567.backup",
      { listing: "installed_sources", folder: ".skill-hub-0123456789abcdef01234567.backup" },
    );
  });

  it("keeps an ordinary folder and logs nothing", () => {
    const sink = { debug: vi.fn() };

    expect(skipsSkillHubScratchFolder("meeting-notes", "installed_sources", sink)).toBe(false);

    expect(sink.debug).not.toHaveBeenCalled();
  });
});
