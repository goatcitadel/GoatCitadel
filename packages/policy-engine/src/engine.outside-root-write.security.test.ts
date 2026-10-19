import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { ToolPolicyEngine, type ToolPolicyEngineRuntimeHooks } from "./engine.js";
import {
  createOutsideRootFixture,
  createOutsideRootStorage,
  outsideRootConfig,
  type OutsideRootFixture,
} from "./outside-root-write.test-support.js";

let fixture: OutsideRootFixture;

beforeEach(() => {
  fixture = createOutsideRootFixture();
});

afterEach(() => {
  fixture.cleanup();
});

const eligible: ToolPolicyEngineRuntimeHooks = { resolveOutsideRootWriteEligibility: async () => true };

function writeRequest(target: string, extra: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return { toolName: "fs.write", args: { path: target, content: "x" }, agentId: "agent", sessionId: "session-1", ...extra };
}

function engineWith(config: ToolPolicyConfig, hooks: ToolPolicyEngineRuntimeHooks = eligible) {
  const fake = createOutsideRootStorage();
  return { engine: new ToolPolicyEngine(config, fake.storage, undefined, hooks), fake };
}

describe("outside-root writes: when an approval is offered", () => {
  it("keeps the default deny mode a structural block", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture, { mode: "deny" }));
    const result = await engine.evaluateAccess(writeRequest(path.join(fixture.outside, "a.txt")));
    expect(result.allowed).toBe(false);
    expect(result.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("asks for approval in approval_required mode", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture));
    const result = await engine.evaluateAccess(writeRequest(path.join(fixture.outside, "a.txt")));
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.reasonCodes).toContain("outside_root_write_requires_approval");
  });

  it("is not cleared by bypass approval mode or a pre-approved Code Mode run", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture, { approvalMode: "bypass" }));
    const target = path.join(fixture.outside, "a.txt");
    expect((await engine.evaluateAccess(writeRequest(target))).requiresApproval).toBe(true);
    const codeMode = writeRequest(target, { policyContext: { approvedCodeModeRunId: "run-1" } } as never);
    expect((await engine.evaluateAccess(codeMode)).requiresApproval).toBe(true);
  });

  it.each([
    ["without an eligibility hook", {}],
    ["when the gateway says the session is ineligible", { resolveOutsideRootWriteEligibility: async () => false }],
  ])("blocks %s", async (_label, hooks) => {
    const { engine } = engineWith(outsideRootConfig(fixture), hooks as ToolPolicyEngineRuntimeHooks);
    const result = await engine.evaluateAccess(writeRequest(path.join(fixture.outside, "a.txt")));
    expect(result.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("blocks A2A peers and mesh nodes even when the hook would allow", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture));
    for (const authActorSource of ["a2a_peer", "mesh_node"] as const) {
      const request = writeRequest(path.join(fixture.outside, "a.txt"), { policyContext: { authActorSource } } as never);
      expect((await engine.evaluateAccess(request)).reasonCodes).toEqual(["structural_safety_block"]);
    }
  });

  it("blocks hard-forbidden targets and deletes outside the roots with no approval", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture));
    const secret = await engine.evaluateAccess(writeRequest(path.join(fixture.secretsDir, "vault.bin")));
    expect(secret.reasonCodes).toEqual(["structural_safety_block"]);
    const deletion = await engine.evaluateAccess({
      toolName: "fs.delete",
      args: { path: path.join(fixture.outside, "a.txt") },
      agentId: "agent",
      sessionId: "session-1",
    });
    expect(deletion.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("keeps deny-wins authoritative", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture, { deny: ["fs.write"] }));
    const result = await engine.evaluateAccess(writeRequest(path.join(fixture.outside, "a.txt")));
    expect(result.reasonCodes).toEqual(["policy_deny"]);
  });

  it("does not change writes inside the jail", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture));
    const result = await engine.evaluateAccess(writeRequest(path.join(fixture.jailRoot, "a.txt")));
    expect(result.allowed).toBe(true);
    expect(result.reasonCodes).not.toContain("outside_root_write_requires_approval");
  });
});

describe("outside-root writes: approval record", () => {
  it("records targets and server-derived folder candidates in the registration event and preview", async () => {
    const { engine, fake } = engineWith(outsideRootConfig(fixture));
    const target = path.join(fixture.outside, "a.txt");
    const result = await engine.invoke({ ...writeRequest(target) });
    expect(result.outcome).toBe("approval_required");
    const registration = fake.events.find((event) => event.eventType === "pending_action_registered");
    const details = registration?.payload?.outsideRootWrite as { targets: string[]; candidates: { path: string }[] };
    expect(details.targets).toEqual([target]);
    expect(details.candidates.map((candidate) => candidate.path)).toEqual([
      fixture.outside,
      path.dirname(fixture.outside),
    ]);
    const approval = [...fake.approvals.values()][0];
    expect(approval?.preview?.outsideRootWrite).toEqual(registration?.payload?.outsideRootWrite);
    expect(await engine.describeOutsideRootWriteApproval(approval!.approvalId)).toMatchObject({ targets: [target] });
  });
});

describe("outside-root writes: approve once", () => {
  async function approvedOnce(target: string) {
    const setup = engineWith(outsideRootConfig(fixture));
    await setup.engine.invoke({ ...writeRequest(target) });
    const approvalId = [...setup.fake.approvals.keys()][0]!;
    setup.fake.approve(approvalId);
    return { ...setup, approvalId };
  }

  it("admits exactly the registered target for the approved request", async () => {
    const target = path.join(fixture.outside, "a.txt");
    const { engine, approvalId } = await approvedOnce(target);
    const result = await engine.evaluateAccess(writeRequest(target, { consentContext: { reason: `approval:${approvalId}` } } as never));
    expect(result.allowed).toBe(true);
    expect(result.reasonCodes).toContain("outside_root_write_approved_once");
  });

  it("does not admit a different target under the same approval", async () => {
    const { engine, approvalId } = await approvedOnce(path.join(fixture.outside, "a.txt"));
    const other = writeRequest(path.join(fixture.outside, "b.txt"), {
      consentContext: { reason: `approval:${approvalId}` },
    } as never);
    const result = await engine.evaluateAccess(other);
    expect(result.reasonCodes).not.toContain("outside_root_write_approved_once");
    expect(result.reasonCodes).toContain("outside_root_write_requires_approval");
  });

  it("does not admit through an approval that has no outside-root registration", async () => {
    const { engine, fake } = engineWith(outsideRootConfig(fixture));
    const target = path.join(fixture.outside, "a.txt");
    const request = writeRequest(target);
    fake.seedApproval({ approvalId: "approval-unrelated", request: { ...request } });
    const result = await engine.evaluateAccess({ ...request, consentContext: { reason: "approval:approval-unrelated" } } as never);
    expect(result.reasonCodes).not.toContain("outside_root_write_approved_once");
  });
});

describe("outside-root writes: folder grants", () => {
  async function mintedGrant() {
    const setup = engineWith(outsideRootConfig(fixture));
    await setup.engine.invoke({ ...writeRequest(path.join(fixture.outside, "a.txt")) });
    const approvalId = [...setup.fake.approvals.keys()][0]!;
    setup.fake.approve(approvalId);
    const details = await setup.engine.describeOutsideRootWriteApproval(approvalId);
    const grant = await setup.engine.mintOutsideRootWriteGrant({
      approvalId,
      rootId: details!.candidates[0]!.rootId,
      duration: "1h",
      scope: "session",
      scopeRef: "session-1",
      createdBy: "operator",
    });
    return { ...setup, approvalId, grant };
  }

  it("mints a ttl grant for the approved tool and folder only", async () => {
    const { grant } = await mintedGrant();
    expect(grant).toMatchObject({
      toolPattern: "fs.write",
      decision: "allow",
      scope: "session",
      scopeRef: "session-1",
      grantType: "ttl",
      constraints: { writeRoots: [fixture.outside] },
    });
    expect(grant.constraints?.writeRootsApprovalId).toBeTruthy();
    const ttlMs = Date.parse(grant.expiresAt!) - Date.now();
    expect(ttlMs).toBeGreaterThan(59 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60_000);
  });

  it("admits later writes inside the folder through the grant", async () => {
    const { engine, grant } = await mintedGrant();
    const result = await engine.evaluateAccess(writeRequest(path.join(fixture.outside, "later.txt")));
    expect(result.allowed).toBe(true);
    expect(result.matchedGrantId).toBe(grant.grantId);
    expect(result.reasonCodes).toContain("outside_root_write_grant");
    expect(result.reasonCodes).not.toContain("outside_root_write_requires_approval");
  });

  it("is skipped for jail writes and for other folders", async () => {
    const { engine, grant } = await mintedGrant();
    const jail = await engine.evaluateAccess(writeRequest(path.join(fixture.jailRoot, "a.txt")));
    expect(jail.allowed).toBe(true);
    expect(jail.matchedGrantId).not.toBe(grant.grantId);
    const elsewhere = await engine.evaluateAccess(writeRequest(path.join(fixture.base, "elsewhere.txt")));
    expect(elsewhere.matchedGrantId).not.toBe(grant.grantId);
    expect(elsewhere.reasonCodes).toContain("outside_root_write_requires_approval");
  });

  it("stops working once the mode is switched back to deny", async () => {
    const { fake, grant } = await mintedGrant();
    const config = outsideRootConfig(fixture, { mode: "deny" });
    const engine = new ToolPolicyEngine(config, fake.storage, undefined, eligible);
    const result = await engine.evaluateAccess(writeRequest(path.join(fixture.outside, "later.txt")));
    expect(result.matchedGrantId).not.toBe(grant.grantId);
    expect(result.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("binds the grant to the approved request's own session or workspace", async () => {
    const setup = engineWith(outsideRootConfig(fixture));
    await setup.engine.invoke({ ...writeRequest(path.join(fixture.outside, "a.txt")) });
    const approvalId = [...setup.fake.approvals.keys()][0]!;
    setup.fake.approve(approvalId);
    const details = await setup.engine.describeOutsideRootWriteApproval(approvalId);
    const mint = (scope: "session" | "workspace", scopeRef: string) =>
      setup.engine.mintOutsideRootWriteGrant({
        approvalId,
        rootId: details!.candidates[0]!.rootId,
        duration: "1h",
        scope,
        scopeRef,
        createdBy: "operator",
      });
    await expect(mint("session", "session-other")).rejects.toThrow(/approved request's own session/u);
    await expect(mint("workspace", "workspace-1")).rejects.toThrow(/approved request's own workspace/u);
    expect(setup.fake.grants).toHaveLength(0);
  });

  it("mints at most one grant per approval, and only soon after approval", async () => {
    const { engine, approvalId } = await mintedGrant();
    const details = await engine.describeOutsideRootWriteApproval(approvalId);
    const again = {
      approvalId,
      rootId: details!.candidates[0]!.rootId,
      duration: "1h" as const,
      scope: "session" as const,
      scopeRef: "session-1",
      createdBy: "operator",
    };
    await expect(engine.mintOutsideRootWriteGrant(again)).rejects.toThrow(/already opened a folder/u);

    const stale = engineWith(outsideRootConfig(fixture));
    await stale.engine.invoke({ ...writeRequest(path.join(fixture.outside, "a.txt")) });
    const staleId = [...stale.fake.approvals.keys()][0]!;
    stale.fake.approve(staleId, new Date(Date.now() - 16 * 60_000).toISOString());
    const staleDetails = await stale.engine.describeOutsideRootWriteApproval(staleId);
    await expect(
      stale.engine.mintOutsideRootWriteGrant({ ...again, approvalId: staleId, rootId: staleDetails!.candidates[0]!.rootId }),
    ).rejects.toThrow(/too old/u);
  });

  it("refuses unknown folders and unapproved approvals when minting", async () => {
    const { engine, approvalId } = await mintedGrant();
    await expect(
      engine.mintOutsideRootWriteGrant({
        approvalId,
        rootId: "owr_0000000000000000",
        duration: "1h",
        scope: "session",
        scopeRef: "session-1",
        createdBy: "operator",
      }),
    ).rejects.toThrow(/not available/u);
    const fresh = engineWith(outsideRootConfig(fixture));
    await fresh.engine.invoke({ ...writeRequest(path.join(fixture.outside, "a.txt")) });
    const pendingId = [...fresh.fake.approvals.keys()][0]!;
    const details = await fresh.engine.describeOutsideRootWriteApproval(pendingId);
    await expect(
      fresh.engine.mintOutsideRootWriteGrant({
        approvalId: pendingId,
        rootId: details!.candidates[0]!.rootId,
        duration: "1h",
        scope: "session",
        scopeRef: "session-1",
        createdBy: "operator",
      }),
    ).rejects.toThrow(/approved/u);
  });

  it("validates writeRoots grants created through the grants API", async () => {
    const { engine } = engineWith(outsideRootConfig(fixture));
    await expect(
      engine.createGrant({
        toolPattern: "fs.write",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
        createdBy: "operator",
        constraints: { writeRoots: [fixture.outside] },
      }),
    ).rejects.toThrow(/Invalid write-root grant/u);
  });
});
