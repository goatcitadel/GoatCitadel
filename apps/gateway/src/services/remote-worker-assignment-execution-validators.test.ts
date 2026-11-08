import { describe, expect, it } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import * as validators from "./remote-worker-assignment-execution-validators.js";

// Namespace lookup makes the initial RED report the missing diagnostic contract,
// rather than an import-link failure. Production is added only after that RED.
function reader() {
  const read = (validators as unknown as Record<string, unknown>).readExecutionRejectionDiagnostic;
  expect(read, "closed rejection diagnostic reader must exist").toBeTypeOf("function");
  return read as (error: unknown) => { stage: string; reason: string };
}
function classify(error: unknown) {
  const classify = (validators as unknown as Record<string, unknown>).classifyArtifactAdmissionRejection;
  expect(classify, "artifact admission classifier must exist").toBeTypeOf("function");
  return (classify as (error: unknown) => { stage: string; reason: string })(error);
}
const parentMismatch = "remote worker assignment lease parent dispatch authority conflicts with durable assignment authority.";

describe("internal execution rejection diagnostics", () => {
  it("projects only the exact storage conflict into the closed admission reason", () => {
    expect(classify(new ConflictError({ code: "STATE_CONFLICT", message: parentMismatch })))
      .toStrictEqual({ stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" });
    for (const error of [
      new ConflictError({ code: "STATE_CONFLICT", message: "unrelated conflict synthetic-secret" }),
      new ConflictError({ code: "WRITE_CONFLICT", message: parentMismatch }),
      new Error(parentMismatch), { code: "STATE_CONFLICT", message: parentMismatch },
      new ConflictError({ code: "STATE_CONFLICT", message: `${parentMismatch} synthetic-secret` }),
    ]) expect(classify(error)).toStrictEqual({ stage: "artifact_admission", reason: "other" });
  });

  it("retains an immutable closed diagnostic without retaining arbitrary input", () => {
    const input = { stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch", token: "synthetic-secret" };
    const error = Reflect.construct(validators.RemoteWorkerAssignmentExecutionProtocolError,
      ["fixed refusal", input]);
    const read = reader();
    expect(read(error)).toStrictEqual({ stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" });
    input.reason = "synthetic-secret";
    expect(read(error)).toStrictEqual({ stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" });
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    expect(Object.isFrozen(read(error))).toBe(true);
  });

  it("rejects forged, malformed, accessor and proxy diagnostics without invoking attacker code", () => {
    const read = reader();
    const getter = () => { throw new Error("synthetic-secret getter ran"); };
    for (const diagnostic of [undefined, null, [], { stage: "artifact_admission", reason: "synthetic-secret" },
      { stage: "synthetic-secret", reason: "other" },
      Object.defineProperty({}, "stage", { get: getter }),
      new Proxy({}, { get: getter, getOwnPropertyDescriptor: getter }),
    ]) {
      const error = Reflect.construct(validators.RemoteWorkerAssignmentExecutionProtocolError,
        ["fixed refusal", diagnostic]);
      expect(read(error)).toStrictEqual({ stage: "unclassified", reason: "unclassified" });
      expect(JSON.stringify(read(error))).not.toContain("synthetic-secret");
    }
    expect(read({ diagnostic: { stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" } }))
      .toStrictEqual({ stage: "unclassified", reason: "unclassified" });
  });
});
