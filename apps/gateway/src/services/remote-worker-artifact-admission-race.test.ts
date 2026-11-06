import { createHash, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { serializeRemoteWorkerRuntimeOutputArtifact } from "@goatcitadel/contracts";
import { createSignedArtifactRaceFixture } from "../../test/fixtures/remote-worker-artifact-admission-race.js";
import { verifyRetainedNativeChatResult } from "../../../../packages/storage/src/remote-worker-native-chat-result-fixture.js";
import { buildWorkerInferenceSubmission } from "../../../remote-worker/src/worker-inference-execution.js";
import { publishWorkerChatArtifact } from "../../../remote-worker/src/worker-artifact-publication.js";
import { projectRemoteWorkerNativeChatWorkload } from "./remote-worker-native-chat-workload.js";
import { RemoteWorkerInferenceRuntime } from "./remote-worker-inference-runtime.js";
import { RemoteWorkerArtifactRuntime } from "./remote-worker-artifact-runtime.js";
import { LlmService } from "./llm-service.js";
import { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { SecretStoreService } from "./secret-store-service.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { buildRemoteWorkerChatSequenceContext, readCanonicalWorkerChatOutput } from "./remote-worker-chat-output-service.js";
import { readRetainedRemoteWorkerChatEvidence } from "./remote-worker-chat-admission-authority.js";
import { NodeExternalSourceArtifactFilesystem } from "./external-source-artifact-store.js";
import { NodeExternalSourceWindowsSecurity } from "./external-source-windows-security.js";

import { REMOTE_WORKER_POP_V2_SCHEMA_VERSION, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  buildRemoteWorkerPopV2Preimage } from "@goatcitadel/contracts";
import { remoteWorkerProtocolBodySha256, type RemoteWorkerProtocolBody } from "./remote-worker-protocol.js";
import { RemoteWorkerCurrentAuthorityService, type CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";
import { RemoteWorkerProtectedAdmissionAuthorityService } from "./remote-worker-protected-admission-authority-service.js";
import { RemoteWorkerAssignmentExecutionProtocolService, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES,
  type RemoteWorkerAssignmentExecutionProtocolRequest } from "./remote-worker-assignment-execution-protocol-service.js";
import type { KeyObject } from "node:crypto";
import * as executionValidators from "./remote-worker-assignment-execution-validators.js";

function signedSettlement(current: CurrentRemoteWorkerRuntimeCredentialAuthority, privateKey: KeyObject,
  credential: string, payload: object, idempotencyKey: string, nonce = randomBytes(32).toString("base64url")): RemoteWorkerAssignmentExecutionProtocolRequest {
  const route = REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission;
  const timestamp = new Date().toISOString();
  const tlsExporter = randomBytes(32);
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const transportIdentity = {
    source: "native_mtls" as const,
    certificateDerSha256: current.clientCertificateSha256,
    publicKeySpkiSha256: current.publicKeySpkiSha256,
    trustAnchorDerSha256: current.transportTrustAnchorSha256,
    tlsExporterSha256: digest(tlsExporter), tlsExporter,
  };
  const body: RemoteWorkerProtocolBody = {
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION, operation: route.operation,
    authorityId: current.credentialId, authorityGeneration: current.credentialGeneration,
    workerGeneration: current.workerGeneration, idempotencyKey,
    payload: payload as RemoteWorkerProtocolBody["payload"],
  };
  const preimage = buildRemoteWorkerPopV2Preimage({
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION, method: "POST", rawPath: route.rawPath,
    operation: route.operation, bodySha256: remoteWorkerProtocolBodySha256(body), nonce, timestamp,
    idempotencyKey, authorityKind: "credential", authorityId: current.credentialId,
    authorityGeneration: current.credentialGeneration, workerGeneration: current.workerGeneration,
    tlsExporterSha256: transportIdentity.tlsExporterSha256,
    clientCertificateSha256: current.clientCertificateSha256, workerPublicKeySpkiSha256: current.publicKeySpkiSha256,
  });
  return { method: "POST", rawPath: route.rawPath, transportIdentity, body,
    headers: { authorization: `Bearer ${credential}`, "idempotency-key": idempotencyKey,
      "x-goatcitadel-worker-nonce": nonce, "x-goatcitadel-worker-operation": route.operation,
      "x-goatcitadel-worker-proof": sign(null, Buffer.from(preimage), privateKey).toString("base64url"),
      "x-goatcitadel-worker-timestamp": timestamp } };
}
// Keep provider fixtures explicit; real transport tests use the pinned implementation.
vi.mock("./llm-provider-fetch.js", () => ({
  fetchLlmProvider: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

type Point = "pre" | "initial" | "continuation";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type DiagnosticPhase = "open" | "part" | "commit" | "protocol_result" | "runtime_commit" | "verification";
type TimingEvent = "chat_exact_begin" | "chat_exact_end" | "chat_continuation_begin" | "chat_continuation_end" |
  "transaction_request" | "transaction_begin" | "transaction_end" | "transaction_settled" |
  "install_begin" | "install_end" | "gate_enter" | "gate_leave";
// Explicit output vocabulary only: never retain a message, arbitrary code,
// complete stack, request, receipt, token, digest, or filesystem path.
function boundedFailure(error: unknown, phase: DiagnosticPhase, startedAt: number, signal?: AbortSignal) {
  const allowedCodes = new Set([
    "REMOTE_WORKER_PROTOCOL_INVALID", "REMOTE_WORKER_ASSIGNMENT_EXECUTION_PROTOCOL_REJECTED",
    "cancelled", "digest_mismatch", "filesystem_error", "invalid_address", "limit_exceeded", "not_found", "tampered", "unsafe_path",
  ]);
  const ownCode = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  const ownStatus = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "statusCode")?.value : undefined;
  const frames = error instanceof Error ? (error.stack ?? "").split("\n").slice(1).flatMap(line => {
    const match = /(?:\/|\\)(remote-worker-(?:artifact-(?:runtime|store|settlement-service|admission-race\.test)|assignment-execution-(?:protocol-service|validators)|verification-service|chat-output-service))\.ts:(\d+):\d+\)?$/.exec(line);
    return match ? [{ file: `${match[1]}.ts`, line: Number(match[2]) }] : [];
  }).slice(0, 3) : [];
  return {
    phase, code: typeof ownCode === "string" && allowedCodes.has(ownCode) ? ownCode : "unclassified",
    status: [400, 401, 403, 409, 410, 413, 429, 500, 503, 504].includes(ownStatus) ? ownStatus as number : undefined,
    aborted: signal?.aborted ?? false,
    deadline: (error instanceof Error && error.name === "TimeoutError") ||
      (signal?.reason instanceof Error && signal.reason.name === "TimeoutError"),
    elapsedMs: Math.min(120_000, Math.max(0, Math.round(performance.now() - startedAt))), frames,
  };
}
it.each([
  ["control D pre", "pre", false, false, false], ["control D initial", "initial", false, false, false],
  ["control D continuation", "continuation", false, false, false], ["continuation C", "continuation", true, false, false],
  ["exact refusal A", "pre", true, false, false], ["protocol admission B", "initial", true, false, false],
  ["expiry shortening refusal", "continuation", true, true, false],
  ["admitted worker rotation", "initial", false, false, true],
  ["authenticated publication replay", "initial", false, false, false],
] as const)("%s", async (_label, point: Point, heartbeat: boolean, shortenExpiry: boolean, rotateWorker: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "goat-native-chat-acceptance-"));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes("goat-native-chat-acceptance-")) throw new Error("Unexpected fixture root.");
  const storageOptions = { dbPath: join(root, "gateway.sqlite"), transcriptsDir: join(root, "transcripts"), auditDir: join(root, "audit") };
  const storage = new Storage(storageOptions);
  let releasePending = () => {};
  let drainPending: Promise<unknown> = Promise.resolve();
  let emitProfile = () => {};
  try {
    const asyncStorage = createSqliteAsyncStorage(storage);
    const signed = createSignedArtifactRaceFixture();
    const h = signed.seed(storage.db, "native-chat-acceptance", true);
    const native = await verifyRetainedNativeChatResult(storage.db, "native-chat-acceptance", {
      workerId: h.finalized.generation.workerId, workerGeneration: h.finalized.generation.workerGeneration,
      nodeId: h.finalized.generation.nodeId, nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
    }, h.fence);
    const rawLease = Buffer.alloc(32, 0x51).toString("base64url"), hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const scope = { registryWorkspaceId: native.ref.registryWorkspaceId, assignmentId: native.ref.assignmentId };
    const renewed = storage.remoteWorkerAssignments.renewLease({ ...scope,
      expectedAssignmentGeneration: native.ref.assignmentGeneration, expectedLeaseRevision: native.lease.leaseRevision,
      expectedLeaseTokenSha256: native.token, leaseTokenSha256: hash(rawLease), workerSentThrough: 0, idempotencyKey: "native-chat-model-lease" }, h.fence);
    const lease = { ...native.ref, leaseRevision: renewed.lease.leaseRevision, leaseToken: rawLease };
    const authority = { ...native.ref, leaseTokenSha256: hash(rawLease), protectedAuthority: h.fence };
    const execution = storage.remoteWorkerAssignments.resolveActiveChatExecution(authority, h.fence);
    const workload = await projectRemoteWorkerNativeChatWorkload(asyncStorage, execution.workload, native.ref);
    const submission = buildWorkerInferenceSubmission(workload as never, lease);
    expect(submission.messages.at(-1)!.text).toContain('"exitCode":23');
    expect(workload.nativeChatContext?.schemaVersion).toBe("goatcitadel.remote-worker-native-chat-context.v2");
    expect(submission.messages.at(-1)).toMatchObject({ role: "user", name: "native_runtime_output" });
    expect(submission.messages.at(-1)!.text).toContain("useful native output");
    expect(submission.messages.filter(message => message.role === "system").some(message => message.text.includes("useful native output"))).toBe(false);
    const nativeOutputKey = { ...native.ref, nonce: native.expectation.nonce };
    const nativeOutputDocument = storage.remoteWorkerRuntimeReads.readNativeOutputArtifact(nativeOutputKey)!;
    serializeRemoteWorkerRuntimeOutputArtifact(nativeOutputDocument);
    expect(nativeOutputDocument.output.streams.stdout.text).toBe("useful native output\n");
    expect(nativeOutputDocument.outcome.exitCode).toBe(23);
    storage.remoteWorkerBudgets.createGrant({ grantId: "native-chat-grant", registryWorkspaceId: "default", executionWorkspaceId: "default",
      workerId: h.finalized.generation.workerId, workerGeneration: h.finalized.generation.workerGeneration,
      // Controlled accounting only: cover the route's maximum-context reservation.
      maxRequests: 2, maxCostMicrousd: 50_000_000, expiresAt: new Date(Date.now() + 300_000).toISOString() }, "operator-a");
    const answer = "Native execution exited with code 23; retained stdout was: useful native output. The nonzero exit is not task-success proof.";
    const provider = vi.fn(async () => new Response(JSON.stringify({ id: "native-chat-controlled-response", model: "gpt-5.4",
      status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, total_tokens: 20 },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", provider);
    const llm = new LlmService({ activeProviderId: "openai", activeModel: "gpt-5.4", providers: [{ providerId: "openai",
      label: "Controlled native fixture", baseUrl: "https://api.openai.com/v1", apiStyle: "openai-responses", defaultModel: "gpt-5.4", apiKey: "fixture-not-a-real-key" }] }, {}, {
      secretStore: Object.assign(new SecretStoreService(), { getSecret: () => undefined, isAvailable: () => false }),
      modelUsageAccounting: new ModelUsageAccountingService(storage.modelUsageEvents, "native-chat-acceptance", 60_000, 60_000),
    });
    const completionHost = { llmService: llm,
      config: { assistant: { memory: { enabled: false, qmd: { enabled: false, applyToChat: false } } } },
      memoryLifecycleService: { composeContext: vi.fn() }, hooksService: { runInlineHooks: async () => ({ runs: [] }), enqueueAfterHooks: vi.fn(), hasMutateHook: () => false },
      resolveMemoryWorkspaceRelativeDir: async () => "workspace", resolveChatCompletionHookWorkspaceId: async () => "default",
      persistContextManifestForCompletionRequest: vi.fn(), resolveFallbackTargets: () => [], recordDevDiagnostic: vi.fn(), publishRealtime: vi.fn() };
    const inference = new RemoteWorkerInferenceRuntime({ storage: asyncStorage, llm, completionHost,
      dispatchOwnerId: "native-chat-acceptance", listCallableCapabilities: async () => [],
      resolvePolicyContext: async () => ({ permissionProfileId: "safe" }) } as never);
    const model = await inference.performInference({ protectedAuthority: h.fence, submission });
    expect(model.request.state, JSON.stringify({ disposition: model.disposition, reason: model.request.blockReason,
      budget: model.request.budgetAuthorityState, calls: provider.mock.calls.length })).toBe("completed");
    expect(model.request.budgetAuthorityState).toBe("settled");
    expect(provider).toHaveBeenCalledOnce();
    const replay = await inference.performInference({ protectedAuthority: h.fence, submission });
    expect(replay.request.requestSha256).toBe(model.request.requestSha256);
    expect(provider).toHaveBeenCalledOnce();

    // Establish the real verifier's retained-output contract before interpreting
    // any race failure. This reads canonical owners and never grants authority.
    const retainedEvidence = await readRetainedRemoteWorkerChatEvidence(asyncStorage, execution.workload);
    const canonicalOutput = await readCanonicalWorkerChatOutput(asyncStorage.remoteWorkerInference, native.ref,
      buildRemoteWorkerChatSequenceContext(asyncStorage, retainedEvidence, execution));
    expect(canonicalOutput.text).toBe(answer);

    const protectedAuthority = new RemoteWorkerProtectedAdmissionAuthorityService(asyncStorage.remoteWorkerAdmissions);
    const currentAuthority = new RemoteWorkerCurrentAuthorityService(asyncStorage.remoteWorkerAdmissions, protectedAuthority);
    const current = await currentAuthority.resolveByCredentialTokenSha256(hash(signed.credentialSecret));
    expect(current).toBeDefined();
    if (!current) throw new Error("Signed fixture did not resolve canonical protected authority.");
    expect(current.publicKeySpkiSha256).toBe(h.finalizeInput.command.verifiedPublicKeySpkiSha256);
    const state = new Map<string, string>();
    const entered = deferred(), release = deferred();
    releasePending = release.resolve;
    let gated = false, phase: "protected_fence" | "artifact_admitted_handoff" | "artifact_continuation" | undefined;
    let armed = false, exactAdmissions = 0, artifactEntries = 0, directNegative = false;
    const publicationStartedAt = performance.now();
    const timings: Array<{ event: TimingEvent; elapsedMs: number }> = [];
    const mark = (event: TimingEvent) => {
      if (armed && !directNegative && timings.length < 32) timings.push({ event,
        elapsedMs: Math.min(120_000, Math.max(0, Math.round(performance.now() - publicationStartedAt))) });
    };
    if (process.env.GOAT_ARTIFACT_RACE_PROFILE === "1") {
      type Sample = { ordinal: number; count: number; totalMs: number; maxMs: number;
        gapOver100ms: number; first: Array<{ durationMs: number; gapMs: number | null }> };
      const lstat: Sample[] = [], reparse: Sample[] = [];
      const lstatIds = new WeakMap<object, number>(), reparseIds = new WeakMap<object, number>();
      const lastEnds = new WeakMap<object, number>();
      let lstatInstances = 0, reparseInstances = 0;
      const totals = { lstatCount: 0, lstatTotalMs: 0, lstatMaxMs: 0,
        reparseCount: 0, reparseTotalMs: 0, reparseMaxMs: 0 };
      const clampMs = (value: number) => Math.min(120_000, Math.max(0, Math.round(value)));
      const measure = async <T>(kind: "lstat" | "reparse", instance: object, work: () => Promise<T>): Promise<T> => {
        const ids = kind === "lstat" ? lstatIds : reparseIds;
        const samples = kind === "lstat" ? lstat : reparse;
        let ordinal = ids.get(instance);
        if (!ordinal) {
          ordinal = kind === "lstat" ? ++lstatInstances : ++reparseInstances;
          ids.set(instance, ordinal);
          if (ordinal <= 8) samples.push({ ordinal, count: 0, totalMs: 0, maxMs: 0, gapOver100ms: 0, first: [] });
        }
        const began = performance.now(), previousEnd = lastEnds.get(instance);
        try { return await work(); }
        finally {
          const end = performance.now(), durationMs = clampMs(end - began);
          const gapMs = previousEnd === undefined ? null : clampMs(began - previousEnd);
          lastEnds.set(instance, end);
          totals[`${kind}Count`] += 1; totals[`${kind}TotalMs`] += durationMs;
          totals[`${kind}MaxMs`] = Math.max(totals[`${kind}MaxMs`], durationMs);
          const sample = samples[ordinal - 1];
          if (sample) {
            sample.count += 1; sample.totalMs += durationMs; sample.maxMs = Math.max(sample.maxMs, durationMs);
            if (gapMs !== null && gapMs > 100) sample.gapOver100ms += 1;
            if (sample.first.length < 4) sample.first.push({ durationMs, gapMs });
          }
        }
      };
      const realLstat = NodeExternalSourceArtifactFilesystem.prototype.lstat;
      vi.spyOn(NodeExternalSourceArtifactFilesystem.prototype, "lstat").mockImplementation(
        function(this: NodeExternalSourceArtifactFilesystem, ...args: Parameters<typeof realLstat>) {
          return measure("lstat", this, () => realLstat.apply(this, args));
        });
      const realReparse = NodeExternalSourceWindowsSecurity.prototype.inspectReparsePoint;
      vi.spyOn(NodeExternalSourceWindowsSecurity.prototype, "inspectReparsePoint").mockImplementation(
        function(this: NodeExternalSourceWindowsSecurity, ...args: Parameters<typeof realReparse>) {
          return measure("reparse", this, () => realReparse.apply(this, args));
        });
      const spawnStats = { count: 0, exits: 0, totalLifetimeMs: 0, maxLifetimeMs: 0,
        first: [] as Array<{ ordinal: number; startMs: number; lifetimeMs?: number }> };
      const realSpawn = childProcess.spawn;
      const observedSpawn = new Proxy(realSpawn, {
        apply(target, receiver, args: unknown[]) {
          const child = Reflect.apply(target, receiver, args) as ReturnType<typeof realSpawn>;
          // Inspect the binary basename only; never retain command/args/env/PID.
          if (typeof args[0] === "string" && args[0].split(/[\\/]/).at(-1)?.toLowerCase() === "powershell.exe") {
            const began = performance.now(), ordinal = ++spawnStats.count;
            const sample = ordinal <= 4 ? { ordinal, startMs: clampMs(began - publicationStartedAt) } : undefined;
            if (sample) spawnStats.first.push(sample);
            child.once("exit", () => {
              const lifetimeMs = clampMs(performance.now() - began);
              spawnStats.exits += 1; spawnStats.totalLifetimeMs += lifetimeMs;
              spawnStats.maxLifetimeMs = Math.max(spawnStats.maxLifetimeMs, lifetimeMs);
              if (sample) Object.assign(sample, { lifetimeMs });
            });
          }
          return child;
        },
      });
      vi.spyOn(childProcess, "spawn").mockImplementation(observedSpawn);
      syncBuiltinESMExports();
      let emitted = false;
      emitProfile = () => {
        if (emitted) return;
        emitted = true;
        console.info("ARTIFACT_RACE_PROFILE", JSON.stringify({ totals, lstatInstances, reparseInstances,
          lstat, reparse, spawnStats, timings }));
      };
    }
    let nonceAccepted = 0, nonceRejected = 0;
    const realConsume = asyncStorage.remoteWorkerNonces.consume.bind(asyncStorage.remoteWorkerNonces);
    const nonceConsumer: ConstructorParameters<typeof RemoteWorkerAssignmentExecutionProtocolService>[0]["nonceConsumer"] = {
      consume: async input => {
        const consumed = await realConsume(input);
        if (consumed) nonceAccepted += 1; else nonceRejected += 1;
        return consumed;
      },
    };
    let directInput: Parameters<RemoteWorkerArtifactRuntime["commitArtifact"]>[0] | undefined;
    let admissionFailure: { stage: string; reason: string } | undefined;
    let protocolFailure: { stage: string; reason: string } | undefined;
    const diagnosticReader = () => {
      const read = (executionValidators as unknown as Record<string, unknown>).readExecutionRejectionDiagnostic;
      expect(read, "real signed rejection must expose a closed internal diagnostic").toBeTypeOf("function");
      return read as (error: unknown) => { stage: string; reason: string };
    };
    const realAssignments = asyncStorage.remoteWorkerAssignments;
    const realAdmission = realAssignments.admitChatArtifactPublication.bind(realAssignments);
    const admitPublication: typeof realAssignments.admitChatArtifactPublication = async (input, fence) => {
      if (armed && point === "pre" && !gated) {
        gated = true; phase = "protected_fence"; entered.resolve(); await release.promise;
      }
      const resolved = await realAdmission(input, fence).catch(error => {
        // This error really crosses createSqliteAsyncStorage; do not replace it
        // with an injected ConflictError or infer its reason from DB snapshots.
        const classify = (executionValidators as unknown as Record<string, unknown>).classifyArtifactAdmissionRejection;
        expect(classify, "AsyncStorage admission error classifier must exist").toBeTypeOf("function");
        admissionFailure = (classify as (error: unknown) => { stage: string; reason: string })(error);
        throw error;
      });
      if (armed) { expect(resolved.records.lease.leaseRevision).toBe(lease.leaseRevision); exactAdmissions += 1; }
      return resolved;
    };
    const realResolve = realAssignments.resolveActiveChatExecution.bind(realAssignments);
    const chatRead: typeof realAssignments.resolveActiveChatExecution = async (input, fence) => {
      if (armed && !gated && point === "continuation" && !!input.continuingArtifact) {
        expect(exactAdmissions).toBe(1);
        expect(artifactEntries).toBe(1);
        gated = true;
        phase = "artifact_continuation";
        mark("gate_enter");
        entered.resolve(); await release.promise;
        mark("gate_leave");
      }
      mark(input.continuingArtifact ? "chat_continuation_begin" : "chat_exact_begin");
      try { return await realResolve(input, fence); }
      finally { mark(input.continuingArtifact ? "chat_continuation_end" : "chat_exact_end"); }
    };
    // DeepAsyncRepository methods are get-proxies, not own properties that spyOn can replace.
    // Override only the two read boundaries; every result still comes from the original SQLite port.
    const assignments = new Proxy(realAssignments, {
      get(target, property, receiver) {
        if (property === "admitChatArtifactPublication") return admitPublication;
        if (property === "resolveActiveChatExecution") return chatRead;
        return Reflect.get(target, property, receiver);
      },
    });
    let activePhase: DiagnosticPhase = "open";
    const failures: ReturnType<typeof boundedFailure>[] = [];
    const realArtifacts = asyncStorage.remoteWorkerArtifacts;
    const openVerification: typeof realArtifacts.openGatewayVerification = async input => {
      activePhase = "verification";
      return await realArtifacts.openGatewayVerification(input);
    };
    const artifactRepository = new Proxy(realArtifacts, {
      get(target, property, receiver) {
        if (property === "openGatewayVerification") return openVerification;
        return Reflect.get(target, property, receiver);
      },
    });
    const runImmediateTransaction: typeof asyncStorage.runImmediateTransaction = async <T>(callback: () => T | Promise<T>) => {
      mark("transaction_request");
      try {
        return await asyncStorage.runImmediateTransaction(async () => {
          mark("transaction_begin");
          try { return await callback(); }
          finally { mark("transaction_end"); }
        });
      } finally { mark("transaction_settled"); }
    };
    const artifactStorage: ConstructorParameters<typeof RemoteWorkerArtifactRuntime>[0] = {
      remoteWorkerAssignments: assignments,
      remoteWorkerArtifacts: artifactRepository,
      remoteWorkerInference: asyncStorage.remoteWorkerInference,
      runImmediateTransaction,
      chatTurnCapabilityProfiles: asyncStorage.chatTurnCapabilityProfiles,
      remoteWorkerEffects: asyncStorage.remoteWorkerEffects,
      chatToolRuns: asyncStorage.chatToolRuns,
      approvals: asyncStorage.approvals,
      sessionMutationAdmissions: asyncStorage.sessionMutationAdmissions,
      durableRuns: asyncStorage.durableRuns,
    };
    const artifacts = new RemoteWorkerArtifactRuntime(artifactStorage, join(root, "cas"));
    const effect = vi.fn(async () => { throw new Error("Artifact fixture cannot dispatch effects."); });
    const tool = vi.fn(async () => { throw new Error("Artifact fixture cannot dispatch tools."); });
    const commitEntry = vi.fn(async (input: Parameters<typeof artifacts.commitArtifact>[0],
      admission: Parameters<typeof artifacts.commitArtifact>[1]) => {
      artifactEntries += 1;
      expect(admission, "signed commit must carry repository-created admission").toBeDefined();
      expect(Object.isFrozen(admission)).toBe(true);
      expect(Object.isFrozen(admission!.continuingArtifact.parentDispatchAuthority)).toBe(true);
      if (_label === "control D initial") {
        const file = input.files[0]!;
        const changedBytes = Buffer.from(file.bytes); changedBytes[0] = changedBytes[0]! ^ 1;
        const mismatches: Array<Partial<typeof input>> = [
          { uploadId: "other-upload" }, { assignmentId: "other-assignment" },
          { assignmentGeneration: input.assignmentGeneration + 1 }, { registryWorkspaceId: "other-workspace" },
          { idempotencyKey: "changed-publication-request" },
          { manifest: { ...input.manifest, pathJailSha256: hash("changed-jail") } },
          { manifest: { ...input.manifest, identity: { ...input.manifest.identity, workerId: "other-worker" } } },
          { files: [{ ...file, logicalPath: "other.txt" }] },
          { files: [{ ...file, logicalPathSha256: hash("changed-path") }] },
          { files: [{ ...file, mimeType: "application/octet-stream" }] },
          { files: [{ ...file, bytes: Buffer.concat([file.bytes, Buffer.from("x")]) }] },
          { files: [{ ...file, bytes: changedBytes }] },
          { protectedAuthority: { ...h.fence, credentialAuthority: { ...h.fence.credentialAuthority, workerId: "other-worker" } } },
        ];
        for (const mismatch of mismatches) {
          await expect(artifacts.commitArtifact({ ...input, ...mismatch }, admission))
            .rejects.toThrow("differs from its admitted publication");
        }
        expect(installs).not.toHaveBeenCalled(); expect(commits).not.toHaveBeenCalled();
      }
      if (point === "initial" && !gated) {
        expect(exactAdmissions).toBe(1);
        gated = true; phase = "artifact_admitted_handoff"; mark("gate_enter");
        entered.resolve(); await release.promise; mark("gate_leave");
      }
      activePhase = "runtime_commit";
      try {
        if (_label === "control D initial") {
          const mutableInput = { ...input, manifest: structuredClone(input.manifest),
            files: input.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) })) };
          const mutableAdmission = structuredClone(admission!);
          const pending = artifacts.commitArtifact(mutableInput, mutableAdmission);
          // Mutation after the async call starts cannot alter either its
          // captured request bytes or nested canonical continuation custody.
          mutableInput.files[0]!.bytes.fill(0);
          Reflect.set(mutableInput.manifest.identity, "workerId", "mutated-after-runtime-capture");
          Reflect.set(mutableAdmission.continuingArtifact.parentDispatchAuthority, "dispatchOwnerId", "mutated-after-runtime-capture");
          return await pending;
        }
        return await artifacts.commitArtifact(input, admission);
      } catch (error) {
        failures.push(boundedFailure(error, activePhase, publicationStartedAt, input.signal));
        throw error;
      }
    });
    const protocol = new RemoteWorkerAssignmentExecutionProtocolService({
      credentialAuthority: currentAuthority, nonceConsumer,
      meshAdmissions: asyncStorage.remoteWorkerMeshNodeAdmissions,
      assignments, inference,
      settlement: { artifacts: { openUpload: input => artifacts.openUpload(input),
        appendPart: input => artifacts.appendPart(input), commitArtifact: commitEntry },
        effects: { dispatchEffect: effect }, chatTools: { dispatchTool: tool } },
      clock: () => new Date(),
    });
    const realCommit = storage.remoteWorkerArtifacts.commitArtifact.bind(storage.remoteWorkerArtifacts);
    const commits = vi.spyOn(storage.remoteWorkerArtifacts, "commitArtifact").mockImplementation(realCommit);
    const realInstall = RemoteWorkerArtifactStore.prototype.installBlob;
    const installs = vi.spyOn(RemoteWorkerArtifactStore.prototype, "installBlob").mockImplementation(
      async function(this: RemoteWorkerArtifactStore, input: Parameters<typeof realInstall>[0]) {
        mark("install_begin");
        try { return await realInstall.call(this, input); }
        finally { mark("install_end"); }
      });
    const beforeParent = storage.durableRuns.getRun(native.parent.runId);
    const publish = publishWorkerChatArtifact({ lease, workload: workload as never, lines: [answer],
      state: { read: async key => state.get(key), write: async (key, value) => { state.set(key, value); }, delete: async key => { state.delete(key); } },
      call: async (publicationPhase, material) => {
        activePhase = publicationPhase;
        const { kind: _kind, ...payload } = material;
        if (publicationPhase === "commit") {
          directInput = { ...authority, ...payload, idempotencyKey: "direct-stale-negative",
            files: (payload.files as Array<{ logicalPath: string; logicalPathSha256: string; bytesBase64: string; mimeType: string }>).map(
              ({ bytesBase64, ...file }) => ({ ...file, bytes: Buffer.from(bytesBase64, "base64") })),
            signal: new AbortController().signal } as Parameters<typeof artifacts.commitArtifact>[0];
          armed = true;
        }
        const requestPayload = {
          schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
          registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId,
          assignmentGeneration: lease.assignmentGeneration, leaseRevision: lease.leaseRevision,
          leaseToken: lease.leaseToken, submission: material,
        };
        const nonce = randomBytes(32).toString("base64url");
        let response: Awaited<ReturnType<typeof protocol.execute>>;
        try {
          response = await protocol.execute(signedSettlement(current, signed.workerPrivateKey,
            signed.credentialSecret, requestPayload, `race-artifact-${publicationPhase}`, nonce));
        } catch (error) {
          if (publicationPhase === "commit") protocolFailure = diagnosticReader()(error);
          if (failures.length < 3) failures.push(boundedFailure(error, activePhase, publicationStartedAt));
          throw error;
        }
        activePhase = "protocol_result";
        if (publicationPhase === "open") {
          // Fresh valid PoP transport, same durable nonce: replay must stop before domain dispatch.
          await expect(protocol.execute(signedSettlement(current, signed.workerPrivateKey,
            signed.credentialSecret, requestPayload, `race-artifact-${publicationPhase}`, nonce))).rejects.toThrow();
          expect(nonceRejected).toBe(1);
        }
        expect(response.disposition).toBe("artifact_recorded");
        if (!("upload" in response)) throw new Error("Protocol did not record artifact upload.");
        if (_label === "authenticated publication replay" && publicationPhase === "commit") {
          // A fresh authenticated request obtains its own exact admission;
          // it never reuses the previous request's internal handoff object.
          const replayed = await protocol.execute(signedSettlement(current, signed.workerPrivateKey,
            signed.credentialSecret, requestPayload, `race-artifact-${publicationPhase}`));
          expect(replayed.disposition).toBe("artifact_recorded");
          if (!("upload" in replayed)) throw new Error("Replay did not record artifact upload.");
          expect(replayed.upload).toEqual(response.upload);
        }
        return response.upload as never;
      } });
    // Attach rejection handler immediately, before yielding to the gate.
    const outcome = publish.then(value => ({ ok: true as const, value }), error => ({
      ok: false as const,
      // Never serialize an arbitrary error: credentials, bodies and identifiers
      // cannot escape via diagnostic assertion messages.
      code: error instanceof Error && error.message === "Worker artifact requires verification reconciliation."
        ? "verification_reconciliation"
        : error instanceof Error && error.message === "Worker artifact has no matching Gateway verification receipt."
          ? "verification_receipt_mismatch" : "publication_refused",
    }));
    drainPending = outcome;
    await Promise.race([entered.promise, outcome.then(() => { throw new Error("Publication exited before its deterministic barrier."); })]);
    if (rotateWorker) {
      const nextToken = hash("artifact-admitted-worker-rotation");
      const rotation = storage.remoteWorkerAssignments.renewLease({ ...scope,
        expectedAssignmentGeneration: lease.assignmentGeneration, expectedLeaseRevision: lease.leaseRevision,
        expectedLeaseTokenSha256: hash(lease.leaseToken), leaseTokenSha256: nextToken,
        workerSentThrough: 0, idempotencyKey: "artifact-admitted-worker-rotation" }, h.fence);
      expect(rotation.lease.leaseRevision).toBe(lease.leaseRevision + 1);
    }
    if (heartbeat) {
      // Preserve the native fixture's 300s expiry for ordinary heartbeat drift.
      // The separate negative control intentionally shortens it to 120s.
      const renewedParent = storage.durableRuns.renewLease({ runId: beforeParent.runId,
        workerId: beforeParent.leaseOwnerId!, leaseHeartbeatAt: storage.durableRuns.readDatabaseNow(),
        leaseExpiresAt: shortenExpiry ? new Date(Date.now() + 120_000).toISOString() : beforeParent.leaseExpiresAt! });
      expect(renewedParent).toBeDefined();
      expect(renewedParent!.version).toBeGreaterThan(beforeParent.version);
      expect(Date.parse(renewedParent!.leaseHeartbeatAt!)).toBeGreaterThan(Date.parse(beforeParent.leaseHeartbeatAt!));
      if (shortenExpiry) expect(renewedParent!.leaseExpiresAt! < beforeParent.leaseExpiresAt!).toBe(true);
      else expect(renewedParent!.leaseExpiresAt).toBe(beforeParent.leaseExpiresAt);
      expect(renewedParent).toMatchObject({ runId: beforeParent.runId, leaseOwnerId: beforeParent.leaseOwnerId,
        attemptCount: beforeParent.attemptCount, payload: beforeParent.payload });
    }
    if (heartbeat || rotateWorker) {
      expect(directInput).toBeDefined();
      if (!directInput) throw new Error("Missing exact direct-entry negative input.");
      // A plain direct caller has no server-admitted handoff and must stay fenced.
      directNegative = true;
      try { await expect(artifacts.commitArtifact(directInput)).rejects.toThrow(); }
      finally { directNegative = false; }
      expect(installs).not.toHaveBeenCalled();
      expect(commits).not.toHaveBeenCalled();
    }
    release.resolve();
    const result = await outcome;
    emitProfile();
    const diagnostic = JSON.stringify({ failures, timings, activePhase,
      publication: result.ok ? "completed" : result.code,
      manifestCommitCalls: commits.mock.calls.length, blobInstallCalls: installs.mock.calls.length });
    if (!(point === "pre" && heartbeat) && !shortenExpiry) {
      // Inspect actual canonical state before a generic no-side-effects check
      // can mask a post-CAS or post-commit failure. Keep all guards below.
      if (!directInput) throw new Error("Missing canonical artifact inspection input.");
      const currentUpload = storage.remoteWorkerArtifacts.getUpload(authority.registryWorkspaceId,
        authority.assignmentId, authority.assignmentGeneration, directInput.uploadId);
      expect({ uploadState: currentUpload.uploadState, verificationGateState: currentUpload.verificationGateState }, diagnostic)
        .toEqual({ uploadState: "committed", verificationGateState: "satisfied" });
      expect(result.ok, diagnostic).toBe(true);
    }
    expect(phase).toBe(point === "pre" ? "protected_fence" : point === "initial" ? "artifact_admitted_handoff" : "artifact_continuation");
    expect(provider).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled(); expect(tool).not.toHaveBeenCalled();
    const publicationCount = _label === "authenticated publication replay" ? 2 : 1;
    expect(nonceAccepted).toBe(2 + publicationCount); expect(nonceRejected).toBe(1);
    expect(exactAdmissions).toBe(point === "pre" && heartbeat ? 0 : publicationCount);
    expect(artifactEntries).toBe(point === "pre" && heartbeat ? 0 : publicationCount);
    if (!result.ok) {
      expect(commits.mock.calls.length, result.code).toBe(0);
      expect(installs.mock.calls.length, result.code).toBe(0);
    }
    if ((point === "pre" && heartbeat) || shortenExpiry) {
      // Characterization: intentional exact-fence refusal, not a liveness fix.
      expect(result.ok).toBe(false);
      expect(commits).not.toHaveBeenCalled();
      if (point === "pre" && heartbeat) {
        expect(admissionFailure).toStrictEqual({ stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" });
        expect(protocolFailure).toStrictEqual(admissionFailure);
        expect(artifactEntries).toBe(0);
        expect(exactAdmissions).toBe(0);
        expect(failures.every(failure => !failure.deadline && !failure.aborted)).toBe(true);
      }
    } else {
      // Both admitted handoff and later continuation preserve live ownership.
      expect(result.ok, result.ok ? "same-owner server-admitted artifact must publish" : result.code).toBe(true);
      expect(commits).toHaveBeenCalledTimes(publicationCount);
      if (point === "pre" && !heartbeat) {
        expect(admissionFailure).toBeUndefined();
        expect(protocolFailure).toBeUndefined();
        expect(exactAdmissions).toBe(1);
        expect(artifactEntries).toBe(1);
      }
      if (!result.ok) throw new Error("artifact publication failed");
      const upload = commits.mock.results[0]!.value;
      expect(upload.verificationGateState === "satisfied" || storage.remoteWorkerArtifacts.getUpload(
        authority.registryWorkspaceId, authority.assignmentId, authority.assignmentGeneration, upload.uploadId
      ).verificationGateState === "satisfied").toBe(true);
    }
    commits.mockRestore(); installs.mockRestore();
  } finally {
    releasePending();
    await drainPending;
    emitProfile();
    vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
