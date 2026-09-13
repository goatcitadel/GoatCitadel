import { sha256, portOf, tlsConfig, seedBootstrap, runWorkerProcess } from "../../test/fixtures/remote-worker-native.js";
import { createRequesterMcpWorkerFixture } from "../../test/fixtures/remote-worker-requester-mcp.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatSendMessageRequest,
  type CapabilityCatalogEntry,
} from "@goatcitadel/contracts";
import {
  RemoteWorkerAdmissionRepository,
  RemoteWorkerAssignmentRepository,
  RemoteWorkerMeshNodeAdmissionRepository,
  RemoteWorkerNonceRepository,
  Storage,
  createSqliteAsyncStorage,
  createDatabase,
  type DatabaseClient,
} from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { LlmService } from "./llm-service.js";
import type { GovernedLlmCompletionHost } from "./llm-completion-service.js";
import { SecretStoreService } from "./secret-store-service.js";
import { createRemoteWorkerExecutionOwners } from "./remote-worker-execution-owners.js";
import { RemoteWorkerChatExecutionService } from "./remote-worker-chat-execution-service.js";
import { RemoteWorkerChatPlacementService } from "./remote-worker-chat-placement-service.js";
import type { RemoteWorkerChatExecution } from "./remote-worker-chat-execution-service.js";
import { finalizeDurableChatRun, GENERAL_CHAT_POST_COMMIT_EFFECTS, type ChatDurableRunFinalizeDeps } from "./chat-durable-run-service.js";
import { DurableRunService } from "./durable-run-service.js";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";
import { executeApprovedExternalRuntimeSideEffect } from "./approved-external-runtime-side-effect-service.js";
import { toToolInvokeRequest } from "./gateway/external-runtime-approval-adapter.js";
import { prepareRemoteWorkerChatApprovalHandoff, shouldDeferRemoteWorkerChatApprovalWake } from "./remote-worker-chat-approval-resume.js";
import { RemoteWorkerApprovalResumeRequiredError } from "./remote-worker-approved-action-guard.js";
import type { ApprovalEffectRecord } from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { RemoteWorkerAssignmentExecutionOwnerDependencies } from "./remote-worker-assignment-runtime-composition.js";
import {
  CONNECTED_WORKER_CONTEXT_MESSAGES,
  prepareChatOfferFixture,
  seedAssignmentOffer,
} from "../../../../packages/storage/src/remote-worker-chat-offer-fixture.js";
import { createGatewayRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-composition.js";
import { createGatewayRemoteWorkerAssignmentRuntimeComposition } from "./remote-worker-assignment-runtime-composition.js";
import { RemoteWorkerChatApprovalWaitReadService } from "./remote-worker-chat-approval-wait-read-service.js";
import { startRemoteWorkerNativeTlsListener } from "./remote-worker-native-tls-listener.js";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";

const cleanupRoots: string[] = [];
const openHandles: Array<{ close(): Promise<void> }> = [];
const openDatabases: DatabaseClient[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.allSettled(openHandles.splice(0).map(async (handle) => handle.close()));
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // Best-effort cleanup: a failed assertion must not be masked by a close error.
    }
  }
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Compose the exact production owners over the canonical repositories. Nothing
 * here is a stub of an owner: the admission service, protected-evidence
 * verifier, mesh-node admission owner, and the flag-gated assignment RPC and
 * dispatch owners are the shipped classes. Only the composition is harness-made
 * — production still composes none of it.
 */
async function composeGatewayHandler(
  db: DatabaseClient,
  config: EnabledRemoteWorkerRuntimeConfig,
  ownerErrors: string[],
  execution?: RemoteWorkerAssignmentExecutionOwnerDependencies,
  approvalWait?: RemoteWorkerChatApprovalWaitReadService,
) {
  const admissions = new RemoteWorkerAdmissionRepository(db);
  const meshNodeAdmissions = new RemoteWorkerMeshNodeAdmissionRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const nonces = new RemoteWorkerNonceRepository(db);
  const runtime = createGatewayRemoteWorkerAssignmentRuntimeComposition({
    admissionStore: admissions,
    meshAdmissions: meshNodeAdmissions,
    assignments,
    nonceConsumer: nonces,
    execution,
    approvalWait,
  });
  // The wire owners collapse every failure to an opaque 403 by design. Capture
  // the real cause here so a harness failure is diagnosable without weakening
  // the production response.
  const observed = <T extends { assertAvailable(): Promise<void>; execute(input: never): Promise<unknown> }>(
    owner: T,
    label: string,
  ) =>
    ({
      assertAvailable: () => owner.assertAvailable(),
      execute: async (input: never) => {
        try {
          return await owner.execute(input);
        } catch (error) {
          ownerErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
    }) as unknown as T;
  const loggedAdmissions = new Proxy(admissions, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          ownerErrors.push(
            `admission-store.${String(property)}: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      };
    },
  });
  const handler = await createGatewayRemoteWorkerAdmissionNativeRequestHandler({
    config,
    admissionStore: loggedAdmissions,
    meshNodeAdmissionStore: meshNodeAdmissions,
    assignmentProtocol: observed(runtime.assignmentProtocol, "assignment-rpc"),
    assignmentDispatch: observed(runtime.assignmentDispatch, "assignment-dispatch"),
    // The protocol probe has no execution owners. The separate text-execution
    // scenario supplies the real inference and artifact owners below.
    assignmentExecution: runtime.assignmentExecution
      ? observed(runtime.assignmentExecution, "assignment-execution")
      : {
          assertAvailable: async () => undefined,
          execute: async () => {
            throw new Error("Routes 11-12 are not composed by this harness.");
          },
        },
    createEvidenceVerifier: () => {
      const verifier = new RemoteWorkerProtectedAdmissionEvidenceVerifier();
      return {
        assertAvailable: () => verifier.assertAvailable(),
        verify: (input) => {
          try {
            return verifier.verify(input);
          } catch (error) {
            ownerErrors.push(`evidence-verifier: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        },
      };
    },
  });
  if (handler === undefined) throw new Error("The connected-worker composition returned no handler.");
  return { handler, admissions, meshNodeAdmissions, assignments };
}

function countRows(db: DatabaseClient, sql: string, params: Record<string, unknown> = {}): number {
  const row = db.prepare(sql).get<{ count: number | bigint }>(params);
  return Number(row?.count ?? -1);
}

async function verifyCanonicalApprovalWait(storage: Storage, root: string, assignmentId: string): Promise<PreparedAgentChatTurn> {
  const asyncStorage = createSqliteAsyncStorage(storage);
  const aggregate = storage.remoteWorkerAssignments.findAssignmentAggregate("default", assignmentId)!;
  const manifest = aggregate.assignment.manifest;
  const run = storage.durableRuns.getRun(manifest.durableRunId);
  const profile = storage.chatTurnCapabilityProfiles.findByRun(run.runId)!;
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey, durableRunId: run.runId, payload: run.payload,
  })!;
  const prepared = {
    workspaceId: payload.workspaceId, session: { sessionId: payload.sessionId }, turnId: payload.turnId,
    capabilityProfile: profile, assistantMessageId: payload.assistantMessageId, content: payload.request.content,
    userMessage: { messageId: payload.userMessageId, sessionId: payload.sessionId },
    turnAdmission: {
      identity: {
        admissionId: payload.admissionId, sessionIncarnationId: payload.sessionIncarnationId,
        materialSha256: payload.admissionMaterialSha256, workspaceId: payload.workspaceId,
        sessionId: payload.sessionId, turnId: payload.turnId, aggregateRevision: payload.admissionAggregateRevision,
        controllerGeneration: payload.admissionControllerGeneration,
      },
      admittedRequest: payload.request as ChatSendMessageRequest, requestActor: payload.requestActor,
    },
  } as PreparedAgentChatTurn;
  // Bind the controlled harness's existing admitted turn to the same trace and
  // retry policy normally installed by the durable Chat execution owner.
  await asyncStorage.chatTurnTraces.patch(payload.turnId, {
    assistantMessageId: payload.assistantMessageId, durable: { runId: run.runId, status: "running" },
  });
  await asyncStorage.durableRuns.updateRun({ runId: run.runId, status: "running", expectedVersion: run.version,
    metadata: { ...run.metadata, retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT } },
  });
  const handoff = new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas"));
  const execution = (await handoff.resolve(run, prepared))!;
  const chunks = [];
  for await (const chunk of execution.stream({ signal: new AbortController().signal,
    canonicalWriteFence: async (work) => await asyncStorage.runImmediateTransaction(async () => {
      if (!await asyncStorage.durableRuns.lockFreshActiveLeaseForUpdate(run.runId, run.leaseOwnerId!))
        throw new Error("Fixture lost its parent Chat lease.");
      return await work();
    }),
  })) chunks.push(chunk);
  expect(chunks).toHaveLength(1);
  const waiting = chunks[0]!;
  expect(waiting.type).toBe("approval_required");
  if (waiting.type !== "approval_required") throw new Error("Expected the canonical worker approval.");
  expect(storage.chatInlineApprovals.get(waiting.approval.approvalId)).toMatchObject({
    status: "pending", sessionId: payload.sessionId, turnId: payload.turnId,
  });
  expect(storage.durableRuns.getRun(run.runId).status).toBe("running");
  const deps: ChatDurableRunFinalizeDeps = {
    runImmediateTransaction: (work) => asyncStorage.runImmediateTransaction(work),
    durableRuns: asyncStorage.durableRuns, chatMessages: asyncStorage.chatMessages,
    chatTurnTraces: asyncStorage.chatTurnTraces, chatToolRuns: asyncStorage.chatToolRuns,
    chatToolArtifacts: asyncStorage.chatToolArtifacts,
    resolvePostCommitEligibility: async () => ({ version: 1, autonomyEnabledAtParentSettlement: false,
      evalIntegrityTurn: false, humanSession: true }),
    recordDurableTimelineEvent: async (runId, eventType, payload) => {
      await asyncStorage.durableRunEvents.append({ eventId: randomUUID(), runId, eventType,
        payload: payload ?? {}, createdAt: new Date().toISOString() });
    },
  };
  const trace = await asyncStorage.chatTurnTraces.get(payload.turnId);
  await finalizeDurableChatRun(deps, run.runId, prepared, trace, run.leaseOwnerId);
  const waitingRun = await asyncStorage.durableRuns.getRun(run.runId);
  expect(waitingRun).toMatchObject({ status: "waiting", metadata: {
    waitForEvent: { eventKey: "approval.resolved", correlationId: waiting.approval.approvalId },
  } });
  expect(waitingRun.leaseOwnerId).toBeUndefined();
  expect(await asyncStorage.durableRuns.getLatestCheckpointByKind(run.runId, "run_waiting")).toMatchObject({
    state: { currentStep: "waiting_for_approval", waitForEvent: waitingRun.metadata!.waitForEvent },
  });
  await finalizeDurableChatRun(deps, run.runId, prepared, await asyncStorage.chatTurnTraces.get(payload.turnId));
  expect(await asyncStorage.durableRuns.getRun(run.runId)).toEqual(waitingRun);
  expect(storage.chatMessages.get(prepared.assistantMessageId)).toBeUndefined();
  return prepared;
}

describe("connected worker end-to-end (scenario 12)", () => {
  it.runIf(process.platform === "win32")(
    "admits a real second process over native mTLS, claims a dispatched offer, ships an ordered transcript, and settles once across a restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "goat-connected-worker-"));
      cleanupRoots.push(root);
      const tls = await tlsConfig(root);
      const db = createDatabase({ dbPath: join(root, "gateway.sqlite") });
      openDatabases.push(db);

      const evidenceSigner = generateKeyPairSync("ed25519");
      const evidenceSignerSpkiDer = evidenceSigner.publicKey.export({ format: "der", type: "spki" });
      const evidenceSignerPrivateKeyPem = evidenceSigner.privateKey.export({ format: "pem", type: "pkcs8" });
      if (!Buffer.isBuffer(evidenceSignerSpkiDer) || typeof evidenceSignerPrivateKeyPem !== "string") {
        throw new Error("Unable to create the protected admission signer fixture.");
      }
      const bootstrap = seedBootstrap(db, tls, evidenceSignerSpkiDer, evidenceSignerPrivateKeyPem);
      const offer = seedAssignmentOffer(db);

      const ownerErrors: string[] = [];
      const composed = await composeGatewayHandler(db, tls.config, ownerErrors);
      const listener = await startRemoteWorkerNativeTlsListener(tls.config, composed.handler);
      openHandles.push(listener);
      const port = portOf(listener.address);
      const stateDir = join(root, "worker-state");
      const ticketFile = join(root, "ticket.json");
      writeFileSync(ticketFile, JSON.stringify(bootstrap.ticket), "utf8");

      // Run 1 — the one-time bootstrap exchange, in a real second process.
      const admitRun = await runWorkerProcess({
        root,
        port,
        paths: tls.paths,
        ticketFile,
        stateDir,
        runId: "admit",
        stopAfter: "admit",
      });
      expect({
        exit: admitRun.exitCode,
        outcome: admitRun.report.outcome,
        errors: ownerErrors,
        error: admitRun.report.error ?? (admitRun.stderr.trim() === "" ? undefined : admitRun.stderr.slice(-600)),
      }).toEqual({
        exit: 0,
        outcome: "stopped",
        errors: [],
        error: undefined,
      });
      expect(admitRun.report.admitted).toBe("bootstrap_exchange");
      expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_runtime_credentials")).toBe(1);

      // Operator step: issue the mesh join authority the worker needs to bind
      // its node into the execution workspace. This is deliberately operator
      // side; the worker performs the route-7 admission itself.
      const generation = composed.admissions.findCurrentGeneration("default", String(bootstrap.ticket.workerId));
      if (!generation) throw new Error("The bootstrap exchange recorded no worker generation.");
      const evidence = composed.admissions.findProtectedAdmissionEvidenceRecord(
        "default",
        generation.workerId,
        generation.workerGeneration,
      );
      if (!evidence) throw new Error("The bootstrap exchange recorded no protected admission evidence.");
      const meshJoinCredential = randomBytes(32).toString("base64url");
      composed.meshNodeAdmissions.issueJoinAuthority({
        registryWorkspaceId: generation.registryWorkspaceId,
        bootstrapId: generation.bootstrapId,
        workerId: generation.workerId,
        workerGeneration: generation.workerGeneration,
        nodeId: generation.nodeId,
        clientCertificateSha256: generation.clientCertificateSha256,
        protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
        protectedAdmissionContextSha256: evidence.contextSha256,
        workspaceId: "default",
        expiresInSeconds: 300,
        issuedByActorId: "operator-a",
        idempotencyKey: "mesh-authority:connected-worker",
        rawMeshNodeCredential: meshJoinCredential,
      });
      writeFileSync(ticketFile, JSON.stringify({ ...bootstrap.ticket, meshJoinCredential }), "utf8");

      // Run 2 — reconnect on the retained credential, admit the node, claim the
      // offer, read the workload, ship the first transcript batch, then die
      // mid-loop holding a live lease.
      const midRun = await runWorkerProcess({
        root,
        port,
        paths: tls.paths,
        ticketFile,
        stateDir,
        runId: "mid",
        stopAfter: "events",
      });
      expect({
        exit: midRun.exitCode,
        outcome: midRun.report.outcome,
        errors: ownerErrors,
        error: midRun.report.error ?? (midRun.stderr.trim() === "" ? undefined : midRun.stderr.slice(-600)),
      }).toEqual({
        exit: 0,
        outcome: "stopped",
        errors: [],
        error: undefined,
      });
      expect(midRun.report.admitted).toBe("retained_credential");
      expect(midRun.report.claim).toBe("started");
      expect(midRun.report.offerCount).toBe(1);

      // Run 3 — restart: resend the byte-identical tail, renew, and settle.
      const finalRun = await runWorkerProcess({
        root,
        port,
        paths: tls.paths,
        ticketFile,
        stateDir,
        runId: "final",
        stopAfter: "complete",
      });
      expect({
        exit: finalRun.exitCode,
        outcome: finalRun.report.outcome,
        errors: ownerErrors,
        error: finalRun.report.error ?? (finalRun.stderr.trim() === "" ? undefined : finalRun.stderr.slice(-600)),
      }).toEqual({
        exit: 0,
        outcome: "completed",
        errors: [],
        error: undefined,
      });
      expect(finalRun.report.admitted).toBe("retained_credential");
      expect(finalRun.report.reconnectSync).toBe("synchronized");
      expect(finalRun.report.eventDispositions).toEqual(["replayed", "appended"]);
      expect(finalRun.report.settlement).toBe("settled");
      expect(finalRun.report.control).toBe("active");
      expect(finalRun.report.settlementOutcome).toBe("failed");

      // Durable-state proof: one credential, one generation, one settlement, and
      // a contiguous, non-duplicated event chain. Nothing is read from logs.
      expect({
        credentials: countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_runtime_credentials"),
        generations: countRows(
          db,
          "SELECT COUNT(*) AS count FROM remote_worker_assignment_generations WHERE assignment_id = @assignmentId",
          { assignmentId: offer.assignmentId },
        ),
        settlements: countRows(
          db,
          "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements WHERE assignment_id = @assignmentId",
          { assignmentId: offer.assignmentId },
        ),
        events: countRows(
          db,
          "SELECT COUNT(*) AS count FROM remote_worker_assignment_events WHERE assignment_id = @assignmentId",
          { assignmentId: offer.assignmentId },
        ),
        distinctSequences: countRows(
          db,
          `SELECT COUNT(DISTINCT sequence) AS count FROM remote_worker_assignment_events
             WHERE assignment_id = @assignmentId`,
          { assignmentId: offer.assignmentId },
        ),
      }).toEqual({ credentials: 1, generations: 1, settlements: 1, events: 3, distinctSequences: 3 });

      // No provider redispatch and no second accounting authority: the loop
      // never reached an inference route, and no HX-306 row exists at all.
      expect(countRows(db, "SELECT COUNT(*) AS count FROM model_usage_events")).toBe(0);
      expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_inference_requests")).toBe(0);
    },
    300_000,
  );

  it
    .runIf(process.platform === "win32")
    .each(["heartbeat", "parent_takeover", "parent_expiry", "parent_recovery", "continuous", "continuous_budget_exhausted", "tool_calls", "tool_withdrawal", "tool_approval_wait", "tool_approval_approve", "tool_mcp", "tool_approval_mcp", "tool_mcp_revoked"] as const)(
    "executes canonical inference with %s authority and prevents unauthorized publication",
    async (authorityCase) => {
      const toolsCase = authorityCase.startsWith("tool_");
      const mcpCase = authorityCase.includes("_mcp");
      const approvalCase = authorityCase.startsWith("tool_approval_");
      const approvedCase = authorityCase === "tool_approval_approve" || authorityCase === "tool_approval_mcp";
      const toolModelCase = !mcpCase && (authorityCase === "tool_calls" || approvedCase);
      const root = mkdtempSync(join(tmpdir(), "goat-connected-execution-"));
      cleanupRoots.push(root);
      const storage = new Storage({
        dbPath: join(root, "gateway.sqlite"),
        transcriptsDir: join(root, "transcripts"),
        auditDir: join(root, "audit"),
      });
      openHandles.push({ close: async () => storage.close() });
      const asyncStorage = createSqliteAsyncStorage(storage);
      const db = storage.db;
      const tls = await tlsConfig(root);
      const signer = generateKeyPairSync("ed25519");
      const bootstrap = seedBootstrap(
        db,
        tls,
        signer.publicKey.export({ format: "der", type: "spki" }),
        String(signer.privateKey.export({ format: "pem", type: "pkcs8" })),
        true,
        toolsCase,
      );
      const callableEntries: CapabilityCatalogEntry[] = toolsCase ? [{
        capabilityId: "tool:fs.read", kind: "tool", category: "built_in", title: "Read file",
        summary: "Read an admitted file", callable: true, trustLabel: "Builtin", toolName: "fs.read",
        effectPotential: { version: "goatcitadel.tool-effect.v1", potential: "none",
          sourceKind: "builtin", reason: "trusted_builtin_safe_read" },
      }] : [];
      const providerDefinition = { type: "function", function: {
        name: "fs_read", description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      } };
      const mcpFixture = mcpCase ? await createRequesterMcpWorkerFixture(asyncStorage, root, approvedCase) : undefined;
      const profileOptions = mcpFixture?.profileOptions ?? {
        callableEntries,
        tools: callableEntries.length ? [{ canonicalName: "fs.read", modelName: "fs_read",
          providerDefinition, definitionHash: sha256(canonicalJsonString(providerDefinition)),
          runtimeOwner: { kind: "builtin" as const, bindingHash: sha256("fixture-fs-read-owner") },
          effectPotential: callableEntries[0]!.effectPotential,
        }] : [],
      };
      const canonicalToolName = mcpFixture?.canonicalName ?? "fs.read";
      const modelToolName = mcpFixture?.modelName ?? "fs_read";
      const profileAuthority = {
        listCallableCapabilities: mcpFixture?.listCallableCapabilities ?? (async () => callableEntries),
        resolvePolicyContext: mcpFixture?.resolvePolicyContext ?? (async () => ({ permissionProfileId: "safe" })),
        ...(mcpFixture ? { revalidateRequesterTool: mcpFixture.revalidateRequesterTool,
          createMcpRequesterTurnContext: mcpFixture.createMcpRequesterTurnContext } : {}),
      };
      const placementSeed = authorityCase === "heartbeat" || authorityCase === "parent_recovery" || toolsCase
        ? prepareChatOfferFixture(db, true, "", { ...profileOptions, subagentPolicy: "off" }) : undefined;
      const seededOffer = placementSeed ? undefined : seedAssignmentOffer(db, true, "", undefined, profileOptions);
      const secondOffer = authorityCase.startsWith("continuous") ? seedAssignmentOffer(db, true, "-second") : undefined;
      const llm = new LlmService(
        {
          activeProviderId: "openai",
          activeModel: "gpt-5.4",
          providers: [
            {
              providerId: "openai",
              label: "Controlled fixture",
              baseUrl: "https://api.openai.com/v1",
              apiStyle: "openai-responses",
              defaultModel: "gpt-5.4",
              apiKey: "fixture-not-a-real-key",
            },
          ],
        },
        {},
        {
          secretStore: Object.assign(new SecretStoreService(), {
            getSecret: () => undefined,
            isAvailable: () => false,
          }),
          modelUsageAccounting: new ModelUsageAccountingService(
            storage.modelUsageEvents,
            "connected-execution",
            60_000,
            60_000,
          ),
        },
      );
      const completionHooks: string[] = [];
      const completionHost = {
        llmService: llm,
        config: { assistant: { memory: { enabled: false, qmd: { enabled: false, applyToChat: false } } } },
        memoryLifecycleService: { composeContext: vi.fn() },
        hooksService: {
          runInlineHooks: async ({ trigger }: { trigger: string }) => { completionHooks.push(trigger); return { runs: [] }; },
          enqueueAfterHooks: vi.fn(), hasMutateHook: () => false,
        },
        resolveMemoryWorkspaceRelativeDir: async () => "workspace",
        resolveChatCompletionHookWorkspaceId: async () => "default",
        persistContextManifestForCompletionRequest: vi.fn(), resolveFallbackTargets: () => [],
        recordDevDiagnostic: vi.fn(), publishRealtime: vi.fn(),
      } as unknown as GovernedLlmCompletionHost;
      let toolInvocations = 0;
      let approvedToolInvocations = 0;
      const toolProvider = vi.fn(async () => new Response(JSON.stringify({ id: "tool-helper-response", model: "gpt-5.4",
        status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Helper completed." }] }],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 11 },
      }), { headers: { "content-type": "application/json" } }));
      const callToolHelper = async () => {
        await llm.chatCompletions({ providerId: "openai", model: "gpt-5.4", max_tokens: 16,
          messages: [{ role: "user", content: "Governed tool helper request" }] }, { callKind: "utility" });
      };
      writeFileSync(join(root, "note.txt"), "The retained file result is Orion 7.", "utf8");
      const executionOwners = createRemoteWorkerExecutionOwners({
        storage: asyncStorage,
        llm,
        completionHost,
        dispatchOwnerId: "connected-execution",
        ...profileAuthority,
        artifactRoot: join(root, "cas"),
        executeApprovedAction: async (input) => {
          expect(approvedCase).toBe(true);
          if (mcpFixture) {
            approvedToolInvocations++;
            return await mcpFixture.executeApprovedAction(input);
          }
          expect(input.runtimeOwner).toEqual({ kind: "builtin", bindingHash: sha256("fixture-fs-read-owner") });
          return await executeApprovedExternalRuntimeSideEffect({ storage: asyncStorage, approvalId: input.approvalId,
            request: toToolInvokeRequest(input.pending.request, input.signal), execute: async () => {
              await input.checkExecution();
              if (toolModelCase) await callToolHelper();
              approvedToolInvocations++;
              return { outcome: "executed", policyReason: "Controlled approved read", auditEventId: "controlled-approved-read",
                result: { text: readFileSync(join(root, "note.txt"), "utf8") } };
            },
          });
        },
        coordinator: {
          invokeTool: async (request, options) => {
            if (!toolsCase) throw new Error("Text-only fixture must not dispatch a tool.");
            expect(request).toMatchObject({ toolName: canonicalToolName, args: { path: "note.txt" },
              sessionId: "session-connected-worker", turnId: "turn-connected-worker" });
            if (mcpFixture) {
              toolInvocations++;
              return await mcpFixture.coordinator.invokeTool(request, options);
            }
            await options!.executionFence!();
            await expect(llm.runWithDispatchGuard(async () => {}, () => llm.chatCompletions({
              providerId: "openai", model: "gpt-5.4", max_tokens: 16,
              messages: [{ role: "user", content: "Foreign tool-side request" }],
            }, { workerId: "foreign-worker" }))).rejects.toThrow("Model usage conflicts with its governed execution lineage.");
            if (toolModelCase && !approvalCase) await callToolHelper();
            toolInvocations++;
            options!.externalSideEffect!.markNotRequired();
            if (approvalCase) {
              const approval = await asyncStorage.approvals.create({ kind: "tool.invoke", riskLevel: "caution",
                payload: {}, preview: {}, linkage: { workspaceId: request.workspaceId, sessionId: request.sessionId,
                  turnId: request.turnId, runId: request.runId, taskId: request.taskId, toolName: request.toolName },
              });
              await asyncStorage.pendingApprovalActions.upsertPending({
                approvalId: approval.approvalId, actionType: "tool.invoke", request: { ...request },
              });
              return { outcome: "approval_required", approvalId: approval.approvalId,
                policyReason: "Controlled approval required", auditEventId: "controlled-approval" };
            }
            return { outcome: "executed", policyReason: "Controlled read permission", auditEventId: "controlled-read",
              result: { text: readFileSync(join(root, "note.txt"), "utf8") },
            };
          },
        },
      });
      const ownerErrors: string[] = [];
      const composed = await composeGatewayHandler(db, tls.config, ownerErrors, executionOwners,
        new RemoteWorkerChatApprovalWaitReadService(asyncStorage));
      const timings: Array<{ path: string; elapsedMs?: number; phase: string }> = [];
      const listener = await startRemoteWorkerNativeTlsListener(tls.config, async (request) => {
        const started = performance.now();
        timings.push({ path: request.rawPath, phase: "start" });
        try {
          return await composed.handler(request);
        } finally {
          timings.push({ path: request.rawPath, phase: "finish", elapsedMs: Math.round(performance.now() - started) });
        }
      });
      openHandles.push(listener);
      const ticketFile = join(root, "ticket.json"),
        stateDir = join(root, "worker-state");
      writeFileSync(ticketFile, JSON.stringify(bootstrap.ticket), "utf8");
      const common = {
        root,
        port: portOf(listener.address),
        paths: tls.paths,
        ticketFile,
        stateDir,
        executionMode: "gateway_inference" as const,
      };
      const admit = await runWorkerProcess({ ...common, runId: "admit", stopAfter: "admit" });
      expect({ exit: admit.exitCode, report: admit.report.error, ownerErrors }).toEqual({
        exit: 0,
        report: undefined,
        ownerErrors: [],
      });
      const generation = composed.admissions.findCurrentGeneration("default", String(bootstrap.ticket.workerId))!;
      const evidence = composed.admissions.findProtectedAdmissionEvidenceRecord(
        "default",
        generation.workerId,
        generation.workerGeneration,
      )!;
      const meshJoinCredential = randomBytes(32).toString("base64url");
      composed.meshNodeAdmissions.issueJoinAuthority({
        registryWorkspaceId: generation.registryWorkspaceId,
        bootstrapId: generation.bootstrapId,
        workerId: generation.workerId,
        workerGeneration: generation.workerGeneration,
        nodeId: generation.nodeId,
        clientCertificateSha256: generation.clientCertificateSha256,
        protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
        protectedAdmissionContextSha256: evidence.contextSha256,
        workspaceId: "default",
        expiresInSeconds: 300,
        issuedByActorId: "operator-a",
        idempotencyKey: "join-execution",
        rawMeshNodeCredential: meshJoinCredential,
      });
      writeFileSync(ticketFile, JSON.stringify({ ...bootstrap.ticket, meshJoinCredential }), "utf8");
      storage.remoteWorkerBudgets.createGrant(
        {
          grantId: "connected-execution-grant",
          registryWorkspaceId: "default",
          executionWorkspaceId: "default",
          workerId: generation.workerId,
          workerGeneration: generation.workerGeneration,
          // Reserve primary + recovery before each task. After one settled
          // request, a three-request grant can admit the second task safely.
          maxRequests: toolModelCase ? 4 : authorityCase === "continuous" || toolsCase ? 3 : 2,
          maxCostMicrousd: 50_000_000,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        "operator-a",
      );
      let placedExecution: RemoteWorkerChatExecution | undefined;
      const offer = seededOffer ?? await (async () => {
        // A real idle worker joins the mesh before ordinary Chat chooses its
        // execution location. No pre-seeded assignment exists in this scenario.
        const ready = await runWorkerProcess({ ...common, runId: "placement-ready", stopAfter: "workload" });
        expect(ready.exitCode, ready.stderr).toBe(0);
        expect(ready.report).toMatchObject({ outcome: "stopped", awaiting: "assignment_offer" });
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignments")).toBe(0);
        const run = storage.durableRuns.getRun(placementSeed!.durableRunId);
        const profile = storage.chatTurnCapabilityProfiles.findByRun(run.runId)!;
        const placement = new RemoteWorkerChatPlacementService({
          storage: asyncStorage, enabled: true, registryWorkspaceId: "default",
          artifactRoot: join(root, "cas"), pathJailSha256: placementSeed!.offerInput.pathJailSha256,
          ...profileAuthority,
        });
        placedExecution = await placement.resolve(run, {
          workspaceId: profile.identity.workspaceId, session: { sessionId: profile.identity.sessionId },
          turnId: profile.identity.turnId, capabilityProfile: profile, assistantMessageId: run.payload!.assistantMessageId,
        } as PreparedAgentChatTurn);
        expect(placedExecution).toBeDefined();
        const selected = storage.chatExecutionPlacements.get(run.runId)!;
        expect(selected.executionKind).toBe("remote_worker");
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignments")).toBe(1);
        return { assignmentId: selected.assignmentId!, durableRunId: run.runId, offerInput: placementSeed!.offerInput };
      })();
      const providerSignals: boolean[] = [];
      const provider = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(completionHooks).toContain("gateway.dispatch.before");
        expect(completionHooks).toContain("llm.request.before");
        timings.push({ path: "controlled-provider", phase: "start" });
        const providerBody = JSON.parse(String(init?.body));
        if (toolsCase)
          expect(providerBody.tools).toEqual([expect.objectContaining({ type: "function", name: modelToolName })]);
        if (toolsCase && provider.mock.calls.length === 2) {
          expect(providerBody.input).toContainEqual(expect.objectContaining({
            type: "function_call", call_id: "call-read", name: modelToolName, arguments: ' {"path":"note.txt"} ',
          }));
          expect(providerBody.input).toContainEqual(expect.objectContaining({
            type: "function_call_output", call_id: "call-read",
            output: expect.stringContaining("The retained file result is Orion 7."),
          }));
        }
        const providerInput = canonicalJsonString({
          input: providerBody.input ?? providerBody.messages,
          instructions: providerBody.instructions,
        });
        for (const message of CONNECTED_WORKER_CONTEXT_MESSAGES) {
          expect(providerInput).toContain(String(message.content));
        }
        const currentOffer = secondOffer && provider.mock.calls.length === 2 ? secondOffer : offer;
        const currentParent = storage.durableRuns.getRun(currentOffer.durableRunId);
        const renewed = storage.durableRuns.renewLeaseWithDatabaseClock({
          runId: currentOffer.durableRunId,
          workerId: currentParent.leaseOwnerId!,
          leaseDurationMs: 300_000,
        });
        expect(renewed?.version).toBe(currentParent.version + 1);
        if (authorityCase === "parent_takeover") {
          db.prepare("UPDATE durable_runs SET lease_owner_id = 'different-owner' WHERE run_id = ?").run(
            offer.durableRunId,
          );
        } else if (authorityCase === "parent_expiry") {
          db.prepare("UPDATE durable_runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?").run(
            offer.durableRunId,
          );
        }
        // Span the former handler and client socket deadlines while the parent
        // advances an ordinary heartbeat. Continuous ownership keeps the call alive.
        await new Promise((resolve) => setTimeout(resolve, authorityCase === "heartbeat" ? 32_500 : 1_250));
        timings.push({ path: "controlled-provider", phase: "finish" });
        providerSignals.push(init?.signal?.aborted === true);
        expect(init?.signal?.aborted).toBe(authorityCase === "parent_takeover" || authorityCase === "parent_expiry");
        return new Response(
          JSON.stringify({
            id: "controlled-response",
            model: "gpt-5.4",
            status: "completed",
            output: toolsCase && provider.mock.calls.length === 1 ? [{
              type: "function_call", id: "fc-read", call_id: "call-read", name: modelToolName,
              arguments: ' {"path":"note.txt"} ',
            }] : [
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: toolsCase ? "The file says Orion 7." : `The connected worker completed ${currentOffer.assignmentId}.` },
                ],
              },
            ],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 10,
              total_tokens: 20,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) =>
        mcpFixture?.isMcpRequest(url) ? mcpFixture.fetchMcp(url, init)
          : String(init?.body).includes("Governed tool helper request") ? toolProvider() : provider(url, init));
      if (authorityCase.startsWith("continuous")) {
        const continuous = await runWorkerProcess({
          ...common,
          runId: "continuous",
          stopAfter: "complete",
          runMode: "continuous",
          stopWhenReport: (report) => report.awaiting === "assignment_offer",
        });
        if (authorityCase === "continuous_budget_exhausted") {
          expect(continuous.exitCode).toBe(1);
          expect(continuous.report, JSON.stringify({ report: continuous.report, ownerErrors })).toMatchObject({
            outcome: "failed",
            recoveryRequired: true,
            lastReport: {
              outcome: "stopped",
              inferenceStatus: "blocked",
              stagesCompleted: ["admit", "claim", "workload", "inference"],
            },
          });
          expect(provider).toHaveBeenCalledOnce();
          expect(ownerErrors).toEqual([]);
          expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(1);
          expect(
            countRows(
              db,
              "SELECT COUNT(*) AS count FROM remote_worker_inference_requests WHERE block_reason = 'budget_denied'",
            ),
          ).toBe(1);
          expect(storage.remoteWorkerBudgets.listGrants("default", "default")[0]).toMatchObject({
            heldRequests: 0,
            settledRequests: 1,
            availableRequests: 1,
          });
          return;
        }
        expect(
          { error: continuous.report.error, ownerErrors },
          JSON.stringify({
            report: continuous.report,
            timings,
            operations: db
              .prepare("SELECT assignment_id, state, block_reason FROM remote_worker_inference_requests")
              .all(),
            usage: db.prepare("SELECT transport_status, terminal_outcome FROM model_usage_events").all(),
          }),
        ).toEqual({ error: undefined, ownerErrors: [] });
        expect(continuous.report).toMatchObject({ outcome: "stopped", awaiting: "assignment_offer" });
        expect(provider).toHaveBeenCalledTimes(2);
        expect(providerSignals).toEqual([false, false]);
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(2);
        expect(
          countRows(db, "SELECT COUNT(DISTINCT result_sha256) AS count FROM remote_worker_assignment_settlements"),
        ).toBe(2);
        expect(countRows(db, "SELECT COUNT(*) AS count FROM model_usage_events")).toBe(2);
        expect(storage.remoteWorkerBudgets.listGrants("default", "default")[0]).toMatchObject({
          heldRequests: 0,
          settledRequests: 2,
        });
        const receipts = JSON.parse(readFileSync(join(stateDir, "settlement-receipts.json"), "utf8")) as Array<{
          assignmentId: string;
        }>;
        expect(receipts.map((receipt) => receipt.assignmentId).sort()).toEqual(
          [offer.assignmentId, secondOffer!.assignmentId].sort(),
        );
        // Killing an idle continuous owner must release process ownership; a
        // restart polls for new work without replaying either terminal assignment.
        const restarted = await runWorkerProcess({ ...common, runId: "continuous-restart", stopAfter: "complete" });
        expect(restarted.exitCode, restarted.stderr).toBe(0);
        expect(restarted.report).toMatchObject({ outcome: "stopped", awaiting: "assignment_offer" });
        expect(provider).toHaveBeenCalledTimes(2);
        return;
      }
      if (authorityCase === "parent_recovery") {
        const initial = await runWorkerProcess({ ...common, runId: "before-parent-recovery", stopAfter: "inference" });
        expect(initial.exitCode, JSON.stringify({ report: initial.report, ownerErrors })).toBe(0);
        expect(initial.report).toMatchObject({ outcome: "stopped", inferenceStatus: "completed" });
        expect(provider).toHaveBeenCalledOnce();
        const before = storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!;
        const previous = storage.durableRuns.getRun(offer.durableRunId);
        storage.durableRuns.updateRun({ runId: previous.runId, status: "running", expectedVersion: previous.version,
          leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
        const ctx = { storage: asyncStorage, requireFeatureEnabled: vi.fn(), publishRealtime: vi.fn() } as unknown as ServiceContext;
        const durable = new DurableRunService(ctx, { backgroundTasks: new Set(), workflowRegistry: {
          executeWorkflow: vi.fn(), isWorkflowRecoverable: () => ({ recoverable: true }), markWorkflowUnrecoverable: vi.fn(),
        } });
        expect(await (durable as unknown as { reconcileRecoverableRuns(): Promise<number> }).reconcileRecoverableRuns()).toBe(1);
        const parked = await runWorkerProcess({ ...common, runId: "parent-recovery-pending", stopAfter: "inference" });
        expect(parked.exitCode, JSON.stringify({ report: parked.report, ownerErrors })).toBe(0);
        expect(parked.report).toMatchObject({ reconnectSync: "parent_recovery_pending", awaiting: "parent_recovery" });
        expect(storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!.lease).toEqual(before.lease);
        const replacement = storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({ runId: previous.runId,
          workerId: "gateway-parent-recovery", leaseDurationMs: 300_000 })!;
        expect(replacement.attemptCount).toBe(previous.attemptCount);
        const profile = storage.chatTurnCapabilityProfiles.findByRun(replacement.runId)!;
        const prepared = { workspaceId: profile.identity.workspaceId, session: { sessionId: profile.identity.sessionId },
          turnId: profile.identity.turnId, capabilityProfile: profile,
          assistantMessageId: replacement.payload!.assistantMessageId } as PreparedAgentChatTurn;
        const parentService = new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas"));
        const parent = (await parentService.resolve(replacement, prepared))!;
        const parentAbort = new AbortController();
        let parentSettled = false;
        let parentError: unknown;
        const parentResult = parent.stream({ signal: parentAbort.signal,
          canonicalWriteFence: work => asyncStorage.runImmediateTransaction(async () => {
            if (!await asyncStorage.durableRuns.lockFreshActiveLeaseForUpdate(replacement.runId, replacement.leaseOwnerId!))
              throw new Error("Recovered native parent claim lost.");
            return await work();
          }),
        }).next().then(value => { parentSettled = true; return { value }; }, error => {
          parentSettled = true; parentError = error; return { error };
        });
        try {
          const ref = { registryWorkspaceId: "default", assignmentId: offer.assignmentId,
            assignmentGeneration: before.generation!.assignmentGeneration };
          await vi.waitFor(() => {
            if (parentError) throw parentError;
            expect(storage.remoteWorkerAssignments.findChatParentRecovery(ref)?.material)
              .toMatchObject({ recoveryRevision: 1, priorLeaseRevision: before.lease!.leaseRevision,
                dispatchAuthority: { dispatchOwnerId: replacement.leaseOwnerId } });
          });
          expect(() => storage.remoteWorkerAssignments.bindChatParentRecoveryDispatch({ ...ref,
            durableRunId: previous.runId, leaseOwnerId: previous.leaseOwnerId!, attemptCount: previous.attemptCount })).toThrow();
          const resumed = await runWorkerProcess({ ...common, runId: "parent-recovery-resumed", stopAfter: "inference" });
          expect(resumed.exitCode, JSON.stringify({ report: resumed.report, ownerErrors })).toBe(0);
          expect(resumed.report).toMatchObject({ reconnectSync: "parent_recovery_ready", inferenceStatus: "completed" });
          const after = storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!;
          expect(after.generation).toEqual(before.generation);
          expect(after.lease!.leaseRevision).toBeGreaterThan(before.lease!.leaseRevision);
          expect(after.lease!.parentDispatchAuthority.dispatchOwnerId).toBe(replacement.leaseOwnerId);
          expect(provider).toHaveBeenCalledOnce();
          expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_artifact_manifests")).toBe(0);
          expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(0);
          expect(parentSettled, "Recovered parent must await the worker artifact and settlement.").toBe(false);
        } finally { parentAbort.abort(); await parentResult; }
        placedExecution = (await parentService.resolve(replacement, prepared))!;
      }
      if (toolsCase) {
        const pending = await runWorkerProcess({ ...common, runId: "pending-tool", stopAfter: "inference" });
        expect(pending.exitCode, JSON.stringify({ report: pending.report, ownerErrors })).toBe(0);
        expect(pending.report).toMatchObject({ inferenceStatus: "requires_tools", pendingToolCallCount: 1 });
        expect(toolInvocations).toBe(0);
        mcpFixture?.restartRequester();
        const mcpMethodsBefore = mcpFixture?.readEvidence().methods;
        if (authorityCase === "tool_mcp_revoked") mcpFixture!.revokeRequester();
        const toolsRun = await runWorkerProcess({ ...common, runId: "tools", stopAfter: "tools" });
        if (authorityCase === "tool_mcp_revoked") {
          expect(toolsRun.report.toolStatus).not.toBe("completed");
          expect(toolsRun.report.outcome).not.toBe("completed");
          expect(mcpFixture!.readEvidence().revokedAuthReads).toBeGreaterThan(0);
          expect(mcpFixture!.readEvidence().methods).toEqual(mcpMethodsBefore);
          expect(mcpFixture!.calls()).toBe(0);
          expect(toolInvocations).toBe(0);
          expect(provider).toHaveBeenCalledOnce();
          expect(storage.remoteWorkerEffects.listIntents("default", offer.assignmentId, 1)).toEqual([]);
          expect(storage.chatToolRuns.listByTurn("turn-connected-worker")).toEqual([]);
          expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_artifact_manifests")).toBe(0);
          expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(0);
          expect(storage.remoteWorkerBudgets.listGrants("default", "default")[0]).toMatchObject({ heldRequests: 0, settledRequests: 1 });
          return;
        }
        expect(toolsRun.exitCode, JSON.stringify({ report: toolsRun.report, ownerErrors })).toBe(0);
        if (approvalCase) {
          expect(toolsRun.report).toMatchObject({ outcome: "stopped", toolStatus: "waiting_approval",
            awaiting: "approval_resolution", pendingToolCallCount: 1 });
          const recovered = await runWorkerProcess({ ...common, runId: "approval-recovered", stopAfter: "tools" });
          expect(recovered.exitCode, JSON.stringify({ report: recovered.report, ownerErrors })).toBe(0);
          expect(recovered.report).toMatchObject({ toolStatus: "waiting_approval", awaiting: "approval_resolution" });
          expect(toolInvocations).toBe(1);
          expect(provider).toHaveBeenCalledOnce();
          const intents = storage.remoteWorkerEffects.listIntents("default", offer.assignmentId, 1);
          expect(intents).toHaveLength(1);
          expect(storage.remoteWorkerEffects.findSettlement("default", offer.assignmentId, 1, intents[0]!.intentId)).toBeUndefined();
          const prepared = await verifyCanonicalApprovalWait(storage, root, offer.assignmentId);
          const parked = storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!;
          const parkedRun = storage.durableRuns.getRun(parked.assignment.manifest.durableRunId);
          const waitingRestart = await runWorkerProcess({ ...common, runId: "parked-restart", stopAfter: "complete" });
          expect(waitingRestart.exitCode, JSON.stringify({ report: waitingRestart.report, ownerErrors })).toBe(0);
          expect(waitingRestart.report).toMatchObject({ outcome: "stopped", reconnectSync: "waiting_approval",
            awaiting: "approval_resolution", stagesCompleted: ["admit"] });
          expect(storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)).toEqual(parked);
          expect(storage.durableRuns.getRun(parkedRun.runId)).toEqual(parkedRun);
          expect(toolInvocations).toBe(1);
          expect(provider).toHaveBeenCalledOnce();
          expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_artifact_manifests")).toBe(0);
          expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(0);
          const tool = storage.chatToolRuns.get(`remote-tool:${intents[0]!.intentId}`);
          const approvalId = tool.approvalId!;
          mcpFixture?.restartRequester();
          storage.approvals.resolve(approvalId, { decision: approvedCase ? "approve" : "reject", resolvedBy: "controlled-operator" });
          if (!approvedCase) storage.pendingApprovalActions.markResolved(approvalId, "rejected", { decision: "reject" });
          storage.chatInlineApprovals.upsert({ ...storage.chatInlineApprovals.get(approvalId)!, status: approvedCase ? "approved" : "denied" });
          const ctx = { storage: asyncStorage, requireFeatureEnabled: vi.fn(), publishRealtime: vi.fn() } as unknown as ServiceContext;
          const durable = new DurableRunService(ctx, {
            backgroundTasks: new Set(), workflowRegistry: { executeWorkflow: vi.fn(),
              isWorkflowRecoverable: () => ({ recoverable: true }), markWorkflowUnrecoverable: vi.fn() },
            // Notification/post-commit callbacks are controlled; the actual
            // durable owner records and verifies their waiting-generation ledger.
            onGeneralChatPostCommit: async (_run, progress) => {
              for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) await progress.runEffect(effect, async () => {});
            },
          });
          expect(await durable.reconcileGeneralChatPostCommit(parkedRun.runId)).toBe(true);
          const approvalProcessor = new ApprovalEffectsService(ctx, {
            backgroundTasks: new Set(), wakeDurableRun: (id, event) => durable.wakeDurableRun(id, event), requestRunProcessing: vi.fn(),
            executeApprovedPendingAction: async () => {
              if (approvedCase) throw new RemoteWorkerApprovalResumeRequiredError();
              throw new Error("Rejected action must not execute.");
            },
            prepareRemoteWorkerApprovalHandoff: id => prepareRemoteWorkerChatApprovalHandoff(asyncStorage, id),
            shouldDeferRemoteWorkerApprovalWake: (id, approval) => shouldDeferRemoteWorkerChatApprovalWake(asyncStorage, id, approval),
            findProactiveDurableRunIdsForApproval: async () => [], executeCodeModePendingApproval: vi.fn(), enqueueAfterHooks: vi.fn(),
            resolveApprovalHookWorkspaceId: () => "default", resolvePostCommitEligibility: () => ({ version: 1,
              autonomyEnabledAtParentSettlement: false, evalIntegrityTurn: false, humanSession: true }),
            recordApprovalResolutionSignals: vi.fn(),
          }) as unknown as { workerId: string; handleLinkedChatTurnWake(effect: ApprovalEffectRecord): Promise<void>;
            handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void> };
          if (approvedCase) {
            const action = storage.approvalEffects.upsert({ approvalId, effectKind: "pending_action_execute", targetKind: "pending_action",
              targetId: approvalId, payload: {} });
            const actionAt = storage.durableRuns.readDatabaseNow();
            const actionClaim = storage.approvalEffects.claimNextPendingEffect(approvalProcessor.workerId, actionAt,
              new Date(Date.parse(actionAt) + 60_000).toISOString())!;
            expect(actionClaim.effectId).toBe(action.effectId);
            await approvalProcessor.handlePendingActionExecute(actionClaim);
            expect(storage.approvalEffects.get(action.effectId)).toMatchObject({ status: "skipped" });
            expect(approvedToolInvocations).toBe(0);
          }
          storage.approvalEffects.upsert({ approvalId, effectKind: "linked_chat_turn_wake", targetKind: "chat_turn",
            targetId: prepared.turnId, payload: { runId: parkedRun.runId, correlationId: approvalId } });
          const claimAt = storage.durableRuns.readDatabaseNow();
          const wakeClaim = storage.approvalEffects.claimNextPendingEffect(approvalProcessor.workerId, claimAt,
            new Date(Date.parse(claimAt) + 60_000).toISOString())!;
          await approvalProcessor.handleLinkedChatTurnWake(wakeClaim);
          expect(storage.approvalEffects.get(wakeClaim.effectId)).toMatchObject({ status: "completed", result: { outcome: "woke" } });
          const claimed = storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({ runId: parkedRun.runId,
            workerId: "gateway-approval-continuation", leaseDurationMs: 300_000 })!;
          const parent = (await new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas")).resolve(claimed, prepared))!;
          const parentAbort = new AbortController();
          let parentSettled = false;
          const parentResult = parent.stream({ signal: parentAbort.signal,
            canonicalWriteFence: work => asyncStorage.runImmediateTransaction(async () => {
              if (!await asyncStorage.durableRuns.lockFreshActiveLeaseForUpdate(claimed.runId, claimed.leaseOwnerId!))
                throw new Error("Native fixture parent claim lost.");
              return await work();
            }),
          }).next().then(value => { parentSettled = true; return { value }; }, error => { parentSettled = true; return { error }; });
          try {
            await vi.waitFor(() => expect(storage.remoteWorkerAssignments.findChatApprovalResume({ registryWorkspaceId: "default",
              assignmentId: offer.assignmentId, assignmentGeneration: parked.generation!.assignmentGeneration })?.binding?.dispatchOwnerId)
              .toBe(claimed.leaseOwnerId));
            const resumed = await runWorkerProcess({ ...common, runId: "approval-resume", stopAfter: approvedCase ? "workload" : "tools" });
            expect(resumed.exitCode, JSON.stringify({ report: resumed.report, ownerErrors })).toBe(0);
            expect(resumed.report).toMatchObject(approvedCase ? { outcome: "stopped", reconnectSync: "approval_resume_ready" }
              : { outcome: "stopped", toolStatus: "completed", pendingToolCallCount: 0, awaiting: "model_continuation" });
            const rotated = storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!;
            expect(rotated.generation?.assignmentGeneration).toBe(parked.generation!.assignmentGeneration);
            expect(rotated.lease!.leaseRevision).toBeGreaterThan(parked.lease!.leaseRevision);
            if (approvedCase) {
              // Lose the parent again before the approved read. The next native
              // process must execute under the additional recovery binding.
              expect(approvedToolInvocations).toBe(0);
              expect(storage.remoteWorkerEffects.findSettlement("default", offer.assignmentId, 1, intents[0]!.intentId)).toBeUndefined();
            } else {
              expect(storage.remoteWorkerEffects.findSettlement("default", offer.assignmentId, 1, intents[0]!.intentId)?.receipt.receiptState)
                .toBe("blocked_before_dispatch");
              const replayed = await runWorkerProcess({ ...common, runId: "declined-replay", stopAfter: "tools" });
              expect(replayed.exitCode, JSON.stringify({ report: replayed.report, ownerErrors })).toBe(0);
              expect(replayed.report).toMatchObject({ toolStatus: "completed", awaiting: "model_continuation" });
            }
            expect(toolInvocations).toBe(1);
            expect(provider).toHaveBeenCalledOnce();
            expect(storage.pendingApprovalActions.find(approvalId)?.resolutionStatus).toBe(approvedCase ? "pending" : "rejected");
            expect(parentSettled, "The Chat dispatcher must not emit the resolved approval again.").toBe(false);
            expect(storage.chatTurnTraces.get(prepared.turnId).status).toBe("running");
          } finally {
            parentAbort.abort();
            await parentResult;
          }
          const beforeRecovery = storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!;
          const previousParent = storage.durableRuns.getRun(parkedRun.runId);
          storage.durableRuns.updateRun({ runId: previousParent.runId, status: "running", expectedVersion: previousParent.version,
            leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
          const recovery = durable as unknown as { reconcileRecoverableRuns(): Promise<number> };
          expect(await recovery.reconcileRecoverableRuns()).toBe(1);
          const awaitingParent = await runWorkerProcess({ ...common, runId: "declined-parent-pending", stopAfter: "tools" });
          expect(awaitingParent.exitCode, JSON.stringify({ report: awaitingParent.report, ownerErrors })).toBe(0);
          expect(awaitingParent.report).toMatchObject({ reconnectSync: "approval_resume_pending", awaiting: "approval_resolution" });
          expect(storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!.lease)
            .toEqual(beforeRecovery.lease);
          const replacement = storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({ runId: previousParent.runId,
            workerId: "gateway-after-another-restart", leaseDurationMs: 300_000 })!;
          expect(replacement.attemptCount).toBe(previousParent.attemptCount);
          const nextParent = (await new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas")).resolve(replacement, prepared))!;
          const nextAbort = new AbortController();
          let nextSettled = false;
          const nextResult = nextParent.stream({ signal: nextAbort.signal,
            canonicalWriteFence: work => asyncStorage.runImmediateTransaction(async () => {
              if (!await asyncStorage.durableRuns.lockFreshActiveLeaseForUpdate(replacement.runId, replacement.leaseOwnerId!))
                throw new Error("Recovered native fixture parent claim lost.");
              return await work();
            }),
          }).next().then(value => { nextSettled = true; return { value }; }, error => { nextSettled = true; return { error }; });
          try {
            const ref = { registryWorkspaceId: "default", assignmentId: offer.assignmentId,
              assignmentGeneration: parked.generation!.assignmentGeneration };
            await vi.waitFor(() => expect(storage.remoteWorkerAssignments.findChatApprovalResume(ref)?.recovery?.material)
              .toMatchObject({ recoveryRevision: 1, priorLeaseRevision: beforeRecovery.lease!.leaseRevision,
                dispatchAuthority: { dispatchOwnerId: replacement.leaseOwnerId } }));
            expect(() => storage.remoteWorkerAssignments.bindChatApprovalResumeDispatch({ ...ref,
              durableRunId: previousParent.runId, leaseOwnerId: previousParent.leaseOwnerId!, attemptCount: previousParent.attemptCount }))
              .toThrow();
            const recoveredWorker = await runWorkerProcess({ ...common, runId: "approval-parent-recovered", stopAfter: "tools" });
            expect(recoveredWorker.exitCode, JSON.stringify({ report: recoveredWorker.report, ownerErrors })).toBe(0);
            expect(recoveredWorker.report).toMatchObject({ toolStatus: "completed", awaiting: "model_continuation" });
            const afterRecovery = storage.remoteWorkerAssignments.findAssignmentAggregate("default", offer.assignmentId)!;
            expect(afterRecovery.generation).toEqual(beforeRecovery.generation);
            expect(afterRecovery.lease!.leaseRevision).toBeGreaterThan(beforeRecovery.lease!.leaseRevision);
            expect(storage.remoteWorkerEffects.findSettlement("default", offer.assignmentId, 1, intents[0]!.intentId)?.receipt.receiptState)
              .toBe(approvedCase ? mcpCase ? "completed_with_effect" : "completed_no_effect" : "blocked_before_dispatch");
            expect(approvedToolInvocations).toBe(approvedCase ? 1 : 0);
            expect(storage.pendingApprovalActions.find(approvalId)?.resolutionStatus).toBe(approvedCase ? "executed" : "rejected");
            expect(toolInvocations).toBe(1);
            expect(provider).toHaveBeenCalledOnce();
            expect(nextSettled, "Recovered Chat must keep waiting for the next model result.").toBe(false);
          } finally {
            nextAbort.abort();
            await nextResult;
          }
          if (!approvedCase) return;
        }
        if (!approvedCase) expect(toolsRun.report, JSON.stringify({ report: toolsRun.report, ownerErrors })).toMatchObject({
          outcome: "stopped", inferenceStatus: "requires_tools", pendingToolCallCount: 0,
          toolStatus: "completed", awaiting: "model_continuation",
        });
        const recovered = await runWorkerProcess({ ...common, runId: "tools-recovered", stopAfter: "tools" });
        expect(recovered.exitCode, JSON.stringify({ report: recovered.report, ownerErrors })).toBe(0);
        expect(recovered.report).toMatchObject({
          outcome: "stopped", inferenceStatus: "requires_tools", pendingToolCallCount: 0,
          toolStatus: "completed", awaiting: "model_continuation",
        });
        expect(provider).toHaveBeenCalledOnce();
        expect(toolInvocations).toBe(1);
        const intents = storage.remoteWorkerEffects.listIntents("default", offer.assignmentId, 1);
        expect(intents).toHaveLength(1);
        expect(storage.remoteWorkerEffects.findSettlement("default", offer.assignmentId, 1, intents[0]!.intentId)?.receipt.receiptState)
          .toBe(mcpCase ? "completed_with_effect" : "completed_no_effect");
        const completedTool = storage.chatToolRuns.get(`remote-tool:${intents[0]!.intentId}`);
        expect(completedTool).toMatchObject({
          status: "executed", toolName: canonicalToolName,
          ...(!mcpCase ? { result: { text: "The retained file result is Orion 7." } } : {}),
        });
        expect(JSON.stringify(completedTool.result)).toContain("The retained file result is Orion 7.");
        if (mcpFixture) expect(mcpFixture.calls()).toBe(1);
        expect(countRows(db, "SELECT COUNT(*) AS count FROM model_usage_events WHERE transport_status = 'accepted'")).toBe(toolModelCase ? 2 : 1);
        expect(countRows(db, "SELECT COUNT(*) AS count FROM model_usage_events WHERE dispatch_reconciliation = 'confirmed_not_dispatched'")).toBe(0);
        const toolUsage = storage.remoteWorkerBudgets.listToolAttempts({ registryWorkspaceId: "default",
          assignmentId: offer.assignmentId, assignmentGeneration: 1, intentId: intents[0]!.intentId });
        expect(toolUsage).toHaveLength(toolModelCase ? 1 : 0);
        if (toolModelCase) {
          expect(toolProvider).toHaveBeenCalledOnce();
          expect(toolUsage[0]).toMatchObject({ workerId: generation.workerId, durableRunId: offer.durableRunId,
            callKind: "utility", terminalOutcome: "succeeded", transportStatus: "accepted",
            parentOperationId: `worker-tool:${intents[0]!.intentId}` });
        }
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_artifact_manifests")).toBe(0);
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(0);
        const request = storage.remoteWorkerInference.getRequestByIdempotency(
          "default", `inference:${offer.assignmentId}:1`,
        )!;
        const terminal = storage.remoteWorkerInference.listFramesAfter({
          registryWorkspaceId: request.registryWorkspaceId, assignmentId: request.assignmentId,
          assignmentGeneration: request.assignmentGeneration, inferenceRequestId: request.inferenceRequestId,
          attempt: request.attempt,
        }, 0).at(-1)!;
        expect(JSON.parse(terminal.payloadJson)).toMatchObject({
          kind: "terminal", terminalState: "completed",
          toolCalls: [{ callId: "call-read", modelToolName, argumentsJson: ' {"path":"note.txt"} ' }],
        });
        if (authorityCase === "tool_withdrawal") {
          callableEntries.splice(0);
          const withdrawn = await runWorkerProcess({ ...common, runId: "tool-withdrawn", stopAfter: "complete" });
          expect(withdrawn.report.toolStatus).not.toBe("completed");
          expect(withdrawn.report.outcome).not.toBe("completed");
          expect(toolInvocations).toBe(1);
          expect(provider).toHaveBeenCalledOnce();
          return;
        }
      }
      const artifactRun = await runWorkerProcess({ ...common, runId: "artifact", stopAfter: "artifact" });
      if (authorityCase === "parent_takeover" || authorityCase === "parent_expiry") {
        expect(providerSignals).toEqual([true]);
        expect(provider).toHaveBeenCalledOnce();
        expect(artifactRun.report.outcome).not.toBe("completed");
        expect(artifactRun.report.outputManifestSha256).toBeUndefined();
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_artifact_manifests")).toBe(0);
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(0);
        expect(timings).toContainEqual({ path: "controlled-provider", phase: "finish" });
        expect(
          countRows(db, "SELECT COUNT(*) AS count FROM model_usage_events WHERE transport_status = 'accepted'"),
        ).toBe(1);
        return;
      }
      expect(
        artifactRun.exitCode,
        JSON.stringify({
          timings,
          error: artifactRun.report.error,
          ownerErrors,
          operation: db
            .prepare("SELECT state, block_reason, budget_authority_state FROM remote_worker_inference_requests")
            .all(),
          usage: db.prepare("SELECT transport_status, terminal_outcome FROM model_usage_events").all(),
        }),
      ).toBe(0);
      expect({
        exit: artifactRun.exitCode,
        error: artifactRun.report.error ?? artifactRun.stderr.slice(-800),
        ownerErrors,
      }).toEqual({ exit: 0, error: "", ownerErrors: [] });
      expect(artifactRun.report).toMatchObject({
        outcome: "stopped",
        inferenceStatus: "completed",
        outputManifestSha256: expect.any(String),
      });
      const expectedProviderCalls = toolsCase ? 2 : 1;
      expect(provider).toHaveBeenCalledTimes(expectedProviderCalls);
      const settledRun = await runWorkerProcess({ ...common, runId: "settled", stopAfter: "settle" });
      expect({
        exit: settledRun.exitCode,
        error: settledRun.report.error ?? settledRun.stderr.slice(-800),
        ownerErrors,
      }).toEqual({ exit: 0, error: "", ownerErrors: [] });
      expect(settledRun.report).toMatchObject({ outcome: "stopped", settlementOutcome: "completed" });
      const recovered = await runWorkerProcess({ ...common, runId: "recovered", stopAfter: "complete" });
      expect({
        exit: recovered.exitCode,
        error: recovered.report.error ?? recovered.stderr.slice(-800),
        ownerErrors,
      }).toEqual({ exit: 0, error: "", ownerErrors: [] });
      expect(recovered.report).toMatchObject({
        outcome: "completed",
        settlement: "recovered",
        settlementOutcome: "completed",
      });
      expect(recovered.report.stagesCompleted).toEqual(["admit", "settle", "complete"]);
      expect(provider).toHaveBeenCalledTimes(expectedProviderCalls);
      expect(toolInvocations).toBe(toolsCase ? 1 : 0);
      expect(approvedToolInvocations).toBe(approvedCase ? 1 : 0);
      expect(countRows(db, "SELECT COUNT(*) AS count FROM model_usage_events")).toBe(expectedProviderCalls + (toolModelCase ? 1 : 0));
      if (mcpFixture) {
        expect(mcpFixture.calls()).toBe(1);
        expect(mcpFixture.readEvidence().arguments).toEqual([{ path: "note.txt" }]);
        expect(JSON.stringify({ report: recovered.report, ownerErrors, toolRuns: storage.chatToolRuns.listByTurn("turn-connected-worker") }))
          .not.toContain("controlled-worker-mcp-secret");
      }
      expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements")).toBe(1);
      expect(storage.remoteWorkerBudgets.listGrants("default", "default")[0]).toMatchObject({
        heldRequests: 0,
        settledRequests: expectedProviderCalls + (toolModelCase ? 1 : 0),
      });
      const operation = storage.remoteWorkerInference.getRequestByIdempotency(
        "default",
        `inference:${offer.assignmentId}:1`,
      )!;
      expect(operation).toMatchObject({ state: "completed", budgetAuthorityState: "settled" });
      const chatRun = storage.durableRuns.getRun(operation.durableRunId!);
      const chatProfile = storage.chatTurnCapabilityProfiles.findByRun(chatRun.runId)!;
      const chatPayload = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: chatRun.workflowKey, durableRunId: chatRun.runId, payload: chatRun.payload,
      })!;
      const preparedChat = {
        workspaceId: chatProfile.identity.workspaceId,
        session: { sessionId: chatProfile.identity.sessionId }, turnId: chatProfile.identity.turnId,
        capabilityProfile: chatProfile, assistantMessageId: chatPayload.assistantMessageId,
        content: chatPayload.request.content,
        userMessage: { messageId: chatPayload.userMessageId, sessionId: chatPayload.sessionId },
        turnAdmission: {
          identity: {
            admissionId: chatPayload.admissionId, sessionIncarnationId: chatPayload.sessionIncarnationId,
            materialSha256: chatPayload.admissionMaterialSha256, workspaceId: chatPayload.workspaceId,
            sessionId: chatPayload.sessionId, turnId: chatPayload.turnId,
            aggregateRevision: chatPayload.admissionAggregateRevision,
            controllerGeneration: chatPayload.admissionControllerGeneration,
          },
          admittedRequest: chatPayload.request as ChatSendMessageRequest, requestActor: chatPayload.requestActor,
        },
      } as PreparedAgentChatTurn;
      const handoff = new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas"));
      const execution = placedExecution ?? (await handoff.resolve(chatRun, preparedChat))!;
      const chatChunks = [];
      for await (const chunk of execution.stream({ signal: new AbortController().signal,
        canonicalWriteFence: async (work) => await asyncStorage.runImmediateTransaction(work),
      })) chatChunks.push(chunk);
      const completed = chatChunks.find((chunk) => chunk.type === "message_done")!;
      if (toolsCase) {
        expect(completed.content).toBe("The file says Orion 7.");
        expect(chatChunks).toContainEqual(expect.objectContaining({ type: "usage", usage: expect.objectContaining({
          inputTokens: toolModelCase ? 30 : 20, outputTokens: toolModelCase ? 21 : 20,
        }) }));
      }
      expect(completed).toMatchObject({ sessionId: preparedChat.session.sessionId,
        turnId: preparedChat.turnId, messageId: preparedChat.assistantMessageId });
      const commitChat = async () => {
        await asyncStorage.chatMessages.upsert({ messageId: preparedChat.assistantMessageId,
          sessionId: preparedChat.session.sessionId, role: "assistant", actorType: "agent", actorId: "assistant",
          content: completed.content, sourceAuthority: "unknown", timestamp: new Date().toISOString() });
        await asyncStorage.chatTurnTraces.patch(preparedChat.turnId, {
          status: "completed", assistantMessageId: preparedChat.assistantMessageId,
        });
        await execution.recordAssistantCommit(preparedChat.assistantMessageId, completed.content);
        await execution.recordAssistantCommit(preparedChat.assistantMessageId, completed.content);
      };
      await expect(execution.recordAssistantCommit(preparedChat.assistantMessageId, completed.content))
        .rejects.toThrow("canonical assistant message");
      await expect(asyncStorage.runImmediateTransaction(async () => {
        await commitChat();
        throw new Error("test rollback after materialization");
      })).rejects.toThrow("test rollback after materialization");
      expect(storage.chatMessages.get(preparedChat.assistantMessageId)).toBeUndefined();
      expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_materializations")).toBe(0);
      await asyncStorage.runImmediateTransaction(commitChat);
      expect(storage.chatMessages.get(preparedChat.assistantMessageId)).toMatchObject({
        content: completed.content, role: "assistant", sessionId: preparedChat.session.sessionId,
      });
      expect(storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
        executionWorkspaceId: preparedChat.workspaceId, sessionId: preparedChat.session.sessionId,
        turnId: preparedChat.turnId, durableRunId: chatRun.runId,
      })!.materialization).toMatchObject({ chatTranscriptCount: 1, count: 1 });
      // The fixture previously stopped at worker settlement. Bind its existing
      // run to canonical retry policy before exercising the real Chat finalizer.
      await asyncStorage.durableRuns.updateRun({ runId: chatRun.runId, status: chatRun.status,
        metadata: { ...chatRun.metadata, retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT } },
        expectedVersion: chatRun.version });
      const finalizer: ChatDurableRunFinalizeDeps = {
        runImmediateTransaction: async (work) => await asyncStorage.runImmediateTransaction(work),
        durableRuns: asyncStorage.durableRuns, chatMessages: asyncStorage.chatMessages,
        chatTurnTraces: asyncStorage.chatTurnTraces, chatToolRuns: asyncStorage.chatToolRuns,
        chatToolArtifacts: asyncStorage.chatToolArtifacts,
        resolvePostCommitEligibility: async () => ({ version: 1, autonomyEnabledAtParentSettlement: false,
          evalIntegrityTurn: false, humanSession: true }),
        recordDurableTimelineEvent: async (runId, eventType, payload) => {
          await asyncStorage.durableRunEvents.append({ eventId: randomUUID(), runId, eventType,
            payload: payload ?? {}, createdAt: new Date().toISOString() });
        },
        recordTerminalResultMaterialization: async (runId, prepared) =>
          await handoff.recordDurableCommit(runId, prepared),
      };
      const completedTrace = await asyncStorage.chatTurnTraces.get(preparedChat.turnId);
      await expect(asyncStorage.runImmediateTransaction(async () => {
        await finalizeDurableChatRun(finalizer, chatRun.runId, preparedChat, completedTrace, chatRun.leaseOwnerId);
        expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_materializations")).toBe(2);
        throw new Error("test rollback after durable result");
      })).rejects.toThrow("test rollback after durable result");
      expect(storage.durableRuns.getRun(chatRun.runId).status).toBe("running");
      expect(storage.durableRuns.getLatestCheckpointByKind(chatRun.runId, "run_completed")).toBeUndefined();
      expect(countRows(db, "SELECT COUNT(*) AS count FROM remote_worker_assignment_materializations")).toBe(1);
      await finalizeDurableChatRun(finalizer, chatRun.runId, preparedChat, completedTrace, chatRun.leaseOwnerId);
      const completedRun = storage.durableRuns.getRun(chatRun.runId);
      expect(completedRun).toMatchObject({ status: "completed", metadata: { outputText: completed.content } });
      finalizer.recordTerminalResultMaterialization = async (runId, prepared) =>
        await new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas")).recordDurableCommit(runId, prepared);
      await finalizeDurableChatRun(finalizer, chatRun.runId, preparedChat, completedTrace);
      expect(storage.durableRuns.getRun(chatRun.runId)).toEqual(completedRun);
      expect(storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
        executionWorkspaceId: preparedChat.workspaceId, sessionId: preparedChat.session.sessionId,
        turnId: preparedChat.turnId, durableRunId: chatRun.runId,
      })!.materialization).toMatchObject({ chatTranscriptCount: 1, durableRunResultCount: 1, count: 2 });
      await expect(asyncStorage.runImmediateTransaction(async () => {
        await asyncStorage.durableRuns.updateRun({ runId: chatRun.runId, status: completedRun.status,
          metadata: { ...completedRun.metadata, finalOutput: "changed terminal output" },
          expectedVersion: completedRun.version });
        await handoff.recordDurableCommit(chatRun.runId, preparedChat);
      })).rejects.toThrow("canonical Chat terminal authority");
      expect(storage.durableRuns.getRun(chatRun.runId)).toEqual(completedRun);
      // A new Gateway service replays canonical output without another model call.
      const replay = (await new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas"))
        .resolve(chatRun, preparedChat))!;
      const replayChunks = [];
      for await (const chunk of replay.stream({ signal: new AbortController().signal,
        canonicalWriteFence: async (work) => await asyncStorage.runImmediateTransaction(work),
      })) replayChunks.push(chunk);
      expect(replayChunks).toEqual(chatChunks);
      await expect(execution.recordAssistantCommit(preparedChat.assistantMessageId, "changed output"))
        .rejects.toThrow("verified settlement binding");
      const idle = await runWorkerProcess({ ...common, runId: "idle", stopAfter: "complete" });
      expect(idle.report).toMatchObject({ outcome: "stopped", awaiting: "assignment_offer" });
      expect(provider).toHaveBeenCalledTimes(expectedProviderCalls);
    },
    300_000,
  );
});
