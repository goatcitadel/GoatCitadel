import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EvidenceEnvelopeService, evidenceDigestHex, sha256, stableStringify } from "./evidence-envelope-service.js";

describe("evidence-envelope-service digest helpers", () => {
  it("returns canonical evidence when retained realtime publication fails", () => {
    const create = vi.fn((input) => input);
    const service = new EvidenceEnvelopeService({
      storage: {
        evidenceEnvelopes: {
          latest: vi.fn(() => undefined),
          create,
          list: vi.fn(() => []),
        },
      } as never,
      publishRealtime: () => {
        throw new Error("retained stream unavailable");
      },
    });

    const envelope = service.createEnvelope({ eventKind: "continuation_gate", runId: "run-1" });

    expect(envelope).toMatchObject({ eventKind: "continuation_gate", runId: "run-1" });
    expect(create).toHaveBeenCalledOnce();
  });

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

  it("keeps deterministic evidence digests fast and off constant-key HMAC helpers", () => {
    const source = readFileSync(new URL("./evidence-envelope-service.ts", import.meta.url), "utf8");

    expect(source).toMatch(/createHash\("sha256"\)\.update\(EVIDENCE_DIGEST_DOMAIN_KEY\)/);
    expect(source).not.toMatch(/pbkdf2Sync\(\s*canonicalPayload,\s*EVIDENCE_DIGEST_DOMAIN_KEY,/);
    expect(source).not.toMatch(/createHmac\("sha256",\s*EVIDENCE_DIGEST_DOMAIN_KEY\)/);
  });

  it("uses the canonical structured projector for secret-safe, cycle-safe evidence metadata", () => {
    const circular: Record<string, unknown> = { visible: "ok" };
    circular.self = circular;
    const metadata = {
      webhookUrl: "https://example.test/hook?token=short-token",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "tiny-secret",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      circular,
    };
    const create = vi.fn((input) => input);
    const service = new EvidenceEnvelopeService({
      storage: {
        evidenceEnvelopes: {
          latest: vi.fn(() => undefined),
          create,
          list: vi.fn(() => []),
        },
      } as never,
    });

    const envelope = service.createEnvelope({
      eventKind: "tool_call_completed",
      metadata,
      createdAt: "2026-07-09T12:00:00.000Z",
    });

    expect(envelope.metadata).toEqual({
      webhookUrl: "[redacted]",
      authorization: "[redacted]",
      DATABASE_PASSWORD: "[redacted]",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      circular: { visible: "ok", self: "[Circular]" },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(metadata.webhookUrl).toContain("short-token");
    expect(metadata.authorization).toBe("Bearer short");
    expect(metadata.DATABASE_PASSWORD).toBe("tiny-secret");
    expect(circular.self).toBe(circular);
  });

  it("projects legacy metadata on reads without changing canonical hashes, signatures, or stored rows", () => {
    const stored = {
      envelopeId: "envelope-legacy-1",
      eventKind: "tool_invocation" as const,
      contentHash: "content-hash-1",
      payloadHash: "payload-hash-1",
      toolCallHashes: [],
      memoryLineage: [],
      signatureStatus: "signed_hmac" as const,
      signature: "signature-1",
      metadata: {
        webhookUrl: "https://hooks.example.test/services/team/legacy-secret",
        authorization: "Bearer short",
        DATABASE_PASSWORD: "hunter2",
        tokenId: "safe-token-id",
      },
      createdAt: "2026-07-09T12:00:00.000Z",
    };
    const service = new EvidenceEnvelopeService({
      storage: {
        evidenceEnvelopes: {
          latest: vi.fn(() => undefined),
          create: vi.fn(),
          list: vi.fn(() => [stored]),
        },
      } as never,
    });

    const [projected] = service.listEnvelopes();

    expect(projected).toMatchObject({
      contentHash: "content-hash-1",
      payloadHash: "payload-hash-1",
      signature: "signature-1",
      metadata: {
        webhookUrl: "[redacted]",
        authorization: "[redacted]",
        DATABASE_PASSWORD: "[redacted]",
        tokenId: "safe-token-id",
      },
      publicProjection: {
        metadataRedacted: true,
        redactedPaths: ["$.webhookUrl", "$.authorization", "$.DATABASE_PASSWORD"],
        canonicalHashesReferToStoredEnvelope: true,
      },
    });
    expect(stored.metadata.webhookUrl).toContain("legacy-secret");
    expect(stored.metadata.authorization).toBe("Bearer short");
    expect(stored.metadata.DATABASE_PASSWORD).toBe("hunter2");
  });
});
