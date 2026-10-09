import type { ChannelProbeReport } from "./channel-probes.js";
import type { ChannelSetupFinalizationEligibility, ChannelSetupIssue, ChannelSetupStatus } from "./channel-wizard.js";

/** Immutable, redacted setup evidence; credential values and message bodies never belong here. */
export interface ChannelSetupEvidence {
  evidenceId: string;
  /** Database-assigned append order; callers cannot select it. */
  sequence?: number;
  catalogId: string;
  draftId: string;
  draftRevision: number;
  /** Original probe owner above; this is the exact draft revision consumed by activation. */
  activationDraftRevision?: number;
  connectionId?: string;
  connectionRevision?: string;
  phase: "test" | "acknowledgement" | "activation";
  status: ChannelSetupStatus;
  checkedAt: string;
  createdAt: string;
  issues: ChannelSetupIssue[];
  probe?: ChannelProbeReport;
  priorEvidenceId?: string;
  inputFingerprint?: string;
  actorId?: string;
  acknowledgement?: "cleanup" | "receipt";
  finalizationEligibility?: ChannelSetupFinalizationEligibility;
}

export type ChannelSetupEvidenceCreateInput = Omit<ChannelSetupEvidence, "evidenceId" | "createdAt"> & {
  evidenceId?: string;
  createdAt?: string;
};

export interface ChannelSetupEvidenceListQuery {
  draftId?: string;
  connectionId?: string;
  limit?: number;
}

/** Internal authority stamp. Provider-supplied values are removed by the Gateway ingress owner. */
export const CHANNEL_INGRESS_ACCEPTED_REVISION_KEY = "__goatcitadelAcceptedConnectionRevision";
