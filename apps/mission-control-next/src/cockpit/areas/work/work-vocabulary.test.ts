import { describe, expect, it } from "vitest";
import {
  presentApprovalKind,
  presentExportValidation,
  presentImportCompatibility,
  presentRecordedCancellation,
} from "./work-vocabulary";

describe("Work run label maps", () => {
  it("names known approval kinds and falls back to Other for anything else", () => {
    expect(presentApprovalKind("tool.invoke")).toBe("Use a tool");
    expect(presentApprovalKind("something_new")).toBe("Other");
    expect(presentApprovalKind("__proto__")).toBe("Other");
    expect(presentApprovalKind("constructor")).toBe("Other");
    expect(presentApprovalKind("toString")).toBe("Other");
  });

  it("names automation validation values and falls back to Other", () => {
    expect(presentExportValidation("blocked")).toBe("Blocked");
    expect(presentExportValidation("ready_for_operator_import_review")).toBe("Ready for your import review");
    expect(presentExportValidation("__proto__")).toBe("Other");
    expect(presentExportValidation("constructor")).toBe("Other");
    expect(presentImportCompatibility("not_verified")).toBe("Not verified");
    expect(presentImportCompatibility("__proto__")).toBe("Other");
    expect(presentImportCompatibility("constructor")).toBe("Other");
  });
});

describe("recorded cancellations", () => {
  it("says an operator cancelled only for a recorded operator or signed-in caller", () => {
    for (const text of [
      "cancelled by operator",
      "Cancelled by operator.",
      "cancelled by auth:[REDACTED]",
      "cancelled by auth:none",
      "cancelled by device:abc",
      "cancelled by companion:xyz",
      "cancelled by ip:10.0.0.2",
      "cancelled by background-task-rail:operator",
    ]) {
      expect(presentRecordedCancellation(text)).toBe("Cancelled by an operator.");
    }
  });

  it("words the system and parent causes truthfully", () => {
    expect(presentRecordedCancellation("cancelled by fanout:parent_cancelled")).toBe(
      "Cancelled because the run that started it was cancelled.",
    );
    expect(presentRecordedCancellation("cancelled by abort_signal")).toBe(
      "Cancelled because the request that started it was stopped.",
    );
    expect(presentRecordedCancellation("cancelled by worktree-lease-fence")).toBe("Cancelled by the system.");
  });

  it("leaves text it cannot classify alone", () => {
    expect(presentRecordedCancellation("cancelled by orchestration")).toBeUndefined();
    expect(presentRecordedCancellation("cancelled by fanout:something_else")).toBeUndefined();
    expect(presentRecordedCancellation("cancelled by")).toBeUndefined();
    expect(presentRecordedCancellation("Tool failed, cancelled by operator")).toBeUndefined();
    expect(presentRecordedCancellation("")).toBeUndefined();
  });
});
