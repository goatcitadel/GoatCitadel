import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerRuntimeResultSubmission as normalize, normalizeRemoteWorkerRuntimeResultExchange as exchange } from "./remote-worker-runtime-result-pages.js";
import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";

describe("bounded native result transport", () => {
  const fixture = runtimeResultPagesFixture();
  it("rejects every ASCII control character in scope identifiers", () => {
    const valid = fixture.response(null);
    for (const field of ["registryWorkspaceId", "assignmentId"]) {
      for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127])
        expect(() => exchange({ ...valid, [field]: `scope${String.fromCharCode(code)}` })).toThrow();
      expect(exchange({ ...valid, [field]: "scope é" })).toHaveProperty(field, "scope é");
    }
  });
  it("keeps all 31 full-result pages under the unchanged 256 KiB RPC ceiling", () => {
    let count = 0;
    for (let offset = 0; offset < fixture.bytes.length; offset += 32768) {
      const page = normalize(fixture.page(offset)), response = exchange(fixture.response(fixture.page(offset)));
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(256 * 1024);
      expect(Object.isFrozen(page) && Object.isFrozen(response)).toBe(true); count += 1;
    }
    expect(count).toBe(31);
    expect(exchange(fixture.response(fixture.page(), true)).accepted?.nextOffset).toBe(fixture.bytes.length);
    expect(exchange(fixture.response(null, true)).accepted).toBeNull();
  });
  it.each([{ offset: -1 }, { offset: 1 }, { byteLength: 1000609 }, { byteLength: 257 }, { bytesHex: "00" },
    { bytesHex: "00".repeat(32769) }, { nonce: "0".repeat(64) }, { approved: true }, { kind: "runtime.result.admit" }])("rejects malformed pages %j", patch => {
    expect(() => normalize({ ...fixture.page(), ...patch })).toThrow();
  });
  it("refuses getters, inherited data and hidden extras without invoking them", () => {
    let reads = 0;
    const getter = { ...fixture.page(), get bytesHex() { reads += 1; return ""; } };
    for (const page of [getter, Object.create(fixture.page()), Object.assign(fixture.page(), { [Symbol("extra")]: true })]) expect(() => normalize(page)).toThrow();
    expect(reads).toBe(0);
  });
  it("never turns a partial acknowledgment into a durable receipt", () => {
    const first = fixture.response(fixture.page());
    for (const nextOffset of [1, 32769, fixture.bytes.length]) expect(() => exchange({ ...first, accepted: { ...first.accepted, nextOffset } })).toThrow();
    const full = fixture.response(fixture.page(), true);
    for (const record of [{ ...full.record, resultSha256: "ff".repeat(32) }, { ...full.record, byteLength: 256 },
      { ...full.record, leaseRevision: 2 }, { ...full.record, recordedAt: "2026-02-30T00:00:00.000Z" }]) expect(() => exchange({ ...full, record })).toThrow();
    expect(() => normalize({ kind: "runtime.result.lookup", nonce: fixture.expectation.nonce, requestSha256: fixture.expectation.requestSha256, expectation: fixture.expectation })).toThrow();
  });
});
