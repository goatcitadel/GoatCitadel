import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { ChatThreadResponse, DurableRunRecord } from "@goatcitadel/contracts";
import { redactSecretText } from "@goatcitadel/contracts";
import {
  ensureGatewayWorkspaceBuild, prepareVerificationRuntime, requestJson, resolveAvailablePort,
  startVerificationStack, stopProcess, stopVerificationStack,
} from "../../../../scripts/verification/lib/runtime.mjs";
import {
  DETERMINISTIC_LLM_KEY_ENV, startDeterministicLlmStub, writeDeterministicLlmProviderConfig,
} from "../../../../scripts/verification/lib/scenarios/deterministic-llm-stub.mjs";
import { runWorkerProcess, seedBootstrap, tlsConfig } from "../../test/fixtures/remote-worker-native.js";
import { startWorkerRequesterMcpProbe } from "../../test/fixtures/remote-worker-requester-probe.js";
import { prepareWorkerMeshChatProbe } from "../../test/fixtures/remote-worker-mesh-chat-probe.js";
import { REMOTE_WORKER_RUNTIME_ENV as workerEnv } from "./remote-worker-runtime-config.js";
import { resolveModelPricingLineage } from "./llm-pricing.js";
import { hasAutonomousChatPostCommitPending, hasGeneralChatPostCommitPending } from "./chat-durable-run-service.js";

const reply = "Recovered worker Gateway restart.";
const providerId = "openai";
const model = "gpt-5.4";
interface RestartCase {
  restartAfter: "inference" | "approval";
  genericChat: boolean;
  mcpCase: false | "requester" | "static";
  meshCase?: boolean | "write" | "mcp" | "mcp_bearer";
}

async function eventually<T>(label: string, read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(200);
  }
}

async function requestApi(gatewayUrl: string, route: string, body?: object, method = "POST", headers: Record<string, string> = {}) {
  const response = await requestJson(gatewayUrl, route, { ...(body ? { method, body } : {}), headers });
  expect(response.ok, `${route}: ${JSON.stringify(response.body)}`).toBe(true);
  return response.body;
}

/** Real built Gateway and native worker processes, isolated SQLite and loopback
 * provider. The synthetic signer/TLS fixture is not installed-service custody
 * or proof of a second physical host. */
describe.skipIf(process.platform !== "win32")("native worker across a full Gateway restart", () => {
  it.each<RestartCase>([
    { restartAfter: "inference", genericChat: false, mcpCase: false }, { restartAfter: "approval", genericChat: false, mcpCase: false },
    { restartAfter: "inference", genericChat: true, mcpCase: false }, { restartAfter: "approval", genericChat: true, mcpCase: false },
    { restartAfter: "inference", genericChat: true, mcpCase: "requester" }, { restartAfter: "approval", genericChat: true, mcpCase: "requester" },
    { restartAfter: "inference", genericChat: true, mcpCase: "static" }, { restartAfter: "approval", genericChat: true, mcpCase: "static" },
    { restartAfter: "approval", genericChat: true, mcpCase: false, meshCase: true },
    { restartAfter: "approval", genericChat: true, mcpCase: false, meshCase: "write" },
    { restartAfter: "approval", genericChat: true, mcpCase: false, meshCase: "mcp" },
    { restartAfter: "approval", genericChat: true, mcpCase: false, meshCase: "mcp_bearer" },
  ])("recovers Chat after $restartAfter with generic admission=$genericChat MCP=$mcpCase mesh=$meshCase without repeating work", async ({ restartAfter, genericChat, mcpCase, meshCase = false }) => {
    const destinationMcp = meshCase === "mcp" || meshCase === "mcp_bearer";
    const approvalCase = restartAfter === "approval";
    const toolCase = approvalCase || mcpCase;
    let canonicalToolName = mcpCase ? "mcp.worker-mcp.read" : "fs.read";
    const authToken = mcpCase || meshCase ? randomBytes(32).toString("hex") : undefined;
    const actorId = authToken ? `token:${createHash("sha256").update(authToken).digest("hex").slice(0, 16)}` : "auth:none";
    const requestHeaders: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const api = (url: string, route: string, body?: object, method?: string) => requestApi(url, route, body, method, requestHeaders);
    // The real spending owner requires pinned pricing even for a loopback provider.
    expect(resolveModelPricingLineage(providerId, model)).toBeDefined();
    const runId = `worker-gateway-restart-${randomUUID()}`;
    const context = { runId, artifactRoot: fileURLToPath(new URL(`../../../../.tmp/${runId}/`, import.meta.url)) };
    await mkdir(context.artifactRoot, { recursive: true });
    const runtimeRoot = await prepareVerificationRuntime(runId);
    const fixtureRoot = join(runtimeRoot, "native-worker-fixture");
    await mkdir(fixtureRoot);
    const notePath = join(runtimeRoot, "workspace", "worker-approval-note.txt");
    if (approvalCase) {
      await mkdir(join(runtimeRoot, "workspace"), { recursive: true });
      await writeFile(notePath, "Approved worker read: Orion 7.");
    }
    const stub = await startDeterministicLlmStub({ providerId, model, replyText: reply });
    const mcpProbe = mcpCase ? await startWorkerRequesterMcpProbe(mcpCase === "static" ? "static" : "requester_scoped") : undefined;
    let meshProbe: Awaited<ReturnType<typeof prepareWorkerMeshChatProbe>> | undefined;
    let stack: Awaited<ReturnType<typeof startVerificationStack>> | undefined;
    let storage: Storage | undefined;
    const streamController = new AbortController();
    let streamOutcome: unknown;
    let stage = "setup";
    try {
      await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl, { providerId, model, apiStyle: "openai-responses" });
      const configPath = join(runtimeRoot, "config", "goatcitadel.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.assistant.dataDir = "./data";
      config.assistant.durable.enabled = true;
      config.assistant.durable.executionEnabled = true;
      if (approvalCase) config.assistant.toolApprovalMode = "approve_all";
      else if (mcpCase) config.assistant.toolApprovalMode = "bypass";
      if (mcpCase) {
        config.assistant.auth.allowLoopbackBypass = false;
        config.toolPolicy.sandbox.networkAllowlist = [...new Set([...config.toolPolicy.sandbox.networkAllowlist, "127.0.0.1"])];
        // Only this isolated fixture opts into MCP; preserve every unrelated
        // denial from the copied operator configuration.
        config.toolPolicy.tools.deny = config.toolPolicy.tools.deny.filter((name: string) => name !== "mcp.invoke");
        config.toolPolicy.tools.allow = [...new Set([...config.toolPolicy.tools.allow, "mcp.invoke", canonicalToolName])];
      }
      if (meshCase) {
        config.assistant.auth.allowLoopbackBypass = false;
        config.toolPolicy.tools.deny = config.toolPolicy.tools.deny.filter((name: string) => name !== "mesh.invoke");
        config.toolPolicy.tools.allow = [...new Set([...config.toolPolicy.tools.allow, "mesh.invoke", "mesh:*"])];
      }
      delete config.generation;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const gatewayEnvOmit = Object.keys(process.env).filter((key) =>
        /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)(?:$|_)/u.test(key)
        || key.startsWith("GOATCITADEL_REMOTE_WORKER")
        || key.startsWith("GOATCITADEL_POSTGRES_"));
      // Select the native port only after the potentially long first build.
      // A probe does not reserve its port while other test processes are binding.
      stage = "build Gateway";
      await ensureGatewayWorkspaceBuild(context, { omitEnv: gatewayEnvOmit, processLogPrefix: "before" });
      stage = "prepare native listener";
      const tls = await tlsConfig(fixtureRoot);
      const port = await resolveAvailablePort(0);
      const gatewayEnv = {
        [DETERMINISTIC_LLM_KEY_ENV]: "local-verification-only",
        [workerEnv.enabled]: "true",
        [workerEnv.host]: "127.0.0.1",
        [workerEnv.port]: String(port),
        [workerEnv.serverCertificateFile]: tls.paths.cert,
        [workerEnv.serverKeyFile]: tls.paths.key,
        [workerEnv.clientCaFile]: tls.paths.ca,
        [workerEnv.clientCaSha256]: tls.config.tls.clientCaSha256,
        [workerEnv.manifestSignerKeyId]: tls.config.manifestSigner.keyId,
        [workerEnv.manifestSignerPublicKeyFile]: tls.paths.signer,
        [workerEnv.manifestSignerSpkiSha256]: tls.config.manifestSigner.spkiSha256,
        GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED: "true",
        ...(meshCase ? { GOATCITADEL_AUTH_MODE: "token", GOATCITADEL_AUTH_TOKEN: authToken! } : {}),
        ...(mcpProbe ? { GOATCITADEL_VERIFY_MCP_URL: mcpProbe.endpoint, GOATCITADEL_AUTH_MODE: "token", GOATCITADEL_AUTH_TOKEN: authToken!,
          GOATCITADEL_VERIFY_DELAY_ARTIFACT_COMMIT: String(approvalCase),
          GOATCITADEL_VERIFY_DELAY_TERMINAL_SETTLEMENT: String(!approvalCase) } : {}),
      };
      const stackOptions = { runtimeRoot, includeUi: false, gatewayMode: "built", gatewayEnv, gatewayEnvOmit,
        ...(mcpCase === "requester" ? { builtGatewayEntryFile: fileURLToPath(new URL("../../test/fixtures/remote-worker-requester-gateway.mjs", import.meta.url)) } : {}),
      };
      stage = "start Gateway";
      stack = await startVerificationStack(context, { ...stackOptions, processLogPrefix: "before" });
      storage = new Storage({ dbPath: join(runtimeRoot, "data", "index.db"),
        transcriptsDir: join(runtimeRoot, "data", "transcripts"), auditDir: join(runtimeRoot, "data", "audit") });
      const store = storage;
      if (mcpProbe) store.systemSettings.set("mcp_servers_v1", [mcpProbe.record]);
      await eventually("onboarding bootstrap", () => requestJson(stack!.gatewayUrl, "/api/v1/onboarding/state", { headers: requestHeaders }),
        (response) => response.status !== 409);
      await api(stack.gatewayUrl, "/api/v1/onboarding/complete", { completedBy: runId });
      if (mcpCase === "static") {
        const connected = await api(stack.gatewayUrl, "/api/v1/mcp/servers/worker-mcp/connect", {});
        expect(connected.status).toBe("connected");
      }
      const signer = generateKeyPairSync("ed25519");
      const bootstrap = seedBootstrap(store.db, tls,
        signer.publicKey.export({ format: "der", type: "spki" }),
        String(signer.privateKey.export({ format: "pem", type: "pkcs8" })), true, toolCase);
      const ticketFile = join(fixtureRoot, "ticket.json");
      await writeFile(ticketFile, JSON.stringify(bootstrap.ticket));
      const common = { root: fixtureRoot, port, paths: tls.paths, ticketFile,
        stateDir: join(fixtureRoot, "worker-state"), executionMode: "gateway_inference" as const,
        meshRegistry: undefined as { readonly file: string; readonly sha256: string } | undefined,
        stockWorkerEntrypoint: undefined as string | undefined };
      stage = "admit worker";
      const admitted = await runWorkerProcess({ ...common, runId: "admit", stopAfter: "admit" });
      expect(admitted.exitCode, JSON.stringify(admitted.report)).toBe(0);
      const generation = store.remoteWorkerAdmissions.findCurrentGeneration("default", String(bootstrap.ticket.workerId))!;
      const evidence = store.remoteWorkerAdmissions.findProtectedAdmissionEvidenceRecord("default", generation.workerId, generation.workerGeneration)!;
      const meshJoinCredential = randomBytes(32).toString("base64url");
      store.remoteWorkerMeshNodeAdmissions.issueJoinAuthority({
        registryWorkspaceId: "default", bootstrapId: generation.bootstrapId,
        workerId: generation.workerId, workerGeneration: generation.workerGeneration,
        nodeId: generation.nodeId, clientCertificateSha256: generation.clientCertificateSha256,
        protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
        protectedAdmissionContextSha256: evidence.contextSha256, workspaceId: "default",
        expiresInSeconds: 600, issuedByActorId: actorId, idempotencyKey: `${runId}:mesh`,
        rawMeshNodeCredential: meshJoinCredential,
      });
      await writeFile(ticketFile, JSON.stringify({ ...bootstrap.ticket, meshJoinCredential }));
      store.remoteWorkerBudgets.createGrant({ grantId: `${runId}:grant`, registryWorkspaceId: "default",
        executionWorkspaceId: "default", workerId: generation.workerId, workerGeneration: generation.workerGeneration,
        maxRequests: toolCase ? 3 : 2, maxCostMicrousd: 50_000_000,
        expiresAt: new Date(Date.now() + 600_000).toISOString() }, actorId);
      const ready = await runWorkerProcess({ ...common, runId: "ready", stopAfter: "workload" });
      expect(ready.exitCode, JSON.stringify(ready.report)).toBe(0);
      expect(store.mesh.getNode(generation.nodeId).status).toBe("online");
      expect(store.remoteWorkerAdmissions.findWorkerRegistryEntry("default", generation.workerId)).toMatchObject({
        admission: { platform: "windows", transportIdentitySource: "native_mtls" },
      });
      expect(store.remoteWorkerBudgets.listExecutionGrants("default", actorId)[0])
        .toMatchObject({ availableRequests: toolCase ? 3 : 2 });
      if (meshCase) {
        stage = "publish and approve native mesh capability";
        meshProbe = await prepareWorkerMeshChatProbe({ ...common, nodeId: generation.nodeId, write: meshCase === "write",
          mcp: destinationMcp, mcpBearer: meshCase === "mcp_bearer" });
        common.meshRegistry = meshProbe.registry;
        common.stockWorkerEntrypoint = meshProbe.stockWorkerEntrypoint;
        canonicalToolName = meshProbe.capabilityId;
        const activation = await api(stack.gatewayUrl, "/api/v1/mesh/capabilities/activations", meshProbe.activationRequest);
        expect(activation.approval.kind).toBe("mesh.capability.activate");
        await api(stack.gatewayUrl, `/api/v1/approvals/${encodeURIComponent(activation.approval.approvalId)}/resolve`, {
          decision: "approve", resolvedBy: "verification", resolutionNote: "Activate the isolated mesh destination fixture.",
        });
        await eventually("activated mesh capability", () => store.meshCapabilityPublications.listCallableActivations("default"),
          (items) => items.some((item) => item.capabilityId === canonicalToolName));
      }
      const task = genericChat ? undefined
        : store.tasks.create({ workspaceId: "default", title: "Gateway restart worker fixture", createdBy: actorId });
      const session = await api(stack.gatewayUrl, "/api/v1/chat/sessions", { title: "Native Gateway restart fixture" });
      const route = `/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}`;
      const prefs = await api(stack.gatewayUrl, `${route}/prefs`);
      const turnRequest = { action: "send", content: meshCase
        ? `Use ${canonicalToolName} on note.txt with these arguments: ${JSON.stringify(meshProbe!.args)}.` : toolCase
        ? `Use ${canonicalToolName} to read ${mcpCase ? "note.txt" : notePath} and report its contents.` : "Reply with the recovery verification text.",
        ...(task ? { policyTaskId: task.taskId } : {}),
        providerId, model, webMode: "off", memoryMode: "off", thinkingLevel: "off", subagentPolicy: "off",
        prefsOverride: { providerId, model, webMode: "off", memoryMode: "off", thinkingLevel: "off",
          subagentPolicy: "off", toolAutonomy: toolCase ? "safe_auto" : "manual", orchestrationEnabled: false } };
      await api(stack.gatewayUrl, `${route}/prefs`, { ...turnRequest.prefsOverride, expectedRevision: prefs.revision }, "PATCH");
      const preflight = await api(stack.gatewayUrl, `${route}/route-preflight`, turnRequest);
      stage = "Chat admission and worker placement";
      const stream = fetch(`${stack.gatewayUrl}${route}/agent-send/stream`, { method: "POST", signal: streamController.signal,
        headers: { Accept: "text/event-stream", "Content-Type": "application/json", "Idempotency-Key": randomUUID(), ...requestHeaders },
        body: JSON.stringify({ ...turnRequest, routeDecision: preflight.decision }) })
        .then(async (response) => ({ status: response.status, body: await response.text() }))
        .catch((error: Error) => ({ error: error.message }))
        .then((outcome) => { streamOutcome = outcome; });
      const run = await eventually("admitted Chat", () => store.durableRuns.listRuns(100).find(
        (candidate) => candidate.workflowKey === "chat.turn.execute" && candidate.payload.sessionId === session.sessionId),
      (value) => value !== undefined) as DurableRunRecord;
      const assignment = await eventually("worker placement", () => ({
        aggregate: store.remoteWorkerAssignments.findTaskBoundChatAssignment({ executionWorkspaceId: "default",
          sessionId: session.sessionId, turnId: String(run.payload.turnId), durableRunId: run.runId }),
        run: store.durableRuns.getRun(run.runId), streamOutcome,
      }), (value) => value.aggregate !== undefined);
      expect(store.chatExecutionPlacements.get(run.runId)).toMatchObject({ executionKind: "remote_worker" });
      const executionTaskId = assignment.aggregate!.assignment.manifest.taskId;
      if (genericChat) {
        expect(run.payload.request).not.toHaveProperty("policyTaskId");
        expect(store.tasks.get(executionTaskId)).toMatchObject({ status: "in_progress",
          proactiveContext: { sessionId: session.sessionId, durableRunId: run.runId } });
      } else expect(executionTaskId).toBe(task!.taskId);
      expect(stub.completionDispatches()).toBe(0);
      if (toolCase) {
        const profile = store.chatTurnCapabilityProfiles.findByRun(run.runId)!;
        const read = profile.selection.tools.find((tool) => tool.canonicalName === canonicalToolName);
        expect(read, JSON.stringify(profile.governance.policyDecisions.filter((item) => item.toolName.startsWith("mcp.")))).toBeDefined();
        if (mcpCase) {
          expect(profile.identity.authActorId).toBe(actorId);
          expect(profile.identity.authActorSource).toBe("token");
          if (mcpCase === "static") {
            expect(read!.mcpStaticBinding).toMatchObject({ mode: "static", serverId: "worker-mcp", nativeToolName: "read" });
            expect(read!.mcpRequesterResolution).toBeUndefined();
          } else expect(read!.mcpRequesterResolution?.serverId).toBe("worker-mcp");
        }
        if (meshCase) expect(read!.meshPublication).toMatchObject({ nodeId: generation.nodeId,
          manifestSha256: meshProbe!.activationRequest.manifestSha256 });
        stub.replaceDispatchPlan([{ type: "tool_call", name: read!.modelName,
          arguments: meshCase ? meshProbe!.args : { path: mcpCase ? "note.txt" : notePath },
          callId: "read-before-restart" }]);
      }
      stage = "worker inference";
      const inferred = await runWorkerProcess({ ...common, runId: "inferred", stopAfter: "inference" });
      expect(inferred.exitCode, JSON.stringify(inferred.report)).toBe(0);
      expect(stub.completionDispatches()).toBe(1);
      const assignmentId = assignment.aggregate!.assignment.assignmentId;
      const workerUsage = store.modelUsageEvents.list({ durableRunId: run.runId, limit: 100 }).items;
      expect(workerUsage).toHaveLength(1);
      expect(workerUsage[0]).toMatchObject({ transportStatus: "accepted", terminalOutcome: "succeeded" });
      expect(workerUsage[0]!.costUsd).toBeGreaterThan(0);
      let approvalId: string | undefined;
      let toolRunId: string | undefined;
      if (approvalCase) {
        stage = "canonical tool approval wait";
        const parked = await runWorkerProcess({ ...common, runId: "parked", stopAfter: "tools" });
        expect(parked.exitCode, JSON.stringify(parked.report)).toBe(0);
        expect(parked.report).toMatchObject({ toolStatus: "waiting_approval", awaiting: "approval_resolution" });
        const tools = store.chatToolRuns.listByTurn(String(run.payload.turnId));
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({ status: "approval_required", toolName: canonicalToolName });
        approvalId = tools[0]!.approvalId!;
        toolRunId = tools[0]!.toolRunId;
        expect(store.approvals.get(approvalId).status).toBe("pending");
        await eventually("sealed Chat approval wait", () => store.durableRuns.getRun(run.runId),
          (value) => value.status === "waiting" && !hasGeneralChatPostCommitPending(value)
            && !hasAutonomousChatPostCommitPending(value));
      }
      const before = store.remoteWorkerAssignments.findAssignmentAggregate("default", assignmentId)!;
      const beforeParent = store.durableRuns.getRun(run.runId);
      if (meshProbe) {
        expect(await meshProbe.receipts()).toEqual([]);
        expect(await meshProbe.readContent()).toBe("Orion 7.\n");
        if (meshCase === "mcp") expect(meshProbe.mcpCalls()).toBe(0);
      }
      expect(before.generation).toBeDefined();
      expect(before.lease).toBeDefined();
      expect(before.settlement).toBeUndefined();
      expect(beforeParent.status).toBe(approvalCase ? "waiting" : "running");
      const oldPid = stack.gateway.child.pid;
      const discoveryBeforeRestart = mcpProbe?.evidence().methods.filter((method) => method === "tools/list").length ?? 0;
      if (mcpProbe) {
        expect(discoveryBeforeRestart).toBeGreaterThan(0);
        expect(mcpProbe.evidence().calls).toEqual([]);
      }
      stage = "restart real Gateway process";
      await stopProcess(stack.gateway);
      await stream;
      stack = await startVerificationStack(context, { ...stackOptions, processLogPrefix: "after" });
      expect(stack.gateway.child.pid).not.toBe(oldPid);
      if (approvalId) {
        stage = "approve retained tool after Gateway restart";
        const parked = await runWorkerProcess({ ...common, runId: "still-parked", stopAfter: "complete" });
        expect(parked.exitCode, JSON.stringify(parked.report)).toBe(0);
        expect(parked.report).toMatchObject({ reconnectSync: "waiting_approval", awaiting: "approval_resolution" });
        expect(store.chatToolRuns.get(toolRunId!).status).toBe("approval_required");
        if (meshProbe) {
          expect(await meshProbe.receipts()).toEqual([]);
          expect(await meshProbe.readContent()).toBe("Orion 7.\n");
          if (meshCase === "mcp") expect(meshProbe.mcpCalls()).toBe(0);
        }
        await api(stack.gatewayUrl, `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
          decision: "approve", resolvedBy: "verification", resolutionNote: "Read the isolated restart fixture.",
        });
      }
      stage = "canonical parent recovery";
      const replacement = await eventually("replacement Gateway claim", () => store.durableRuns.getRun(run.runId),
        (value) => value.status === "running" && Boolean(value.leaseOwnerId) && value.leaseOwnerId !== beforeParent.leaseOwnerId, 155_000);
      if (approvalId) {
        // Claiming the durable run precedes the dispatcher binding its native
        // continuation. A one-shot worker may legitimately park in that gap.
        await eventually("bound native approval continuation", () => store.remoteWorkerAssignments.findChatApprovalResume({
          registryWorkspaceId: "default", assignmentId, assignmentGeneration: before.generation!.assignmentGeneration,
        }), (value) => Boolean(value?.binding));
      }
      stage = "worker completion after Gateway restart";
      const completed = await runWorkerProcess({ ...common, runId: "completed", stopAfter: "complete" });
      await writeFile(join(context.artifactRoot, "completion.json"), JSON.stringify(completed.report, null, 2));
      if (completed.exitCode !== 0) await writeFile(join(context.artifactRoot, "worker-completion-failure.json"), JSON.stringify({
        exitCode: completed.exitCode, stderr: redactSecretText(completed.stderr.slice(-8_000)).value,
      }, null, 2));
      if (approvalId) {
        const intents = store.remoteWorkerEffects.listIntents("default", assignmentId, before.generation!.assignmentGeneration);
        await writeFile(join(context.artifactRoot, "tool-state.json"), JSON.stringify({
          approval: store.approvals.get(approvalId), pending: store.pendingApprovalActions.find(approvalId),
          tools: store.chatToolRuns.listByTurn(String(run.payload.turnId)),
          effects: intents.map((intent) => ({ intent,
            settlement: store.remoteWorkerEffects.findSettlement("default", assignmentId,
              before.generation!.assignmentGeneration, intent.intentId),
          })),
        }, null, 2));
      }
      expect(completed.exitCode, JSON.stringify(completed.report)).toBe(0);
      expect(completed.report, JSON.stringify(completed.report)).toMatchObject({ outcome: "completed", settlementOutcome: "completed" });
      const terminal = await eventually("terminal Chat", () => store.durableRuns.getRun(run.runId),
        (value) => ["completed", "failed", "cancelled", "dead_lettered"].includes(value.status));
      expect(terminal.status, terminal.lastError).toBe("completed");
      const after = store.remoteWorkerAssignments.findAssignmentAggregate("default", assignmentId)!;
      expect(after.generation).toEqual(before.generation);
      expect(after.lease!.leaseRevision).toBeGreaterThan(before.lease!.leaseRevision);
      expect(after.lease!.parentDispatchAuthority.dispatchOwnerId).toBe(replacement.leaseOwnerId);
      expect(terminal.attemptCount).toBe(0);
      expect(terminal.attemptCount).toBe(beforeParent.attemptCount);
      const thread = await api(stack.gatewayUrl, `${route}/thread?includeDecisionTrace=true`) as ChatThreadResponse;
      expect(thread.turns).toHaveLength(1);
      expect(thread.turns[0]).toMatchObject({ turnId: run.payload.turnId,
        assistantMessage: { messageId: run.payload.assistantMessageId, content: reply }, trace: { status: "completed" } });
      expect(store.remoteWorkerBudgets.listGrants("default", "default")[0])
        .toMatchObject({ heldRequests: 0, settledRequests: toolCase ? 2 : 1 });
      const toolRuns = store.chatToolRuns.listByTurn(String(run.payload.turnId));
      if (toolCase) {
        expect(toolRuns).toHaveLength(1);
        expect(toolRuns[0]).toMatchObject({ ...(toolRunId ? { toolRunId } : {}), toolName: canonicalToolName, status: "executed" });
        if (meshCase) {
          expect(toolRuns[0]!.result).toMatchObject({ externalRuntime: true, ok: true, output: meshProbe!.expectedOutput });
          expect(await meshProbe!.readContent()).toBe(meshCase === "write" ? "Orion 8.\n" : "Orion 7.\n");
        }
        else expect(JSON.stringify(toolRuns[0]!.result)).toContain("Approved worker read: Orion 7.");
        if (approvalId) expect(store.pendingApprovalActions.get(approvalId)?.resolutionStatus).toBe("executed");
      }
      // Normal Chat post-commit effects have their own canonical operations.
      // Account for them explicitly; the original worker operation stays exact.
      await eventually("Chat post-commit settlement", () => store.durableRuns.getRun(run.runId),
        (value) => !hasGeneralChatPostCommitPending(value) && !hasAutonomousChatPostCommitPending(value));
      const usage = await eventually("settled provider accounting", () => store.modelUsageEvents.list({ limit: 100 }).items,
        (items) => items.length === stub.completionDispatches() && items.every((item) => item.terminalOutcome !== "in_flight"));
      expect(usage.every((item) => item.transportStatus === "accepted" && item.terminalOutcome === "succeeded")).toBe(true);
      expect(store.modelUsageEvents.listOperationAttemptsForUpdate(workerUsage[0]!.operationId, workerUsage[0]!.dispatchGeneration)).toEqual(workerUsage);
      const providerDispatches = stub.completionDispatches();
      const replay = await runWorkerProcess({ ...common, runId: "replay", stopAfter: "complete" });
      expect(replay.exitCode, JSON.stringify(replay.report)).toBe(0);
      expect(stub.completionDispatches()).toBe(providerDispatches);
      expect(store.chatToolRuns.listByTurn(String(run.payload.turnId))).toEqual(toolRuns);
      expect(store.modelUsageEvents.listOperationAttemptsForUpdate(workerUsage[0]!.operationId, workerUsage[0]!.dispatchGeneration)).toEqual(workerUsage);
      const replayedThread = await api(stack.gatewayUrl, `${route}/thread?includeDecisionTrace=true`) as ChatThreadResponse;
      expect(replayedThread.turns).toHaveLength(1);
      expect(replayedThread.turns[0]!.assistantMessage).toEqual(thread.turns[0]!.assistantMessage);
      if (genericChat) {
        expect(terminal.payload).toEqual(run.payload);
        expect(store.tasks.get(executionTaskId).status).toBe("done");
        expect(store.tasks.list({ limit: 100 }).filter((entry) => entry.proactiveContext?.durableRunId === run.runId))
          .toHaveLength(1);
      }
      if (mcpProbe) {
        expect(mcpProbe.evidence().calls).toEqual([{ path: "note.txt" }]);
        expect(mcpProbe.evidence().errors).toEqual([]);
        expect(mcpProbe.evidence().methods.filter((method) => method === "tools/list").length).toBeGreaterThan(discoveryBeforeRestart);
        expect(JSON.stringify({ completed: completed.report, thread, toolRuns, profile: store.chatTurnCapabilityProfiles.findByRun(run.runId) }))
          .not.toContain("controlled-worker-mcp-secret");
      }
      const meshReceipts = await meshProbe?.receipts();
      if (destinationMcp) expect(meshProbe!.mcpCalls()).toBe(1);
      if (meshCase === "mcp_bearer") {
        expect(meshProbe!.mcpAuthentication()).toEqual({ requests: 5, allAccepted: true });
        meshProbe!.assertCredentialAbsent({ completed: completed.report, thread, toolRuns, meshReceipts,
          profile: store.chatTurnCapabilityProfiles.findByRun(run.runId) });
      }
      if (meshReceipts) {
        expect(meshReceipts).toHaveLength(1);
        expect(meshReceipts[0]).toMatchObject({ disposition: "succeeded" });
        expect(store.meshCapabilityPublications.findInvocationSettlement("default", meshReceipts[0]!.invocationId))
          .toMatchObject({ disposition: "succeeded", outputSha256: meshProbe!.expectedOutputSha256,
            settlementSha256: meshReceipts[0]!.settlementSha256, requestSha256: meshReceipts[0]!.requestSha256 });
      }
      await writeFile(join(context.artifactRoot, "result.json"), JSON.stringify({ passed: true, stage,
        runId: terminal.runId, assignmentId, beforePid: oldPid, afterPid: stack.gateway.child.pid,
        restartAfter, genericChat, mcpCase, meshCase, meshReceipts, artifactCommitDelayMs: mcpCase === "requester" && approvalCase ? 6_000 : 0,
        terminalSettlementDelayMs: mcpCase === "requester" && !approvalCase ? 6_000 : 0,
        mcp: mcpProbe?.evidence(), executionTaskId, taskStatus: store.tasks.get(executionTaskId).status,
        approvalId, toolRunId, providerDispatches,
        workerProviderDispatches: usage.filter((event) => event.workerId === generation.workerId).length,
        otherProviderDispatches: usage.filter((event) => event.workerId !== generation.workerId).length,
        model, destinationMcpCalls: meshProbe?.mcpCalls(), destinationMcpAuthentication: meshProbe?.mcpAuthentication(),
        boundary: destinationMcp ? "stock-built-gateway-and-worker-destination-http-mcp-and-synthetic-custody"
          : meshCase === "write" ? "stock-built-gateway-and-worker-native-mesh-file-write-and-synthetic-custody"
          : meshCase ? "stock-built-gateway-and-worker-native-mesh-file-read-and-synthetic-custody"
          : mcpCase === "static" ? "stock-built-gateway-static-loopback-mcp-and-synthetic-native-custody"
          : mcpCase ? "built-gateway-app-with-constructor-resolver-loopback-mcp-and-synthetic-native-custody" : "loopback-provider-and-synthetic-native-custody" }, null, 2));
    } catch (error) {
      await writeFile(join(context.artifactRoot, "failure.json"), JSON.stringify({ stage,
        error: error instanceof Error ? error.message : String(error), streamOutcome,
        runs: storage?.durableRuns.listRuns(20).filter((run) => run.workflowKey === "chat.turn.execute").map((run) => {
          const profile = storage!.chatTurnCapabilityProfiles.findByRun(run.runId);
          const assignment = storage!.remoteWorkerAssignments.findTaskBoundChatAssignment({
            executionWorkspaceId: "default", sessionId: String(run.payload.sessionId),
            turnId: String(run.payload.turnId), durableRunId: run.runId,
          });
          const lease = assignment?.lease;
          return { runId: run.runId, status: run.status, lastError: run.lastError,
            attemptCount: run.attemptCount, version: run.version,
            leaseHeartbeatAt: run.leaseHeartbeatAt, leaseExpiresAt: run.leaseExpiresAt,
            assignment: assignment ? {
              assignmentId: assignment.assignment.assignmentId,
              assignmentGeneration: assignment.generation?.assignmentGeneration,
              lease: lease ? { leaseRevision: lease.leaseRevision, heartbeatAt: lease.heartbeatAt,
                expiresAt: lease.expiresAt, workerSentThrough: lease.workerSentThrough,
                serverAcknowledgedThrough: lease.serverAcknowledgedThrough,
                parentRunVersion: lease.parentDispatchAuthority.durableRunVersion,
                parentRunLeaseExpiresAt: lease.parentDispatchAuthority.durableRunLeaseExpiresAt } : undefined,
              artifactManifestRecorded: assignment.generation ? Boolean(storage!.remoteWorkerArtifacts.getManifestSha256(
                "default", assignment.assignment.assignmentId, assignment.generation.assignmentGeneration)) : false,
            } : undefined,
            requestActor: run.payload.requestActor,
            policyTaskId: (run.payload.request as Record<string, unknown> | undefined)?.policyTaskId,
            unsupportedWorkflow: Object.fromEntries(["modelCouncil", "parentDelegationStepId", "sideChatContext"].map((key) =>
              [key, (run.payload.request as Record<string, unknown> | undefined)?.[key]])),
            heartbeat: run.payload.heartbeatOccurrenceId,
            frozenContext: Boolean(run.metadata?.remoteWorkerChatContextSha256),
            placement: storage!.chatExecutionPlacements.get(run.runId)?.executionKind,
            profile: profile ? { tools: profile.selection.tools.map((tool) => tool.canonicalName), subagentPolicy: profile.selection.subagentPolicy,
              mcpPolicy: profile.governance.policyDecisions.filter((item) => item.toolName.startsWith("mcp.")) } : undefined };
        }),
        providerDispatches: stub.completionDispatches(), mcp: mcpProbe?.evidence() }, null, 2));
      throw error;
    } finally {
      streamController.abort();
      await stopProcess(stack?.gateway);
      storage?.close();
      await stub.close();
      await mcpProbe?.close();
      await meshProbe?.close();
      const cleanupErrors = await stopVerificationStack(stack ?? { runtimeRoot });
      expect(cleanupErrors).toEqual([]);
    }
  }, 420_000);
});
