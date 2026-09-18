import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodeRemoteWorkerControllerAttestation, hashRemoteWorkerControllerPublicKey } from "@goatcitadel/contracts";
import { createControllerSignedInstallationEndpoint } from "./remote-worker-controller-attestation.js";
import { createWorkerControllerAttestationRelay } from "../../../remote-worker/src/worker-controller-attestation-relay.js";

function fixture() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const publicPointHex = `04${Buffer.from(jwk.x!, "base64url").toString("hex")}${Buffer.from(jwk.y!, "base64url").toString("hex")}`;
  const authority = { publicPointHex, keySha256: hashRemoteWorkerControllerPublicKey(publicPointHex),
    controllerInstanceHex: "11".repeat(32), authoritySha256: "22".repeat(32), connectionNonceHex: "33".repeat(32),
    installationNonce: "44".repeat(32), requestSha256: "55".repeat(32) };
  const window = { nonce: "66".repeat(32), connectionNonceHex: authority.connectionNonceHex, poolSnapshotSha256: "77".repeat(32),
    hostCaptureSha256: "88".repeat(32), membersSha256: "99".repeat(32), referencesSha256: "aa".repeat(32) };
  const statement = (nonce: string, ordinal: number) => ({ keySha256: authority.keySha256,
    controllerInstanceHex: authority.controllerInstanceHex, authoritySha256: authority.authoritySha256,
    installationNonce: authority.installationNonce, requestSha256: authority.requestSha256,
    challengeNonceHex: nonce, ordinal, window });
  const signed = (value: ReturnType<typeof statement>, privateKey = pair.privateKey) => {
    const bytes = Buffer.from(encodeRemoteWorkerControllerAttestation(value));
    return { statementHex: bytes.toString("hex"), signatureHex: sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex") };
  };
  const stop = new AbortController(), caller = new AbortController();
  const challenge = vi.fn(async (nonce: string, ordinal: number) => signed(statement(nonce, ordinal)));
  const current = vi.fn(async (_signal: AbortSignal) => {});
  const endpoint = createControllerSignedInstallationEndpoint(authority, { signal: stop.signal, challenge }, current);
  return { authority, window, statement, signed, stop, caller, challenge, current, endpoint };
}

describe("controller-signed installation endpoint", () => {
  it("pins a previously unknown instance only after verifying its fresh signature", async () => {
    const f = fixture();
    const endpoint = createControllerSignedInstallationEndpoint({ ...f.authority, controllerInstanceHex: undefined },
      { signal: f.stop.signal, challenge: f.challenge }, f.current);
    await endpoint.verify(f.window, f.caller.signal);
    f.challenge.mockImplementation(async (nonce, ordinal) => f.signed({ ...f.statement(nonce, ordinal), controllerInstanceHex: "bb".repeat(32) }));
    await expect(endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    expect(endpoint.signal.aborted).toBe(true);
  });
  it("verifies proof through the worker's out-of-band native frame relay", async () => {
    const f = fixture();
    const relay = createWorkerControllerAttestationRelay(async frame => {
      expect(frame[0]).toBe(20); expect(frame.readUInt32LE(1)).toBe(36);
      const signed = f.signed(f.statement(frame.subarray(5, 37).toString("hex"), frame.readUInt32LE(37)));
      relay.accept(Buffer.from(signed.statementHex + signed.signatureHex, "hex"));
    }, f.stop.signal, f.current);
    const endpoint = createControllerSignedInstallationEndpoint({ ...f.authority, controllerInstanceHex: undefined }, relay.transport, f.current);
    await endpoint.verify(f.window, f.caller.signal);
    await endpoint.verify(f.window, f.caller.signal);
    relay.close();
    await expect(endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
  });
  it("requires a fresh signed challenge and enrollment check before and after every exchange", async () => {
    const f = fixture();
    await f.endpoint.verify(f.window, f.caller.signal);
    await f.endpoint.verify(f.window, f.caller.signal);
    expect(f.challenge.mock.calls.map(call => call[1])).toEqual([1, 2]);
    expect(f.challenge.mock.calls[0]![0]).not.toBe(f.challenge.mock.calls[1]![0]);
    expect(f.current).toHaveBeenCalledTimes(4);
  });
  for (const field of ["keySha256", "controllerInstanceHex", "authoritySha256", "challengeNonceHex", "installationNonce", "requestSha256"] as const) {
    it(`rejects a correctly signed foreign ${field}`, async () => {
      const f = fixture();
      f.challenge.mockImplementation(async (nonce, ordinal) => f.signed({ ...f.statement(nonce, ordinal), [field]: "bb".repeat(32) }));
      await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
      expect(f.endpoint.signal.aborted).toBe(true);
    });
  }
  for (const field of ["nonce", "connectionNonceHex", "poolSnapshotSha256", "hostCaptureSha256", "membersSha256", "referencesSha256"] as const) {
    it(`rejects a correctly signed different window ${field}`, async () => {
      const f = fixture();
      f.challenge.mockImplementation(async (nonce, ordinal) => f.signed({ ...f.statement(nonce, ordinal), window: { ...f.window, [field]: "bb".repeat(32) } }));
      await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    });
  }
  it("rejects a signature from another controller key", async () => {
    const f = fixture(), other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    f.challenge.mockImplementation(async (nonce, ordinal) => f.signed(f.statement(nonce, ordinal), other.privateKey));
    await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
  });
  it("rejects replay and permanently closes the endpoint", async () => {
    const f = fixture();
    await f.endpoint.verify(f.window, f.caller.signal);
    const prior = await f.challenge.mock.results[0]!.value;
    f.challenge.mockResolvedValue(prior);
    await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    expect(f.challenge).toHaveBeenCalledTimes(2);
  });
  it("rejects enrollment revocation during a valid exchange", async () => {
    const f = fixture();
    f.current.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    expect(f.endpoint.signal.aborted).toBe(true);
  });
  it("aborts a transport that ignores cancellation and refuses concurrent challenges", async () => {
    const f = fixture();
    f.challenge.mockImplementation(() => new Promise(() => {}));
    const first = expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    await first;
    expect(f.endpoint.signal.aborted).toBe(true);
  });
  it("rejects disconnected transport before sending any challenge", async () => {
    const f = fixture(); f.stop.abort();
    await expect(f.endpoint.verify(f.window, f.caller.signal)).rejects.toThrow();
    expect(f.challenge).not.toHaveBeenCalled();
  });
  it("rejects a substituted enrollment public point", () => {
    const f = fixture();
    expect(() => createControllerSignedInstallationEndpoint({ ...f.authority, keySha256: "bb".repeat(32) },
      { signal: f.stop.signal, challenge: f.challenge }, f.current)).toThrow();
  });
});
