import { describe, expect, it } from "vitest";
import { isResumableCodeModeRequestFailure } from "./code-mode-request-resume.js";

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
