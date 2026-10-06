import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import { getApproval, type ApprovalLifecycleHost } from "./approval-lifecycle-service.js";
import { DocumentEditingService } from "./document-editing-service.js";

/** A read by id must not reveal a record its workspace-scoped list would hide (IN-08). */
describe("reads by id keep the list's workspace scope", () => {
  it("returns an approval in its workspace and answers not found for another", async () => {
    const approval = {
      approvalId: "approval-1",
      kind: "tool.invoke",
      riskLevel: "caution",
      status: "pending",
      payload: {},
      preview: {},
      linkage: { workspaceId: "workspace-a" },
      createdAt: "2026-10-05T00:00:00.000Z",
    };
    const host = {
      storage: {
        approvals: {
          get: vi.fn(async (approvalId: string) => {
            if (approvalId !== "approval-1") throw new NotFoundError({ entity: "Approval", id: approvalId });
            return approval;
          }),
        },
        approvalEffects: { listByApproval: vi.fn(async () => []) },
        approvalEvents: { listByApprovalId: vi.fn(async () => []) },
      },
    } as unknown as ApprovalLifecycleHost;

    await expect(getApproval(host, "approval-1", "workspace-a")).resolves.toMatchObject({ approvalId: "approval-1" });
    await expect(getApproval(host, "approval-1")).resolves.toMatchObject({ approvalId: "approval-1" });
    await expect(getApproval(host, "approval-1", "workspace-b")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getApproval(host, "missing", "workspace-a")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns a document proposal in its workspace and answers not found for another", async () => {
    const proposal = { proposalId: "proposal-1", workspaceId: "workspace-a", state: "pending" };
    const service = new DocumentEditingService({
      storage: {
        personalOps: {},
        documentPatchProposals: { get: vi.fn(async () => proposal) },
      },
    } as never);
    await expect(service.getProposal("proposal-1", "workspace-a")).resolves.toEqual(proposal);
    await expect(service.getProposal("proposal-1", "workspace-b")).rejects.toBeInstanceOf(NotFoundError);
  });
});
