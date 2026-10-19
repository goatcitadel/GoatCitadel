import { useQuery } from "@tanstack/react-query";
import { useState, type SetStateAction } from "react";
import type { LocalOperatorOverrideScope } from "@goatcitadel/contracts";
import { fetchActiveLocalOperatorOverrides, fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { resolveLocalOperatorOverrideScopeRef } from "../../../features/native-routes/settings/helpers/permission-helpers";
import { usePermissionManagement } from "../../../features/native-routes/settings/use-permission-management";
import { PermissionManagementReview } from "../../../features/native-routes/settings/PermissionManagementReview";
import type { PermissionManagementOperation } from "../../../features/native-routes/settings/permission-management-binding";
import { formatSeconds, plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass as inputClass } from "../../ui/input-class";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";

const OVERRIDE_SCOPE_LABELS: Record<LocalOperatorOverrideScope, string> = {
  workspace: "Selected workspace",
  session: "Exact session",
  run: "Exact run",
  operator: "This operator across workspaces",
};

/** The Gateway accepts 60–3600 seconds; offering whole minutes inside that range leaves nothing to mistype. */
const OVERRIDE_MINUTES = [1, 5, 10, 15, 30, 60] as const;
const durationLabel = (seconds: number) =>
  seconds % 60 === 0 ? plural(seconds / 60, "minute") : formatSeconds(seconds);
export function LocalOperatorOverrides({ workspaceId }: { workspaceId: string }) {
  const snapshot = useQuery({
    queryKey: ["settings", "local-operator-overrides", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const [overrides, settings] = await Promise.all([fetchActiveLocalOperatorOverrides(), fetchSettings()]);
      return { overrides: overrides.items, settings };
    },
  });
  const [acknowledged, setAcknowledged] = useState(false);
  const [limit, setLimit] = useState(30);
  const empty = {
    scope: "workspace" as LocalOperatorOverrideScope,
    scopeRef: workspaceId,
    reason: "",
    ttlSeconds: 600,
  };
  const editor = useSessionDraft(`permission-override:${workspaceId}:new`, empty, undefined, {
    label: "Temporary override",
  });
  const control = usePermissionManagement({
    workspaceId,
    identity: JSON.stringify([editor.value, acknowledged]),
    reload: () => snapshot.refetch(),
  });
  const operation: PermissionManagementOperation = {
    kind: "override-create",
    input: {
      ...editor.value,
      reason: editor.value.reason.trim(),
      scopeRef: resolveLocalOperatorOverrideScopeRef(editor.value.scope, editor.value.scopeRef, workspaceId),
    },
  };
  const attempt = control.attemptFor(operation);
  const available = Boolean(workspaceId && snapshot.data && !snapshot.isError && !snapshot.isFetching);
  const restricted =
    !snapshot.data?.settings.deploymentProfile || snapshot.data.settings.deploymentProfile === "remote_hardened";
  function change(value: SetStateAction<typeof editor.value>) {
    control.invalidate();
    setAcknowledged(false);
    editor.setValue(value);
  }
  return (
    <section
      id="local-operator-overrides"
      aria-label="Temporary local operator overrides"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <h3 className="text-base font-semibold">Temporary local operator overrides</h3>
      <p className="text-sm text-fg-secondary">
        A time-limited override grants broad local tool access and skips normal prompts. Hard denies, auth, path jails,
        network blocks, disabled capabilities and Code Mode checks remain enforced.
      </p>
      <Button size="sm" disabled={snapshot.isFetching} onClick={() => void snapshot.refetch()}>
        Refresh temporary overrides
      </Button>
      {snapshot.isError ? <p role="alert">{describeApiError(snapshot.error).summary}</p> : null}
      {restricted ? (
        <p role="status">Starting overrides is unavailable until deployment settings permit local overrides.</p>
      ) : null}
      <fieldset disabled={!available || restricted || Boolean(attempt)} className="space-y-3">
        <legend>New temporary override{editor.isDirty ? " · Unsaved" : ""}</legend>
        <Field label="Override scope">
          {(fieldProps) => (
            <select
              {...fieldProps}
              className={inputClass}
              value={editor.value.scope}
              onChange={(event) =>
                change((old) => ({
                  ...old,
                  scope: event.target.value as LocalOperatorOverrideScope,
                  scopeRef: event.target.value === "workspace" ? workspaceId : "",
                }))
              }
            >
              {(["workspace", "session", "run", "operator"] as const).map((scope) => (
                <option key={scope} value={scope}>
                  {OVERRIDE_SCOPE_LABELS[scope]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {editor.value.scope !== "operator" ? (
          <Field label="Override target">
            {(fieldProps) => (
              <input
                {...fieldProps}
                className={inputClass}
                value={editor.value.scope === "workspace" ? workspaceId : editor.value.scopeRef}
                readOnly={editor.value.scope === "workspace"}
                onChange={(event) => change((old) => ({ ...old, scopeRef: event.target.value }))}
              />
            )}
          </Field>
        ) : null}
        <Field label="Override reason" required>
          {(fieldProps) => (
            <textarea
              {...fieldProps}
              className={inputClass}
              value={editor.value.reason}
              onChange={(event) => change((old) => ({ ...old, reason: event.target.value }))}
            />
          )}
        </Field>
        <Field label="Override duration" help="The override ends on its own after this time.">
          {(fieldProps) => (
            <select
              {...fieldProps}
              className={inputClass}
              value={editor.value.ttlSeconds}
              onChange={(event) => change((old) => ({ ...old, ttlSeconds: Number(event.target.value) }))}
            >
              {/* A draft saved before minutes were offered keeps its own value until it is changed. */}
              {OVERRIDE_MINUTES.some((minutes) => minutes * 60 === editor.value.ttlSeconds) ? null : (
                <option value={editor.value.ttlSeconds}>{durationLabel(editor.value.ttlSeconds)}</option>
              )}
              {OVERRIDE_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes * 60}>
                  {durationLabel(minutes * 60)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => {
              control.invalidate();
              setAcknowledged(event.target.checked);
            }}
          />
          I understand this grants broad local tool access and skips normal prompts for the reviewed scope and duration.
        </label>
        <Button
          disabled={!acknowledged || control.checking || !editor.value.reason.trim()}
          onClick={() => {
            const submitted = editor.value;
            void control.request(operation, () => editor.acceptSaved(empty, undefined, submitted));
          }}
        >
          Review temporary override
        </Button>
      </fieldset>
      <p className="text-xs text-fg-muted">
        Reviews read current settings and active overrides again, but changes made in the meantime are not blocked. The
        saved expiry time decides when an override ends. No tools run as part of this action.
      </p>
      {attempt ? <p role={attempt.phase === "uncertain" ? "alert" : "status"}>{attempt.message}</p> : null}
      {control.message ? <p role="status">{control.message}</p> : null}
      {control.checking ? <p role="status">Checking saved overrides…</p> : null}
      <PermissionManagementReview
        control={control}
        renderButton={({ label, secondary, ...props }) => (
          <Button variant={secondary ? "secondary" : "primary"} {...props}>
            {label}
          </Button>
        )}
      />
      <h4 className="font-semibold">Active overrides for this operator</h4>
      {!snapshot.isError ? (
        <ul className="space-y-3">
          {snapshot.data?.overrides.slice(0, limit).map((item) => (
            <li key={item.overrideId} className="rounded-md border border-line p-3 text-sm">
              <p>{item.reason}</p>
              <p>
                {OVERRIDE_SCOPE_LABELS[item.scope] ?? "Unknown scope"} ·{" "}
                <TimeText absolute prefix="Expires" value={item.expiresAt} />
              </p>
              <TechnicalDetails label="Override identity">
                <p className="break-all font-mono text-xs">
                  {item.overrideId} · {item.scope} · {item.scopeRef ?? item.operatorId}
                </p>
              </TechnicalDetails>
              <Button
                size="sm"
                disabled={!available || Boolean(attempt) || control.checking}
                onClick={() => void control.request({ kind: "override-revoke", override: item })}
              >
                Review ending override
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot.data?.overrides.length === 0 ? (
        <p className="text-sm text-fg-muted">No active overrides returned by the Gateway.</p>
      ) : null}
      {(snapshot.data?.overrides.length ?? 0) > limit ? (
        <Button size="sm" onClick={() => setLimit((value) => value + 30)}>
          Show more temporary overrides
        </Button>
      ) : null}
    </section>
  );
}
