import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { WorkflowSkillCaptureService } from "./workflow-skill-capture-service.js";
import { CapabilitySystemService } from "./capability-system-service.js";
import { resolveCallableSkillActivation } from "./callable-skill-activation.js";
import {
  buildGovernedActivatedSkillReceipts,
  renderGovernedActivatedSkillInstructions,
} from "./governed-skill-instruction-service.js";
import type { ChatTurnCapabilityProfileRecord } from "@goatcitadel/contracts";

const actor = { actorId: "capture-operator", authActorSource: "loopback" as const };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const markdown = [
  "---",
  "name: review-workflow",
  "description: Review a completed work item using explicit checks and retained evidence.",
  "---",
  "# Review workflow",
  ...["When to use", "Inputs", "Instructions", "Failure handling", "Output", "Verification", "Boundaries"].flatMap(
    (heading) => [`\n## ${heading}\n`, "Check the supplied work item and record the observed result."],
  ),
].join("\n");
const resources: { root: string; storage: Storage }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    resource.storage.close();
    await fs.rm(resource.root, { recursive: true, force: true });
  }
});
async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-workflow-capture-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  resources.push({ root, storage });
  const service = new WorkflowSkillCaptureService({
    storage: createSqliteAsyncStorage(storage),
    rootDir: root,
    candidateRoot: "candidates",
  });
  const seed = (id: string, user: string, assistant: string, sessionId = "session") => {
    const timestamp = "2026-09-08T01:00:00.000Z";
    storage.chatSessionMeta.ensure(sessionId, timestamp, "default");
    storage.chatMessages.upsert({
      messageId: `${id}-user`,
      sessionId,
      role: "user",
      actorType: "user",
      actorId: actor.actorId,
      sourceAuthority: "operator",
      content: user,
      timestamp,
    });
    storage.chatMessages.upsert({
      messageId: `${id}-assistant`,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      sourceAuthority: "agent_proposed",
      content: assistant,
      timestamp,
    });
    storage.chatTurnTraces.create({
      turnId: id,
      sessionId,
      userMessageId: `${id}-user`,
      assistantMessageId: `${id}-assistant`,
      status: "completed",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      completion: { status: "complete", repaired: false, providerCallCount: 1 },
      startedAt: timestamp,
      finishedAt: timestamp,
    });
  };
  seed("source", "Review the work item", "Read the supplied file, check the result, and report discrepancies.");
  return { root, storage, service, seed };
}
describe("workflow skill capture", () => {
  it("freezes canonical settled tool evidence without copying raw results, and invalidates a changed result", async () => {
    const h = await harness();
    h.storage.chatToolRuns.create({
      toolRunId: "source-tool",
      turnId: "source",
      sessionId: "session",
      toolName: "fs.read",
      status: "executed",
      result: { content: "An incidental private file value" },
      finishedAt: "2026-09-08T01:00:00.000Z",
      effectPotential: "none",
      effectDisposition: "none",
      effectOutcomeKind: "none",
      effectEvidence: {
        version: "goatcitadel.tool-effect.v1",
        outcomeKind: "none",
        reason: "trusted_safe_read",
        refs: [],
      },
    });
    const prepared = await h.service.prepare("session", { sourceTurnId: "source" }, actor);
    expect(prepared.prompt).toContain("source-tool");
    expect(prepared.prompt).toContain("resultSha256");
    expect(prepared.prompt).not.toContain("An incidental private file value");
    h.seed("draft", prepared.prompt, markdown);
    h.storage.chatToolRuns.patch("source-tool", { result: { content: "Changed canonical result" } });
    await expect(
      h.service.stage("session", { draftTurnId: "draft", reviewedContentSha256: hash(markdown) }, actor),
    ).rejects.toThrow("source workflow changed");
    expect(h.storage.capabilityProposals.list(100)).toEqual([]);
  });
  it("rejects unresolved tool effects and overlarge combined evidence before drafting", async () => {
    const h = await harness();
    h.storage.chatToolRuns.create({
      toolRunId: "pending-tool",
      turnId: "source",
      sessionId: "session",
      toolName: "mcp.invoke",
    });
    await expect(h.service.prepare("session", { sourceTurnId: "source" }, actor)).rejects.toThrow(
      "settled tool results",
    );
    h.storage.chatToolRuns.patch("pending-tool", { status: "executed", finishedAt: "2026-09-08T01:00:00.000Z" });
    await expect(h.service.prepare("session", { sourceTurnId: "source" }, actor)).rejects.toThrow(
      "settled tool results",
    );
    h.seed("large", "A".repeat(33_000), "B".repeat(33_000));
    await expect(h.service.prepare("session", { sourceTurnId: "large" }, actor)).rejects.toThrow(
      "combined workflow evidence",
    );
  });
  it("requires private values and temporary paths in generated instructions to be generalized before staging", async () => {
    const h = await harness();
    for (const [index, value] of [
      "writer@example.test",
      "C:\\Users\\example\\Desktop\\report.md",
      "/tmp/private-task/report.md",
    ].entries()) {
      const draft = `${markdown}\nUse ${value}.`;
      h.seed(`private-${index}`, (await h.service.prepare("session", { sourceTurnId: "source" }, actor)).prompt, draft);
      await expect(
        h.service.stage("session", { draftTurnId: `private-${index}`, reviewedContentSha256: hash(draft) }, actor),
      ).rejects.toThrow("named inputs");
    }
    expect(h.storage.capabilityProposals.list(100)).toEqual([]);
  });
  it("rejects an authority change between review and the candidate transaction", async () => {
    const h = await harness();
    h.seed("draft", (await h.service.prepare("session", { sourceTurnId: "source" }, actor)).prompt, markdown);
    const read = h.storage.chatMessages.get.bind(h.storage.chatMessages);
    let draftReads = 0;
    vi.spyOn(h.storage.chatMessages, "get").mockImplementation((messageId) => {
      const message = read(messageId);
      if (messageId === "draft-user" && ++draftReads > 1 && message) return { ...message, actorId: "changed-operator" };
      return message;
    });
    await expect(
      h.service.stage("session", { draftTurnId: "draft", reviewedContentSha256: hash(markdown) }, actor),
    ).rejects.toThrow("workflow changed while staging");
    expect(h.storage.capabilityProposals.list(100)).toEqual([]);
  });
  it("uses the frozen authenticated identity when Chat's display actor is operator", async () => {
    const h = await harness();
    h.seed("draft", (await h.service.prepare("session", { sourceTurnId: "source" }, actor)).prompt, markdown);
    const user = h.storage.chatMessages.get("draft-user")!;
    h.storage.chatMessages.upsert({ ...user, actorId: "operator" });
    const request = { draftTurnId: "draft", reviewedContentSha256: hash(markdown) };
    await expect(h.service.stage("session", request, actor)).rejects.toThrow("capture request changed");
    h.storage.chatTurnTraces.patch("draft", { capabilityProfileId: "profile", capabilityProfileHash: hash("profile") });
    // The profile repository independently verifies sealed bytes; exercise its
    // authenticated output here without manufacturing a session admission.
    const profile = {
      profileId: "profile",
      hashes: { profileHash: hash("profile") },
      identity: {
        turnId: "draft",
        sessionId: "session",
        workspaceId: "default",
        authActorId: "another-operator",
      },
    } as ChatTurnCapabilityProfileRecord;
    const read = vi.spyOn(h.storage.chatTurnCapabilityProfiles, "get").mockReturnValue(profile);
    await expect(h.service.stage("session", request, actor)).rejects.toThrow("capture request changed");
    read.mockReturnValue({ ...profile, identity: { ...profile.identity, authActorId: actor.actorId } });
    expect(await h.service.stage("session", request, actor)).toMatchObject({ activationPerformed: false });
  });
  it("requires canonical approval, reuses exact instructions in its workspace, and removes revoked skills", async () => {
    const h = await harness();
    h.seed("draft", (await h.service.prepare("session", { sourceTurnId: "source" }, actor)).prompt, markdown);
    const captured = await h.service.stage(
      "session",
      { draftTurnId: "draft", reviewedContentSha256: hash(markdown) },
      actor,
    );
    const storage = createSqliteAsyncStorage(h.storage);
    const unavailable = async (): Promise<never> => {
      throw new Error("This journey must not execute code or external tools.");
    };
    const capability = new CapabilitySystemService({
      rootDir: h.root,
      storage,
      runtimeConfig: {
        candidateRoot: "candidates",
        codeModeArtifactRoot: "code",
        tempRoot: "temp",
        codeModeSandbox: { mode: "best_effort_host", required: true, bestEffortHostEnabled: false },
      },
      listLoadedSkills: () => [],
      listToolCatalog: () => [],
      readSkillStates: async () => new Map(),
      readFeatureFlags: async () => ({ codeModeV1Enabled: false }),
      invokeTool: unavailable,
      createApproval: unavailable,
      resolveApproval: unavailable,
      publishRealtime: async () => {},
      readPolicySnapshot: async () => ({}),
    });
    expect(await capability.listCatalog("callable", "ALL", "default")).toEqual([]);
    const pending = await capability.promoteCandidate(captured.candidateId, captured.revision, captured.versionId);
    if (!pending.pendingApproval) throw new Error("Expected canonical lifecycle approval");
    expect(await capability.listCatalog("callable", "ALL", "default")).toEqual([]);
    h.storage.approvals.resolve(pending.pendingApproval.approvalId, { decision: "approve", resolvedBy: actor.actorId });
    const activated = await capability.executeApprovedCapabilityLifecycleMutation({
      approvalId: pending.pendingApproval.approvalId,
    });
    const [skill] = await capability.listSkills("ALL", "default");
    expect(skill?.callable).toBe(true);
    expect(await capability.listCatalog("callable", "ALL", "another-workspace")).toEqual([]);
    expect(await capability.listCatalog("callable")).toEqual([]);
    const trusted = {
      capabilityId: `skill:${skill!.skillId}`,
      skillId: skill!.skillId,
      category: "self_generated" as const,
      lifecycleState: "approved" as const,
      treeSha256: skill!.lifecycle!.provenance!.contentIntegrity!.treeSha256,
    };
    const lifecycleRows = h.storage.skillLifecycle.list();
    const receipts = buildGovernedActivatedSkillReceipts({
      content: "Use the approved review-workflow skill",
      trustedSkills: [trusted],
      lifecycleRows,
      decision: resolveCallableSkillActivation({
        request: { text: "Use the approved review-workflow skill" },
        loadedSkills: [skill!],
        inspectableCatalog: await capability.listCatalog("inspectable", "ALL", "default"),
        callableCatalog: await capability.listCatalog("callable", "ALL", "default"),
      }),
    });
    expect(receipts).toEqual([expect.objectContaining({ skillId: skill!.skillId, reasons: ["keyword"] })]);
    const profile = {
      selection: { trustedSkills: [trusted], activatedSkills: receipts },
    } as ChatTurnCapabilityProfileRecord;
    expect(renderGovernedActivatedSkillInstructions({ profile, loadedSkills: [skill!], lifecycleRows })).toContain(
      "Check the supplied work item",
    );
    const revoke = await capability.revokeCandidate(captured.candidateId, activated.revision, captured.versionId);
    if (!revoke.pendingApproval) throw new Error("Expected revoke approval");
    h.storage.approvals.resolve(revoke.pendingApproval.approvalId, { decision: "approve", resolvedBy: actor.actorId });
    await capability.executeApprovedCapabilityLifecycleMutation({ approvalId: revoke.pendingApproval.approvalId });
    const after = await capability.listSkills("ALL", "default");
    expect(after).toEqual([]);
    expect(() => renderGovernedActivatedSkillInstructions({ profile, loadedSkills: after, lifecycleRows })).toThrow(
      "no longer loaded",
    );
  });
  it("stages a real immutable candidate and proposal, replays safely, and never activates or writes memory", async () => {
    const h = await harness();
    const prepared = await h.service.prepare("session", { sourceTurnId: "source" }, actor);
    h.seed("draft", prepared.prompt, markdown);
    const request = { draftTurnId: "draft", reviewedContentSha256: hash(markdown) };
    const first = await h.service.stage("session", request, actor);
    expect(first).toMatchObject({ activationPerformed: false, behavioralValidation: "not_run", revision: 1 });
    expect(await h.service.stage("session", request, actor)).toEqual(first);
    const candidate = h.storage.candidateSkillVersions.get(first.versionId);
    expect(candidate).toMatchObject({
      lifecycleState: "candidate",
      sourceKind: "workflow_capture",
      workspaceId: "default",
    });
    expect(await fs.readFile(path.join(h.root, candidate.instructionArtifact.relPath), "utf8")).toBe(markdown);
    expect(h.storage.capabilityProposals.get(first.proposalId).status).toBe("proposed");
    expect(h.storage.learnedMemory.listItemsBySession("session", 20)).toEqual([]);
  });
  it("rejects changed review bytes, foreign sessions and unauthenticated callers", async () => {
    const h = await harness();
    await expect(h.service.prepare("foreign", { sourceTurnId: "source" }, actor)).rejects.toThrow();
    await expect(h.service.prepare("session", { sourceTurnId: "source" }, {})).rejects.toThrow(
      "authenticated operator",
    );
    h.seed("draft", (await h.service.prepare("session", { sourceTurnId: "source" }, actor)).prompt, markdown);
    await expect(
      h.service.stage("session", { draftTurnId: "draft", reviewedContentSha256: hash("changed") }, actor),
    ).rejects.toThrow("draft changed");
    expect(h.storage.candidateSkillVersions.list()).toEqual([]);
  });
  it("replays a revision after its fence advances and rejects a competing stale draft", async () => {
    const h = await harness();
    h.seed("first", (await h.service.prepare("session", { sourceTurnId: "source" }, actor)).prompt, markdown);
    const original = await h.service.stage(
      "session",
      { draftTurnId: "first", reviewedContentSha256: hash(markdown) },
      actor,
    );
    const prepared = await h.service.prepare(
      "session",
      { sourceTurnId: "source", targetCandidateId: original.candidateId, expectedRevision: original.revision },
      actor,
    );
    h.seed("revision", prepared.prompt, markdown);
    h.seed("competitor", prepared.prompt, markdown);
    const request = { draftTurnId: "revision", reviewedContentSha256: hash(markdown) };
    const revised = await h.service.stage("session", request, actor);
    expect(revised.revision).toBe(2);
    expect(await h.service.stage("session", request, actor)).toEqual(revised);
    await expect(
      h.service.stage("session", { draftTurnId: "competitor", reviewedContentSha256: hash(markdown) }, actor),
    ).rejects.toThrow("revision changed");
  });
  it("rejects incomplete instructions and tampered artifacts", async () => {
    const h = await harness();
    const prepared = await h.service.prepare("session", { sourceTurnId: "source" }, actor);
    h.seed("incomplete", prepared.prompt, "Not a reusable skill.");
    await expect(
      h.service.stage(
        "session",
        { draftTurnId: "incomplete", reviewedContentSha256: hash("Not a reusable skill.") },
        actor,
      ),
    ).rejects.toThrow("needs revision");
    h.seed("draft", prepared.prompt, markdown);
    const request = { draftTurnId: "draft", reviewedContentSha256: hash(markdown) };
    const result = await h.service.stage("session", request, actor);
    const candidate = h.storage.candidateSkillVersions.get(result.versionId);
    await fs.writeFile(path.join(h.root, candidate.instructionArtifact.relPath), "tampered");
    await expect(h.service.stage("session", request, actor)).rejects.toThrow("immutable bytes");
  });
});
