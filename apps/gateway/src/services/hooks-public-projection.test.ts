import { describe, expect, it } from "vitest";
import type { HookRecord, HookRunRecord } from "@goatcitadel/contracts";
import {
  preserveHookSecretsForPublicUpdate,
  projectHookRecordForPublicResponse,
  projectHookRunsForPublicResponse,
} from "./hooks-public-projection.js";

function createHook(): HookRecord {
  return {
    hookId: "hook-1",
    workspaceId: "workspace-1",
    label: "Notify",
    trigger: "tool.call.after",
    phase: "after",
    mode: "observe",
    enabled: true,
    priority: 100,
    timeoutMs: 5_000,
    failPolicy: "open",
    action: {
      type: "webhook",
      webhook: {
        url: "https://callback.example.test/token/hook-short?mode=events",
        secret: "signing-short",
      },
    },
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

describe("hook public projection", () => {
  it("uses the exact public action projection when preserving routine updates", () => {
    const hook = createHook();
    const publicHook = projectHookRecordForPublicResponse(hook);

    const update = preserveHookSecretsForPublicUpdate(hook, {
      label: "Renamed hook",
      enabled: false,
      action: publicHook.action,
    });

    expect(update).toEqual({
      label: "Renamed hook",
      enabled: false,
      action: hook.action,
    });
    expect(hook.action.webhook.url).toContain("hook-short");
  });

  it("projects credential-bearing URL paths and text in hook-run DTOs", () => {
    const run: HookRunRecord = {
      runId: "run-1",
      hookId: "hook-1",
      workspaceId: "workspace-1",
      trigger: "tool.call.after",
      entityType: "tool_run",
      entityId: "tool-run-1",
      mode: "observe",
      status: "failed",
      idempotencyKey: "idem-1",
      attemptCount: 1,
      requestPayload: {
        endpoint: "https://callback.example.test/token/request-short?mode=events",
      },
      errorText: "failed at https://hooks.slack.com/services/team/bot/signing-short",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };

    const [projected] = projectHookRunsForPublicResponse([run]);

    expect(projected?.requestPayload?.endpoint).toBe("https://callback.example.test/token/[REDACTED]?mode=events");
    expect(projected?.errorText).toBe("failed at https://hooks.slack.com/services/[REDACTED]/[REDACTED]/[REDACTED]");
    expect(run.errorText).toContain("signing-short");
  });
});
