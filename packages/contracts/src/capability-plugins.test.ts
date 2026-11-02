import { describe, expect, it } from "vitest";
import {
  capabilityPluginSourceFormat,
  isCapabilityPluginIgnoredPart,
  type CapabilityPluginIgnoredPart,
  type CapabilityPluginInspection,
} from "./capability-plugins.js";

function savedBeforePhase5(): CapabilityPluginInspection {
  // As an inspection saved before Phase 5 reads back: no `sourceFormat`, no `claudeCode`, and `ignored` empty.
  return JSON.parse(
    JSON.stringify({
      inspectionId: "insp-1",
      workspaceId: "default",
      pluginId: "notes",
      name: "Notes",
      description: "Notes.",
      version: "1.0.0",
      trust: "unverified",
      sourceKind: "folder",
      sourceDisplay: "notes",
      pin: { kind: "content", treeSha256: "a".repeat(64) },
      manifestSha256: "b".repeat(64),
      pieces: [],
      ignored: [],
      installable: true,
      inspectedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-02T00:00:00.000Z",
    }),
  ) as CapabilityPluginInspection;
}

describe("capability plugin inspections", () => {
  it("parses an inspection saved before Phase 5", () => {
    const inspection = savedBeforePhase5();
    expect(capabilityPluginSourceFormat(inspection)).toBe("goatcitadel");
    expect(inspection.claudeCode).toBeUndefined();
    expect(inspection.ignored.every(isCapabilityPluginIgnoredPart)).toBe(true);
    expect(capabilityPluginSourceFormat({ sourceFormat: "claude_code" })).toBe("claude_code");
  });

  it("reads a left-out part only when every field is there", () => {
    const part: CapabilityPluginIgnoredPart = {
      path: "commands/deploy.md",
      kind: "command",
      label: "deploy",
      reason: "A command. GoatCitadel doesn't take commands from plugins.",
    };
    expect(isCapabilityPluginIgnoredPart(part)).toBe(true);
    // The pre-Phase-5 shape had only a path and a reason.
    expect(isCapabilityPluginIgnoredPart({ path: "x", reason: "y" })).toBe(false);
    expect(isCapabilityPluginIgnoredPart({ ...part, kind: "teleport" })).toBe(false);
    expect(isCapabilityPluginIgnoredPart(null)).toBe(false);
  });
});
