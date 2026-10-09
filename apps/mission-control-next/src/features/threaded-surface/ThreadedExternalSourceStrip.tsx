import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { StatusChip } from "../native-routes/primitives";

const SOURCES_AVAILABLE_NOTICE = "Attached sources remain available for inspection and governed Knowledge copies.";
const NEW_TURN_CONTEXT_NOTICE =
  "New Chat turns use live capabilities, so including external sources in the next turn is temporarily unavailable. Attaching a source does not include it in model context.";

type ThreadedExternalSourceControls = NonNullable<MissionThreadedActiveSessionSurfaceProps["externalSourceControls"]>;

/**
 * HX-407 C3/C4b read-only external-source picker. New-turn inclusion is unavailable; source
 * evidence remains immutable, and attach/detach/knowledge-copy mutations stay
 * behind the Gateway's live session-incarnation check.
 */
export function ExternalSourceStrip({
  controls,
  disabled,
  openAttachFormToken = 0,
  onOpenLibrary,
  onRestoreFocus,
}: {
  controls: ThreadedExternalSourceControls;
  disabled: boolean;
  openAttachFormToken?: number;
  onOpenLibrary?: () => void;
  onRestoreFocus?: () => void;
}) {
  const stripInstanceId = useId();
  const attachFormId = `${stripInstanceId}-attach-form`;
  const stripRef = useRef<HTMLElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerCloseRef = useRef<HTMLButtonElement | null>(null);
  const wasPickerOpenRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachFormOpen, setAttachFormOpen] = useState(false);
  const [recentImportMetadata, setRecentImportMetadata] = useState<
    Map<string, { sourceLabel: string; importedAt: string }>
  >(() => new Map());
  const selectedCount = controls.selectedAttachmentIds.length;
  // On phone the full notices leave Chat only a sliver of transcript. Keep a one-line
  // truthful status in view and the exact notices one tap away (rendered once, not duplicated).
  const compact = useMediaQuery("(max-width: 639px)");
  const mutationHint = controls.canMutate
    ? null
    : "Chat is still preparing this session. You can review attached sources now; source changes will be available when Chat is ready.";

  useEffect(() => {
    if (openAttachFormToken <= 0) return;
    setPickerOpen(true);
    setAttachFormOpen(true);
    stripRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [openAttachFormToken]);

  useEffect(() => {
    if (pickerOpen) pickerCloseRef.current?.focus();
    else if (wasPickerOpenRef.current) {
      if (pickerTriggerRef.current) pickerTriggerRef.current.focus();
      else onRestoreFocus?.();
    }
    wasPickerOpenRef.current = pickerOpen;
  }, [onRestoreFocus, pickerOpen]);

  const closePicker = () => {
    setPickerOpen(false);
    setAttachFormOpen(false);
  };
  const handlePickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.closest("details:not([open])"));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !event.currentTarget.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  if (
    !pickerOpen &&
    !attachFormOpen &&
    controls.attachments.length === 0 &&
    controls.candidates.length === 0 &&
    !controls.loading &&
    !controls.error &&
    controls.candidatesSupported !== false
  ) {
    return null;
  }

  return (
    <section
      ref={stripRef}
      className="mc-next-composer-external-strip my-2 rounded-md border border-line p-3 text-sm"
      aria-label="Read-only external source attachments"
    >
      <div className="mc-next-composer-external-head flex flex-wrap items-center gap-3">
        <strong>Read-only sources</strong>
        <span aria-live="polite">
          {selectedCount > 0
            ? `${selectedCount} retained source selection(s). Clear the selection to send.`
            : compact
              ? "New-turn context unavailable"
              : SOURCES_AVAILABLE_NOTICE}
        </span>
        {selectedCount > 0 ? (
          <button
            type="button"
            className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
            onClick={controls.onClearSelection}
            aria-label="Clear the external source selection"
          >
            Clear selection
          </button>
        ) : null}
        <button
          ref={pickerTriggerRef}
          type="button"
          className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(true)}
        >
          Choose sources
        </button>
      </div>
      {compact ? (
        <details className="mc-next-composer-external-hint mt-2 text-fg-secondary">
          <summary className="mc-next-composer-inline-button inline-flex min-h-11 cursor-pointer items-center text-accent">About read-only sources</summary>
          <p className="mc-next-composer-external-hint my-2">{NEW_TURN_CONTEXT_NOTICE}</p>
          {selectedCount > 0 ? null : <p className="mc-next-composer-external-hint my-2">{SOURCES_AVAILABLE_NOTICE}</p>}
        </details>
      ) : (
        <p className="mc-next-composer-external-hint my-2 text-fg-secondary">{NEW_TURN_CONTEXT_NOTICE}</p>
      )}
      {pickerOpen ? (
        <div className="mc-next-source-picker-backdrop fixed inset-0 z-50 grid place-items-center bg-sunken/90 p-3">
          <div
            ref={pickerRef}
            className="mc-next-source-picker-dialog max-h-[85dvh] w-full max-w-2xl overflow-auto rounded-lg border border-line bg-overlay p-4 shadow-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${stripInstanceId}-picker-title`}
            onKeyDown={handlePickerKeyDown}
          >
            <header className="mc-next-source-picker-header flex items-start justify-between gap-3">
              <div>
                <h2 id={`${stripInstanceId}-picker-title`}>Attached sources</h2>
                <p id={`${stripInstanceId}-selection-restriction`}>Including external sources in new Chat turns is temporarily unavailable while Chat uses live capabilities. Clear any retained selection to send. Read-only inspection and governed Knowledge copies remain available.</p>
              </div>
              <button
                ref={pickerCloseRef}
                type="button"
                className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
                onClick={closePicker}
              >
                Close
              </button>
            </header>
            {controls.error ? (
              <p className="mc-next-composer-external-error my-2 text-status-failed" role="alert">
                {controls.error}
              </p>
            ) : null}
            {mutationHint ? <p className="mc-next-composer-external-hint my-2 text-fg-secondary">{mutationHint}</p> : null}
            {controls.loading && controls.attachments.length === 0 ? (
              <p className="mc-next-composer-external-hint my-2 text-fg-secondary" role="status">
                Checking attached sources…
              </p>
            ) : controls.attachments.length === 0 ? (
              <p className="mc-next-composer-external-hint my-2 text-fg-secondary">No read-only sources are attached to this chat yet.</p>
            ) : (
              <ul role="list" className="mc-next-composer-external-list my-3 grid gap-3" aria-label="Attached read-only sources">
                {controls.attachments.map((attachment) => {
                  const busy = controls.busyAttachmentId !== null;
                  const selected = controls.selectedAttachmentIds.includes(attachment.attachmentId);
                  const checkboxId = `${stripInstanceId}-select-${attachment.attachmentId}`;
                  const candidate = controls.candidates.find(
                    (item) =>
                      item.sourceId === attachment.sourceId &&
                      item.importId === attachment.importId &&
                      item.itemId === attachment.itemId,
                  );
                  const bindingKey = `${attachment.sourceId}\u001f${attachment.importId}\u001f${attachment.itemId}`;
                  const recentImport = recentImportMetadata.get(bindingKey);
                  const sourceName = candidate?.sourceLabel ?? recentImport?.sourceLabel ?? "Read-only source";
                  const importedAt = candidate?.importedAt ?? recentImport?.importedAt;
                  const date = importedAt ?? attachment.attachedAt;
                  const formattedDate = Number.isFinite(Date.parse(date))
                    ? new Date(date).toLocaleDateString(undefined, { dateStyle: "medium" })
                    : "date unavailable";
                  return (
                    <li key={attachment.attachmentId} className="mc-next-composer-external-chip rounded-md border border-line p-3">
                      <div className="mc-next-composer-external-chip-body grid min-w-0 gap-2 break-words">
                        <label className="mc-next-composer-external-select flex min-h-11 items-center gap-2" htmlFor={checkboxId}>
                          <input
                            id={checkboxId}
                            type="checkbox"
                            checked={selected}
                            disabled={disabled || busy || controls.loading || !selected}
                            aria-describedby={`${stripInstanceId}-selection-restriction`}
                            onChange={() => controls.onToggleSelect(attachment.attachmentId)}
                            aria-label={`Include ${sourceName} in the next turn`}
                          />
                          <strong>{sourceName}</strong>
                        </label>
                        <p className="mc-next-composer-external-meta text-xs text-fg-muted break-all">
                          Read-only · {importedAt ? "Imported" : "Attached"} {formattedDate}
                        </p>
                        <details>
                          <summary>Source details and actions</summary>
                          <p className="mc-next-composer-external-meta text-xs text-fg-muted break-all">
                            Item {attachment.itemId} · source {attachment.sourceId} · import {attachment.importId} ·
                            revision {attachment.revision} · sha {attachment.normalizedArtifactSha256.slice(0, 12)}…
                          </p>
                          <div className="mc-next-composer-external-chip-actions flex flex-wrap gap-2">
                            <StatusChip tone="muted">Read-only</StatusChip>
                            <button
                              type="button"
                              className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
                              disabled={disabled || busy || !controls.canMutate}
                              onClick={() => controls.onRequestKnowledgeSnapshot(attachment.attachmentId)}
                              aria-label="Request a governed knowledge copy of this source"
                            >
                              Request knowledge copy
                            </button>
                            <button
                              type="button"
                              className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
                              disabled={disabled || busy || !controls.canMutate}
                              onClick={() => controls.onDetach(attachment.attachmentId)}
                              aria-label="Detach this read-only source"
                            >
                              Detach
                            </button>
                          </div>
                        </details>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <details
              className="mc-next-source-picker-attach my-3 rounded-md border border-line p-3"
              open={attachFormOpen}
              onToggle={(event) => setAttachFormOpen(event.currentTarget.open)}
            >
              <summary>Attach a verified import</summary>
              <div id={attachFormId} className="mc-next-composer-external-attach-form grid gap-3">
                <p className="mc-next-composer-external-hint my-2 text-fg-secondary">
                  Attach a verified import for read-only inspection or a governed Knowledge copy. Attachment does not enable next-turn context.
                </p>
                {controls.loading ? (
                  <p className="mc-next-composer-external-hint my-2 text-fg-secondary" role="status">
                    Refreshing eligible imports…
                  </p>
                ) : controls.candidatesSupported === false ? (
                  <p className="mc-next-composer-external-hint my-2 text-fg-secondary">
                    Verified import selection is unavailable here. Manage imports in Library.
                  </p>
                ) : controls.candidates.length === 0 ? (
                  <p className="mc-next-composer-external-hint my-2 text-fg-secondary">
                    No verified imports are ready to attach. Import and verify an item in Library first.
                  </p>
                ) : (
                  <ul
                    role="list"
                    className="mc-next-composer-external-list my-3 grid gap-3"
                    aria-label="Verified imports ready to attach"
                  >
                    {controls.candidates.map((candidate) => {
                      const busy = controls.busyAttachmentId === `attach:${candidate.itemId}`;
                      const formattedDate = Number.isFinite(Date.parse(candidate.importedAt))
                        ? new Date(candidate.importedAt).toLocaleDateString(undefined, { dateStyle: "medium" })
                        : "date unavailable";
                      return (
                        <li
                          key={`${candidate.sourceId}:${candidate.importId}:${candidate.itemId}`}
                          className="mc-next-composer-external-chip rounded-md border border-line p-3"
                        >
                          <div className="mc-next-composer-external-chip-body grid min-w-0 gap-2 break-words">
                            <strong>{candidate.sourceLabel}</strong>
                            <p className="mc-next-composer-external-meta text-xs text-fg-muted break-all">
                              Imported {formattedDate} · verified {candidate.artifactsVerifiedAt.slice(0, 10)}
                            </p>
                            <details>
                              <summary>Import details</summary>
                              <p className="mc-next-composer-external-meta text-xs text-fg-muted break-all">
                                Item {candidate.itemId} · source revision {candidate.sourceRevision}
                              </p>
                            </details>
                          </div>
                          <div className="mc-next-composer-external-chip-actions flex flex-wrap gap-2">
                            <StatusChip tone="muted">Read-only</StatusChip>
                            <button
                              type="button"
                              className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
                              disabled={disabled || controls.busyAttachmentId !== null || !controls.canMutate}
                              onClick={() => {
                                const bindingKey = `${candidate.sourceId}\u001f${candidate.importId}\u001f${candidate.itemId}`;
                                setRecentImportMetadata((current) =>
                                  new Map(current).set(bindingKey, {
                                    sourceLabel: candidate.sourceLabel,
                                    importedAt: candidate.importedAt,
                                  }),
                                );
                                controls.onAttach({
                                  sourceId: candidate.sourceId,
                                  importId: candidate.importId,
                                  itemId: candidate.itemId,
                                });
                              }}
                              aria-label={`Attach verified import from ${candidate.sourceLabel} read-only`}
                            >
                              {busy ? "Attaching…" : "Attach read-only"}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mc-next-composer-external-chip-actions flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
                    disabled={disabled || controls.loading}
                    onClick={controls.onReload}
                  >
                    Refresh imports
                  </button>
                  {onOpenLibrary ? (
                    <button
                      type="button"
                      className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50"
                      disabled={disabled}
                      onClick={onOpenLibrary}
                    >
                      Manage Library imports
                    </button>
                  ) : null}
                </div>
              </div>
            </details>
            <footer className="mc-next-source-picker-footer mt-3 flex flex-wrap items-center justify-between gap-3">
              <span aria-live="polite">
                {selectedCount > 0
                  ? `${selectedCount} retained source selection(s); clear before sending`
                  : "No sources selected"}
              </span>
              <button type="button" className="mc-next-composer-inline-button inline-flex min-h-11 items-center rounded-md border border-line px-3 text-accent disabled:opacity-50" onClick={closePicker}>
                Done reviewing sources
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
