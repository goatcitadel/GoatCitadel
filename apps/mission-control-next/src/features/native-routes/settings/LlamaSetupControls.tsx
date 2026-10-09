import type { ButtonHTMLAttributes, ComponentType, ReactNode } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { NativeButton } from "../primitives";
import { useLlamaSetup } from "./use-llama-setup";
import { useLlamaSetupChatTest } from "./use-llama-setup-chat-test";
import { LlamaSetupReviews } from "./LlamaSetupReviews";

export function LlamaSetupControls({
  workspaceId,
  onApproval,
  renderApprovalAction,
  cockpit = false,
  buttonComponent: Action = NativeButton,
}: {
  workspaceId: string;
  onApproval?: (approvalId: string) => void;
  renderApprovalAction?: (plan: ChangePlanRecord, pending: boolean) => ReactNode;
  cockpit?: boolean;
  buttonComponent?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const control = useLlamaSetup(workspaceId),
    { draft, projection, plan } = control;
  const visibleChoices = control.choices.slice(0, 200);
  const modelUnverified = Boolean(draft.value.model && !control.choices.includes(draft.value.model));
  const diagnostic = useLlamaSetupChatTest({
    workspaceId,
    projection,
    available: control.ready,
    refresh: control.refresh,
  });
  const input = cockpit
    ? "mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg disabled:opacity-60"
    : "mc-next-settings-input";
  const row = cockpit ? "flex flex-wrap gap-2" : "mc-next-settings-button-row";
  const actionClass = cockpit ? "h-auto min-h-9 max-w-full whitespace-normal break-words" : undefined;
  return (
    <section
      aria-label="Validated llama.cpp setup"
      className={cockpit ? "space-y-3 text-sm text-fg-secondary" : "mc-next-settings-stack"}
    >
      <p>
        Choose a runtime and model for this Gateway installation. Setup plans and the diagnostic Chat are recorded in
        workspace {workspaceId}.
      </p>
      <p>
        Ownership: {projection ? humanizeToken(projection.ownership) : "Unavailable"}. Current Chat route:{" "}
        {projection?.chatRoute.providerId || "Unavailable"} · {projection?.chatRoute.model || "Not selected"}.
      </p>
      {control.evidence.loading ? <p role="status">Loading setup evidence…</p> : null}
      {control.evidence.error ? <p role="alert">{control.evidence.error}</p> : null}
      <fieldset disabled={control.locked}>
        <legend>How will the server run?</legend>
        <label className={cockpit ? "flex min-h-11 items-center gap-2" : undefined}>
          <input
            type="radio"
            name={`llamacpp-management-${workspaceId}`}
            checked={draft.value.mode === "external"}
            onChange={() => control.setDraft((value) => ({ ...value, mode: "external", model: "" }))}
          />
          Use a running server
        </label>
        <label className={cockpit ? "flex min-h-11 items-center gap-2" : undefined}>
          <input
            type="radio"
            name={`llamacpp-management-${workspaceId}`}
            checked={draft.value.mode === "managed"}
            onChange={() => control.setDraft((value) => ({ ...value, mode: "managed", model: "" }))}
          />
          Let GoatCitadel start one
        </label>
      </fieldset>
      <p>
        {draft.value.mode === "external"
          ? "The external process stays with its owner. Only freshly advertised models can be selected."
          : "Only Gateway-discovered GGUF files and an installed llama-server can be used. Approved setup may start the managed process."}
      </p>
      <div className={cockpit ? "grid gap-3 sm:grid-cols-2" : "mc-next-settings-field-grid"}>
        <label>
          Server URL
          <input
            type="url"
            className={input}
            value={draft.value.baseUrl}
            disabled={control.locked}
            onChange={(event) => control.setDraft((value) => ({ ...value, baseUrl: event.target.value, model: "" }))}
          />
        </label>
        <label>
          Model for Chat
          <select
            className={input}
            value={draft.value.model}
            disabled={control.locked || !control.choices.length}
            onChange={(event) => control.setDraft((value) => ({ ...value, model: event.target.value }))}
          >
            <option value="">Choose a verified model</option>
            {draft.value.model && !visibleChoices.includes(draft.value.model) ? (
              <option value={draft.value.model} disabled={modelUnverified}>
                {draft.value.model}{modelUnverified ? " (not currently verified)" : ""}
              </option>
            ) : null}
            {visibleChoices.map((id) => (
              <option key={id} value={id}>
                {draft.value.mode === "managed"
                  ? (control.managedModels.find((model) => model.modelId === id)?.label ?? id)
                  : id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {modelUnverified ? (
        <p role="status">
          The selected model is retained but is not in the current verified catalog.{" "}
          {draft.value.mode === "external"
            ? "Check the server before preparing a new setup."
            : "Refresh setup evidence before preparing a new setup."}
        </p>
      ) : null}
      {draft.value.mode === "managed" ? (
        <p>
          {projection?.binary.found
            ? `${projection.binary.label ?? "llama-server"} detected; ${control.managedModels.length} GGUF files discovered.`
            : "An installed llama-server was not confirmed. Refresh after installing it through the host owner."}
        </p>
      ) : null}
      {draft.isDirty ? <p role="status">Unsaved llama.cpp setup draft</p> : null}
      {draft.hasRemoteChanges ? (
        <div role="status">
          <p>Saved runtime settings changed. Your draft is retained.</p>
          <Action className={actionClass} disabled={control.locked} onClick={draft.rebaseToCurrent}>
            Review setup draft against current settings
          </Action>
        </div>
      ) : null}
      <div className={row}>
        {draft.value.mode === "external" ? (
          <Action
            className={actionClass}
            disabled={!control.ready || control.busy || control.locked || !draft.value.baseUrl.trim()}
            onClick={() => void control.checkServer()}
          >
            Check server
          </Action>
        ) : null}
        <Action className={actionClass} disabled={control.busy} onClick={() => void control.refresh()}>
          Refresh setup evidence
        </Action>
        <Action className={actionClass} disabled={!control.canPrepare} onClick={control.prepareReview}>
          Finish setup
        </Action>
        <Action className={actionClass} disabled={!draft.isDirty || control.locked} onClick={draft.discard}>
          Discard setup draft
        </Action>
      </div>
      {control.state.pending && control.state.pending.workspaceId !== workspaceId ? (
        <p role="status">
          An existing setup plan in workspace {control.state.pending.workspaceId} is still pending. Review it in its
          origin workspace before creating another setup.
        </p>
      ) : null}
      {plan ? (
        <section
          aria-label="Recorded llama.cpp setup"
          className={cockpit ? "space-y-2 rounded-md border border-line bg-raised p-3" : "mc-next-settings-notice"}
        >
          <h4>{humanizeToken(plan.status)}</h4>
          <p>{plan.result?.summary ?? plan.summary}</p>
          <p>{plan.impact}</p>
          {control.canConfirm ? (
            <Action className={actionClass} onClick={control.confirmationReview}>
              Review recorded setup
            </Action>
          ) : null}
          {plan.requiredAction?.kind === "approval" && plan.requiredAction.approvalId ? (
            renderApprovalAction ? renderApprovalAction(plan, control.busy) : onApproval ? <Action
              className={actionClass}
              onClick={() => {
                if (plan.requiredAction?.kind === "approval" && plan.requiredAction.approvalId)
                  onApproval(plan.requiredAction.approvalId);
              }}
            >
              Open approval details
            </Action> : null
          ) : null}
          {control.approved.visible ? (
            <>
              <Action
                className={actionClass}
                disabled={control.approved.disabled || control.locked}
                onClick={() => void control.approved.continueApproved()}
              >
                Continue approved setup
              </Action>
              {control.approved.message ? <p role="status">{control.approved.message}</p> : null}
            </>
          ) : null}
          {control.settledMatches ? (
            <p role="status">
              Recorded setup and the current Chat route agree. A real Chat response has not been proven by setup alone.
            </p>
          ) : null}
          <details>
            <summary>Setup record details</summary>
            <dl className="break-all">
              <dt>Plan</dt>
              <dd>{plan.planId}</dd>
              <dt>Plan revision</dt>
              <dd>{plan.revision}</dd>
              <dt>Settings revision reviewed</dt>
              <dd>{plan.target.expectedRevision}</dd>
            </dl>
          </details>
        </section>
      ) : null}
      <Action className={actionClass} disabled={!diagnostic.eligible} onClick={diagnostic.requestReview}>
        Send test message
      </Action>
      {diagnostic.result ? (
        <section aria-label="Chat diagnostic result">
          <strong>
            {diagnostic.stale ? "Test stale" : diagnostic.result.success ? "Chat tested" : "Chat test failed"}
          </strong>
          <p>
            {diagnostic.result.providerId} · {diagnostic.result.model} · {diagnostic.result.elapsedMs} ms
          </p>
          {diagnostic.result.responseExcerpt ? <blockquote>{diagnostic.result.responseExcerpt}</blockquote> : null}
          {diagnostic.result.error ? <p>{diagnostic.result.error}</p> : null}
          <details>
            <summary>Diagnostic evidence</summary>
            <p className="break-all">{diagnostic.result.traceRef ?? "No trace reported"}</p>
          </details>
        </section>
      ) : null}
      {control.notice ? <p role="status">{control.notice}</p> : null}
      {diagnostic.message ? <p role="status">{diagnostic.message}</p> : null}
      {control.state.attempt ? (
        <p role={control.state.attempt.state === "uncertain" ? "alert" : "status"}>{control.state.attempt.message}</p>
      ) : null}
      {control.state.attempt?.state === "uncertain" && control.state.attempt.transport ? (
        <Action
          className={actionClass}
          disabled={Boolean(control.state.attempt.checking)}
          onClick={() => void control.checkOutcome()}
        >
          {control.state.attempt.checking ? "Checking outcome…" : "Check outcome"}
        </Action>
      ) : null}
      <LlamaSetupReviews control={control} diagnostic={diagnostic} />
    </section>
  );
}
