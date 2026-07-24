import { describe, expect, it } from "vitest";
import { WorkerCellTerminalCapture } from "./remote-worker-cell-terminal-capture.js";

describe("HX-505 cell terminal capture", () => {
  it("counts every raw byte and retains only the bounded prefix and tail", () => {
    const capture = new WorkerCellTerminalCapture({ maxPrefixBytes: 4, maxTailBytes: 4 });
    capture.ingest("stdout", Buffer.from("0123456789", "utf8"));
    const diagnostics = capture.finalize({ exitCode: 0, terminatedBySignal: null });
    expect(diagnostics.stdout.rawByteLength).toBe(10);
    expect(diagnostics.stdout.prefixText).toBe("0123");
    expect(diagnostics.stdout.tailText).toBe("6789");
    expect(diagnostics.stdout.prefixTruncated).toBe(true);
    expect(diagnostics.stdout.tailTruncated).toBe(true);
    expect(diagnostics.stdout.retainedByteLength).toBeLessThanOrEqual(8);
    expect(diagnostics.stdout.captureSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(diagnostics.diagnosticCaptureSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("never splits a multibyte character at the truncation boundary", () => {
    // "a" + a 3-byte emoji-ish char; a 2-byte prefix bound would split the char.
    const capture = new WorkerCellTerminalCapture({ maxPrefixBytes: 2, maxTailBytes: 2 });
    capture.ingest("stdout", Buffer.from("aࠀb", "utf8"));
    const diagnostics = capture.finalize({ exitCode: 0, terminatedBySignal: null });
    // The prefix keeps "a" and drops the incomplete lead byte of the 3-byte char.
    expect(diagnostics.stdout.prefixText).toBe("a");
    expect(diagnostics.stdout.prefixText).not.toContain("�");
  });

  it("redacts secrets across both retained windows and counts the redactions", () => {
    const capture = new WorkerCellTerminalCapture({ maxPrefixBytes: 4_096, maxTailBytes: 4_096 });
    capture.ingest("stderr", Buffer.from("using key sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcd done", "utf8"));
    const diagnostics = capture.finalize({ exitCode: 1, terminatedBySignal: null });
    expect(diagnostics.stderr.redactionCount).toBeGreaterThan(0);
    expect(diagnostics.stderr.prefixText).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcd");
    expect(diagnostics.totalRedactionCount).toBe(diagnostics.stdout.redactionCount + diagnostics.stderr.redactionCount);
  });

  it("leaves no partial secret at the prefix truncation boundary", () => {
    // A canary secret starts inside the retained prefix bound and extends past
    // it; its body marker "LEAKME" straddles the 24-byte cut. Without the
    // redaction overhang, "sk-LEAKM" would survive in the first 24 raw bytes.
    const secret = "sk-LEAKMELEAKMELEAKMELEAKME0123456789abcd";
    const capture = new WorkerCellTerminalCapture({ maxPrefixBytes: 24, maxTailBytes: 8 });
    capture.ingest("stdout", Buffer.from(`PREFIXFILLER0123${secret} trailing filler`, "utf8"));
    const diagnostics = capture.finalize({ exitCode: 0, terminatedBySignal: null });
    // No fragment of the secret body survives in the retained prefix.
    expect(diagnostics.stdout.prefixText).not.toContain("LEAKM");
    expect(diagnostics.stdout.prefixText.length).toBeLessThanOrEqual(24);
    expect(diagnostics.stdout.redactionCount).toBeGreaterThan(0);
    expect(diagnostics.stdout.rawByteLength).toBe(16 + secret.length + " trailing filler".length);
  });

  it("bounds retained output far below a large raw stream", () => {
    const capture = new WorkerCellTerminalCapture({ maxPrefixBytes: 1_024, maxTailBytes: 1_024 });
    capture.ingest("stdout", Buffer.alloc(5_000_000, 0x41));
    const diagnostics = capture.finalize({ exitCode: 0, terminatedBySignal: null });
    expect(diagnostics.stdout.rawByteLength).toBe(5_000_000);
    expect(diagnostics.stdout.retainedByteLength).toBeLessThanOrEqual(2_048);
    expect(diagnostics.totalRetainedBytes).toBeLessThanOrEqual(2_048);
  });

  it("records exit code and terminating signal and refuses ingestion after finalize", () => {
    const capture = new WorkerCellTerminalCapture();
    capture.ingest("stdout", Buffer.from("out", "utf8"));
    const diagnostics = capture.finalize({ exitCode: null, terminatedBySignal: "SIGKILL" });
    expect(diagnostics.exitCode).toBeNull();
    expect(diagnostics.terminatedBySignal).toBe("SIGKILL");
    expect(() => capture.ingest("stdout", Buffer.from("more", "utf8"))).toThrow(/already finalized/u);
  });
});
