import { useEffect, useRef, useState } from "react";
import type { ChannelSetupDraftEvidence } from "@goatcitadel/contracts";
import { fetchChannelSetupDraftEvidence } from "@goatcitadel/mission-control-shared/api/channel-setup-operations";
import { channelProofExpired } from "../channel-setup/channel-wizard-model";
import type { ChannelSetupState } from "./use-channel-setup-state";

/** Read-only recovery. Historical receipts never become current proof in the client. */
export function useChannelDraftEvidence(s: ChannelSetupState) {
  const latest = useRef(s);
  latest.current = s;
  const draft = s.selectedDraft;
  const scope = JSON.stringify([s.activeWorkspaceId, s.selectedDraftId, s.panel, s.selectedConnectionId, s.createCatalogId, draft?.revision]);
  const [read, setRead] = useState<{ scope: string; evidence?: ChannelSetupDraftEvidence; loading: boolean; error?: string }>();
  useEffect(() => {
    // This render's state, read through the synced ref so the read stays keyed on `scope` alone.
    const s = latest.current;
    const draft = s.selectedDraft;
    if (s.panel !== "editor" || !draft || s.busyAction || (s.mutation.pending && !s.mutation.uncertain)) return;
    let current = true;
    const inputEpoch = s.inputEpoch.current;
    const operationEpoch = s.evidenceOperationEpoch.current;
    const input = JSON.stringify(s.channelDraft.value);
    const feedback = s.validationResult;
    const feedbackRevision = s.validationRevision;
    setRead((previous) => ({ scope, evidence: previous?.scope === scope ? previous.evidence : undefined, loading: true }));
    void fetchChannelSetupDraftEvidence(draft.draftId, draft.revision).then((value) => {
      if (!current || !s.isCurrentDraft() || latest.current.evidenceOperationEpoch.current !== operationEpoch) return;
      if (value.draftId !== draft.draftId || value.draftRevision !== draft.revision || !Array.isArray(value.items) ||
        value.items.some((item) => item.draftId !== draft.draftId || item.catalogId !== draft.catalogId ||
          !Number.isSafeInteger(item.draftRevision) || item.draftRevision > draft.revision || item.draftRevision < 1))
        throw new Error("Saved check evidence did not match the selected draft revision.");
      const test = value.currentTest;
      if (test && (test.draftId !== draft.draftId || test.draftRevision !== draft.revision || !test.evidenceId ||
        !test.finalizationEligibility || test.finalizationEligibility.evidenceId !== test.evidenceId ||
        !test.proofExpiresAt || !Number.isFinite(Date.parse(test.proofExpiresAt)) ||
        !value.items.some((item) => item.evidenceId === test.evidenceId)))
        throw new Error("Current check proof did not match the selected draft revision and receipt.");
      const freshTest = test && !channelProofExpired({ ...test, kind: "test", restored: true }) ? test : undefined;
      setRead({ scope, evidence: freshTest === test ? value : { ...value, currentTest: freshTest }, loading: false });
      const now = latest.current;
      if (now.selectedDraft?.draftId !== draft.draftId || now.selectedDraft.revision !== draft.revision ||
        now.inputEpoch.current !== inputEpoch || JSON.stringify(now.channelDraft.value) !== input ||
        now.channelDraft.isDirty || now.channelDraft.hasRemoteChanges || now.channelDraft.baseRevision !== draft.revision ||
        now.needsConnectionReview || now.mutation.pending || now.mutation.uncertain || now.busyAction ||
        now.validationResult !== feedback || now.validationRevision !== feedbackRevision) return;
      now.setValidationRevision(freshTest ? draft.revision : null);
      now.setValidationResult(freshTest ? { ...freshTest, kind: "test", restored: true } : null);
    }).catch(() => {
      if (!current || !s.isCurrentDraft() || latest.current.evidenceOperationEpoch.current !== operationEpoch) return;
      setRead({ scope, loading: false, error: "Saved check evidence could not be verified. Refresh channels before reusing a previous test." });
      const now = latest.current;
      if (now.validationResult === feedback && now.validationRevision === feedbackRevision) {
        now.setValidationResult(null);
        now.setValidationRevision(null);
      }
    });
    return () => { current = false; };
  }, [scope, s.data, s.busyAction, s.mutation.pending, s.mutation.uncertain]);
  return {
    draftEvidence: read?.scope === scope ? read.evidence : undefined,
    draftEvidenceLoading: read?.scope === scope && read.loading,
    draftEvidenceError: read?.scope === scope ? read.error : undefined,
  };
}
