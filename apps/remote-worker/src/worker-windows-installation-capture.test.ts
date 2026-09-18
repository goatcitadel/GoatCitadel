import { describe, expect, it, vi } from "vitest";
import { encodeRemoteWorkerInstallCapacityChallenge, hashRemoteWorkerInstallCapacityCapture, normalizeRemoteWorkerNativeCapacityLayout } from "@goatcitadel/contracts";
import { nativePoolCapacityResponseFixture } from "../../../packages/contracts/src/remote-worker-native-pool-capacity-response-test-fixture.js";
import { createWindowsInstallationCapture } from "./worker-windows-installation-capture.js";

function fixture() {
  const f = nativePoolCapacityResponseFixture();
  const selection = { nonce: "11".repeat(32), requestSha256: "22".repeat(32) };
  const binding = { connectionNonceHex: f.window.connectionNonceHex, installationNonce: selection.nonce,
    requestSha256: selection.requestSha256, captureSha256: hashRemoteWorkerInstallCapacityCapture(f.bytes), byteLength: f.bytes.length };
  const owner = { connected: vi.fn<() => Promise<void>>(async () => {}), capture: vi.fn<() => Promise<void>>(async () => {}), verify: vi.fn<() => Promise<void>>(async () => {}) };
  const current = vi.fn(async () => undefined), abort = new AbortController();
  const bridge = createWindowsInstallationCapture(selection, { pool: f.pool, layout: normalizeRemoteWorkerNativeCapacityLayout(f.layout), captureNonce: f.window.nonce,
    referencesJson: JSON.stringify(f.source.references) }, owner, current, abort.signal);
  const connect = () => bridge.accept(15, Buffer.from(binding.connectionNonceHex, "hex"));
  const header = () => bridge.accept(16, encodeRemoteWorkerInstallCapacityChallenge(binding, 1));
  const capture = () => bridge.accept(17, f.bytes);
  const verify = (ordinal = 1) => bridge.accept(18, encodeRemoteWorkerInstallCapacityChallenge(binding, ordinal));
  return { f, selection, binding, owner, current, abort, bridge, connect, header, capture, verify };
}
describe("installation capture parent", () => {
  it("validates the full independent pool before acknowledging ordered reservation checks", async () => {
    const f = fixture();
    await f.connect(); await f.header(); await f.capture();
    expect(f.owner.connected).toHaveBeenCalledWith(f.binding.connectionNonceHex, f.abort.signal);
    expect(f.owner.capture).toHaveBeenCalledOnce();
    const capture = f.owner.capture.mock.calls[0] as unknown as [string, typeof f.binding, { window: unknown }];
    expect(capture[0]).toBe(f.f.bytes.toString("hex")); expect(capture[1]).toEqual(f.binding);
    expect(capture[2].window).toEqual(f.f.window);
    for (const ordinal of [1, 2]) {
      const reply = await f.verify(ordinal);
      expect(reply?.subarray(0, 5)).toEqual(Buffer.from([19, 144, 0, 0, 0]));
      expect(reply?.subarray(5)).toEqual(Buffer.from(encodeRemoteWorkerInstallCapacityChallenge(f.binding, ordinal)));
    }
    f.bridge.assertComplete(); f.bridge.close();
    await expect(f.verify(3)).rejects.toThrow();
  });
  it.each(["header-before-connection", "capture-before-header", "verify-before-capture", "duplicate-connection", "duplicate-header", "duplicate-capture", "replayed-ordinal", "skipped-ordinal", "unknown"])("poisons %s", async mode => {
    const f = fixture();
    let attempt: () => Promise<unknown>;
    if (mode === "header-before-connection") attempt = f.header;
    else if (mode === "capture-before-header") { await f.connect(); attempt = f.capture; }
    else if (mode === "duplicate-connection") { await f.connect(); attempt = f.connect; }
    else {
      await f.connect(); await f.header();
      if (mode === "duplicate-header") attempt = f.header;
      else if (mode === "verify-before-capture") attempt = () => f.verify();
      else {
        await f.capture();
        if (mode === "duplicate-capture") attempt = f.capture;
        else if (mode === "replayed-ordinal") { await f.verify(); attempt = () => f.verify(); }
        else if (mode === "skipped-ordinal") attempt = () => f.verify(2);
        else attempt = () => f.bridge.accept(99, new Uint8Array());
      }
    }
    await expect(attempt()).rejects.toThrow(); await expect(f.connect()).rejects.toThrow();
    expect(() => f.bridge.assertComplete()).toThrow();
  });
  it.each([0, 32, 64, 128, 132, 140])("rejects altered capture binding at byte %i before admission", async offset => {
    const f = fixture(); await f.connect(); const header = encodeRemoteWorkerInstallCapacityChallenge(f.binding, 1);
    header[offset]! ^= 1;
    await expect(f.bridge.accept(16, header)).rejects.toThrow(); expect(f.owner.capture).not.toHaveBeenCalled();
  });
  it("rejects a changed full capture even with an otherwise valid envelope", async () => {
    const f = fixture(); await f.connect(); await f.header(); const changed = Buffer.from(f.f.bytes); changed[changed.length - 1]! ^= 1;
    await expect(f.bridge.accept(17, changed)).rejects.toThrow(); expect(f.owner.capture).not.toHaveBeenCalled();
  });
  it("requires semantic pool validation even when a tampered response has a matching digest", async () => {
    const f = fixture(); await f.connect(); const changed = Buffer.from(f.f.bytes); changed.writeUInt32LE(1, 12);
    const binding = { ...f.binding, captureSha256: hashRemoteWorkerInstallCapacityCapture(changed) };
    await f.bridge.accept(16, encodeRemoteWorkerInstallCapacityChallenge(binding, 1));
    await expect(f.bridge.accept(17, changed)).rejects.toThrow(); expect(f.owner.capture).not.toHaveBeenCalled();
  });
  it("freezes incoming challenge bytes before an asynchronous current-state check", async () => {
    const f = fixture(); await f.connect(); await f.header(); await f.capture();
    const challenge = encodeRemoteWorkerInstallCapacityChallenge(f.binding, 1), expected = Buffer.from(challenge);
    f.current.mockImplementationOnce(async () => { challenge.fill(0); });
    const reply = await f.bridge.accept(18, challenge); expect(reply?.subarray(5)).toEqual(expected);
  });
  it("withholds acknowledgement until canonical verification completes", async () => {
    const f = fixture(); await f.connect(); await f.header(); await f.capture();
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    f.owner.verify.mockReturnValueOnce(waiting); let replied = false;
    const operation = f.verify().then(result => { replied = true; return result; });
    await vi.waitFor(() => expect(f.owner.verify).toHaveBeenCalledOnce()); expect(replied).toBe(false);
    release(); expect(await operation).toBeDefined();
  });
  it("cancels a stalled admission without sending any later acknowledgement", async () => {
    const f = fixture(); await f.connect(); await f.header();
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    f.owner.capture.mockReturnValueOnce(waiting); const operation = f.capture();
    await vi.waitFor(() => expect(f.owner.capture).toHaveBeenCalledOnce()); f.abort.abort();
    await expect(operation).rejects.toThrow(); release(); await expect(f.verify()).rejects.toThrow();
  });
  it("poisons overlapping calls without allowing the first call to acknowledge", async () => {
    const f = fixture(); await f.connect(); await f.header(); await f.capture();
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    f.owner.verify.mockReturnValueOnce(waiting); const first = f.verify();
    await vi.waitFor(() => expect(f.owner.verify).toHaveBeenCalledOnce());
    await expect(f.verify()).rejects.toThrow(); release(); await expect(first).rejects.toThrow();
  });
});
