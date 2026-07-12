import { createHash, createHmac, randomUUID } from "node:crypto";
import { redactStructuredSecrets } from "@goatcitadel/contracts";
import type {
  EvidenceEnvelope,
  EvidenceEnvelopeEventKind,
  EvidenceEnvelopeListQuery,
  EvidenceEnvelopeSignatureStatus,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export interface EvidenceEnvelopeCreateRequest {
  eventKind: EvidenceEnvelopeEventKind;
  workspaceId?: string;
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

const EVIDENCE_DIGEST_DOMAIN_KEY = "goatcitadel:evidence-envelope-digest:v1";

export class EvidenceEnvelopeService {
  private readonly signingKey?: string;

  public constructor(private readonly deps: EvidenceEnvelopeServiceDependencies) {
    const configuredKey = deps.signingKey?.trim() || process.env.GOATCITADEL_EVIDENCE_SIGNING_KEY?.trim();
    this.signingKey = configuredKey || undefined;
  }

  public createEnvelope(input: EvidenceEnvelopeCreateRequest): EvidenceEnvelope {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const metadata = redactStructuredSecrets(input.metadata ?? {}, { marker: "[redacted]" }).value;
    const workspaceId = input.workspaceId?.trim() || undefined;
    const latest = this.deps.storage.evidenceEnvelopes.latest({ workspaceId });
    const previousEnvelopeHash = latest?.contentHash;
    const payload = {
      eventKind: input.eventKind,
      workspaceId,
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
      workspaceId,
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
    try {
      this.deps.publishRealtime?.("evidence_envelope_recorded", "runtime", {
        envelopeId: envelope.envelopeId,
        eventKind: envelope.eventKind,
        workspaceId: envelope.workspaceId,
        sessionId: envelope.sessionId,
        turnId: envelope.turnId,
        runId: envelope.runId,
        signatureStatus: envelope.signatureStatus,
      });
    } catch {
      // The envelope is canonical evidence; retained realtime is a projection
      // and cannot turn a committed insert into a misleading failure.
      return envelope;
    }
    return envelope;
  }

  public listEnvelopes(query: EvidenceEnvelopeListQuery = {}): EvidenceEnvelope[] {
    return this.deps.storage.evidenceEnvelopes.list(query).map((envelope) => {
      const projected = redactStructuredSecrets(envelope.metadata, { marker: "[redacted]" });
      return {
        ...envelope,
        metadata: projected.value,
        ...(projected.redactionCount > 0
          ? {
              publicProjection: {
                metadataRedacted: true,
                redactedPaths: projected.redactedPaths,
                canonicalHashesReferToStoredEnvelope: true as const,
              },
            }
          : {}),
      };
    });
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
  return createHash("sha256").update(EVIDENCE_DIGEST_DOMAIN_KEY).update("\0").update(canonicalPayload).digest("hex");
}

export function sha256(value: string): string {
  return evidenceDigestHex(value);
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}
