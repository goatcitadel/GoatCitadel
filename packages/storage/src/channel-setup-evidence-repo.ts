import { randomUUID } from "node:crypto";
import {
  ValidationError, redactSecretText,
  type ChannelSetupEvidence, type ChannelSetupEvidenceCreateInput,
  type ChannelSetupEvidenceListQuery, type ChannelSetupIssue, type ChannelProbeReport,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface EvidenceRow { payload_json: string; sequence: number | string }

/** Append-only public receipts. Credentials, custody locators and ingress bodies never belong here. */
export class ChannelSetupEvidenceRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;
  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO channel_setup_evidence (
        evidence_id,catalog_id,draft_id,draft_revision,connection_id,connection_revision,
        phase,status,checked_at,created_at,payload_json
      ) VALUES (
        @evidenceId,@catalogId,@draftId,@draftRevision,@connectionId,@connectionRevision,
        @phase,@status,@checkedAt,@createdAt,@payloadJson
      )`);
    this.getStmt = db.prepare("SELECT payload_json,sequence FROM channel_setup_evidence WHERE evidence_id = ?");
    this.listStmt = db.prepare(`
      SELECT payload_json,sequence FROM channel_setup_evidence
      WHERE (CAST(@draftId AS TEXT) IS NULL OR draft_id = @draftId)
        AND (CAST(@connectionId AS TEXT) IS NULL OR connection_id = @connectionId)
      ORDER BY sequence DESC LIMIT @limit`);
  }
  public create(input: ChannelSetupEvidenceCreateInput): ChannelSetupEvidence {
    return this.db.transaction("immediate", () => {
      if (this.db.dialect === "postgres") {
        this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 6041))")
          .get({ lockKey: "channel-setup-evidence:" + required(input.draftId, "draftId") });
      }
      return this.createLocked(input);
    });
  }
  private createLocked(input: ChannelSetupEvidenceCreateInput): ChannelSetupEvidence {
    const evidence = normalizeEvidence(input);
    let prior: ChannelSetupEvidence | undefined;
    if (evidence.priorEvidenceId) {
      prior = this.get(evidence.priorEvidenceId);
      if (!prior || prior.draftId !== evidence.draftId || prior.catalogId !== evidence.catalogId || prior.draftRevision !== evidence.draftRevision ||
          ((evidence.phase === "acknowledgement" || evidence.phase === "activation") && prior.inputFingerprint !== evidence.inputFingerprint) ||
          (evidence.phase === "acknowledgement" && (prior.connectionId !== evidence.connectionId || prior.connectionRevision !== evidence.connectionRevision))) {
        throw invalid("priorEvidenceId", "Prior evidence must belong to this exact draft revision.");
      }
    }
    if (evidence.phase === "acknowledgement" || evidence.phase === "activation") {
      // Activation is rebound to the committed connection revision. Select its
      // proof using the tested owner's revision, not the new connection's hash.
      const testedConnectionRevision = evidence.phase === "activation" ? prior?.connectionRevision : evidence.connectionRevision;
      const latest = this.list({ draftId: evidence.draftId, limit: 100 }).find((item) =>
        item.catalogId === evidence.catalogId && item.phase !== "activation" &&
        (item.inputFingerprint === evidence.inputFingerprint || (!item.inputFingerprint && item.status === "error")) &&
        item.connectionRevision === testedConnectionRevision);
      if (!evidence.priorEvidenceId || latest?.evidenceId !== evidence.priorEvidenceId) {
        throw invalid("priorEvidenceId", "A newer setup result exists. Review the latest evidence before acknowledging or activating.");
      }
    }
    const payloadJson = JSON.stringify(evidence);
    if (Buffer.byteLength(payloadJson, "utf8") > 65536) throw invalid("evidence", "Evidence exceeds 64 KiB.");
    this.insertStmt.run({
      evidenceId: evidence.evidenceId, catalogId: evidence.catalogId,
      draftId: evidence.draftId, draftRevision: evidence.draftRevision,
      connectionId: evidence.connectionId ?? null, connectionRevision: evidence.connectionRevision ?? null,
      phase: evidence.phase, status: evidence.status, checkedAt: evidence.checkedAt,
      createdAt: evidence.createdAt, payloadJson,
    });
    return this.get(evidence.evidenceId)!;
  }
  public get(evidenceId: string): ChannelSetupEvidence | undefined {
    const row = this.getStmt.get(required(evidenceId, "evidenceId")) as EvidenceRow | undefined;
    return row ? read(row) : undefined;
  }
  public list(query: ChannelSetupEvidenceListQuery): ChannelSetupEvidence[] {
    const draftId = query.draftId === undefined ? null : required(query.draftId, "draftId");
    const connectionId = query.connectionId === undefined ? null : required(query.connectionId, "connectionId");
    if (!draftId && !connectionId) throw invalid("owner", "Select a draft or connection.");
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid("limit", "Limit must be between 1 and 100.");
    return (this.listStmt.all({ draftId, connectionId, limit }) as EvidenceRow[]).map(read);
  }
}

function read(row: EvidenceRow): ChannelSetupEvidence {
  const parsed = safeJsonParse<ChannelSetupEvidence>(row.payload_json, null as unknown as ChannelSetupEvidence);
  if (!parsed || typeof parsed !== "object") throw new Error("Malformed channel setup evidence.");
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Malformed channel setup evidence order.");
  return { ...normalizeEvidence(parsed), sequence };
}
function normalizeEvidence(input: ChannelSetupEvidenceCreateInput): ChannelSetupEvidence {
  if (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 1) throw invalid("draftRevision", "A positive revision is required.");
  if (input.activationDraftRevision !== undefined && (!Number.isSafeInteger(input.activationDraftRevision) || input.activationDraftRevision < 1)) throw invalid("activationDraftRevision", "A positive activation revision is required.");
  if (!["test", "acknowledgement", "activation"].includes(input.phase)) throw invalid("phase", "Unknown evidence phase.");
  if (!["idle", "ok", "warn", "error"].includes(input.status)) throw invalid("status", "Unknown evidence status.");
  if (!Array.isArray(input.issues) || input.issues.length > 50) throw invalid("issues", "Evidence must have at most 50 issues.");
  const eligibility = input.finalizationEligibility;
  return {
    evidenceId: required(input.evidenceId ?? randomUUID(), "evidenceId"),
    catalogId: required(input.catalogId, "catalogId"),
    draftId: required(input.draftId, "draftId"), draftRevision: input.draftRevision,
    activationDraftRevision: input.phase === "activation" ? input.activationDraftRevision : undefined,
    connectionId: optional(input.connectionId), connectionRevision: optional(input.connectionRevision),
    phase: input.phase, status: input.status, checkedAt: timestamp(input.checkedAt),
    createdAt: timestamp(input.createdAt ?? new Date().toISOString()),
    issues: input.issues.map(normalizeIssue),
    probe: input.probe ? normalizeProbe(input.probe) : undefined,
    priorEvidenceId: optional(input.priorEvidenceId), inputFingerprint: optional(input.inputFingerprint),
    actorId: optional(input.actorId),
    acknowledgement: input.acknowledgement === "cleanup" || input.acknowledgement === "receipt" ? input.acknowledgement : undefined,
    finalizationEligibility: eligibility ? {
      allowed: eligibility.allowed === true,
      blockingReasons: (eligibility.blockingReasons ?? []).slice(0, 50).map((reason) => text(reason)),
      evidenceId: optional(eligibility.evidenceId),
      requiresAcknowledgement: eligibility.requiresAcknowledgement === true,
    } : undefined,
  };
}
function normalizeIssue(issue: ChannelSetupIssue): ChannelSetupIssue {
  if (!["info", "warn", "error"].includes(issue.level)) throw invalid("issues.level", "Unknown severity.");
  return {
    key: required(issue.key, "issues.key"), level: issue.level, message: text(issue.message),
    disposition: disposition(issue.disposition), detail: issue.detail === undefined ? undefined : text(issue.detail),
    fieldKey: optional(issue.fieldKey), failureCategory: issue.failureCategory,
    nextSteps: issue.nextSteps?.slice(0, 10).map((step) => text(step)),
  };
}
function normalizeProbe(probe: ChannelProbeReport): ChannelProbeReport {
  if (!Array.isArray(probe.steps) || probe.steps.length > 50) throw invalid("probe.steps", "Evidence must have at most 50 probe steps.");
  return {
    kind: required(probe.kind, "probe.kind"), mode: optional(probe.mode), checkedAt: timestamp(probe.checkedAt),
    steps: probe.steps.map((step) => {
      if (!["pass", "warn", "fail", "skipped"].includes(step.status)) throw invalid("probe.status", "Unknown probe status.");
      return {
        key: required(step.key, "probe.key"), label: text(step.label), status: step.status,
        message: text(step.message), failureCategory: step.failureCategory,
        disposition: disposition(step.disposition), providerMessageId: optional(step.providerMessageId),
        cleanupStatus: step.cleanupStatus,
      };
    }),
  };
}
function disposition(value: ChannelSetupIssue["disposition"]) {
  return value === "blocking" || value === "advisory" || value === "deferred" ? value : undefined;
}
function text(value: string): string {
  if (typeof value !== "string") throw invalid("text", "Evidence text must be a string.");
  return redactSecretText(value
    .replace(/keychain:goatcitadel:[^\s"'<>]+/gi, "[REDACTED_CUSTODY]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")).value.slice(0, 2048);
}
function required(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw invalid(field, "A bounded non-empty value is required.");
  return text(value.trim());
}
function optional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : required(value, "optional");
}
function timestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalid("timestamp", "An ISO timestamp is required.");
  return new Date(value).toISOString();
}
function invalid(field: string, message: string): ValidationError { return new ValidationError({ field, message }); }
