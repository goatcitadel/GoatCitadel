import { describe, expect, it } from "vitest";
import { evidenceDigestHex, sha256, stableStringify } from "./evidence-envelope-service.js";

describe("evidence-envelope-service digest helpers", () => {
  it("produces deterministic 64-character evidence digests without mutating canonical payloads", () => {
    const canonicalPayload = stableStringify({
      beta: ["second", "third"],
      alpha: "first",
    });

    expect(canonicalPayload).toBe('{"alpha":"first","beta":["second","third"]}');
    expect(evidenceDigestHex(canonicalPayload)).toMatch(/^[a-f0-9]{64}$/);
    expect(evidenceDigestHex(canonicalPayload)).toBe(evidenceDigestHex(canonicalPayload));
    expect(evidenceDigestHex(canonicalPayload)).toBe(sha256(canonicalPayload));
    expect(evidenceDigestHex(`${canonicalPayload}:changed`)).not.toBe(evidenceDigestHex(canonicalPayload));
  });
});
