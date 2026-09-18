import { describe, expect, it, vi } from "vitest";
import { createWorkerControllerAttestationRelay } from "./worker-controller-attestation-relay.js";

function fixture() {
  const owner = new AbortController(), caller = new AbortController();
  const writes: Buffer[] = [];
  const current = vi.fn(async () => {});
  const relay = createWorkerControllerAttestationRelay(async frame => { writes.push(Buffer.from(frame)); }, owner.signal, current);
  const proof = (nonce = "11".repeat(32), ordinal = 1) => {
    const bytes = Buffer.alloc(460, 7); bytes.write("GCCATT01", 0, "ascii"); bytes.writeUInt32LE(ordinal, 8);
    Buffer.from(nonce, "hex").copy(bytes, 108); return bytes;
  };
  const started = async () => { await vi.waitFor(() => expect(writes).toHaveLength(1)); };
  return { relay, owner, caller, current, proof, writes, started };
}
describe("worker controller attestation relay", () => {
  it("relays a bounded fresh challenge and snapshots its out-of-band proof", async () => {
    const f = fixture();
    const pending = f.relay.transport.challenge("11".repeat(32), 1, f.caller.signal);
    await f.started();
    expect(f.writes[0]?.length).toBe(41);
    expect(f.writes[0]?.readUInt32LE(1)).toBe(36);
    expect(f.writes[0]?.[0]).toBe(20);
    const proof = f.proof(), original = Buffer.from(proof);
    f.relay.accept(proof); proof.fill(0);
    expect(await pending).toEqual({ statementHex: original.subarray(0, 396).toString("hex"), signatureHex: original.subarray(396).toString("hex") });
    expect(f.current).toHaveBeenCalledTimes(2);
    f.relay.close();
  });
  for (const kind of ["unsolicited", "length", "nonce", "ordinal", "magic", "duplicate"] as const) {
    it(`permanently rejects ${kind} proof`, async () => {
      const f = fixture();
      const pending = kind === "unsolicited" ? undefined : expect(f.relay.transport.challenge("11".repeat(32), 1, f.caller.signal)).rejects.toThrow();
      if (pending) await f.started();
      const bytes = f.proof(kind === "nonce" ? "22".repeat(32) : undefined, kind === "ordinal" ? 2 : 1);
      if (kind === "magic") bytes[0] = 0;
      if (kind === "duplicate") f.relay.accept(bytes);
      expect(() => f.relay.accept(kind === "length" ? bytes.subarray(1) : bytes)).toThrow();
      await pending;
      expect(f.relay.transport.signal.aborted).toBe(true);
    });
  }
  it("cancels a pending read when its native lifetime ends", async () => {
    const f = fixture();
    const pending = expect(f.relay.transport.challenge("11".repeat(32), 1, f.caller.signal)).rejects.toThrow();
    await f.started(); f.owner.abort(); await pending;
  });
  it("rejects a concurrent challenge and cancels the original", async () => {
    const f = fixture();
    const pending = expect(f.relay.transport.challenge("11".repeat(32), 1, f.caller.signal)).rejects.toThrow();
    await f.started();
    await expect(f.relay.transport.challenge("22".repeat(32), 2, f.caller.signal)).rejects.toThrow();
    await pending;
  });
  it("does not write after its authority check loses the caller", async () => {
    const f = fixture(); f.current.mockImplementation(async () => { f.caller.abort(); });
    await expect(f.relay.transport.challenge("11".repeat(32), 1, f.caller.signal)).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });
});
