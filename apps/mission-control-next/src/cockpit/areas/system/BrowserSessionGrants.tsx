import { useState } from "react";
import type { BrowserSessionGrantRecord, BrowserSessionRecord } from "@goatcitadel/contracts";
import {
  createBrowserSessionGrant,
  fetchBrowserSession,
  revokeBrowserSessionGrant,
  rotateBrowserSessionGrant,
} from "@goatcitadel/mission-control-shared/api/browser-sessions";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useLibraryOperation } from "../library/use-library-operation";
import { GrantReviewBody, type GrantReview } from "./BrowserGrantReview";
import {
  EMPTY_GRANT_DRAFT,
  GRANT_SCOPES,
  GRANT_TTL_PRESETS,
  LIST_LIMIT,
  formatTime,
  describeReceiptState,
  grantMatchesRequest,
  isGrantActive,
  sameGrantScope,
  validateGrantDraft,
  type GrantDraft,
  type GrantDraftErrors,
} from "./browser-sessions-model";

type Outcome = { error: boolean; text: string };

const INPUT = "w-full min-w-0 rounded-md border border-line bg-raised p-2";

/** One operation scope per session: an uncertain grant change locks every other change to that session. */
export function browserSessionOperationScope(workspaceId: string, sessionId: string) {
  return JSON.stringify(["browser-session", workspaceId, sessionId]);
}

export function BrowserSessionGrants({
  session,
  workspaceId,
  grants,
  onChanged,
}: {
  session: BrowserSessionRecord;
  workspaceId: string;
  grants: BrowserSessionGrantRecord[];
  onChanged: () => Promise<unknown>;
}) {
  const operation = useLibraryOperation(browserSessionOperationScope(workspaceId, session.sessionId));
  const draft = useSessionDraft(operation.presentationScope + ":grant", EMPTY_GRANT_DRAFT, undefined, {
    label: "Browser session grant",
  });
  const [errors, setErrors] = useState<GrantDraftErrors>({});
  const [review, setReview] = useSessionViewState<GrantReview | undefined>(operation.key + ":grant-review", undefined);
  const [pending, setPending] = useSessionViewState<GrantReview | undefined>(
    operation.key + ":grant-pending",
    undefined,
  );
  const [outcome, setOutcome] = useSessionViewState<Outcome | undefined>(operation.key + ":grant-outcome", undefined);
  const [busy, setBusy] = useState(false);
  const active = session.status === "active";
  const now = Date.now();
  const set = (patch: Partial<GrantDraft>) => draft.setValue((current) => ({ ...current, ...patch }));

  function openCreateReview() {
    if (busy || operation.locked || !active) return;
    const parsed = validateGrantDraft(draft.value);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    setOutcome(undefined);
    setReview({
      kind: "create",
      request: parsed.request,
      requestId: crypto.randomUUID(),
      expiresAtPreview:
        parsed.request.ttlSeconds === null
          ? null
          : new Date(Date.now() + parsed.request.ttlSeconds * 1000).toISOString(),
      // The exact draft that was reviewed; a later replay must not clear text typed afterwards.
      submitted: draft.value,
    });
  }

  function openGrantReview(kind: "rotate" | "revoke", grant: BrowserSessionGrantRecord) {
    if (busy || operation.locked) return;
    setOutcome(undefined);
    const otherActiveForActor = grants.filter(
      (row) => row.grantId !== grant.grantId && row.actorId === grant.actorId && isGrantActive(row),
    ).length;
    setReview({ kind, grant, otherActiveForActor });
  }

  async function confirm(replay = false) {
    const target = review;
    if (!target || busy || !operation.current()) return;
    if (replay ? pending !== target || operation.attempt?.phase !== "uncertain" : operation.locked) return;
    setBusy(true);
    setOutcome(undefined);
    const revision = target.kind === "create" ? `grant:${target.requestId}` : `${target.kind}:${target.grant.grantId}`;
    try {
      const receipt = await operation.run(
        revision,
        async () => {
          const fresh = await fetchBrowserSession(session.sessionId);
          if (fresh.workspaceId !== workspaceId)
            throw new Error("This browser session is not in the current workspace.");
          if (!replay && fresh.status !== "active" && target.kind !== "revoke")
            throw new Error("This browser session is closed. Refresh before changing grants.");
        },
        async () => {
          if (!replay) setPending(target);
          if (target.kind === "create") {
            // Omitting ttlSeconds is how the Gateway records a grant that never expires.
            const { ttlSeconds, ...rest } = target.request;
            return await createBrowserSessionGrant(session.sessionId, {
              ...rest,
              ...(ttlSeconds === null ? {} : { ttlSeconds }),
              requestId: target.requestId,
            });
          }
          if (target.kind === "rotate") return await rotateBrowserSessionGrant(session.sessionId, target.grant.grantId);
          return await revokeBrowserSessionGrant(session.sessionId, target.grant.grantId);
        },
        (value) => {
          if (target.kind === "create" && !grantMatchesRequest(value, target.request, session.sessionId))
            throw new Error("The grant receipt does not match the reviewed grant.");
          if (
            target.kind === "rotate" &&
            (value.sessionId !== session.sessionId ||
              value.grantId === target.grant.grantId ||
              !sameGrantScope(value, target.grant))
          )
            throw new Error("The rotation receipt does not match the reviewed grant.");
          if (target.kind === "revoke" && (value.grantId !== target.grant.grantId || !value.revokedAt))
            throw new Error("The revoke receipt does not confirm this grant was revoked.");
        },
        replay,
      );
      if (!receipt || !operation.current()) return;
      setPending(undefined);
      setReview(undefined);
      if (target.kind === "create") draft.acceptSaved(EMPTY_GRANT_DRAFT, undefined, target.submitted);
      // A replayed receipt names the original record, which may have been revoked or expired since.
      const state = describeReceiptState(receipt);
      const since =
        state === "active" ? "" : ` That grant has since ${state === "revoked" ? "been revoked" : "expired"}.`;
      setOutcome({
        error: false,
        text:
          target.kind === "create"
            ? `Grant recorded for ${receipt.actorId}: ${receipt.scopes.join(", ")}, ${receipt.expiresAt ? `expires ${formatTime(receipt.expiresAt)}` : "never expires (revoke it when no longer needed)"}.${since}`
            : target.kind === "rotate"
              ? `Grant rotated. ${receipt.actorId} keeps the same scopes, hosts and expiry under a new grant record.${since}`
              : `Grant revoked for ${receipt.actorId}.`,
      });
      await onChanged();
    } catch (cause) {
      if (operation.current()) setOutcome({ error: true, text: describeApiError(cause).summary });
    } finally {
      if (operation.current()) setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    const wasPending = pending && pending === review;
    setReview(undefined);
    if (!wasPending) setOutcome({ error: false, text: "Cancelled. Nothing was changed." });
  }

  const canReplay = Boolean(review && pending === review && operation.attempt?.phase === "uncertain");
  return (
    <section className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-line p-3" aria-label="Scoped grants">
      <h3 className="font-display text-md font-semibold">Scoped grants</h3>
      <p className="text-sm text-fg-secondary">
        Grants let one actor use this session within its scopes and hosts. Tools still pass policy checks and
        guardrails; a grant does not open, bind or control a browser.
      </p>
      {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
      {operation.locked && pending ? (
        <Button onClick={() => setReview(pending)}>Review pending grant change</Button>
      ) : null}
      {outcome && !review ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
      {grants.length ? null : <p className="text-sm text-fg-muted">No grants are recorded for this session.</p>}
      {grants.length >= LIST_LIMIT ? (
        <p className="text-sm text-fg-secondary">
          Showing the newest {LIST_LIMIT} grants. Older grants exist; counts here may be incomplete.
        </p>
      ) : null}
      <ul className="grid min-w-0 grid-cols-1 gap-2">
        {grants.map((grant) => {
          const live = isGrantActive(grant, now);
          return (
            <li key={grant.grantId} className="min-w-0 rounded-md border border-line p-3 wrap-anywhere">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{grant.actorId}</strong>
                <StatusBadge
                  status={live ? { label: "Active", tone: "done" } : { label: "Inactive", tone: "neutral" }}
                />
              </div>
              <p className="text-sm">
                {grant.scopes.join(", ")} · {grant.allowedHosts.length ? grant.allowedHosts.join(", ") : "every host"}
              </p>
              <p className="text-sm text-fg-secondary">
                {grant.revokedAt
                  ? `Revoked ${formatTime(grant.revokedAt)}`
                  : grant.expiresAt
                    ? `${live ? "Expires" : "Expired"} ${formatTime(grant.expiresAt)}`
                    : "No expiry (until revoked)"}
              </p>
              <TechnicalDetails label="Grant record">
                <p>Grant {grant.grantId}</p>
              </TechnicalDetails>
              {live && active ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    disabled={busy || operation.locked}
                    onClick={() => openGrantReview("rotate", grant)}
                    aria-label={`Review rotating the grant for ${grant.actorId}`}
                  >
                    Review rotation
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy || operation.locked}
                    onClick={() => openGrantReview("revoke", grant)}
                    aria-label={`Review revoking the grant for ${grant.actorId}`}
                  >
                    Review revoke
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {active ? (
        <details className="min-w-0">
          <summary className="cursor-pointer font-medium">New grant{draft.isDirty ? " · unsaved" : ""}</summary>
          <div className="mt-2 grid min-w-0 grid-cols-1 gap-3">
            <Field label="Actor" help="The operator or agent ID this grant is for." error={errors.actorId}>
              {(props) => (
                <input
                  {...props}
                  className={INPUT}
                  value={draft.value.actorId}
                  onChange={(event) => set({ actorId: event.target.value })}
                />
              )}
            </Field>
            <fieldset
              className="grid min-w-0 gap-1 text-sm"
              aria-describedby={errors.scopes ? "grant-scopes-error" : undefined}
            >
              <legend className="font-medium text-fg-secondary">Scopes</legend>
              {GRANT_SCOPES.map(({ scope, label, meaning }) => (
                <label key={scope} className="flex min-h-11 min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.value.scopes.includes(scope)}
                    onChange={(event) =>
                      set({
                        scopes: event.target.checked
                          ? [...draft.value.scopes, scope]
                          : draft.value.scopes.filter((item) => item !== scope),
                      })
                    }
                  />
                  <span className="min-w-0">
                    <strong>{label}</strong> — {meaning}
                  </span>
                </label>
              ))}
              {errors.scopes ? (
                <p id="grant-scopes-error" role="alert">
                  {errors.scopes}
                </p>
              ) : null}
            </fieldset>
            <Field label="Allowed hosts" help="Comma-separated. Leave empty to allow every host.">
              {(props) => (
                <input
                  {...props}
                  className={INPUT}
                  value={draft.value.hosts}
                  onChange={(event) => set({ hosts: event.target.value })}
                />
              )}
            </Field>
            <Field
              label="Expires after"
              help="Defaults to one hour. Timed grants last at most seven days; choose Never expires only for access meant to be permanent."
              error={errors.ttlSeconds}
            >
              {(props) => (
                <select
                  {...props}
                  className={INPUT}
                  value={draft.value.ttlSeconds}
                  onChange={(event) => set({ ttlSeconds: Number(event.target.value) })}
                >
                  {GRANT_TTL_PRESETS.map((preset) => (
                    <option key={preset.seconds} value={preset.seconds}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy || operation.locked} onClick={openCreateReview}>
                Review grant
              </Button>
              <Button variant="ghost" disabled={busy || !draft.isDirty} onClick={draft.discard}>
                Discard grant draft
              </Button>
            </div>
          </div>
        </details>
      ) : (
        <p className="text-sm text-fg-secondary">Closed sessions cannot receive grants.</p>
      )}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={
          review?.kind === "create"
            ? "Review new grant"
            : review?.kind === "rotate"
              ? "Review grant rotation"
              : "Review grant revoke"
        }
        description={`Session ${session.label} · workspace ${workspaceId}.`}
      >
        {review ? (
          <div className="grid min-w-0 grid-cols-1 gap-3 text-sm wrap-anywhere">
            <GrantReviewBody review={review} />
            {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy} onClick={close}>
                {canReplay ? "Close" : "Cancel"}
              </Button>
              {canReplay ? (
                <Button disabled={busy} onClick={() => void confirm(true)}>
                  Replay exact request
                </Button>
              ) : (
                <Button
                  variant={review.kind === "create" ? "primary" : "danger"}
                  disabled={busy || operation.locked}
                  onClick={() => void confirm()}
                >
                  {review.kind === "create"
                    ? "Create grant"
                    : review.kind === "rotate"
                      ? "Rotate grant"
                      : "Revoke grant"}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
