import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString, redactStructuredSecrets, WORKFLOW_SKILL_CAPTURE_MARKER, type ChatThreadResponse, type RoutingPreflightResult,
  type DurableChatTurnExecutionPayloadAuthority, type WorkflowSkillCaptureResult,
  type CandidateSkillDetailRecord, type ChangePlanRecord,
} from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";
import { WorkflowSkillCaptureService } from "./services/workflow-skill-capture-service.js";

const TOKEN = "workflow-capture-test-operator-1234567890";
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const markdown = [
  "---", "name: inspect-work-item", "description: Inspect a work item using reproducible checks.", "---",
  "# Inspect a work item",
  ...["When to use", "Inputs", "Instructions", "Failure handling", "Output", "Verification", "Boundaries"]
    .flatMap(heading => [`\n## ${heading}\n`, "Check the supplied work item and report the observed result."]),
].join("\n");
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("workflow capture through current authenticated public Chat", { timeout: 180_000 }, () => {
  it.each(["token", "basic", "loopback"] as const)("binds %s author through profile-free native streaming and rejects altered evidence", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-capture-author-"));
    const provider = await startFakeOpenAiCompatibleServer(request => {
      if (request.path === "/v1/models") return { body: { data: [{ id: "fake-chat", object: "model" }] } };
      if (request.path !== "/v1/chat/completions") return { status: 404 };
      const body = request.body as { messages?: { content?: unknown }[]; stream?: boolean };
      const content = JSON.stringify(body.messages).includes(WORKFLOW_SKILL_CAPTURE_MARKER)
        ? markdown : "Read the supplied work item, check the result, and report discrepancies.";
      if (!body.stream) return { body: { model: "fake-chat", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] } };
      return { sseFrames: [JSON.stringify({ model: "fake-chat", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] }), "[DONE]"] };
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let storage: Storage | undefined;
    try {
      const configDir = path.join(root, "config");
      await fs.mkdir(configDir);
      // Explicit checked-in examples only; never copy an operator's config directory.
      const repoConfig = fileURLToPath(new URL("../../../config/", import.meta.url));
      for (const name of ["assistant.config.example.json", "tool-policy.example.json", "budgets.example.json", "cron-jobs.example.json"]) {
        await fs.copyFile(path.join(repoConfig, name), path.join(configDir, name));
      }
      const config = JSON.parse(await fs.readFile(path.join(repoConfig, "goatcitadel.example.json"), "utf8"));
      config.llm = { activeProviderId: "fake-openai", activeModel: "fake-chat", providers: [{
        providerId: "fake-openai", label: "Capture test", baseUrl: provider.baseUrl,
        apiStyle: "openai-chat-completions", defaultModel: "fake-chat",
      }] };
      config.assistant.approvalExplainer.enabled = false;
      await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
      await fs.writeFile(path.join(configDir, "llm-model-metadata.json"), JSON.stringify({ version: 1, entries: {
        "fake-openai/fake-chat": { contextWindow: 128_000, outputTokenLimit: 16_000 },
      } }));
      for (const [key, value] of Object.entries({
        GATEWAY_HOST: "127.0.0.1", NODE_ENV: "test", GOATCITADEL_ROOT_DIR: root,
        GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173", GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
        GOATCITADEL_AUTH_MODE: mode === "loopback" ? "token" : mode,
        GOATCITADEL_AUTH_TOKEN: TOKEN, GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: String(mode === "loopback"),
        GOATCITADEL_AUTH_BASIC_USERNAME: "capture-test", GOATCITADEL_AUTH_BASIC_PASSWORD: "test-only-passphrase",
        GOATCITADEL_DATABASE_DRIVER: "sqlite", GOATCITADEL_RATE_LIMIT_ENABLED: "false",
        GOATCITADEL_FEATURE_EVOLUTION_CONTROL_PLANE_V1_ENABLED: "true",
      })) vi.stubEnv(key, value);
      const authorization = mode === "basic" ? `Basic ${Buffer.from("capture-test:test-only-passphrase").toString("base64")}` : `Bearer ${TOKEN}`;
      let sequence = 0;
      const headers = () => ({ authorization, "idempotency-key": `capture-${mode}-${++sequence}` });
      app = await buildApp();
      const workspace = await app.inject({ method: "POST", url: "/api/v1/workspaces", headers: headers(), payload: { name: "Capture workspace" } });
      expect(workspace.statusCode, workspace.body).toBe(201);
      const workspaceId = workspace.json().workspaceId as string;
      expect(workspaceId).not.toBe("default");
      const created = await app.inject({ method: "POST", url: "/api/v1/chat/sessions", headers: headers(), payload: { title: "Capture test", workspaceId } });
      expect(created.statusCode, created.body).toBe(201);
      const sessionId = created.json().sessionId as string;
      const url = `/api/v1/chat/sessions/${sessionId}`;
      const send = async (content: string) => {
        const preflight = await app!.inject({ method: "POST", url: `${url}/route-preflight`, headers: headers(), payload: { action: "send", content, subagentPolicy: "off" } });
        expect(preflight.statusCode, preflight.body).toBe(200);
        const { decision, blockedReason } = preflight.json() as RoutingPreflightResult;
        expect(blockedReason).toBeUndefined();
        const response = await app!.inject({ method: "POST", url: `${url}/agent-send/stream`, headers: headers(), payload: {
          content, subagentPolicy: "off", providerId: decision.effectiveProviderId, model: decision.effectiveModel, routeDecision: decision,
        } });
        expect(response.statusCode, response.body.slice(0, 2000)).toBe(200);
        const threadResponse = await app!.inject({ method: "GET", url: `${url}/thread`, headers: headers() });
        expect(threadResponse.statusCode).toBe(200);
        const thread = threadResponse.json() as ChatThreadResponse;
        const turn = thread.turns.at(-1)!;
        expect(turn.trace.status).toBe("completed");
        expect(turn.trace.capabilityProfileId).toBeUndefined();
        expect(turn.trace.durable?.runId).toBeTruthy();
        return turn.trace;
      };
      const source = await send("Inspect the supplied work item.");
      const prepare = await app.inject({ method: "POST", url: `${url}/skill-captures/prepare`, headers: headers(), payload: { sourceTurnId: source.turnId } });
      expect(prepare.statusCode, prepare.body).toBe(200);
      const prompt = prepare.json().prompt as string;
      const draft = await send(prompt);
      const stageRequest = { draftTurnId: draft.turnId, reviewedContentSha256: sha256Hex(markdown) };
      const stage = await app.inject({ method: "POST", url: `${url}/skill-captures/stage`, headers: headers(), payload: stageRequest });
      expect(stage.statusCode, stage.body).toBe(200);
      const result = stage.json() as WorkflowSkillCaptureResult;
      expect(result.activationPerformed).toBe(false);
      const forged = await app.inject({ method: "POST", url: `${url}/skill-captures/stage`, headers: headers(), payload: { ...stageRequest, actorId: "forged", authActorSource: mode } });
      expect(forged.statusCode).toBe(400);
      const configRead = app.gatewayConfig;
      await app.close(); app = undefined;
      storage = new Storage({ dbPath: configRead.dbPath, transcriptsDir: path.join(root, "transcripts-read"), auditDir: path.join(root, "audit-read") });
      const asyncStorage = createSqliteAsyncStorage(storage);
      const service = new WorkflowSkillCaptureService({ storage: asyncStorage, rootDir: root, candidateRoot: configRead.assistant.capabilities.candidateRoot });
      const originalRun = storage.durableRuns.getRun(draft.durable!.runId);
      const payload = originalRun.payload as unknown as DurableChatTurnExecutionPayloadAuthority;
      expect(payload.requestActor.authActorSource).toBe(mode);
      expect(payload.requestActor.actorId).toBe(payload.requestActor.authActorId);
      expect(storage.chatMessages.get(draft.userMessageId)?.actorId).toBe("operator");
      expect(storage.candidateSkillVersions.find(result.versionId)?.createdByActorId).toBe(payload.requestActor.authActorId);
      expect(storage.candidateSkillVersions.find(result.versionId)?.lifecycleState).toBe("candidate");
      const actor = { actorId: payload.requestActor.authActorId!, authActorSource: mode };
      expect(await service.stage(sessionId, stageRequest, actor)).toEqual(result);
      await expect(service.stage(sessionId, stageRequest, { ...actor, actorId: "foreign-operator" })).rejects.toThrow("another operator");
      await expect(service.stage("foreign-session", stageRequest, actor)).rejects.toThrow();
      await expect(service.stage(sessionId, { ...stageRequest, reviewedContentSha256: sha256Hex("changed") }, actor)).rejects.toThrow("skill draft changed");
      const readRun = storage.durableRuns.getRun.bind(storage.durableRuns);
      for (const patch of [{ runId: "foreign" }, { workflowKey: "foreign" }, { status: "running" as const }]) {
        const spy = vi.spyOn(storage.durableRuns, "getRun").mockImplementation(id => id === originalRun.runId ? { ...originalRun, ...patch } : readRun(id));
        await expect(service.stage(sessionId, stageRequest, actor)).rejects.toThrow("author binding");
        spy.mockRestore();
      }
      for (const patch of [
        { turnId: "foreign" }, { sessionId: "foreign" }, { workspaceId: "foreign" },
        { userMessageId: "foreign" }, { assistantMessageId: "foreign" }, { admissionId: "missing" },
        { admissionMaterialSha256: "f".repeat(64) }, { effectiveRequestMaterialSha256: "f".repeat(64) },
        { request: { ...payload.request, content: "changed" } },
        { requestActor: { ...payload.requestActor, actorId: "foreign", authActorId: "foreign" } },
        { requestActor: { ...payload.requestActor, actorId: "operator", authActorId: undefined } },
        { requestActor: { ...payload.requestActor, authActorSource: "none" } },
        { requestActor: { ...payload.requestActor, operatorId: "foreign" } },
        { version: "chat.turn.execute.v1" },
      ]) {
        const spy = vi.spyOn(storage.durableRuns, "getRun").mockImplementation(id => id === originalRun.runId ? { ...originalRun, payload: { ...originalRun.payload, ...patch } } : readRun(id));
        await expect(service.stage(sessionId, stageRequest, actor)).rejects.toThrow("author binding");
        spy.mockRestore();
      }
      const admission = storage.sessionMutationAdmissions.get(payload.admissionId)!;
      for (const altered of [
        undefined, { ...admission, admissionId: "foreign" }, { ...admission, actorId: "foreign" },
        { ...admission, workspaceId: "foreign" }, { ...admission, sessionId: "foreign" },
        { ...admission, turnId: "foreign" }, { ...admission, sessionIncarnationId: "foreign" },
        { ...admission, aggregateRevision: admission.aggregateRevision + 1 },
        { ...admission, controllerGeneration: admission.controllerGeneration + 1 },
        { ...admission, terminalDurableRunId: "foreign" }, { ...admission, materialSha256: "f".repeat(64) },
      ]) {
        const spy = vi.spyOn(storage.sessionMutationAdmissions, "get").mockImplementation(id => id === payload.admissionId ? altered : admission);
        await expect(service.stage(sessionId, stageRequest, actor)).rejects.toThrow("author binding");
        spy.mockRestore();
      }
      const bindingSpy = vi.spyOn(storage.sessionMutationAdmissions, "findDurableRunBinding").mockReturnValue(undefined);
      await expect(service.stage(sessionId, stageRequest, actor)).rejects.toThrow("author binding");
      bindingSpy.mockRestore();
      const readTrace = storage.chatTurnTraces.get.bind(storage.chatTurnTraces);
      const missing = vi.spyOn(storage.chatTurnTraces, "get").mockImplementation(id => ({ ...readTrace(id), durable: undefined }));
      await expect(service.stage(sessionId, stageRequest, actor)).rejects.toThrow("authenticated author is unavailable");
      missing.mockRestore();
      const readMessage = storage.chatMessages.get.bind(storage.chatMessages);
      const stale = vi.spyOn(storage.chatMessages, "get").mockImplementation(id => {
        const record = readMessage(id);
        return id === source.assistantMessageId && record ? { ...record, content: "Changed source evidence" } : record;
      });
      await expect(service.stage(sessionId, stageRequest, actor)).rejects.toThrow("source workflow changed");
      stale.mockRestore();
      expect(storage.capabilityProposals.list(100)).toHaveLength(1);
      expect(canonicalJsonString(storage.durableRuns.getRun(originalRun.runId))).toBe(canonicalJsonString(originalRun));
      expect(storage.sessionMutationAdmissions.get(payload.admissionId)).toEqual(admission);
      const immutableVersion = storage.candidateSkillVersions.get(result.versionId);
      expect(immutableVersion).toMatchObject({ workspaceId, sourceKind: "workflow_capture", lifecycleState: "candidate" });
      expect(immutableVersion.originatingRunId).toBeUndefined();
      storage.close(); storage = undefined;
      app = await buildApp();
      const { approvals, planIds } = await proveCapturedLifecycle(app, headers, result, workspaceId);
      await app.close(); app = undefined;
      storage = new Storage({ dbPath: configRead.dbPath, transcriptsDir: path.join(root, "transcripts-read"), auditDir: path.join(root, "audit-read") });
      const finalVersion = storage.candidateSkillVersions.get(result.versionId);
      expect(finalVersion).toEqual({ ...immutableVersion, lifecycleState: "revoked", updatedAt: finalVersion.updatedAt });
      for (const artifact of [finalVersion.manifestArtifact, finalVersion.instructionArtifact, finalVersion.proofArtifact]) {
        expect(createHash("sha256").update(await fs.readFile(path.resolve(root, artifact.relPath))).digest("hex")).toBe(artifact.sha256);
      }
      expect(storage.codeModeRuns.list(100)).toEqual([]);
      // Public projections redact token-derived IDs; exact author truth stays in canonical storage.
      for (const planId of planIds) expect(storage.changePlans.get(planId)).toMatchObject({ status: "completed", origin: { workspaceId, actorId: actor.actorId } });
      for (const [approvalId, action] of approvals) {
        const approval = storage.approvals.get(approvalId);
        expect(approval).toMatchObject({ kind: "capability.lifecycle", riskLevel: "danger", status: "approved", resolvedBy: actor.actorId });
        const binding = (approval.payload as { capabilityLifecycle: { requestSha256: string } }).capabilityLifecycle;
        const effects = storage.approvalEffects.listByApproval(approvalId).filter(effect => effect.effectKind === "capability_lifecycle_apply");
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ status: "completed", targetId: result.candidateId,
          payload: { action, candidateId: result.candidateId, requestSha256: binding.requestSha256 } });
      }
      expect(storage.approvals.list().filter(approval => approval.kind === "capability.lifecycle")).toHaveLength(2);
    } finally {
      storage?.close();
      await app?.close();
      await provider.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// Mirrors mission-control-next candidate-approval-continuation.ts requireCandidateApproval.
function clientDerivedLifecycleBinding(plan: ChangePlanRecord, reviewed: CandidateSkillDetailRecord, action: "promote" | "revoke") {
  const sha = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
  const request = plan.request as { versionId?: string };
  const versionId = request.versionId ?? reviewed.latestVersion?.versionId;
  const version = reviewed.versions.find(item => item.versionId === versionId)!;
  const expectedAction = action === "promote" ? "candidate_promoted" : "candidate_revoked";
  const mutation = action === "promote"
    ? { candidateId: reviewed.candidateId, versionId }
    : { candidateId: reviewed.candidateId, selectedVersionId: versionId, targetVersionIds: version.lifecycleState === "revoked" ? [] : [versionId] };
  const versions = [...reviewed.versions].sort((a, b) => a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0)
    .map(item => ({ versionId: item.versionId, lifecycleState: item.lifecycleState, updatedAt: item.updatedAt }));
  return {
    requestSha256: sha({ schemaVersion: "goatcitadel.capability-lifecycle-request.v1", subjectKind: "capability_candidate", subjectId: reviewed.candidateId, action: expectedAction, mutation }),
    expectedStateSha256: sha({ schemaVersion: "goatcitadel.capability-lifecycle-state.v1", state: { candidateId: reviewed.candidateId, revision: reviewed.revision, versionCount: versions.length, versionsSha256: sha(versions) } }),
    // The client compares the plan origin under the same shared public redaction.
    requesterId: redactStructuredSecrets({ approval: { payload: { request: { requesterId: plan.origin.actorId } } } }, { redactEnvAssignmentsAsWhole: true }).value.approval.payload.request.requesterId,
    mutation,
  };
}

function publicLifecycleBinding(replay: { approval: { payload?: Record<string, unknown> } }) {
  const payload = replay.approval.payload ?? {};
  const binding = (payload.capabilityLifecycle ?? {}) as Record<string, unknown>;
  const envelope = (payload.request ?? {}) as Record<string, unknown>;
  return { requestSha256: binding.requestSha256, expectedStateSha256: binding.expectedStateSha256, requesterId: envelope.requesterId, mutation: envelope.mutation };
}

async function proveCapturedLifecycle(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: () => Record<string, string>,
  captured: WorkflowSkillCaptureResult,
  workspaceId: string,
) {
  const candidateUrl = `/api/v1/capabilities/candidates/${captured.candidateId}`;
  const readDetail = async () => {
    const response = await app.inject({ method: "GET", url: candidateUrl, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as CandidateSkillDetailRecord;
  };
  const initial = await readDetail();
  expect(initial.activationBlocked).toBe(true);
  expect(initial.originatingRun).toBeUndefined();
  const assertNotCallable = async () => {
    const response = await app.inject({ method: "GET", url: `/api/v1/capabilities/catalog?scope=callable&workspaceId=${workspaceId}`, headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items.filter((entry: { candidateId?: string }) => entry.candidateId === captured.candidateId)).toEqual([]);
  };
  await assertNotCallable();
  const review = await app.inject({ method: "GET", url: `${candidateUrl}/versions/${captured.versionId}/review?workspaceId=${workspaceId}`, headers: headers() });
  expect(review.statusCode, review.body).toBe(200);
  const foreignReview = await app.inject({ method: "GET", url: `${candidateUrl}/versions/${captured.versionId}/review?workspaceId=default`, headers: headers() });
  expect(foreignReview.statusCode).toBe(409);
  const approvals: Array<readonly [string, string]> = [];
  const planIds: string[] = [];
  for (const action of ["promote", "rollback", "revoke"] as const) {
    const detail = await readDetail();
    const selection = action === "rollback" ? { targetVersionId: captured.versionId } : { versionId: captured.versionId };
    const requested = await app.inject({ method: "POST", url: `${candidateUrl}/${action}`, headers: headers(), payload: { expectedRevision: detail.revision, ...selection } });
    expect(requested.statusCode, requested.body).toBe(202);
    const planId = (requested.json().changePlan as ChangePlanRecord).planId;
    const planUrl = `/api/v1/change-plans/${planId}`;
    // Match the native inspector: load the current scoped action from its owner.
    const currentPlan = await app.inject({ method: "GET", url: `${planUrl}?workspaceId=${workspaceId}`, headers: headers() });
    expect(currentPlan.statusCode, currentPlan.body).toBe(200);
    const plan = currentPlan.json() as ChangePlanRecord;
    planIds.push(plan.planId);
    expect(plan).toMatchObject({ status: "awaiting_input", risk: "danger", origin: { workspaceId },
      request: { kind: "capability_candidate", proposalId: captured.proposalId, versionId: captured.versionId },
      target: { resourceId: captured.candidateId, expectedRevision: detail.revision,
        expectedHash: detail.latestVersion!.wrapperManifestHash ?? detail.latestVersion!.manifestArtifact.sha256 },
      requiredAction: { kind: "artifact_review" } });
    expect((await readDetail()).revision).toBe(detail.revision);
    const foreign = await app.inject({ method: "GET", url: `${planUrl}?workspaceId=default`, headers: headers() });
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
    const reviewBody = { workspaceId, expectedRevision: plan.revision, actionId: plan.requiredAction!.actionId,
      actionNonce: plan.requiredAction!.actionNonce, values: {} };
    const stale = await app.inject({ method: "POST", url: `${planUrl}/responses`, headers: headers(), payload: { ...reviewBody, actionNonce: "foreign-review-nonce-123456" } });
    expect(stale.statusCode).toBe(409);
    const reviewed = await app.inject({ method: "POST", url: `${planUrl}/responses`, headers: headers(), payload: reviewBody });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const confirmation = reviewed.json() as ChangePlanRecord;
    expect(confirmation.status).toBe("awaiting_confirmation");
    const confirmed = await app.inject({ method: "POST", url: `${planUrl}/confirmations`, headers: headers(), payload: {
      workspaceId, expectedRevision: confirmation.revision, actionNonce: confirmation.requiredAction!.actionNonce,
    } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const waiting = confirmed.json() as ChangePlanRecord;
    if (action === "rollback") {
      // One already-active version is the canonical owner's no-op, not a new approval/effect.
      expect(waiting.status, JSON.stringify(waiting.result)).toBe("completed");
      expect(waiting.approvalRefs).toEqual([]);
      expect((await readDetail()).revision).toBe(detail.revision);
      continue;
    }
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.approvalRefs).toHaveLength(1);
    if (action === "promote") await assertNotCallable();
    expect((await readDetail()).latestVersion!.lifecycleState).toBe(action === "promote" ? "candidate" : "approved");
    const approvalId = waiting.approvalRefs[0]!;
    // The native Inbox and Library approval bar read the canonical approval in the
    // plan's origin workspace: it must be readable there and nowhere else.
    const scopedApproval = await app.inject({ method: "GET", url: `/api/v1/approvals/${approvalId}?workspaceId=${workspaceId}`, headers: headers() });
    expect(scopedApproval.statusCode, scopedApproval.body).toBe(200);
    expect(scopedApproval.json()).toMatchObject({ approvalId, kind: "capability.lifecycle", status: "pending" });
    const foreignApproval = await app.inject({ method: "GET", url: `/api/v1/approvals/${approvalId}?workspaceId=default`, headers: headers() });
    expect(foreignApproval.statusCode).toBe(404);
    // Native continuation re-derives this binding from the public candidate detail the
    // operator reviewed and the public approval replay; both must reproduce it exactly.
    const replay = await app.inject({ method: "GET", url: `/api/v1/approvals/${approvalId}/replay`, headers: headers() });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(clientDerivedLifecycleBinding(plan, detail, action)).toEqual(publicLifecycleBinding(replay.json()));
    expect(replay.json().approval.linkage?.workspaceId).toBe(workspaceId);
    const approved = await app.inject({ method: "POST", url: `/api/v1/approvals/${approvalId}/resolve`, headers: headers(), payload: { decision: "approve" } });
    expect(approved.statusCode, approved.body).toBe(200);
    await vi.waitFor(async () => {
      expect((await readDetail()).latestVersion!.lifecycleState).toBe(action === "promote" ? "approved" : "revoked");
    }, { timeout: 20_000, interval: 100 });
    // This owner resumes through the current approval action after observing its effect.
    const resumed = await app.inject({ method: "POST", url: `${planUrl}/responses`, headers: headers(), payload: {
      workspaceId, expectedRevision: waiting.revision, actionId: waiting.requiredAction!.actionId,
      actionNonce: waiting.requiredAction!.actionNonce, values: {},
    } });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().status).toBe("completed");
    const applied = await readDetail();
    expect(applied.revision).toBe(detail.revision + 1);
    expect(applied.latestVersion!.lifecycleState).toBe(action === "promote" ? "approved" : "revoked");
    expect(applied.activationBlocked).toBe(action === "revoke");
    if (action === "revoke") await assertNotCallable();
    // Approved instruction reuse is the projected runtime skill, not the candidate entry.
    const runtimeSkillId = `extra:reviewed-${createHash("sha256").update(captured.candidateId).digest("hex").slice(0, 12)}`;
    const callableIn = async (scope: string) => {
      const response = await app.inject({ method: "GET", url: `/api/v1/capabilities/catalog?scope=callable&workspaceId=${scope}`, headers: headers() });
      expect(response.statusCode, response.body).toBe(200);
      return (response.json().items as Array<{ skillId?: string; callable?: boolean }>).filter(entry => entry.skillId === runtimeSkillId);
    };
    if (action === "promote") {
      const inspectable = await app.inject({ method: "GET", url: `/api/v1/capabilities/catalog?scope=inspectable&workspaceId=${workspaceId}`, headers: headers() });
      const projected = (inspectable.json().items as Array<Record<string, unknown>>).filter(entry => entry.skillId === runtimeSkillId || entry.candidateId === captured.candidateId)
        .map(entry => ({ kind: entry.kind, callable: entry.callable, lifecycleState: entry.lifecycleState, reviewWarning: entry.reviewWarning }));
      expect({ projected, callable: await callableIn(workspaceId) }).toMatchObject({ callable: [{ skillId: runtimeSkillId, callable: true }] });
    }
    expect(await callableIn("default")).toEqual([]);
    if (action === "revoke") expect(await callableIn(workspaceId)).toEqual([]);
    approvals.push([approvalId, action === "promote" ? "candidate_promoted" : "candidate_revoked"]);
  }
  return { approvals, planIds };
}
