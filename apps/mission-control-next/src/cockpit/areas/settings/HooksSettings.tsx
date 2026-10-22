import { useState } from "react";
import type { HookMode, HookTrigger } from "@goatcitadel/contracts";
import { useHooksSettings } from "../../../features/native-routes/settings/sections/use-hooks-settings";
import {
  HOOK_MODES,
  HOOK_OWNER_BOUNDARY,
  HOOK_OWNER_LIMIT,
  HOOK_TRIGGER_VALUES,
} from "../../../features/native-routes/settings/sections/hooks-owner-binding";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { UnsavedChangesDialog } from "../../ui/UnsavedChangesDialog";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { urlFieldError, useBlurValidation } from "./field-validation";
import { HookRecordEvidence, HookRunEvidence } from "./HookEvidence";
import { useActiveWorkspaceLabel } from "../../data/use-workspace-name";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { HOOK_MODE_LABELS, presentHookDeliveryStatus, presentHookTrigger } from "./settings-vocabulary";

export function HooksSettings({ workspaceId }: { workspaceId: string }) {
  const workspaceLabel = useActiveWorkspaceLabel();
  const s = useHooksSettings(workspaceId);
  const [limit, setLimit] = useState(10),
    [query, setQuery] = useState("");
  const hooks = s.hooks.filter((item) =>
    `${item.label} ${item.trigger} ${presentHookTrigger(item.trigger)} ${item.mode} ${HOOK_MODE_LABELS[item.mode] ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const fields = s.form;
  const labelCheck = useBlurValidation((value) => (value.trim() ? undefined : "Enter a hook label."));
  const urlCheck = useBlurValidation((value) => urlFieldError(value, { required: true, protocols: ["https:"] }));
  return (
    <section id="hooks" aria-label="Governed hooks" className="space-y-4">
      <h3 className="text-md font-semibold text-fg">Governed hooks</h3>
      <p className="text-sm text-fg-secondary">
        Receive lifecycle events through configured hooks. Test and redrive actions can send real requests to the
        configured destination.
      </p>
      <p className="text-xs text-fg-muted">
        {workspaceId ? `Workspace: ${workspaceLabel}.` : "No workspace selected."} {HOOK_OWNER_BOUNDARY}
      </p>
      {s.loading ? (
        <p role="status" className="text-sm">
          Loading hooks…
        </p>
      ) : null}
      {s.error ? (
        <p role="alert" className="text-sm text-status-failed">
          Hooks could not load.
        </p>
      ) : null}
      {s.data?.issues.map((issue) => (
        <p key={issue.label} role="status" className="text-sm text-status-waiting">
          {issue.label} unavailable. Refresh to check it again.
        </p>
      ))}
      {s.notice ? (
        <p role="status" className="break-words text-sm">
          {s.notice.message}
        </p>
      ) : null}
      {s.uncertainty ? (
        <p role="alert" className="text-sm text-status-waiting">
          {s.uncertainty}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!workspaceId || s.mutation.locked} onClick={() => s.openView("new")}>
          Register hook
        </Button>
        <Button onClick={() => s.openView("history")}>Delivery history</Button>
        <Button disabled={s.loading || s.mutation.pending} onClick={() => void s.reload()}>
          Refresh hooks
        </Button>
      </div>
      {s.view === "new" ? (
        <section aria-label="Register hook" className="space-y-3 rounded-md border border-line-subtle p-3">
          <h4 className="text-md font-semibold">Register hook</h4>
          <p className="text-sm text-fg-secondary">
            New registrations are enabled, send metadata only, use priority 100 and a 5-second timeout, and record an
            open failure policy. GoatCitadel decides which modes are permitted.
          </p>
          <fieldset disabled={s.mutation.locked} className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">Hook registration inputs</legend>
            <div className="sm:col-span-2">
              <Field label="Hook label" required error={labelCheck.error}>
                {(fieldProps) => (
                  <input
                    {...fieldProps}
                    aria-label="Hook label"
                    className={cockpitInputClass}
                    value={fields.label}
                    onBlur={(e) => labelCheck.onBlur(e.target.value)}
                    onChange={(e) => {
                      s.setForm({ ...fields, label: e.target.value });
                      labelCheck.onChange(e.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
            <Field label="Lifecycle event">
              {(fieldProps) => (
                <select
                  {...fieldProps}
                  aria-label="Lifecycle event"
                  className={cockpitInputClass}
                  value={fields.trigger}
                  onChange={(e) => s.setForm({ ...fields, trigger: e.target.value as HookTrigger })}
                >
                  {HOOK_TRIGGER_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {presentHookTrigger(value)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Hook mode">
              {(fieldProps) => (
                <select
                  {...fieldProps}
                  aria-label="Hook mode"
                  className={cockpitInputClass}
                  value={fields.mode}
                  onChange={(e) => s.setForm({ ...fields, mode: e.target.value as HookMode })}
                >
                  {HOOK_MODES.map((value) => (
                    <option key={value} value={value}>
                      {HOOK_MODE_LABELS[value]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label="HTTPS endpoint" required error={urlCheck.error}>
                {(fieldProps) => (
                  <input
                    {...fieldProps}
                    aria-label="HTTPS endpoint"
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    className={cockpitInputClass}
                    value={fields.url}
                    onBlur={(e) => urlCheck.onBlur(e.target.value)}
                    onChange={(e) => {
                      s.setForm({ ...fields, url: e.target.value });
                      urlCheck.onChange(e.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Signing secret" required>
                {(fieldProps) => (
                  <input
                    {...fieldProps}
                    aria-label="Signing secret"
                    type="password"
                    autoComplete="new-password"
                    className={cockpitInputClass}
                    value={fields.secret}
                    onChange={(e) => s.setForm({ ...fields, secret: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </fieldset>
          <p className="text-xs text-fg-muted">
            Endpoint and secret inputs stay in this editor only and are discarded when leaving it. The saved private
            values are never read back.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={s.mutation.locked} onClick={s.reviewCreate}>
              Review hook registration
            </Button>
            <Button onClick={() => s.openView(null)}>Close hook editor</Button>
          </div>
        </section>
      ) : null}
      <Field label="Find hooks">
        {(fieldProps) => (
          <input
            {...fieldProps}
            aria-label="Find hooks"
            type="search"
            className={`mt-1 ${cockpitInputClass}`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(10);
            }}
          />
        )}
      </Field>
      {!s.data?.issues.some((issue) => issue.label === "Hooks") && s.data ? (
        <>
          <p className="text-xs text-fg-muted">
            {plural(hooks.length, "matching hook")} in this response
            {s.hooks.length === HOOK_OWNER_LIMIT ? "; response is capped at 500" : ""}.
          </p>
          {!hooks.length ? (
            <p className="text-sm text-fg-muted">No matching hooks returned.</p>
          ) : (
            <ul className="space-y-2">
              {hooks.slice(0, limit).map((hook) => (
                <li key={hook.hookId}>
                  <Button
                    className="h-auto w-full justify-start whitespace-normal text-left"
                    onClick={() => s.selectHook(hook.hookId)}
                  >
                    {hook.label} · {presentHookTrigger(hook.trigger)} · {hook.enabled ? "Enabled" : "Disabled"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {hooks.length > limit ? (
            <Button onClick={() => setLimit((value) => value + 10)}>Show more hooks</Button>
          ) : null}
        </>
      ) : null}
      {s.view === "hook" && s.selectedHook ? (
        <section aria-label="Selected hook" className="space-y-3 rounded-md border border-line-subtle p-3">
          <h4 className="break-words text-md font-semibold">{s.selectedHook.label}</h4>
          <HookRecordEvidence hook={s.selectedHook} workspaceLabel={workspaceLabel} />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={s.mutation.locked || !s.selectedHook.enabled}
              onClick={() => s.reviewHook("test", s.selectedHook!)}
            >
              Review real test delivery
            </Button>
            <Button
              variant="danger"
              disabled={s.mutation.locked}
              onClick={() => s.reviewHook("delete", s.selectedHook!)}
            >
              Review hook deletion
            </Button>
          </div>
          <p className="text-xs text-fg-muted">
            Only completed post-event observers can be redriven. Inline control hooks never run again.
          </p>
        </section>
      ) : null}
      {s.view === "hook" || s.view === "history" ? (
        <section aria-label="Hook delivery history" className="space-y-3 rounded-md border border-line-subtle p-3">
          <h4 className="text-md font-semibold">Hook delivery history</h4>
          {s.data?.issues.some((issue) => issue.label === "Hook deliveries") ? (
            <p role="status">Delivery history is unavailable.</p>
          ) : (
            <>
              <p className="text-xs text-fg-muted">
                Showing at most {limit} of {plural(s.selectedRuns.length, "returned delivery", "returned deliveries")}.
                Payloads and remote response bodies stay in GoatCitadel's records.
              </p>
              <ul className="space-y-2">
                {s.selectedRuns.slice(0, limit).map((run) => (
                  <li key={run.runId}>
                    <Button
                      className="h-auto w-full justify-start whitespace-normal text-left"
                      onClick={() => s.setSelectedRunId(run.runId)}
                    >
                      {presentHookDeliveryStatus(run.status).label} · {presentHookTrigger(run.trigger)} · attempt{" "}
                      {run.attemptCount}
                    </Button>
                  </li>
                ))}
              </ul>
              {!s.selectedRuns.length ? (
                <p className="text-sm text-fg-muted">No retained deliveries returned.</p>
              ) : null}
              {s.selectedRuns.length > limit ? (
                <Button onClick={() => setLimit((value) => value + 10)}>Show more deliveries</Button>
              ) : null}
            </>
          )}
          {s.selectedRun ? (
            <>
              <HookRunEvidence run={s.selectedRun} workspaceLabel={workspaceLabel} />
              <Button
                disabled={s.mutation.locked || !s.selectedRunCanRedrive}
                onClick={() => s.reviewRedrive(s.selectedRun!)}
              >
                Review redrive selected delivery
              </Button>
            </>
          ) : null}
        </section>
      ) : null}
      <Dialog
        open={Boolean(s.review)}
        title={s.review?.title ?? "Review hook action"}
        description={s.review?.description}
        onOpenChange={(open) => {
          if (!open && !s.mutation.pending) s.cancelReview();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant={
              s.review &&
              (s.review.kind === "delete" ||
                (s.review.kind === "create" ? s.review.input.mode : s.review.hook.mode) !== "observe")
                ? "danger"
                : "primary"
            }
            disabled={s.mutation.locked}
            onClick={() => void s.confirmReview()}
          >
            Apply reviewed hook action
          </Button>
          <Button disabled={s.mutation.pending} onClick={s.cancelReview}>
            Cancel hook action
          </Button>
        </div>
      </Dialog>
      <UnsavedChangesDialog {...s.leave.dialogProps} />
    </section>
  );
}
