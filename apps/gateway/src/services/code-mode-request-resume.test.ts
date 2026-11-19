import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  formatRecordedCodeModeResult,
  isResumableCodeModeRequestFailure,
  readStandaloneCodeModeSource,
} from "./code-mode-request-resume.js";

const standalone =
  "Use the governed code_mode.request tool and open its operator approval card. Goal: verify 6 × 7. Language: JavaScript. Source: return 6 * 7; Reads: none. This only requests approval for a bounded computation, with no workspace edits, shell commands, or network. Please request approval even if Code Mode is currently off.";
const approvedRun: ChatToolRunRecord = {
  toolRunId: "tool-1",
  turnId: "turn-1",
  sessionId: "session-1",
  toolName: "code_mode.request",
  startedAt: "2026-11-18T15:31:20.000Z",
  finishedAt: "2026-11-18T15:31:23.000Z",
  approvalId: "approval-1",
  status: "executed",
  args: { language: "javascript", source: "return 6 * 7;", reads: [] },
  result: { status: "completed", runId: "code-run-1", result: { value: 42 } },
};

it("reports a standalone approved result from the saved value, without recalculating it", () => {
  expect(readStandaloneCodeModeSource(standalone)).toBe("return 6 * 7;");
  expect(formatRecordedCodeModeResult("return 6 * 7;", [approvedRun])).toBe("Code Mode returned **42**.");
  expect(
    formatRecordedCodeModeResult("return 6 * 7;", [
      { ...approvedRun, result: { ...approvedRun.result, result: { value: 0 } } },
    ]),
  ).toBe("Code Mode returned **0**.");
});

it("leaves follow-up work, failures, and modified code on the normal resume path", () => {
  expect(readStandaloneCodeModeSource(standalone + " Then explain how it works.")).toBeUndefined();
  expect(formatRecordedCodeModeResult("return 7 * 7;", [approvedRun])).toBeUndefined();
  expect(formatRecordedCodeModeResult("return 6 * 7;", [{ ...approvedRun, approvalId: undefined }])).toBeUndefined();
  expect(
    formatRecordedCodeModeResult("return 6 * 7;", [
      { ...approvedRun, result: { ...approvedRun.result, status: "failed" } },
    ]),
  ).toBeUndefined();
  expect(
    formatRecordedCodeModeResult("return 6 * 7;", [approvedRun, { ...approvedRun, toolRunId: "other" }]),
  ).toBeUndefined();
});

const codeModeRequest = { actionType: "tool.invoke" as const, request: { toolName: "code_mode.request" } };
const failed = { message: "Code Mode is off.", kind: "failed" as const, manualReconciliationRequired: false };

describe("isResumableCodeModeRequestFailure", () => {
  it("treats an executed code_mode.request that reported a failure as executed-with-error", () => {
    expect(isResumableCodeModeRequestFailure(codeModeRequest, "executed", failed)).toBe(true);
  });

  it("keeps every other failure terminal", () => {
    expect(isResumableCodeModeRequestFailure(codeModeRequest, "blocked", failed)).toBe(false);
    expect(isResumableCodeModeRequestFailure(codeModeRequest, "executed", undefined)).toBe(false);
    expect(
      isResumableCodeModeRequestFailure(codeModeRequest, "executed", {
        ...failed,
        kind: "manual_reconciliation",
        manualReconciliationRequired: true,
      }),
    ).toBe(false);
    expect(
      isResumableCodeModeRequestFailure(
        { actionType: "tool.invoke", request: { toolName: "fs.write" } },
        "executed",
        failed,
      ),
    ).toBe(false);
    expect(isResumableCodeModeRequestFailure({ actionType: "code_mode.run", request: {} }, "executed", failed)).toBe(
      false,
    );
    expect(isResumableCodeModeRequestFailure(undefined, "executed", failed)).toBe(false);
  });
});
