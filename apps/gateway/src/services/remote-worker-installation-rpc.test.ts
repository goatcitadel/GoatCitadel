import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString, captureRemoteWorkerNativePoolCapacityResponse, encodeRemoteWorkerControllerAttestation,
  encodeRemoteWorkerInstallCapacityChallenge, hashRemoteWorkerControllerPublicKey, hashRemoteWorkerInstallCapacityCapture,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerRuntimeInstallRequestSha256, remoteWorkerCellCanonicalSha256 } from "@goatcitadel/contracts";
import { nativePoolCapacityResponseFixture } from "../../../../packages/contracts/src/remote-worker-native-pool-capacity-response-test-fixture.js";
import { objectInventoryHistoryFixture } from "../../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { RemoteWorkerInstallationRpc } from "./remote-worker-installation-rpc.js";
import { RemoteWorkerInstallationSessionOwner } from "./remote-worker-installation-session.js";
import { RemoteWorkerInstallationCapacityOwner } from "./remote-worker-installation-capacity-owner.js";
import { openWorkerInstallationSession } from "../../../remote-worker/src/worker-installation-session-client.js";
import { callProtectedRoute } from "../../../remote-worker/src/worker-protected-route-client.js";
import { createWorkerControllerAttestationRelay } from "../../../remote-worker/src/worker-controller-attestation-relay.js";
vi.mock("../../../remote-worker/src/worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const f = nativePoolCapacityResponseFixture(1), history = objectInventoryHistoryFixture();
  const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const request = { schemaVersion: "goatcitadel.worker-runtime-install.v1" as const, nonce: "22".repeat(32),
    journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
    checkpointSha256: history.mountedWorkspaceRecords!.at(-1)!.slice(-64), packageSha256: "55".repeat(32),
    runtimeBundle: { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const, files: [
      { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) }, { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) }] } };
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = pair.publicKey.export({ format: "jwk" });
  const publicPointHex = `04${Buffer.from(jwk.x!, "base64url").toString("hex")}${Buffer.from(jwk.y!, "base64url").toString("hex")}`;
  const enrollment = { publicPointHex, keySha256: hashRemoteWorkerControllerPublicKey(publicPointHex) };
  const baseline = { request, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request), history, pool: f.pool, layout: f.layout };
  const material = { baseline, enrollment, referencesJson: canonicalJsonString(f.source.references) };
  const readPin = vi.fn(async () => enrollment), validate = vi.fn(async ({ capture }: { capture: { binding: unknown } }) => ({ binding: capture.binding,
    baselineSha256: remoteWorkerCellCanonicalSha256(baseline) }));
  const storage = { remoteWorkerRuntimeInstalls: { readControllerCaptureContextForAssignment: vi.fn(async () => material),
    readControllerEnrollmentForAssignment: readPin, readPoolAdmissionMaterialForAssignment: vi.fn(async () => baseline), validatePoolCaptureForAssignment: validate } };
  const reservations = new RemoteWorkerInstallationCapacityOwner(storage as never, { verify: async () => {} });
  const sessions = new RemoteWorkerInstallationSessionOwner(reservations, storage as never);
  const rpc = new RemoteWorkerInstallationRpc(storage as never, sessions);
  const authority = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId,
    assignmentGeneration: history.assignmentGeneration, leaseRevision: history.leaseRevision, leaseTokenSha256: "55".repeat(32),
    protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } } as Parameters<typeof rpc.exchange>[0];
  const stop = new AbortController(), lease = { ...authority, leaseToken: "fixture-token" };
  const commands: Parameters<typeof rpc.exchange>[0]["submission"][] = [];
  vi.mocked(callProtectedRoute).mockImplementation(async input => {
    const submission = (input.payload as { submission: Parameters<typeof rpc.exchange>[0]["submission"] }).submission;
    commands.push(submission);
    const installationSession = await rpc.exchange({ ...authority, submission, signal: input.signal! });
    return { body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", registryWorkspaceId: history.registryWorkspaceId,
      operation: "assignment.settlement.submit", disposition: "installation_session", installationSession } } as never;
  });
  const open = () => openWorkerInstallationSession({} as never, lease, request, stop.signal);
  async function capture() {
    const client = await open();
    const bytes = Buffer.from(f.bytes); Buffer.from(client.capture.captureNonce, "hex").copy(bytes, 88 + 384 + 8);
    const responseHex = bytes.toString("hex"), binding = { connectionNonceHex: f.window.connectionNonceHex,
      installationNonce: request.nonce, requestSha256: baseline.requestSha256, byteLength: bytes.length,
      captureSha256: hashRemoteWorkerInstallCapacityCapture(bytes) };
    const delivery = captureRemoteWorkerNativePoolCapacityResponse(responseHex, f.pool, f.layout, client.capture.captureNonce, f.source.references);
    const relay = createWorkerControllerAttestationRelay(async frame => {
      const statement = Buffer.from(encodeRemoteWorkerControllerAttestation({ keySha256: enrollment.keySha256,
        controllerInstanceHex: "aa".repeat(32), authoritySha256: history.plan.assignmentBindingSha256,
        challengeNonceHex: frame.subarray(5, 37).toString("hex"), ordinal: frame.readUInt32LE(37),
        installationNonce: request.nonce, requestSha256: baseline.requestSha256, window: delivery.window }));
      relay.accept(Buffer.concat([statement, sign("sha256", statement, { key: pair.privateKey, dsaEncoding: "ieee-p1363" })]));
    }, stop.signal, async () => {});
    await client.admission.connected(binding.connectionNonceHex, stop.signal, relay.transport);
    await client.admission.capture(responseHex, binding, delivery, stop.signal);
    return { client, relay, binding, delivery };
  }
  return { ...f, rpc, authority, storage, stop, commands, open, capture, readPin, validate };
}
describe("protected installation session pump", () => {
  it("joins worker RPC, native relay, signature verification, reservation and terminal shutdown", async () => {
    const f = fixture(), { client, relay, binding } = await f.capture();
    await client.admission.verify(encodeRemoteWorkerInstallCapacityChallenge(binding, 1), f.stop.signal);
    await client.admission.verify(encodeRemoteWorkerInstallCapacityChallenge(binding, 2), f.stop.signal);
    const join = vi.fn(async () => { expect(f.commands.at(-1)?.action).toBe("proof"); });
    await client.admission.finish(join, f.stop.signal);
    expect(join).toHaveBeenCalledOnce();
    expect(f.commands.at(-1)?.action).toBe("joined");
    expect(f.validate).toHaveBeenCalledTimes(4);
    expect(f.commands.filter(command => command.action === "proof").length).toBeGreaterThan(8);
    relay.close(); client.close(); f.stop.abort();
  });
  it.each(["revoked", "aborted", "ordinal", "join"])("does not complete on %s", async mode => {
    const f = fixture(), { client, relay, binding } = await f.capture();
    if (mode === "revoked") f.readPin.mockRejectedValue(new Error("revoked"));
    if (mode === "aborted") f.stop.abort();
    if (mode === "join") {
      await client.admission.verify(encodeRemoteWorkerInstallCapacityChallenge(binding, 1), f.stop.signal);
      await expect(client.admission.finish(async () => { throw new Error("helper did not join"); }, f.stop.signal)).rejects.toThrow();
    } else await expect(client.admission.verify(encodeRemoteWorkerInstallCapacityChallenge(binding, mode === "ordinal" ? 2 : 1), f.stop.signal)).rejects.toThrow();
    expect(f.commands.at(-1)?.action).not.toBe("joined");
    relay.close(); client.close(); f.stop.abort();
  });
  it("refuses foreign authority and poisons replayed sequence numbers", async () => {
    const f = fixture(), client = await f.open(); const first = f.commands[0]!;
    await expect(f.rpc.exchange({ ...f.authority, leaseRevision: f.authority.leaseRevision + 1,
      submission: { ...first, sequence: 2, action: "capture", payloadHex: "00" }, signal: f.stop.signal })).rejects.toThrow();
    await expect(f.rpc.exchange({ ...f.authority, submission: first, signal: f.stop.signal })).rejects.toThrow();
    client.close(); f.stop.abort();
  });
  it("refuses approval-selected context failure before starting a native session", async () => {
    const f = fixture(); f.storage.remoteWorkerRuntimeInstalls.readControllerCaptureContextForAssignment.mockRejectedValue(new Error("not approved"));
    await expect(f.open()).rejects.toThrow(); expect(f.validate).not.toHaveBeenCalled(); f.stop.abort();
  });
});
