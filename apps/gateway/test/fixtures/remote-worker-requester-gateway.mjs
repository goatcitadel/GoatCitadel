// A separate process with the built application and a trusted, synthetic resolver.
// The stock main entry point keeps its empty resolver registry.
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../../dist/app.js";
import { endBootTracking } from "../../dist/boot-tracker.js";
import { performShutdown } from "../../dist/shutdown.js";
import { createMcpEphemeralResolvedConnectionCandidate } from "../../dist/services/mcp-requester-resolution.js";
import { createRemoteWorkerNativeRuntimeService } from "../../dist/services/remote-worker-native-runtime-service.js";
import { RemoteWorkerArtifactStore } from "../../dist/services/remote-worker-artifact-store.js";
import { RemoteWorkerAssignmentProtocolService } from "../../dist/services/remote-worker-assignment-protocol-service.js";

const endpoint = new URL(process.env.GOATCITADEL_VERIFY_MCP_URL);
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.pathname !== "/mcp" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  process.env.GATEWAY_HOST !== "127.0.0.1" ||
  !process.env.GOATCITADEL_AUTH_TOKEN
) {
  throw new Error("Requester Gateway fixture requires isolated loopback endpoints and a test actor.");
}
if (process.env.GOATCITADEL_VERIFY_DELAY_TERMINAL_SETTLEMENT === "true") {
  const settle = RemoteWorkerAssignmentProtocolService.prototype.settle;
  RemoteWorkerAssignmentProtocolService.prototype.settle = async function (...args) {
    process.stdout.write(
      `${JSON.stringify({ fixture: "delayed_terminal_settlement", delayMs: 6_000, phase: "started" })}\n`,
    );
    await delay(6_000);
    try {
      return await settle.apply(this, args);
    } catch (error) {
      const parentFenceMessage =
        "remote worker assignment lease parent dispatch authority conflicts with durable assignment authority.";
      process.stdout.write(
        `${JSON.stringify({
          fixture: "delayed_terminal_settlement",
          delayMs: 6_000,
          rejectedAt:
            error instanceof Error && error.message === parentFenceMessage ? "parent_heartbeat_fence" : "unclassified",
        })}\n`,
      );
      throw error;
    }
  };
}
if (process.env.GOATCITADEL_VERIFY_DELAY_ARTIFACT_COMMIT === "true") {
  // Exercise an artifact write spanning the worker's five-second heartbeat.
  // Only this isolated entry point delays I/O; the real CAS and fences still run.
  const installBlob = RemoteWorkerArtifactStore.prototype.installBlob;
  RemoteWorkerArtifactStore.prototype.installBlob = async function (input) {
    process.stdout.write(`${JSON.stringify({ fixture: "delayed_artifact_commit", delayMs: 6_000 })}\n`);
    await delay(6_000, undefined, { signal: input.signal });
    return await installBlob.call(this, input);
  };
}
const actorId = `token:${createHash("sha256").update(process.env.GOATCITADEL_AUTH_TOKEN).digest("hex").slice(0, 16)}`;
const resolve = async ({ serverId, requester, signal }) => {
  if (
    signal.aborted ||
    serverId !== "worker-mcp" ||
    requester.actorId !== actorId ||
    requester.actorSource !== "token" ||
    requester.workspaceId !== "default"
  ) {
    throw new Error("Requester Gateway fixture authority mismatch.");
  }
  return createMcpEphemeralResolvedConnectionCandidate({
    outcomeClass: "resolved",
    url: endpoint.href,
    headers: [{ name: "authorization", value: "Bearer controlled-worker-mcp-secret" }],
    connectionGeneration: 1,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
};
const registration = { resolverId: "fixture.worker", resolverVersion: "1.0.0", configGeneration: 1 };
const app = await buildApp({
  mcpRequesterResolvers: {
    profileDiscovery: [{ ...registration, resolveForProfileDiscovery: resolve }],
    toolCall: [{ ...registration, resolveForToolCall: resolve }],
  },
});
const native = createRemoteWorkerNativeRuntimeService({
  sharedHostLifecycle: app.sharedHostLifecycle,
  createHandler: (config) => app.gatewayRuntime.createRemoteWorkerAdmissionNativeRequestHandler(config),
});
let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await performShutdown(app, signal, undefined, { stopListeners: () => native.close() });
  endBootTracking();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
try {
  await native.start();
  await app.listen({ host: "127.0.0.1", port: Number(process.env.GATEWAY_PORT) });
  endBootTracking();
} catch (error) {
  await shutdown("STARTUP_FAILURE");
  throw error;
}
