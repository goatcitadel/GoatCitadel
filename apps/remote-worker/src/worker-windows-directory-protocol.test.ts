import { describe, expect, it } from "vitest";
import { decodeWindowsWorkerDirectoryResult, WORKER_DIRECTORY_RESPONSE_BYTES, WindowsWorkerDirectoryRefusedError } from "./worker-windows-directory-protocol.js";

const identity = "ab".repeat(24);
function receipt(entries: Array<{ name: string | Buffer; kind: number }> = [{ name: "note.txt", kind: 1 }], truncated = false): Buffer {
  const header = Buffer.alloc(44);
  header.write("GCFLIST1"); header.writeUInt32LE(truncated ? 1 : 0, 12); header.writeUInt32LE(entries.length, 16);
  Buffer.from(identity, "hex").copy(header, 20);
  return Buffer.concat([header, ...entries.map(entry => {
    const name = Buffer.from(entry.name), frame = Buffer.alloc(8);
    frame.writeUInt32LE(entry.kind); frame.writeUInt32LE(name.length, 4);
    return Buffer.concat([frame, name]);
  })]);
}

describe("native directory receipt decoder", () => {
  it("preserves Unicode and leading BOM names, sorts names, and reports unavailable links and truncation", () => {
    const result = decodeWindowsWorkerDirectoryResult(receipt([
      { name: "z", kind: 2 }, { name: "a", kind: 1 }, { name: "link", kind: 3 }, { name: "\ufeffhéllo ☄", kind: 1 },
    ], true), identity);
    expect(result).toEqual({ rootIdentity: identity, truncated: true, entries: [
      { name: "a", type: "file" }, { name: "link", type: "unavailable" }, { name: "z", type: "directory" },
      { name: "\ufeffhéllo ☄", type: "file" },
    ] });
    expect(decodeWindowsWorkerDirectoryResult(receipt([]), identity).entries).toEqual([]);
  });
  it.each(["..", ".", "a/b", "a\\b", "a:stream", "NUL", "trailing.", "\0", "", "x".repeat(256)])(
    "refuses unsafe returned name %j", name => {
      expect(() => decodeWindowsWorkerDirectoryResult(receipt([{ name, kind: 1 }]), identity)).toThrow();
    });
  it("recognizes only a complete empty native refusal as a known failed read", () => {
    for (const root of [identity, "0".repeat(48)]) {
      const bytes = receipt([]); bytes.writeUInt32LE(3, 8); Buffer.from(root, "hex").copy(bytes, 20);
      expect(() => decodeWindowsWorkerDirectoryResult(bytes, identity)).toThrow(WindowsWorkerDirectoryRefusedError);
      bytes.writeUInt32LE(1, 12);
      expect(() => decodeWindowsWorkerDirectoryResult(bytes, identity)).not.toThrow(WindowsWorkerDirectoryRefusedError);
      expect(() => decodeWindowsWorkerDirectoryResult(bytes, identity)).toThrow();
    }
  });
  it("rejects malformed frames, mismatched roots and malformed text without exposing names", () => {
    const invalid = [Buffer.alloc(0), Buffer.alloc(43), Buffer.alloc(WORKER_DIRECTORY_RESPONSE_BYTES + 1),
      Buffer.concat([receipt(), Buffer.from([0])]), receipt().subarray(0, -1), receipt([], true),
      receipt([{ name: Buffer.from([0xff]), kind: 1 }]), receipt([{ name: "x", kind: 0 }]), receipt([{ name: "x", kind: 4 }]),
      receipt([{ name: "x", kind: 1 }, { name: "x", kind: 2 }]),
      receipt(Array.from({ length: 129 }, (_, index) => ({ name: String(index), kind: 1 })))];
    for (const [offset, value] of [[0, 0xc7], [8, 5], [12, 2], [16, 2], [20, 0], [48, 0xff]] as const) {
      const changed = receipt(); changed[offset] = value; invalid.push(changed);
    }
    for (const bytes of invalid) expect(() => decodeWindowsWorkerDirectoryResult(bytes, identity)).toThrow();
    for (const root of ["cd".repeat(24), "0".repeat(48), "invalid"])
      expect(() => decodeWindowsWorkerDirectoryResult(receipt(), root)).toThrow();
  });
});
