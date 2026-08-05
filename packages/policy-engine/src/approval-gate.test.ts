import { describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
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

function createStorage(): {
  storage: AsyncStorage;
  create: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(
    async (input: ApprovalCreateInput): Promise<ApprovalRequest> => ({
      approvalId: "apr-1",
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      payload: input.payload,
      preview: input.preview,
      createdAt: "2026-06-13T00:00:00.000Z",
      explanationStatus: "not_requested",
    }),
  );
  const append = vi.fn(async () => undefined);
  const createWithTtlDuration = vi.fn(async (input: ApprovalCreateInput, ttlMs: number) => {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs must be a positive duration");
    }
    return {
      ...(await create(input)),
      expiresAt: new Date(Date.parse("2026-06-13T00:00:00.000Z") + ttlMs).toISOString(),
    };
  });
  const storage = {
    runImmediateTransaction: vi.fn(
      async <T>(operation: () => T | Promise<T>): Promise<Awaited<T>> => await operation(),
    ),
    approvals: { create, createWithTtlDuration },
    audit: { append },
  } as unknown as AsyncStorage;
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

  it.each([0, Number.NaN])("fails closed for invalid compatibility TTL authority %s", async (ttlMs) => {
    const { storage, create, append } = createStorage();
    const gate = new ApprovalGate(storage);

    await expect(gate.create(buildInput(), undefined, { ttlMs })).rejects.toThrow(/positive duration/i);

    expect(create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("delegates valid requests to the canonical creation port without direct storage or audit writes", async () => {
    const { storage, create, append } = createStorage();
    const createApproval = vi.fn(
      async (input: ApprovalCreateInput): Promise<ApprovalRequest> => ({
        approvalId: "apr-canonical",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        linkage: {
          ...input.linkage,
          durableRunId: "approval-wait-apr-canonical",
        },
        createdAt: "2026-07-10T00:00:00.000Z",
        explanationStatus: "not_requested",
      }),
    );
    const gate = new ApprovalGate(storage, createApproval);
    const input = buildInput({
      linkage: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        toolName: "shell.exec",
        actionType: "tool.invoke",
      },
    });

    await expect(gate.create(input)).resolves.toMatchObject({
      approvalId: "apr-canonical",
      linkage: {
        durableRunId: "approval-wait-apr-canonical",
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    });

    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(createApproval).toHaveBeenCalledWith(input, undefined);
    expect(create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("does not create an orphan when the canonical creation port rejects", async () => {
    const { storage, create, append } = createStorage();
    const createApproval = vi.fn(async () => {
      throw new Error("approval observability transaction failed");
    });
    const gate = new ApprovalGate(storage, createApproval);

    await expect(gate.create(buildInput())).rejects.toThrow("approval observability transaction failed");

    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("fails closed instead of silently dropping bare observability effects in compatibility mode", async () => {
    const { storage, append } = createStorage();
    const gate = new ApprovalGate(storage);

    await expect(
      gate.create(buildInput(), () => [
        {
          operationId: "compatibility-audit",
          delivery: {
            kind: "audit",
            stream: "tool_invocations",
            payload: { event: "approval.created" },
          },
        },
      ]),
    ).rejects.toThrow(/canonical approval creation runtime/i);
    expect(append).not.toHaveBeenCalled();
  });
});
