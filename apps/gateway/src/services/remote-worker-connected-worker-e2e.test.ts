import { execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type ChatTurnCapabilityProfileDraft,
  type RemoteWorkerAssignmentManifest,
} from "@goatcitadel/contracts";
import {
  ChatSessionLifecycleRepository,
  ChatTurnCapabilityProfileRepository,
  ChatTurnTraceRepository,
  DurableRunRepository,
  RemoteWorkerAdmissionRepository,
  RemoteWorkerAssignmentRepository,
  RemoteWorkerMeshNodeAdmissionRepository,
  RemoteWorkerNonceRepository,
  SessionMutationAdmissionRepository,
  TaskRepository,
  createDatabase,
  sealChatTurnCapabilityProfile,
  type DatabaseClient,
} from "@goatcitadel/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-composition.js";
import { createGatewayRemoteWorkerAssignmentRuntimeComposition } from "./remote-worker-assignment-runtime-composition.js";
import { startRemoteWorkerNativeTlsListener } from "./remote-worker-native-tls-listener.js";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";

// Public, non-secret test fixtures generated solely for the HX-501 loopback proof.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBeDCCASqgAwIBAgIUZTNs1ByBlRL7pMZAVAYlyN0teqowBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowKDEmMCQGA1UEAwwdR29hdENpdGFkZWwgSFg1
MDEgTGlzdGVuZXIgQ0EwKjAFBgMrZXADIQBSjxcD22J7+xt6LJu4UnOJKaXZhTtc
DNUL0Sc17UIySqNmMGQwHQYDVR0OBBYEFKNuM5RciNLBA4yMy9gbSZJl/TMRMB8G
A1UdIwQYMBaAFKNuM5RciNLBA4yMy9gbSZJl/TMRMBIGA1UdEwEB/wQIMAYBAf8C
AQAwDgYDVR0PAQH/BAQDAgEGMAUGAytlcANBAMQ+p3my9NrSqOm0fF+C0va6qSbw
k9WLzL7qJnU+N2nTjrbotBwiGwx8I9BlDhVNZSY/w3qSBm0+vxWL3+qrvw4=
-----END CERTIFICATE-----
`;
const SERVER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCCAUOgAwIBAgIUMFqWz4nhKmOp4ZrcncR9oaEoiB4wBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MCowBQYD
K2VwAyEApw4nkG7WgBmO2bN73r98GKsDjA9bngBJLAI1WBISBXyjgZIwgY8wGgYD
VR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/
BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBSZDRm2hCmy2yT3
1vE/ppFeanKi0zAfBgNVHSMEGDAWgBSjbjOUXIjSwQOMjMvYG0mSZf0zETAFBgMr
ZXADQQD1b9ZjFapMTW6dOndRfXTl6Md06NKtSLgQFmwCxc3UaAy1VWQESaosmrRO
9Hf/jfKiVRt4jgexXOuD67sB0BoH
-----END CERTIFICATE-----
`;
const SERVER_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB81SweGGRtBMfQh+I7Wo37pzfi5OH82CMinGgKsCCWQ
-----END PRIVATE KEY-----
`;
const CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBdTCCASegAwIBAgIUMFqWz4nhKmOp4ZrcncR9oaEoiB8wBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowFjEUMBIGA1UEAwwLd29ya2VyLXRlc3QwKjAF
BgMrZXADIQD2T1jzXgcwp1PO5oB4g11yGDpKYg0rJ9UJHurdPyLLA6N1MHMwDAYD
VR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwIw
HQYDVR0OBBYEFCu/5nk7wPmPf105JYKUIoPMY3NuMB8GA1UdIwQYMBaAFKNuM5Rc
iNLBA4yMy9gbSZJl/TMRMAUGAytlcANBAPpVSsCZqAookqSqgB3fZnpH59824/M3
4wkMWAKzgxgJIFP7uq0mJDI7UqXoQyjdWVcACP+8igEU/xboG1WNMQU=
-----END CERTIFICATE-----
`;
const CLIENT_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIP7oQh0GClRqd2Tb5kfT1Cbdc78LOylrcLyeqYoBNyo1
-----END PRIVATE KEY-----
`;

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const workerEntry = join(repoRoot, "apps", "remote-worker", "src", "main.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

const cleanupRoots: string[] = [];
const openHandles: Array<{ close(): Promise<void> }> = [];
const openDatabases: DatabaseClient[] = [];

afterEach(async () => {
  await Promise.allSettled(openHandles.splice(0).map(async (handle) => handle.close()));
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // A failed assertion must not be masked by a close error.
    }
  }
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
}

function portOf(address: string | undefined): number {
  const port = Number(address?.slice((address.lastIndexOf(":") ?? -1) + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error("Listener did not expose a bound port.");
  return port;
}

function databaseClock(db: DatabaseClient): string {
  const row = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>();
  if (!row) throw new Error("database clock unavailable");
  return row.now;
}

/**
 * Write the loopback trust material and lock the directory to this operator, as
 * the listener's own no-follow trust loader requires on Windows.
 */
async function tlsConfig(root: string): Promise<{
  readonly config: EnabledRemoteWorkerRuntimeConfig;
  readonly manifestSignerKeyId: string;
  readonly signManifestPayload: (payload: object) => string;
  readonly paths: Readonly<Record<"cert" | "key" | "ca" | "signer" | "clientCert" | "clientKey", string>>;
}> {
  const systemRoot = process.env.SystemRoot as string;
  const { stdout } = await execFileAsync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[0-9-]+)"/u.exec(stdout)?.[1];
  if (sid === undefined) throw new Error("Unable to resolve the Windows test operator SID.");
  await execFileAsync(join(systemRoot, "System32", "icacls.exe"), [
    root,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
  const paths = Object.freeze({
    cert: join(root, "server.crt"),
    key: join(root, "server.key"),
    ca: join(root, "client-ca.crt"),
    signer: join(root, "signer.pub"),
    clientCert: join(root, "client.crt"),
    clientKey: join(root, "client.key"),
  });
  const manifestSigner = generateKeyPairSync("ed25519");
  const signerSpkiDer = manifestSigner.publicKey.export({ format: "der", type: "spki" });
  const signerPublicPem = manifestSigner.publicKey.export({ format: "pem", type: "spki" });
  if (!Buffer.isBuffer(signerSpkiDer) || typeof signerPublicPem !== "string") {
    throw new Error("Unable to create the connected-worker manifest signer fixture.");
  }
  writeFileSync(paths.cert, SERVER_CERT_PEM, "utf8");
  writeFileSync(paths.key, SERVER_KEY_PEM, "utf8");
  writeFileSync(paths.ca, CA_PEM, "utf8");
  writeFileSync(paths.signer, signerPublicPem, "utf8");
  writeFileSync(paths.clientCert, CLIENT_CERT_PEM, "utf8");
  writeFileSync(paths.clientKey, CLIENT_KEY_PEM, "utf8");
  return {
    paths,
    manifestSignerKeyId: "connected-worker-e2e",
    signManifestPayload: (payload) =>
      sign(null, Buffer.from(canonicalJsonString(payload), "utf8"), manifestSigner.privateKey).toString("base64url"),
    config: Object.freeze({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      tls: Object.freeze({
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: true,
        serverCertificateFile: paths.cert,
        serverKeyFile: paths.key,
        clientCaFile: paths.ca,
        clientCaSha256: sha256(new X509Certificate(CA_PEM).raw),
      }),
      manifestSigner: Object.freeze({
        keyId: "connected-worker-e2e",
        publicKeyFile: paths.signer,
        spkiSha256: sha256(signerSpkiDer),
      }),
      bootstrapTtlSeconds: 600,
      credentialTtlSeconds: 900,
    }),
  };
}

function capabilityProfileDraft(input: {
  profileId: string;
  turnId: string;
  sessionId: string;
  durableRunId: string;
  createdAt: string;
}): ChatTurnCapabilityProfileDraft {
  const emptyCatalogHash = sha256(canonicalJsonString([]));
  return {
    profileId: input.profileId,
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: "default",
      citadelId: "default",
      durableRunId: input.durableRunId,
      operatorId: "operator-a",
      authActorId: "operator-a",
      authActorSource: "token",
    },
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: "connected-worker-snapshot",
      inspectableHash: emptyCatalogHash,
      callableHash: emptyCatalogHash,
      inspectableCount: 0,
      callableCount: 0,
    },
    selection: {
      contentHash: sha256("connected-worker-content"),
      effectiveProviderId: "provider-a",
      effectiveModel: "model-a",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "default",
        sessionId: input.sessionId,
        contextManifestRef: `chat-memory-scope:${sha256("connected-worker-memory-scope")}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "auto_when_useful",
      toolAutonomy: "manual",
      tools: [],
      modelNameAllowMap: [],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: {
        profileId: "safe",
        approvalMode: "approve_all",
        profileHash: sha256("connected-worker-permission"),
      },
      policyDecisions: [],
      authReadiness: [
        { kind: "provider", ref: "provider-a", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "chat", status: "ready", reasonCodes: [] },
      ],
      approval: {
        mode: "approve_all",
        selectedToolCount: 0,
        toolsRequiringApproval: [],
        approvalGranted: false,
      },
    },
    preflightFingerprint: sha256("connected-worker-preflight"),
    createdAt: input.createdAt,
  };
}

/**
 * Create the task-bound Chat assignment a scheduler would eventually dispatch,
 * through the canonical storage owners only. There is deliberately NO
 * production scheduler: this is the harness standing in for one, and it stops
 * at the offer — the worker starts the generation by claiming it.
 */
function seedAssignmentOffer(db: DatabaseClient): { readonly assignmentId: string; readonly durableRunId: string } {
  const now = databaseClock(db);
  const taskId = "task-connected-worker";
  const sessionId = "session-connected-worker";
  const turnId = "turn-connected-worker";
  const durableRunId = "run-connected-worker";
  new TaskRepository(db).create({ title: "Connected worker assignment", workspaceId: "default" }, now, { taskId });
  new ChatSessionLifecycleRepository(db).initialize({
    workspaceId: "default",
    sessionId,
    actorId: "operator-a",
    idempotencyKey: "lifecycle:connected-worker",
    correlationId: "correlation:connected-worker",
    metadataTimestamp: now,
  });
  new ChatTurnTraceRepository(db).create({
    turnId,
    sessionId,
    userMessageId: "message-connected-worker",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const profile = sealChatTurnCapabilityProfile(
    capabilityProfileDraft({
      profileId: "profile-connected-worker",
      turnId,
      sessionId,
      durableRunId,
      createdAt: now,
    }),
  );
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId, sessionId, turnId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  const durableRequest = { policyTaskId: taskId, content: "Execute the connected-worker assignment." } as const;
  const admissionMaterialSha256 = sha256(canonicalJsonString({ version: 2, request: durableRequest }));
  const mutationAdmissions = new SessionMutationAdmissionRepository(db);
  const profileAdmission = mutationAdmissions.admit({
    workspaceId: "default",
    sessionId,
    turnId,
    runtimeOwnerId: "runtime-connected-worker",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator-a",
    operation: "chat.turn.execute",
    materialSha256: admissionMaterialSha256,
    idempotencyKey: "admission:connected-worker",
    correlationId: "correlation:connected-worker",
  }).admission;
  db.transaction("immediate", () => {
    mutationAdmissions.bindCapabilityProfile({
      admissionId: profileAdmission.admissionId,
      workspaceId: profileAdmission.workspaceId,
      sessionId: profileAdmission.sessionId,
      sessionIncarnationId: profileAdmission.sessionIncarnationId,
      turnId: profileAdmission.turnId!,
      profileId: profile.profileId,
      profileHash: profile.hashes.profileHash,
      createdAt: profile.createdAt,
      requestRuntimeClaim: {
        runtimeOwnerId: profileAdmission.runtimeOwnerId!,
        leaseRevision: profileAdmission.runtimeLeaseRevision!,
      },
    });
    new ChatTurnCapabilityProfileRepository(db).create(profile);
  });
  const durablePayload = {
    version: "chat.turn.execute.v2",
    admissionId: profileAdmission.admissionId,
    sessionIncarnationId: profileAdmission.sessionIncarnationId,
    admissionMaterialSha256,
    workspaceId: "default",
    admissionAggregateRevision: profileAdmission.aggregateRevision,
    admissionControllerGeneration: profileAdmission.controllerGeneration,
    effectiveRequestMaterialSha256: sha256(
      canonicalJsonString({ version: 1, admissionMaterialSha256, request: durableRequest }),
    ),
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: durableRunId },
    requestActor: { actorKind: "operator", actorId: "operator-a" },
    sessionId,
    turnId,
    userMessageId: "message-connected-worker",
    assistantMessageId: "assistant-connected-worker",
    capabilityProfileId: profile.profileId,
    capabilityProfileHash: profile.hashes.profileHash,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: durableRequest,
  } as const;
  new DurableRunRepository(db).createRun({
    runId: durableRunId,
    workflowKey: "chat.turn.execute",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwnerId: "gateway-connected-worker",
    leaseHeartbeatAt: now,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    version: 3,
    startedAt: now,
    now,
    payload: durablePayload,
    metadata: {
      remoteWorkerAssignmentParentContext: parentContext,
      remoteWorkerAssignmentParentContextSha256: parentContextSha256,
      capabilityProfileId: profile.profileId,
      capabilityProfileHash: profile.hashes.profileHash,
    },
  });
  mutationAdmissions.bindDurableRun({
    admissionId: profileAdmission.admissionId,
    workspaceId: profileAdmission.workspaceId,
    sessionId: profileAdmission.sessionId,
    sessionIncarnationId: profileAdmission.sessionIncarnationId,
    turnId: profileAdmission.turnId!,
    durableRunId,
    requestRuntimeClaim: {
      runtimeOwnerId: profileAdmission.runtimeOwnerId!,
      leaseRevision: profileAdmission.runtimeLeaseRevision!,
    },
  });
  const manifest: RemoteWorkerAssignmentManifest = {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    registryWorkspaceId: "default",
    ...parentInput,
    capabilityProfileSha256: profile.hashes.profileHash,
    contextSnapshotSha256: sha256("connected-worker-context-snapshot"),
    toolEffectPostureSha256: sha256("connected-worker-tool-posture"),
    pathJailSha256: sha256("connected-worker-path-jail"),
    parentContextSha256,
    requiredCapabilityClasses: ["durable_compute"],
    deadlineAt: "2099-01-01T00:00:00.000Z",
    leaseTtlSeconds: 300,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes: 65_536,
    maxArtifactBytes: 1_048_576,
  };
  const assignment = new RemoteWorkerAssignmentRepository(db).createAssignment({
    manifest,
    createdByActorId: "gateway-connected-worker",
    idempotencyKey: "assignment:connected-worker",
  }).assignment;
  return { assignmentId: assignment.assignmentId, durableRunId };
}

interface HarnessBootstrap {
  readonly bootstrapSecret: string;
  readonly ticket: Record<string, unknown>;
}

/**
 * Create the bootstrap record an operator would provision, pinned to a real
 * protected admission signer. The single-host harness holds that signer key as
 * a PEM (production keeps it in the platform's protected key store); everything
 * else — the manifest signature, the ceilings, the TLS identity — is real.
 */
function seedBootstrap(
  db: DatabaseClient,
  tls: Awaited<ReturnType<typeof tlsConfig>>,
  evidenceSignerSpkiDer: Buffer,
  evidenceSignerPrivateKeyPem: string,
): HarnessBootstrap {
  const runtimePayload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: sha256("connected-worker-bundle"),
    dependencyLockSha256: sha256("connected-worker-lock"),
    vendorTreeSha256: sha256("connected-worker-vendor"),
    launcherSha256: sha256("connected-worker-launcher"),
    installedTreeManifestSha256: sha256("connected-worker-tree"),
    installedTreeFileCount: 7,
    platform: "windows",
    architecture: "x64",
  } as const;
  const runtimeManifest = {
    payload: runtimePayload,
    payloadSha256: sha256(canonicalJsonString(runtimePayload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: tls.manifestSignerKeyId,
    signatureBase64Url: tls.signManifestPayload(runtimePayload),
  } as const;
  const keysetReceiptSha256 = sha256("connected-worker-keyset-receipt");
  const bootstrapSecret = randomBytes(32).toString("base64url");
  const bootstrap = new RemoteWorkerAdmissionRepository(db).createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: "Connected worker",
    platform: "windows",
    architecture: "x64",
    runtimeManifest,
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    protectedAdmissionSignerPin: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
      signatureAlgorithm: "ed25519",
      keysetGeneration: 1,
      keysetReceiptSha256,
      signerSpkiSha256: sha256(evidenceSignerSpkiDer),
      signerSpkiBase64Url: evidenceSignerSpkiDer.toString("base64url"),
    },
    expiresInSeconds: 600,
    createdByActorId: "operator-a",
    idempotencyKey: "bootstrap:connected-worker",
    bootstrapSecretSha256: sha256(bootstrapSecret),
  }).record;
  return {
    bootstrapSecret,
    ticket: {
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      executionWorkspaceId: "default",
      bootstrapId: bootstrap.bootstrapId,
      workerId: bootstrap.workerId,
      nodeId: bootstrap.nodeId,
      targetWorkerGeneration: bootstrap.targetWorkerGeneration,
      platform: bootstrap.platform,
      architecture: bootstrap.architecture,
      runtimeManifestSha256: sha256(canonicalJsonString(bootstrap.runtimeManifest)),
      runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
      workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
      keysetReceiptSha256,
      protectedSignerPrivateKeyPem: evidenceSignerPrivateKeyPem,
      bootstrapSecret,
      downloadVerificationReceiptSha256: sha256("connected-worker-download-receipt"),
      installedTreeAttestationSha256: sha256("connected-worker-installed-tree"),
      installedTreeVerificationReceiptSha256: sha256("connected-worker-installed-receipt"),
    },
  };
}

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
    // Routes 11-12 stay unavailable in this harness: the HX-503/HX-506 inner
    // owners are not composed here, so the execution owner is a fail-closed
    // stand-in that refuses every call rather than pretending to execute.
    assignmentExecution: {
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

interface WorkerRun {
  readonly report: Record<string, unknown>;
  readonly exitCode: number | null;
  readonly stderr: string;
}

async function runWorkerProcess(input: {
  readonly root: string;
  readonly port: number;
  readonly paths: Readonly<Record<string, string>>;
  readonly ticketFile: string;
  readonly stateDir: string;
  readonly runId: string;
  readonly stopAfter: string;
}): Promise<WorkerRun> {
  const reportFile = join(input.root, `report-${input.runId}.json`);
  const child = spawn(process.execPath, [tsxCli, workerEntry], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GOATCITADEL_CONNECTED_WORKER_HOST: "127.0.0.1",
      GOATCITADEL_CONNECTED_WORKER_PORT: String(input.port),
      GOATCITADEL_CONNECTED_WORKER_CLIENT_CERT_FILE: input.paths.clientCert!,
      GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE: input.paths.clientKey!,
      GOATCITADEL_CONNECTED_WORKER_CA_FILE: input.paths.ca!,
      GOATCITADEL_CONNECTED_WORKER_TICKET_FILE: input.ticketFile,
      GOATCITADEL_CONNECTED_WORKER_STATE_DIR: input.stateDir,
      GOATCITADEL_CONNECTED_WORKER_REPORT_FILE: reportFile,
      GOATCITADEL_CONNECTED_WORKER_RUN_ID: input.runId,
      GOATCITADEL_CONNECTED_WORKER_STOP_AFTER: input.stopAfter,
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdout.on("data", () => undefined);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Connected worker run ${input.runId} exceeded its budget.`));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
  } catch {
    report = { outcome: "missing_report" };
  }
  return { report, exitCode, stderr };
}

function countRows(db: DatabaseClient, sql: string, params: Record<string, unknown> = {}): number {
  const row = db.prepare(sql).get<{ count: number | bigint }>(params);
  return Number(row?.count ?? -1);
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
});
