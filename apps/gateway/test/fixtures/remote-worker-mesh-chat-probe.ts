import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJsonString,
} from "@goatcitadel/contracts";
import { computeMeshCapabilityDescriptorSha256 } from "@goatcitadel/storage";
import { WorkerWireClient } from "../../../remote-worker/src/worker-wire-client.js";
import { WorkerCredentialVault } from "../../../remote-worker/src/worker-credential-vault.js";
import { createFileWorkerDurableState } from "../../../remote-worker/src/worker-durable-state.js";
import { exchangeWorkerMeshCapability } from "../../../remote-worker/src/worker-mesh-capability-client.js";
import { createWorkerMeshFileReadDescriptor } from "../../../remote-worker/src/worker-mesh-file-read.js";
import { createWorkerMeshFileWriteDescriptor } from "../../../remote-worker/src/worker-mesh-file-write.js";
import { createWorkerMeshMcpHttpDescriptor } from "../../../remote-worker/src/worker-mesh-mcp-http.js";
import { destinationMcpTools, startDestinationMcpFixture } from "../../../remote-worker/src/worker-destination-mcp.test-fixture.js";
import { prepareStockWorkerWithNativeFiles } from "./remote-worker-native.js";
import { WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION } from "../../../remote-worker/src/worker-mesh-tool-registry.js";
import { readWorkerMeshJournal } from "../../../remote-worker/src/worker-mesh-capability-journal.js";
import { workerMeshHash } from "../../../remote-worker/src/worker-mesh-capability-data.js";

/** Publish a stock filesystem or MCP tool through the actual native listener. */
export async function prepareWorkerMeshChatProbe(input: {
  root: string; port: number; paths: Readonly<Record<string, string>>; stateDir: string; nodeId: string;
  write?: boolean;
  mcp?: boolean;
  mcpBearer?: boolean;
}) {
  const vault = await WorkerCredentialVault.open(createFileWorkerDurableState(input.stateDir));
  const client = new WorkerWireClient({ host: "127.0.0.1", port: input.port,
    clientCertificatePem: await readFile(input.paths.clientCert!, "utf8"),
    clientPrivateKeyPem: await readFile(input.paths.clientKey!, "utf8"),
    trustAnchorPem: await readFile(input.paths.ca!, "utf8") });
  const documents = join(input.root, "mesh-documents");
  await mkdir(documents);
  await writeFile(join(documents, "note.txt"), "Orion 7.\n", { flag: "wx" });
  const bearerToken = input.mcp && input.mcpBearer ? randomBytes(32).toString("base64url") : undefined;
  const authorization = bearerToken ? { type: "bearer_file" as const, file: join(input.root, "destination-mcp.token"),
    sha256: createHash("sha256").update(bearerToken).digest("hex") } : undefined;
  if (authorization) await writeFile(authorization.file, bearerToken!, { flag: "wx" });
  const mcp = input.mcp ? await startDestinationMcpFixture(documents, { bearerToken }) : undefined;
  try {
    const descriptor = mcp ? createWorkerMeshMcpHttpDescriptor(mcp.endpoint, destinationMcpTools, authorization)
      : input.write ? createWorkerMeshFileWriteDescriptor("documents") : createWorkerMeshFileReadDescriptor("documents");
    const published = await exchangeWorkerMeshCapability({ client, credential: vault.getCredential(),
      expectedNodeId: input.nodeId, idempotencyKey: "publish-mesh-chat-proof",
      payload: { schemaVersion: "goatcitadel.remote-worker-mesh-capability.v1", workspaceId: "default", action: "publish",
        submission: { publicationKey: "mesh-chat-proof", entries: [{ localId: mcp ? "mcp.notes" : input.write ? "file.write" : "file.read", kind: descriptor.kind,
          descriptor: descriptor as unknown as Record<string, unknown>, descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor) }] } } });
    if (published.action !== "publish") throw new Error("Unexpected mesh publication response.");
    const manifest = published.result.manifest;
    const entry = manifest.entries[0]!;
    const expectedOutput = mcp ? { content: [{ type: "text", text: "Orion 7.\n" }], structuredContent: { content: "Orion 7.\n" }, isError: false }
      : input.write ? { path: "note.txt", bytes: 9, created: false,
      sha256: createHash("sha256").update("Orion 8.\n").digest("hex") } : { path: "note.txt", bytes: 9, content: "Orion 7.\n" };
    const registryBytes = canonicalJsonString({ schemaVersion: WORKER_MESH_TOOL_REGISTRY_SCHEMA_VERSION,
      workspaceId: manifest.workspaceId, nodeId: input.nodeId,
      bindings: [mcp ? { toolName: "mcp.http", localId: entry.localId, manifest, endpoint: mcp.endpoint, tools: destinationMcpTools,
        ...(authorization ? { authorization } : {}) }
        : { toolName: input.write ? "fs.write" : "fs.read", localId: entry.localId, manifest, rootId: "documents", rootPath: documents }] });
    const registry = { file: join(input.root, "mesh-registry.json"), sha256: createHash("sha256").update(registryBytes).digest("hex") };
    await writeFile(registry.file, registryBytes, { flag: "wx" });
    const credential = vault.getCredential();
    const journalKey = `mesh-execution-${workerMeshHash({ workspaceId: manifest.workspaceId, nodeId: input.nodeId,
      registryWorkspaceId: credential.registryWorkspaceId, workerGeneration: credential.workerGeneration })}`;
    return {
      registry, expectedOutput, expectedOutputSha256: workerMeshHash(expectedOutput), capabilityId: entry.capabilityId,
      stockWorkerEntrypoint: input.write ? await prepareStockWorkerWithNativeFiles(input.root) : undefined,
      args: mcp ? { toolName: "note.read", arguments: { path: "note.txt" } }
        : input.write ? { path: "note.txt", content: "Orion 8.\n", expectedContent: "Orion 7.\n" } : { path: "note.txt" },
      readContent: () => readFile(join(documents, "note.txt"), "utf8"),
      mcpCalls: () => mcp?.toolCalls(),
      mcpAuthentication: () => bearerToken ? { requests: mcp!.authorizationChecks.length, allAccepted: mcp!.authorizationChecks.every(Boolean) } : undefined,
      assertCredentialAbsent: (value: unknown) => {
        if (bearerToken && JSON.stringify(value).includes(bearerToken)) throw new Error("Destination credential escaped into execution evidence.");
      },
      close: async () => { await mcp?.close(); },
      activationRequest: { workspaceId: "default", capabilityId: entry.capabilityId,
        manifestSha256: manifest.manifestSha256, entrySha256: entry.entrySha256 },
      async receipts() {
        return (await readWorkerMeshJournal(createFileWorkerDurableState(input.stateDir), journalKey)).receipts;
      },
    };
  } catch (error) { await mcp?.close(); throw error; }
}
