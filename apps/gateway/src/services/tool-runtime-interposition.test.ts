import { describe, expect, it } from "vitest";
import { deriveHookPhase, type HookRecord } from "@goatcitadel/contracts";
import { buildToolCallBeforeHookInterpositionBinding } from "./tool-runtime-interposition.js";

function hook(url: string): HookRecord {
  return {
    hookId: "hook-1",
    workspaceId: "workspace-1",
    label: "same timestamp hook",
    trigger: "tool.call.before",
    phase: deriveHookPhase("tool.call.before"),
    mode: "observe",
    enabled: true,
    priority: 100,
    timeoutMs: 1_000,
    failPolicy: "closed",
    action: { type: "webhook", webhook: { url, secret: "signing-secret" } },
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

describe("tool runtime interposition binding", () => {
  it("detects action drift even when the hook timestamp is reused and does not expose secrets", () => {
    const original = buildToolCallBeforeHookInterpositionBinding([
      hook("https://hooks.example.test/original?token=private-token"),
    ]);
    const replaced = buildToolCallBeforeHookInterpositionBinding([
      hook("https://hooks.example.test/replaced?token=private-token"),
    ]);

    expect(original.count).toBe(1);
    expect(original.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(replaced.hash).not.toBe(original.hash);
    expect(JSON.stringify(original)).not.toContain("private-token");
    expect(JSON.stringify(original)).not.toContain("signing-secret");
  });
});
