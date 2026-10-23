import { describe, expect, it } from "vitest";
import {
  assignmentStatus,
  readWorkerSelection,
  reconciliationStatus,
  settlementStatus,
  shortDigest,
  workerStatus,
} from "./worker-copy";

describe("worker copy", () => {
  it("presents worker posture in operator words", () => {
    expect(workerStatus("active")).toEqual({ label: "Active", tone: "done" });
    expect(workerStatus("quarantined")).toEqual({ label: "Contained", tone: "waiting" });
    expect(workerStatus("revoked")).toEqual({ label: "Revoked", tone: "failed" });
    expect(workerStatus(null)).toEqual({ label: "Unknown", tone: "neutral" });
  });

  it("presents assignment phase, settlement and reconciliation without raw enum values", () => {
    expect(assignmentStatus("leased")).toEqual({ label: "Running", tone: "running" });
    expect(assignmentStatus("lease_expired")).toEqual({ label: "Lease expired", tone: "waiting" });
    expect(assignmentStatus("settled")).toEqual({ label: "Done", tone: "done" });
    expect(settlementStatus("failed")).toEqual({ label: "Failed", tone: "failed" });
    expect(reconciliationStatus("divergent")).toEqual({ label: "Differs", tone: "waiting" });
    expect(reconciliationStatus(undefined)).toEqual({ label: "Unknown", tone: "neutral" });
  });

  it("truncates digests", () => {
    expect(shortDigest("a".repeat(64))).toBe("aaaaaaaaaa…");
  });
});

describe("readWorkerSelection", () => {
  it("reads one worker and one assignment", () => {
    expect(readWorkerSelection("?workerId=w%2F1&assignmentId=a1")).toEqual({
      workerId: "w/1",
      assignmentId: "a1",
      invalid: false,
    });
  });

  it.each(["?workerId=", "?workerId=a&workerId=b", "?assignmentId=a", "?workerId=a&assignmentId=x&assignmentId=y"])(
    "rejects an ambiguous selection %s",
    (search) => {
      expect(readWorkerSelection(search).invalid).toBe(true);
    },
  );
});
