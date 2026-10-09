import { ConflictError, ValidationError, ServiceUnavailableError, type ChannelSetupDraft, type ChannelSetupTestResult, type ChannelSetupAcknowledgementInput, type IntegrationConnection, type ChannelSetupEvidence, type ChannelSetupDraftEvidence } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { assertDraftRevision, hydrateChannelSetupDraftSecrets } from "./channel-setup-draft-security.js";
import { requireReviewedChannelConnection } from "./channel-setup-connection-review.js";
import { buildEphemeralChannelConnection } from "./channel-setup-helpers.js";
import { buildChannelSetupRecentTestSignature, CHANNEL_SETUP_TEST_MAX_AGE_MS, channelSetupProofExpiresAt } from "./channel-setup-test-cache.js";
import { evaluateChannelSetupEligibility } from "./channel-setup-eligibility.js";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import { projectPublicSecretValue } from "./public-secret-projection.js";

export async function persistChannelSetupTestEvidence(host: ChannelSetupHost, draft: ChannelSetupDraft, result: ChannelSetupTestResult, fingerprint?: string): Promise<ChannelSetupTestResult> {
  result = { ...result, proofExpiresAt: channelSetupProofExpiresAt(result.checkedAt) };
  if (!host.storage.channelSetupEvidence) return result;
  const evidence = await host.storage.channelSetupEvidence.create({ catalogId: draft.catalogId, draftId: draft.draftId, draftRevision: result.draftRevision, connectionId: draft.connectionId, connectionRevision: draft.connectionRevision, phase: "test", status: result.status, checkedAt: result.checkedAt, probe: result.probe, issues: result.issues, inputFingerprint: fingerprint, finalizationEligibility: result.finalizationEligibility });
  return { ...result, evidenceId: evidence.evidenceId, ...(result.finalizationEligibility ? { finalizationEligibility: { ...result.finalizationEligibility, evidenceId: evidence.evidenceId } } : {}) };
}

/** Runtime requirements, rather than old persisted draft metadata, govern proof reuse. */
export function buildCurrentChannelSetupEvidenceSignature(draft: ChannelSetupDraft, connection: IntegrationConnection, host?: Pick<ChannelSetupHost, "resolveConnectionSecret">): string {
  const runtime = requireChannelSetupDefinition(draft.catalogId).definition;
  return buildChannelSetupRecentTestSignature(draft, connection, runtime.testing.testVersion, { contentVersion: runtime.wizard.contentVersion, validationVersion: runtime.validation.validationVersion, secretFieldKeys: runtime.adapter.secretFieldKeys, resolveConnectionSecret: host?.resolveConnectionSecret });
}

export async function restoreChannelSetupTestEvidence(host: ChannelSetupHost, draft: ChannelSetupDraft, connection: IntegrationConnection, records?: readonly ChannelSetupEvidence[]): Promise<ChannelSetupTestResult | undefined> {
  if (!host.storage.channelSetupEvidence) return undefined;
  const fingerprint = buildCurrentChannelSetupEvidenceSignature(draft, connection, host);
  const latest = (records ?? await host.storage.channelSetupEvidence.list({ draftId: draft.draftId, limit: 20 })).find((evidence) =>
    evidence.draftId === draft.draftId && evidence.catalogId === draft.catalogId && evidence.phase !== "activation" && (evidence.inputFingerprint === fingerprint || (!evidence.inputFingerprint && evidence.status === "error")) && evidence.connectionRevision === draft.connectionRevision);
  if (!latest) return undefined;
  // Select canonical order first. Expired/future/invalid newest proof cannot revive an older pass.
  const age = Date.now() - Date.parse(latest.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > CHANNEL_SETUP_TEST_MAX_AGE_MS) return undefined;
  const runtime = requireChannelSetupDefinition(draft.catalogId).definition;
  const result: ChannelSetupTestResult = { draftId: draft.draftId, draftRevision: draft.revision, status: latest.status, levels: [...runtime.testing.levels], checkedAt: latest.checkedAt, proofExpiresAt: channelSetupProofExpiresAt(latest.checkedAt), issues: structuredClone(latest.issues), ...(latest.probe ? { probe: structuredClone(latest.probe) } : {}), evidenceId: latest.evidenceId };
  result.finalizationEligibility = evaluateChannelSetupEligibility(result, connection, await hasCleanupAcknowledgement(host, latest));
  return projectPublicSecretValue(result);
}

/** Read-only, revision-bound recovery. No diagnostics, draft writes or cache writes run here. */
export async function getChannelSetupDraftEvidence(host: ChannelSetupHost, draftId: string, expectedRevision: number): Promise<ChannelSetupDraftEvidence> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(draft, expectedRevision);
  await requireReviewedChannelConnection(host, draft);
  if (!host.storage.channelSetupEvidence) throw new ServiceUnavailableError("Durable channel setup evidence is unavailable.");
  const connection = await buildEphemeralChannelConnection(host, hydrateChannelSetupDraftSecrets(host, draft));
  const items = (await host.storage.channelSetupEvidence.list({ draftId, limit: 20 })).filter((evidence) => evidence.draftId === draftId && evidence.catalogId === draft.catalogId).slice(0, 20);
  const currentTest = await restoreChannelSetupTestEvidence(host, draft, connection, items);
  assertDraftRevision(await host.storage.channelSetupDrafts.get(draftId), expectedRevision);
  await requireReviewedChannelConnection(host, draft);
  return projectPublicSecretValue({ draftId, draftRevision: draft.revision, items, ...(currentTest ? { currentTest } : {}) });
}

export async function acknowledgeChannelSetupTest(host: ChannelSetupHost, draftId: string, input: ChannelSetupAcknowledgementInput, actorId: string): Promise<ChannelSetupTestResult> {
  const draft = await host.storage.channelSetupDrafts.get(draftId);
  assertDraftRevision(draft, input.expectedRevision);
  await requireReviewedChannelConnection(host, draft);
  if (!host.storage.channelSetupEvidence) throw new ValidationError({ message: "Durable setup evidence is unavailable." });
  const source = await host.storage.channelSetupEvidence.get(input.evidenceId);
  if (!source || source.draftId !== draftId || source.catalogId !== draft.catalogId || source.phase === "activation") throw new ValidationError({ message: "Choose test evidence belonging to this draft." });
  const connection = await buildEphemeralChannelConnection(host, hydrateChannelSetupDraftSecrets(host, draft));
  const fingerprint = buildCurrentChannelSetupEvidenceSignature(draft, connection, host);
  const age = Date.now() - Date.parse(source.checkedAt);
  if (source.inputFingerprint !== fingerprint || source.connectionRevision !== draft.connectionRevision || !Number.isFinite(age) || age < 0 || age > CHANNEL_SETUP_TEST_MAX_AGE_MS) throw new ConflictError({ code: "WRITE_CONFLICT", message: "Setup inputs or proof freshness changed. Retest before acknowledging." });
  const latest = (await host.storage.channelSetupEvidence.list({ draftId, limit: 20 })).find((evidence) => evidence.draftId === draft.draftId && evidence.catalogId === draft.catalogId && evidence.phase !== "activation" && (evidence.inputFingerprint === fingerprint || (!evidence.inputFingerprint && evidence.status === "error")) && evidence.connectionRevision === draft.connectionRevision);
  if (latest?.evidenceId !== source.evidenceId) throw new ConflictError({ code: "WRITE_CONFLICT", message: "Newer setup evidence is available. Review the latest result before acknowledging." });
  const sent = source.probe?.steps.some((step) => step.key.endsWith("_sandbox_send") && step.status === "pass");
  if (!sent || (input.acknowledgement === "cleanup" && !source.probe?.steps.some((step) => step.key.endsWith("_sandbox_send") && step.status === "pass" && step.providerMessageId))) throw new ValidationError({ message: "An acknowledgement requires successful transport evidence; an unknown send cannot be approved." });
  const result: ChannelSetupTestResult = { draftId, draftRevision: draft.revision, status: source.status, levels: [], issues: source.issues, probe: source.probe, checkedAt: source.checkedAt, proofExpiresAt: channelSetupProofExpiresAt(source.checkedAt) };
  result.finalizationEligibility = evaluateChannelSetupEligibility(result, connection, input.acknowledgement === "cleanup" || await hasCleanupAcknowledgement(host, source));
  assertDraftRevision(await host.storage.channelSetupDrafts.get(draftId), input.expectedRevision);
  await requireReviewedChannelConnection(host, draft);
  const evidence = await host.storage.channelSetupEvidence.create({ ...source, evidenceId: undefined, createdAt: undefined, phase: "acknowledgement", priorEvidenceId: source.evidenceId, actorId, acknowledgement: input.acknowledgement, finalizationEligibility: result.finalizationEligibility });
  result.evidenceId = evidence.evidenceId;
  result.finalizationEligibility = { ...result.finalizationEligibility, evidenceId: evidence.evidenceId };
  host.recentChannelSetupTests.set(draftId, { signature: fingerprint, result });
  return result;
}

async function hasCleanupAcknowledgement(host: ChannelSetupHost, evidence: ChannelSetupEvidence): Promise<boolean> {
  let current: ChannelSetupEvidence | undefined = evidence;
  const seen = new Set<string>();
  for (let depth = 0; current && depth < 10; depth++) {
    if (seen.has(current.evidenceId)) break;
    seen.add(current.evidenceId);
    if (current.phase === "acknowledgement" && current.acknowledgement === "cleanup") return true;
    if (!current.priorEvidenceId || !host.storage.channelSetupEvidence) break;
    const prior = await host.storage.channelSetupEvidence.get(current.priorEvidenceId);
    if (!prior || prior.draftId !== evidence.draftId || prior.catalogId !== evidence.catalogId || prior.inputFingerprint !== evidence.inputFingerprint || prior.checkedAt !== evidence.checkedAt) break;
    current = prior;
  }
  return false;
}
