import { useChatBindingDraftReceipt } from "./useChatBindingDraftReceipt";
import { presentSpecialistCandidateStatus } from "./chat-vocabulary";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Button } from "../../ui/Button";
import {
  ChatContextMemoryPages,
  ChatContextActionOutcome,
  ChatContextDisclosure as ContextDisclosure,
} from "./ChatContextActionOutcome";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";

type Family = "specialists" | "learnedMemory" | "binding";
type Review = {
  family: Family;
  scopeIdentity: string;
  callerRevision: number;
  title: string;
  message: string;
  label: string;
  fingerprint: (dock: MissionThreadedContextDockProps) => string | undefined;
  originalFingerprint: string;
  action: () => Promise<void>;
  inputCurrent?: () => boolean;
};
/** Supported Classic actions through their original controllers; no new reads on mount. */
export function ChatContextActions({ dock }: { dock: MissionThreadedContextDockProps }) {
  const latest = useRef(dock);
  useLayoutEffect(() => {
    latest.current = dock;
  }, [dock]);
  const [review, setReview] = useState<Review>();
  const activeReview = useRef<Review | undefined>(undefined);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeReview.current = undefined;
    };
  }, []);
  const [memoryPage, setMemoryPage] = useState(0);
  const groups = dock.contextMutations;
  const canonicalBinding = useMemo(
    () => ({
      connectionId: dock.binding?.transport === "integration" ? (dock.binding.connectionId ?? "") : "",
      target: dock.binding?.transport === "integration" ? (dock.binding.target ?? "") : "",
    }),
    [dock.binding],
  );
  const bindingDraft = useSessionDraft(
    JSON.stringify(["chat-binding", groups?.binding?.workspaceId, dock.selectedSessionId]),
    canonicalBinding,
    dock.binding?.updatedAt ?? "no-binding",
    { label: "Conversation integration binding" },
  );
  const noteBindingSubmission = useChatBindingDraftReceipt(
    bindingDraft,
    canonicalBinding,
    dock.binding?.updatedAt,
    groups?.binding,
  );
  if (!groups?.specialists || !groups.learnedMemory || !groups.binding)
    return <p role="status">Conversation context actions are not available right now.</p>;
  const ownersCurrent = Object.values(groups).every((group) => group.isCurrent());
  const busy =
    !ownersCurrent ||
    dock.sending ||
    Boolean(dock.sessionControlPending) ||
    Object.values(groups).some((group) => group.locked);
  const openReview = (
    family: Family,
    title: string,
    message: string,
    label: string,
    action: () => Promise<void>,
    fingerprint: Review["fingerprint"],
  ) => {
    const owner = groups[family];
    const originalFingerprint = fingerprint(dock);
    if (!mounted.current || activeReview.current || busy || !owner.isCurrent() || originalFingerprint === undefined)
      return;
    const pending = {
      family,
      scopeIdentity: owner.scopeIdentity,
      callerRevision: getGatewayCallerScopeRevision(),
      title,
      message,
      label,
      fingerprint,
      originalFingerprint,
      action,
      inputCurrent: family === "binding" ? bindingDraft.isSnapshotCurrent : undefined,
    };
    activeReview.current = pending;
    setReview(pending);
  };
  const reviewCurrent = () => {
    if (!mounted.current || !review || activeReview.current !== review) return false;
    const owner = latest.current.contextMutations?.[review.family];
    return Boolean(
      owner?.isCurrent() &&
      !owner.locked &&
      owner.scopeIdentity === review.scopeIdentity &&
      getGatewayCallerScopeRevision() === review.callerRevision &&
      review.inputCurrent?.() !== false &&
      review.fingerprint(latest.current) === review.originalFingerprint &&
      !latest.current.sending &&
      !latest.current.sessionControlPending,
    );
  };
  const pageCount = Math.max(1, Math.ceil(dock.learnedMemory.length / 8));
  const currentPage = Math.min(memoryPage, pageCount - 1);
  return (
    <div className="space-y-3" aria-label="Conversation context actions">
      {!ownersCurrent ? (
        <p role="status">
          Select a current conversation in this workspace and review its access before changing context.
        </p>
      ) : null}
      {Object.values(groups).some((group) => group.phase === "uncertain") ? (
        <p role="alert">
          A Chat context mutation has an unknown outcome. Its original lock is retained; inspection and layout switching
          do not settle or run it again.
        </p>
      ) : null}
      {review && !reviewCurrent() ? (
        <p role="status">
          This review is no longer current. Cancel it and review the current conversation before applying.
        </p>
      ) : null}
      <ContextDisclosure summary="Specialists">
        <p className="text-sm text-fg-muted">
          Draft candidates for review or activate a catalog specialist for this conversation. Activation remains
          manual-only and governed by GoatCitadel.
        </p>
        <ul className="divide-y divide-line-subtle">
          {dock.specialistSuggestions.map((suggestion) => {
            const fingerprint: Review["fingerprint"] = (current) => {
              const value = current.specialistSuggestions.find((item) => item.candidateId === suggestion.candidateId);
              return value ? JSON.stringify(value) : undefined;
            };
            return (
              <li key={suggestion.candidateId} className="space-y-2 py-3">
                <strong>{suggestion.title}</strong>
                <p>{suggestion.summary}</p>
                <p className="text-sm text-fg-muted">{suggestion.reason}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-8 max-sm:min-h-11"
                    disabled={busy}
                    onClick={() =>
                      openReview(
                        "specialists",
                        "Draft this specialist?",
                        `Create a candidate for ${dock.selectedSession.title ?? "this conversation"}. This records a draft; it does not activate the candidate.`,
                        "Draft specialist",
                        () => dock.onCreateSpecialistDraft(suggestion),
                        fingerprint,
                      )
                    }
                  >
                    Draft
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-8 max-sm:min-h-11"
                    disabled={busy || suggestion.source !== "catalog"}
                    onClick={() =>
                      openReview(
                        "specialists",
                        "Activate this catalog specialist?",
                        `Activate ${suggestion.title} for ${dock.selectedSession.title ?? "this conversation"} as manual-only. GoatCitadel provenance, permissions and activation policy remain authoritative.`,
                        "Activate manual-only",
                        () => dock.onActivateCatalogSpecialist(suggestion),
                        fingerprint,
                      )
                    }
                  >
                    Activate
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {dock.specialistSuggestions.length === 0 ? <p>No specialist suggestions are loaded.</p> : null}
        <p className="text-sm text-fg-muted">
          {dock.specialistCandidates.length} candidate records loaded. Inspection refreshes the current bounded list.
        </p>
        <ul className="space-y-2">
          {dock.specialistCandidates.slice(0, 8).map((candidate) => (
            <li key={candidate.candidateId}>
              <strong>{candidate.title}</strong>
              <p>
                {presentSpecialistCandidateStatus(candidate.status)} ·{" "}
                {candidate.routingMode === "manual_only"
                  ? "manual-only routing"
                  : candidate.routingMode === "disabled"
                    ? "routing disabled"
                    : "strong-match routing"}
              </p>
              <TechnicalDetails label="Record identifiers">
                <p className="break-all font-mono text-xs text-fg-muted">{candidate.candidateId}</p>
              </TechnicalDetails>
            </li>
          ))}
        </ul>
        {dock.specialistCandidates.length > 8 ? <p>Showing the first 8 loaded candidate records.</p> : null}
        <ChatContextActionOutcome owner={groups.specialists} family="specialists" />
      </ContextDisclosure>
      <ContextDisclosure summary="Learned memory">
        <p className="text-sm text-fg-muted">
          {dock.learnedMemory.length} loaded records. Inspection refreshes a bounded session list and does not establish
          historical completeness.
        </p>
        <ul className="divide-y divide-line-subtle">
          {dock.learnedMemory.slice(currentPage * 8, currentPage * 8 + 8).map((item) => {
            const fingerprint: Review["fingerprint"] = (current) => {
              const value = current.learnedMemory.find((record) => record.itemId === item.itemId);
              return value ? JSON.stringify(value) : undefined;
            };
            return (
              <li key={item.itemId} className="space-y-2 py-3">
                <p className="break-words">{item.content}</p>
                <p className="text-sm text-fg-muted">Status: {item.status}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-8 max-sm:min-h-11"
                    disabled={busy}
                    onClick={() =>
                      openReview(
                        "learnedMemory",
                        "Keep this memory active?",
                        "Mark this recorded item active for the current conversation. GoatCitadel memory policy remains authoritative.",
                        "Keep active",
                        () => dock.onUpdateMemoryStatus(item.itemId, "active"),
                        fingerprint,
                      )
                    }
                  >
                    Keep active
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-8 max-sm:min-h-11"
                    disabled={busy}
                    onClick={() =>
                      openReview(
                        "learnedMemory",
                        "Mark this memory stale?",
                        "Mark this recorded item superseded for the current conversation. Its history is kept.",
                        "Mark stale",
                        () => dock.onUpdateMemoryStatus(item.itemId, "superseded"),
                        fingerprint,
                      )
                    }
                  >
                    Mark stale
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <ChatContextMemoryPages pageCount={pageCount} currentPage={currentPage} onPageChange={setMemoryPage} />
        <Button
          type="button"
          size="sm"
          className="min-h-8 max-sm:min-h-11"
          disabled={busy}
          onClick={() =>
            openReview(
              "learnedMemory",
              "Rebuild learned memory?",
              "Rebuild the learned memory saved for this conversation. The rebuild result is recorded separately and does not by itself change how future replies run.",
              "Rebuild learned memory",
              dock.onRebuildLearnedMemory,
              (current) => `${current.selectedSessionId}:${current.selectedSession.workspaceId ?? ""}`,
            )
          }
        >
          Rebuild learned memory
        </Button>
        <ChatContextActionOutcome owner={groups.learnedMemory} family="learnedMemory" />
      </ContextDisclosure>
      <ContextDisclosure summary="External binding">
        <p className="text-sm text-fg-muted">
          Bind this conversation to a writable integration target. Connection permissions and access policy still apply.
        </p>
        <fieldset disabled={busy} className="min-w-0 border-0 space-y-2 p-0">
          <label className="block">
            Connection
            <input
              className="block w-full rounded-md border border-line-control bg-canvas p-2"
              value={bindingDraft.value.connectionId}
              onChange={(event) => bindingDraft.setValue({ ...bindingDraft.value, connectionId: event.target.value })}
            />
          </label>
          <label className="block">
            Target
            <input
              className="block w-full rounded-md border border-line-control bg-canvas p-2"
              value={bindingDraft.value.target}
              onChange={(event) => bindingDraft.setValue({ ...bindingDraft.value, target: event.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="min-h-8 max-sm:min-h-11"
              disabled={
                !bindingDraft.value.connectionId.trim() ||
                !bindingDraft.value.target.trim() ||
                bindingDraft.hasRemoteChanges
              }
              onClick={() => {
                const reviewedDraft = {
                  connectionId: bindingDraft.value.connectionId.trim(),
                  target: bindingDraft.value.target.trim(),
                };
                openReview(
                  "binding",
                  "Save this writable integration binding?",
                  `Bind ${dock.selectedSession.title ?? "this conversation"} to connection ${reviewedDraft.connectionId}, target ${reviewedDraft.target}. The existing connection permissions remain authoritative.`,
                  "Save binding",
                  () => {
                    noteBindingSubmission(reviewedDraft);
                    return dock.onSaveExternalBinding(reviewedDraft);
                  },
                  (current) => current.binding?.updatedAt ?? "no-binding",
                );
              }}
            >
              Save binding
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-8 max-sm:min-h-11"
              disabled={!bindingDraft.isDirty}
              onClick={bindingDraft.discard}
            >
              Discard draft
            </Button>
          </div>
        </fieldset>
        {bindingDraft.hasRemoteChanges ? (
          <p role="alert">
            The binding changed somewhere else while you edited this draft. Discard the draft and check the recorded
            binding below before saving.
          </p>
        ) : null}
        {dock.binding ? (
          <p className="text-sm text-fg-muted">
            Recorded binding: {dock.binding.transport}; {dock.binding.writable ? "writable" : "read-only"}.
          </p>
        ) : (
          <p>No binding is currently recorded.</p>
        )}
        <ChatContextActionOutcome owner={groups.binding} family="binding" />
      </ContextDisclosure>
      <ConfirmModal
        open={Boolean(review)}
        title={review?.title ?? "Review conversation action"}
        message={review?.message ?? ""}
        confirmLabel={review?.label}
        confirmDisabled={!reviewCurrent()}
        onCancel={() => {
          if (activeReview.current && activeReview.current !== review) return;
          if (activeReview.current === review) activeReview.current = undefined;
          setReview((value) => (value === review ? undefined : value));
        }}
        onConfirm={() => {
          if (!reviewCurrent() || !review) return;
          const action = review.action;
          activeReview.current = undefined;
          setReview((value) => (value === review ? undefined : value));
          void action();
        }}
      />
    </div>
  );
}
