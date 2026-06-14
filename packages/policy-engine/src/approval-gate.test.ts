import { describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ApprovalGate } from "./approval-gate.js";

function buildInput(overrides: Partial<ApprovalCreateInput> = {}): ApprovalCreateInput {
  return {
    kind: "shell.exec",
    riskLevel: "danger",
    payload: {},
    preview: {},
    ...overrides,
  };
}

function createStorage(): { storage: Storage; create: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> } {
  const create = vi.fn((input: ApprovalCreateInput): ApprovalRequest => ({
    approvalId: "apr-1",
    kind: input.kind,
    riskLevel: input.riskLevel,
    status: "pending",
    payload: input.payload,
    preview: input.preview,
    createdAt: "2026-06-13T00:00:00.000Z",
    explanationStatus: "not_requested",
  }));
  const append = vi.fn(async () => undefined);
  const storage = {
    approvals: { create },
    audit: { append },
  } as unknown as Storage;
  return { storage, create, append };
}

describe("ApprovalGate", () => {
  it("creates an approval for a valid risk level", async () => {
    const { storage, create, append } = createStorage();
    const gate = new ApprovalGate(storage);

    const approval = await gate.create(buildInput({ riskLevel: "nuclear" }));

    expect(approval.approvalId).toBe("apr-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-enum risk level at the gate without persisting", async () => {
    const { storage, create, append } = createStorage();
    const gate = new ApprovalGate(storage);

    await expect(
      gate.create(buildInput({ riskLevel: "catastrophic" as unknown as ApprovalRequest["riskLevel"] })),
    ).rejects.toThrow(/riskLevel/i);

    expect(create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
