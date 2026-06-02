import { createHmac, pbkdf2Sync, randomUUID } from "node:crypto";
import type {
  EvidenceEnvelope,
  EvidenceEnvelopeEventKind,
  EvidenceEnvelopeListQuery,
  EvidenceEnvelopeSignatureStatus,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export interface EvidenceEnvelopeCreateRequest {
  eventKind: EvidenceEnvelopeEventKind;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  toolCallHashes?: string[];
  memoryLineage?: string[];
  policyHash?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface EvidenceEnvelopeServiceDependencies {
  storage: Storage;
  signingKey?: string;
  publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|auth|bearer|cookie|credential|password|secret|token)/i;
const SECRET_VALUE_PATTERN =
  /(?:sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,}|bearer\s+[a-z0-9._-]{16,})/i;
const EVIDENCE_DIGEST_DOMAIN_KEY = "goatcitadel:evidence-envelope-digest:v1";
const EVIDENCE_DIGEST_ITERATIONS = 120_000;
const EVIDENCE_DIGEST_BYTES = 32;

export class EvidenceEnvelopeService {
  private readonly signingKey?: string;

  public constructor(private readonly deps: EvidenceEnvelopeServiceDependencies) {
    const configuredKey = deps.signingKey?.trim() || process.env.GOATCITADEL_EVIDENCE_SIGNING_KEY?.trim();
    this.signingKey = configuredKey || undefined;
  }

  public createEnvelope(input: EvidenceEnvelopeCreateRequest): EvidenceEnvelope {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const metadata = redactEvidenceValue(input.metadata ?? {}) as Record<string, unknown>;
    const latest = this.deps.storage.evidenceEnvelopes.latest();
    const previousEnvelopeHash = latest?.contentHash;
    const payload = {
      eventKind: input.eventKind,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.runId,
      approvalId: input.approvalId,
      toolCallHashes: normalizeStringList(input.toolCallHashes),
      memoryLineage: normalizeStringList(input.memoryLineage),
      policyHash: input.policyHash,
      metadata,
      createdAt,
    };
    const payloadHash = evidenceDigestHex(stableStringify(payload));
    const contentHash = evidenceDigestHex(
      stableStringify({
        payloadHash,
        previousEnvelopeHash,
        eventKind: input.eventKind,
        createdAt,
      }),
    );
    const signature = this.signingKey
      ? createHmac("sha256", this.signingKey).update(contentHash).digest("hex")
      : undefined;
    const signatureStatus: EvidenceEnvelopeSignatureStatus = signature ? "signed_hmac" : "unsigned_local";
    const envelope = this.deps.storage.evidenceEnvelopes.create({
      envelopeId: randomUUID(),
      eventKind: input.eventKind,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.runId,
      approvalId: input.approvalId,
      contentHash,
      previousEnvelopeHash,
      payloadHash,
      toolCallHashes: payload.toolCallHashes,
      memoryLineage: payload.memoryLineage,
      policyHash: input.policyHash,
      signatureStatus,
      signature,
      metadata,
      createdAt,
    });
    this.deps.publishRealtime?.("evidence_envelope_recorded", "runtime", {
      envelopeId: envelope.envelopeId,
      eventKind: envelope.eventKind,
      sessionId: envelope.sessionId,
      turnId: envelope.turnId,
      runId: envelope.runId,
      signatureStatus: envelope.signatureStatus,
    });
    return envelope;
  }

  public listEnvelopes(query: EvidenceEnvelopeListQuery = {}): EvidenceEnvelope[] {
    return this.deps.storage.evidenceEnvelopes.list(query);
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

export function evidenceDigestHex(canonicalPayload: string): string {
  return pbkdf2Sync(
    canonicalPayload,
    EVIDENCE_DIGEST_DOMAIN_KEY,
    EVIDENCE_DIGEST_ITERATIONS,
    EVIDENCE_DIGEST_BYTES,
    "sha256",
  ).toString("hex");
}

export function sha256(value: string): string {
  return evidenceDigestHex(value);
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function redactEvidenceValue(value: unknown, keyHint?: string): unknown {
  if (typeof value === "string") {
    if ((keyHint && SECRET_KEY_PATTERN.test(keyHint)) || SECRET_VALUE_PATTERN.test(value)) {
      return "[redacted]";
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactEvidenceValue(item, keyHint));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    output[key] = redactEvidenceValue(entryValue, key);
  }
  return output;
}
