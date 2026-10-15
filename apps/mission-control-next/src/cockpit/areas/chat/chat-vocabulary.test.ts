import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  presentApprovalAction,
  presentDelegationRunStatus,
  presentDelegationStepStatus,
  presentFileType,
  presentToolRunStatus,
} from "./chat-vocabulary";

describe("chat vocabulary", () => {
  it("shows one tool status everywhere: executed is Done, never Executed", () => {
    expect(presentToolRunStatus({ toolName: "fs.read", status: "executed" } as ChatToolRunRecord)).toEqual({
      label: "Done",
      tone: "done",
    });
    expect(presentToolRunStatus({ toolName: "fs.read", status: "approval_required" } as ChatToolRunRecord).label).toBe(
      "Approval needed",
    );
  });

  it("keeps a cancelled step neutral rather than a red failure", () => {
    expect(presentDelegationStepStatus("cancelled")).toEqual({ label: "Cancelled", tone: "neutral" });
    expect(presentDelegationRunStatus("waiting_for_approval" as never).label).toBe("Waiting on you");
  });

  it("names approval actions in plain words", () => {
    expect(presentApprovalAction("shell.exec", "tool_invoke")).toBe("Run command");
    expect(presentApprovalAction(undefined, "remote_worker.native_runtime")).toBe("Run on a remote worker");
    expect(presentApprovalAction(undefined, undefined)).toBe("Action request");
  });

  it("presents friendly file types", () => {
    expect(presentFileType("application/pdf")).toBe("PDF");
    expect(presentFileType("image/png")).toBe("Image");
    expect(presentFileType("text/plain; charset=utf-8")).toBe("Text");
    expect(presentFileType("application/x-unknown")).toBe("File");
  });
});
