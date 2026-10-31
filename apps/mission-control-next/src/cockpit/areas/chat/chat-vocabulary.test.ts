import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  presentApprovalAction,
  presentDelegationRunStatus,
  presentAttachmentType,
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

  it("shows a Code Mode request whose code failed as Failed, not Done", () => {
    const request = { toolName: "code_mode.request", status: "executed" } as ChatToolRunRecord;
    expect(presentToolRunStatus({ ...request, result: { status: "failed", error: "Code Mode is off." } })).toEqual({
      label: "Failed",
      tone: "failed",
    });
    expect(presentToolRunStatus({ ...request, result: { status: "completed" } }).label).toBe("Done");
  });

  it("keeps a cancelled step neutral rather than a red failure", () => {
    expect(presentDelegationStepStatus("cancelled")).toEqual({ label: "Cancelled", tone: "neutral" });
    expect(presentDelegationRunStatus("waiting_for_approval" as never).label).toBe("Waiting on you");
  });

  it("names approval actions in plain words", () => {
    expect(presentApprovalAction("shell.exec", "tool_invoke")).toBe("Run command");
    expect(presentApprovalAction(undefined, "remote_worker.native_runtime")).toBe("Run on a remote worker");
    expect(presentApprovalAction(undefined, undefined)).toBe("Action request");
    expect(presentApprovalAction(undefined, "citadel_ward.integration_action")).toBe(
      "Citadel Ward: integration action",
    );
    expect(presentApprovalAction(undefined, "citadel_ward.a2a_outbound")).toBe("Citadel Ward: outbound A2A call");
    expect(presentApprovalAction(undefined, "citadel_ward.a2a_push")).toBe("Citadel Ward: A2A push delivery");
  });

  it("presents friendly file types", () => {
    expect(presentFileType("application/pdf")).toBe("PDF");
    expect(presentFileType("image/png")).toBe("Image");
    expect(presentFileType("text/plain; charset=utf-8")).toBe("Text");
    expect(presentFileType("application/x-unknown")).toBe("File");
  });

  it("names an attachment's type the same way for chips and sent messages", () => {
    expect(presentAttachmentType({ fileName: "a.txt", mimeType: "text/plain" })).toBe("Text");
    expect(presentAttachmentType({ fileName: "brief.pdf", mimeType: "application/pdf" })).toBe("PDF");
    expect(presentAttachmentType({ fileName: "data.parquet", mimeType: "application/octet-stream" })).toBe("PARQUET");
    expect(presentAttachmentType({ fileName: "blob", mimeType: undefined })).toBe("File");
  });
});
