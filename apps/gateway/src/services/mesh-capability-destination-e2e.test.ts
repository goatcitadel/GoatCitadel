import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION, canonicalJsonString,
  type ChatTurnCapabilityToolMeshPublicationBinding, type MeshCapabilityActivationRecord,
  type MeshToolCapabilityDescriptor } from "@goatcitadel/contracts";
import { Storage, createLocalAsyncStorage, computeMeshCapabilityDescriptorSha256 } from "@goatcitadel/storage";
import { tlsConfig, portOf, seedBootstrap, prepareStockWorkerWithNativeFiles, runWorkerProcess as bootstrapWorker } from "../../test/fixtures/remote-worker-native.js";
import { WorkerWireClient } from "../../../remote-worker/src/worker-wire-client.js";
import { WorkerCredentialVault } from "../../../remote-worker/src/worker-credential-vault.js";
import { createFileWorkerDurableState } from "../../../remote-worker/src/worker-durable-state.js";
import { admitMeshNode } from "../../../remote-worker/src/connected-worker-routes.js";
import { exchangeWorkerMeshCapability } from "../../../remote-worker/src/worker-mesh-capability-client.js";
import { createWorkerMeshFileReadDescriptor } from "../../../remote-worker/src/worker-mesh-file-read.js";
import { createWorkerMeshFileWriteDescriptor } from "../../../remote-worker/src/worker-mesh-file-write.js";
import { createWorkerMeshMcpHttpDescriptor } from "../../../remote-worker/src/worker-mesh-mcp-http.js";
import { destinationMcpTools, startDestinationMcpFixture } from "../../../remote-worker/src/worker-destination-mcp.test-fixture.js";
import { WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION } from "../../../remote-worker/src/worker-mesh-tool-registry.js";
import { createGatewayRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-composition.js";
import { createGatewayRemoteWorkerAssignmentRuntimeComposition } from "./remote-worker-assignment-runtime-composition.js";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";
import { startRemoteWorkerNativeTlsListener } from "./remote-worker-native-tls-listener.js";
import { MeshCapabilityPublicationService } from "./mesh-capability-publication-service.js";
import { MeshCapabilityActivationService } from "./mesh-capability-activation-service.js";
import { MeshCapabilityInvocationService } from "./mesh-capability-invocation-service.js";
import { REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES } from "./remote-worker-assignment-dispatch-service.js";
import { seedAssignmentOffer } from "../../../../packages/storage/src/remote-worker-chat-offer-fixture.js";

function bindingOf(activation: MeshCapabilityActivationRecord): ChatTurnCapabilityToolMeshPublicationBinding {
  return { nodeId: activation.nodeId, publisherGeneration: activation.publisherGeneration,
    manifestSha256: activation.manifestSha256, entrySha256: activation.entrySha256,
    activationId: activation.activationId, activationRevision: activation.activationRevision,
    permissionEnvelopeSha256: activation.permissionEnvelopeSha256, publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
    effectPosture: activation.effectPosture, healthGeneration: activation.healthGeneration };
}

describe("native mesh destination process recovery", () => {
  it.runIf(process.platform === "win32").each(["after_effect", "after_settlement", "assignment_dependency", "stock_file_read", "stock_file_write", "stock_mcp_http", "stock_mcp_lost", "stock_mcp_bearer", "stock_mcp_bearer_lost"] as const)(
    "preserves one actual destination effect with %s", async (cut) => {
      const root = await mkdtemp(path.join(tmpdir(), "gc-mesh-destination-e2e-"));
      const stockReader = cut === "stock_file_read";
      const stockWriter = cut === "stock_file_write";
      const bearer = cut === "stock_mcp_bearer" || cut === "stock_mcp_bearer_lost";
      const lostMcp = cut === "stock_mcp_lost" || cut === "stock_mcp_bearer_lost";
      const stockMcp = cut === "stock_mcp_http" || cut === "stock_mcp_lost" || bearer;
      const uncertain = cut === "after_effect" || lostMcp;
      const stock = stockReader || stockWriter || stockMcp;
      let mcpServer: Awaited<ReturnType<typeof startDestinationMcpFixture>> | undefined;
      const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];
      let storage: Storage | undefined;
      let listener: Awaited<ReturnType<typeof startRemoteWorkerNativeTlsListener>> | undefined;
      let pendingDispatch: Promise<unknown> | undefined;
      let dispatchFromAssignment: (() => Promise<unknown>) | undefined;
      let workloadReads = 0;
      const dispatchStop = new AbortController();
      try {
        const tls = await tlsConfig(root);
        const workerEntrypoint = stockWriter ? await prepareStockWorkerWithNativeFiles(root)
          : fileURLToPath(new URL("../../../remote-worker/dist/main.js", import.meta.url));
        storage = new Storage({ dbPath: path.join(root, "gateway.sqlite"), transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
        const localStorage = storage;
        const asyncStorage = createLocalAsyncStorage(storage);
        const publication = new MeshCapabilityPublicationService({ storage: asyncStorage });
        const invocation = new MeshCapabilityInvocationService({ storage: asyncStorage, settlementPollIntervalMs: 10,
          transport: { localNodeId: () => "origin-gateway", appendEvent: (request) => asyncStorage.mesh.appendReplicationEvent(request) } });
        const runtime = createGatewayRemoteWorkerAssignmentRuntimeComposition({
          admissionStore: storage.remoteWorkerAdmissions, meshAdmissions: storage.remoteWorkerMeshNodeAdmissions,
          assignments: storage.remoteWorkerAssignments, nonceConsumer: storage.remoteWorkerNonces,
          meshCapabilities: { publication, invocation },
        });
        const evidence = new RemoteWorkerProtectedAdmissionEvidenceVerifier();
        const handler = await createGatewayRemoteWorkerAdmissionNativeRequestHandler({ config: tls.config,
          admissionStore: storage.remoteWorkerAdmissions, meshNodeAdmissionStore: storage.remoteWorkerMeshNodeAdmissions,
          assignmentProtocol: runtime.assignmentProtocol, assignmentDispatch: {
            assertAvailable: () => runtime.assignmentDispatch.assertAvailable(),
            execute: async (request) => {
              const result = await runtime.assignmentDispatch.execute(request);
              if (cut === "assignment_dependency" && request.rawPath === REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.readWorkload.rawPath) {
                // Controlled dependency after canonical admission/claim/workload
                // validation. This proves scheduling, not the full Chat policy loop.
                workloadReads++;
                if (!dispatchFromAssignment) throw new Error("Assignment dependency was not prepared.");
                await dispatchFromAssignment();
              }
              return result;
            },
          },
          assignmentExecution: { assertAvailable: async () => undefined, execute: async () => { throw new Error("No assignment execution in this mesh proof."); } },
          meshCapabilities: runtime.meshCapabilities, createEvidenceVerifier: () => evidence });
        if (!handler) throw new Error("Native mesh handler was not composed.");
        listener = await startRemoteWorkerNativeTlsListener(tls.config, handler);
        const port = portOf(listener.address);
        const signer = generateKeyPairSync("ed25519");
        const seeded = seedBootstrap(storage.db, tls, signer.publicKey.export({ format: "der", type: "spki" }) as Buffer,
          signer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), true, true);
        const stateDir = path.join(root, "worker-state");
        const ticketFile = path.join(root, "ticket.json");
        await writeFile(ticketFile, JSON.stringify(seeded.ticket), "utf8");
        const admitted = await bootstrapWorker({ root, port, paths: tls.paths, ticketFile, stateDir, runId: "admit", stopAfter: "admit" });
        expect(admitted).toMatchObject({ exitCode: 0, report: { admitted: "bootstrap_exchange" } });
        const generation = storage.remoteWorkerAdmissions.findCurrentGeneration("default", String(seeded.ticket.workerId))!;
        const protectedEvidence = storage.remoteWorkerAdmissions.findProtectedAdmissionEvidenceRecord("default", generation.workerId, generation.workerGeneration)!;
        const meshJoinCredential = randomBytes(32).toString("base64url");
        storage.remoteWorkerMeshNodeAdmissions.issueJoinAuthority({ registryWorkspaceId: "default", bootstrapId: generation.bootstrapId,
          workerId: generation.workerId, workerGeneration: generation.workerGeneration, nodeId: generation.nodeId,
          clientCertificateSha256: generation.clientCertificateSha256, protectedAdmissionEnvelopeSha256: protectedEvidence.envelopeSha256,
          protectedAdmissionContextSha256: protectedEvidence.contextSha256, workspaceId: "default", expiresInSeconds: 300,
          issuedByActorId: "operator-a", idempotencyKey: "mesh-destination-join", rawMeshNodeCredential: meshJoinCredential });
        const vault = await WorkerCredentialVault.open(createFileWorkerDurableState(stateDir));
        const context = { credential: vault.getCredential(), client: new WorkerWireClient({ host: "127.0.0.1", port,
          clientCertificatePem: await readFile(tls.paths.clientCert!, "utf8"), clientPrivateKeyPem: await readFile(tls.paths.clientKey!, "utf8"),
          trustAnchorPem: await readFile(tls.paths.ca!, "utf8") }) };
        await admitMeshNode(context, { workspaceId: "default", rawMeshNodeCredential: meshJoinCredential, idempotencyKey: "mesh-destination-admit" });
        const descriptor: MeshToolCapabilityDescriptor = { kind: "tool", title: "Controlled destination write", semanticVersion: "1.0.0",
          effectPosture: "write_local", permissions: { schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
            filesystemRead: [], filesystemWrite: ["workspace://mesh-proof"], networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
          resourceLimits: { timeoutMs: 60_000, maxRequestBytes: 1024, maxResponseBytes: 1024 },
          healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 120_000, timeoutMs: 5_000 },
          inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
          outputSchema: { type: "object" }, idempotency: "none" };
        const documents = path.join(root, "documents");
        if (stock) {
          await mkdir(documents);
          await writeFile(path.join(documents, "note.txt"), "Orion 7.\n", { flag: "wx" });
        }
        const bearerToken = bearer ? randomBytes(32).toString("base64url") : undefined;
        const authorization = bearerToken ? { type: "bearer_file" as const, file: path.join(root, "mcp.token"),
          sha256: createHash("sha256").update(bearerToken).digest("hex") } : undefined;
        if (authorization) await writeFile(authorization.file, bearerToken!, { flag: "wx" });
        if (stockMcp) mcpServer = await startDestinationMcpFixture(documents, { bearerToken });
        if (lostMcp) mcpServer!.setMode("disconnect");
        const localId = stockMcp ? "mcp.notes" : stockReader ? "file.read" : stockWriter ? "file.write" : "local.write";
        const publishedDescriptor = stockReader ? createWorkerMeshFileReadDescriptor("documents")
          : stockWriter ? createWorkerMeshFileWriteDescriptor("documents")
          : stockMcp ? createWorkerMeshMcpHttpDescriptor(mcpServer!.endpoint, destinationMcpTools, authorization) : descriptor;
        const published = await exchangeWorkerMeshCapability({ ...context, expectedNodeId: generation.nodeId, idempotencyKey: "publish-destination",
          payload: { schemaVersion: "goatcitadel.remote-worker-mesh-capability.v1", workspaceId: "default", action: "publish",
            submission: { publicationKey: "destination-proof", entries: [{ localId, kind: publishedDescriptor.kind,
              descriptor: publishedDescriptor as unknown as Record<string, unknown>, descriptorSha256: computeMeshCapabilityDescriptorSha256(publishedDescriptor) }] } } });
        if (published.action !== "publish") throw new Error("Wrong publication response.");
        const manifestFile = path.join(root, "manifest.json");
        await writeFile(manifestFile, canonicalJsonString(published.result.manifest), "utf8");
        const registryFile = path.join(root, "registry.json");
        let registrySha256 = "";
        if (stock) {
          const registryBytes = canonicalJsonString({ schemaVersion: WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION,
            workspaceId: "default", nodeId: generation.nodeId,
            bindings: [stockMcp ? { toolName: "mcp.http", localId, manifest: published.result.manifest,
              endpoint: mcpServer!.endpoint, tools: destinationMcpTools, ...(authorization ? { authorization } : {}) }
              : { toolName: stockWriter ? "fs.write" : "fs.read", localId,
                manifest: published.result.manifest, rootId: "documents", rootPath: documents }] });
          await writeFile(registryFile, registryBytes, { flag: "wx" });
          registrySha256 = createHash("sha256").update(registryBytes).digest("hex");
        }
        const entry = published.result.manifest.entries[0]!;
        const activationService = new MeshCapabilityActivationService({ storage: asyncStorage, publication });
        const approval = await activationService.requestActivation({ workspaceId: "default", capabilityId: entry.capabilityId,
          manifestSha256: published.result.manifest.manifestSha256, entrySha256: entry.entrySha256, actorId: "operator-a" });
        storage.approvals.resolve(approval.approval.approvalId, { decision: "approve", resolvedBy: "operator-a" });
        const { activation } = await activationService.executeApprovedActivation({ workspaceId: "default", approvalId: approval.approval.approvalId });
        const startDispatch = () => invocation.dispatch({ workspaceId: "default", binding: bindingOf(activation), capabilityId: entry.capabilityId,
          args: stockMcp ? { toolName: "note.read", arguments: { path: "note.txt" } }
            : stockReader ? { path: "note.txt" } : stockWriter ? { path: "note.txt", content: "Orion 8.\n", expectedContent: "Orion 7.\n" }
            : { message: "one actual destination effect" }, toolRunId: "mesh-destination-tool-run", sessionId: "session-a", turnId: "turn-a",
          executionProfileSha256: "9".repeat(64) }, { signal: dispatchStop.signal });
        let dispatch: ReturnType<typeof startDispatch> | undefined;
        dispatchFromAssignment = () => {
          dispatch ??= startDispatch();
          pendingDispatch = dispatch;
          // Capture rejection while the parent drives the separate worker process.
          void dispatch.catch(() => undefined);
          return dispatch;
        };
        if (cut === "assignment_dependency") seedAssignmentOffer(storage.db, true);
        else void dispatchFromAssignment();
        let delivered = false;
        for (let attempt = 0; cut !== "assignment_dependency" && attempt < 100 && !delivered; attempt++) {
          const pending = await exchangeWorkerMeshCapability({ ...context, expectedNodeId: generation.nodeId, idempotencyKey: `pending:${attempt}`,
            payload: { schemaVersion: "goatcitadel.remote-worker-mesh-capability.v1", workspaceId: "default", action: "pending" } });
          delivered = pending.action === "pending" && pending.result.items.length === 1;
          if (!delivered) await delay(10);
        }
        expect(delivered).toBe(cut !== "assignment_dependency");

        const start = (runId: string, point?: string) => {
          const launch = stock ? [workerEntrypoint]
            : ["--import", "tsx", fileURLToPath(new URL("../../test/fixtures/mesh-destination-worker.ts", import.meta.url))];
          const child = spawn(process.execPath, launch, {
            windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env,
              GOATCITADEL_CONNECTED_WORKER_HOST: "127.0.0.1", GOATCITADEL_CONNECTED_WORKER_PORT: String(port),
              GOATCITADEL_CONNECTED_WORKER_CLIENT_CERT_FILE: tls.paths.clientCert!, GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE: tls.paths.clientKey!,
              GOATCITADEL_CONNECTED_WORKER_CA_FILE: tls.paths.ca!, GOATCITADEL_CONNECTED_WORKER_TICKET_FILE: ticketFile,
              GOATCITADEL_CONNECTED_WORKER_STATE_DIR: stateDir, GOATCITADEL_CONNECTED_WORKER_REPORT_FILE: path.join(root, `${runId}.json`),
              GOATCITADEL_CONNECTED_WORKER_RUN_ID: runId,
              GOATCITADEL_CONNECTED_WORKER_STOP_AFTER: cut === "assignment_dependency" ? "workload" : "complete",
              GOATCITADEL_CONNECTED_WORKER_EXECUTION_MODE: "gateway_inference", GOATCITADEL_CONNECTED_WORKER_RUN_MODE: "once",
              GOATCITADEL_TEST_MESH_MANIFEST_FILE: manifestFile, GOATCITADEL_TEST_MESH_EFFECT_FILE: path.join(root, "mesh-effect.jsonl"),
              ...(stock ? { GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_FILE: registryFile,
                GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_SHA256: registrySha256 } : {}),
              ...(point ? { GOATCITADEL_TEST_MESH_CUT: point } : {}),
            },
          });
          let stderr = "";
          child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
          const exited = once(child, "exit");
          children.push({ child, exited });
          const message = stock ? exited.then(async ([code]) => {
            if (code !== 0) throw new Error(`Stock destination failed: ${stderr} ${await readFile(path.join(root, `${runId}.json`), "utf8")}`);
            return [{ kind: "report", report: JSON.parse(await readFile(path.join(root, `${runId}.json`), "utf8")) }];
          }) : Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Destination exited before reporting: ${stderr}`); })]);
          return { child, exited, message };
        };
        if (lostMcp) {
          const first = start("stock-mcp-lost");
          await expect(first.message).rejects.toThrow(/reconciliation/u);
          expect((await first.exited)[0]).toBe(1);
          const replay = start("stock-mcp-uncertain-restart");
          await expect(replay.message).rejects.toThrow(/reconciliation/u);
          expect((await replay.exited)[0]).toBe(1);
          expect(mcpServer!.toolCalls()).toBe(1);
        } else if (stock) {
          const first = start("stock-tool");
          expect((await first.message)[0]).toMatchObject({ kind: "report", report: { meshSettlementCount: 1,
            meshInvocation: { status: "settled", recovered: false, manualReconciliationRequired: false } } });
          if (stockWriter) expect(await readFile(path.join(root, "documents", "note.txt"), "utf8")).toBe("Orion 8.\n");
          await writeFile(path.join(root, "documents", "note.txt"), "Changed after settlement.");
          const replay = start("stock-tool-restart");
          const event = (await replay.message)[0] as { report: Record<string, unknown> };
          expect(event.report.meshInvocation).toBeUndefined();
          expect(event.report.meshSettlementCount).toBeUndefined();
          expect(await readFile(path.join(root, "documents", "note.txt"), "utf8")).toBe("Changed after settlement.");
          if (authorization) {
            await writeFile(authorization.file, randomBytes(32).toString("base64url"));
            const credentialRevoked = start("stock-credential-revoked");
            await expect(credentialRevoked.message).rejects.toThrow(/reconciliation/u);
            expect((await credentialRevoked.exited)[0]).toBe(1);
          }
          await writeFile(registryFile, "{}", "utf8");
          const revoked = start("stock-registry-revoked");
          await expect(revoked.message).rejects.toThrow(/reconciliation/u);
          expect((await revoked.exited)[0]).toBe(1);
          if (stockMcp) expect(mcpServer!.toolCalls()).toBe(1);
        } else if (cut === "assignment_dependency") {
          const first = start("assignment");
          const event = (await first.message)[0] as { kind: string; report: Record<string, unknown> };
          expect(event).toMatchObject({ kind: "report", report: { outcome: "stopped", meshSettlementCount: 1,
            meshInvocation: { status: "settled", recovered: false, manualReconciliationRequired: false } } });
          expect(event.report.stagesCompleted).toEqual(["admit", "claim", "workload"]);
          expect((await first.exited)[0]).toBe(0);
          const restart = start("assignment-resume");
          const replay = (await restart.message)[0] as { kind: string; report: Record<string, unknown> };
          expect(replay.report).toMatchObject({ outcome: "stopped", reconnectSync: "synchronized" });
          expect(replay.report.meshInvocation).toBeUndefined();
          expect((await restart.exited)[0]).toBe(0);
          expect(workloadReads).toBe(2);
        } else {
          const first = start("interrupted", cut);
          expect((await first.message)[0]).toEqual({ kind: "cut", point: cut });
          first.child.kill("SIGKILL");
          await first.exited;
          const restarted = start("recovered");
          const event = (await restarted.message)[0] as { kind: string; report: Record<string, unknown> };
          expect(event.kind).toBe("report");
          expect(event.report.meshInvocation).toMatchObject({ status: "settled", recovered: true,
            manualReconciliationRequired: cut === "after_effect", receipt: { disposition: cut === "after_effect" ? "unknown" : "succeeded" } });
          expect((await restarted.exited)[0]).toBe(0);
          if (cut === "after_effect") {
            const quarantined = start("quarantined-restart");
            await expect(quarantined.message).rejects.toThrow("reconciliation");
            expect((await quarantined.exited)[0]).toBe(1);
          }
        }
        const outcome = await dispatch;
        if (!outcome) throw new Error("No mesh dispatch was executed.");
        expect(outcome).toMatchObject({ settled: true, disposition: uncertain ? "unknown" : "succeeded" });
        if (cut === "after_settlement") expect(outcome.output).toEqual({ message: "one actual destination effect" });
        if (stockMcp) {
          if (!uncertain) expect(outcome.output).toEqual({ content: [{ type: "text", text: "Orion 7.\n" }],
            structuredContent: { content: "Orion 7.\n" }, isError: false });
          expect(await readdir(root)).not.toContain("mesh-effect.jsonl");
        } else if (stock) {
          expect(outcome.output).toEqual(stockReader ? { path: "note.txt", bytes: 9, content: "Orion 7.\n" }
            : { path: "note.txt", bytes: 9, sha256: createHash("sha256").update("Orion 8.\n").digest("hex"), created: false });
          expect(await readdir(root)).not.toContain("mesh-effect.jsonl");
        } else {
          const effects = (await readFile(path.join(root, "mesh-effect.jsonl"), "utf8")).trim().split("\n");
          expect(effects).toHaveLength(1);
          expect(JSON.parse(effects[0]!)).toMatchObject({ invocationId: outcome.invocationId });
        }
        expect(localStorage.meshCapabilityPublications.findInvocationSettlement("default", outcome.invocationId)?.disposition).toBe(outcome.disposition);
        const journalFile = (await readdir(stateDir)).find((name) => name.startsWith("mesh-execution-"))!;
        const journal = JSON.parse(await readFile(path.join(stateDir, journalFile), "utf8"));
        expect(journal.active).toBeUndefined();
        expect(journal.receipts).toHaveLength(1);
        if (bearerToken) {
          expect(mcpServer!.authorizationChecks).toEqual([true, true, true, true, true]);
          expect(JSON.stringify({ journal, outcome, manifest: published.result.manifest })).not.toContain(bearerToken);
        }
      } finally {
        for (const { child, exited } of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
        dispatchStop.abort();
        await pendingDispatch?.catch(() => undefined);
        await listener?.close();
        await mcpServer?.close();
        storage?.close();
        expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
        expect(path.basename(root)).toMatch(/^gc-mesh-destination-e2e-/u);
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000,
  );
});
