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
import { Button } from "../../ui/Button";

const inputClass = "mt-1 min-h-10 w-full rounded border border-line bg-canvas px-2 text-sm text-fg";
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
      aria-label="Temporary Local Operator Overrides"
      className="mt-4 space-y-3 rounded-lg border border-line bg-sunken p-4"
    >
      <h3 className="font-display text-base font-semibold">Temporary Local Operator Overrides</h3>
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
        <label className="block">
          Override scope
          <select
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
            <option value="workspace">Selected workspace</option>
            <option value="session">Exact session</option>
            <option value="run">Exact run</option>
            <option value="operator">This operator across workspaces</option>
          </select>
        </label>
        {editor.value.scope !== "operator" ? (
          <label className="block">
            Override target
            <input
              className={inputClass}
              value={editor.value.scope === "workspace" ? workspaceId : editor.value.scopeRef}
              readOnly={editor.value.scope === "workspace"}
              onChange={(event) => change((old) => ({ ...old, scopeRef: event.target.value }))}
            />
          </label>
        ) : null}
        <label className="block">
          Override reason
          <textarea
            className={inputClass}
            value={editor.value.reason}
            onChange={(event) => change((old) => ({ ...old, reason: event.target.value }))}
          />
        </label>
        <label className="block">
          Override duration in seconds
          <input
            className={inputClass}
            type="number"
            min={60}
            max={3600}
            value={editor.value.ttlSeconds}
            onChange={(event) => change((old) => ({ ...old, ttlSeconds: Number(event.target.value) }))}
          />
        </label>
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
        The Gateway API does not provide override revision checks. Reviews re-read current settings and active
        overrides; the database owns the expiry window. No tools run as part of this action.
      </p>
      {attempt ? <p role={attempt.phase === "uncertain" ? "alert" : "status"}>{attempt.message}</p> : null}
      {control.message ? <p role="status">{control.message}</p> : null}
      {control.checking ? <p role="status">Reading the override owner…</p> : null}
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
            <li key={item.overrideId} className="rounded border border-line p-3 text-sm">
              <p>{item.reason}</p>
              <p>
                {item.scope} · Expires {new Date(item.expiresAt).toLocaleString()}
              </p>
              <details>
                <summary>Override identity</summary>
                <p className="break-all font-mono text-xs">
                  {item.overrideId} · {item.scopeRef ?? item.operatorId}
                </p>
              </details>
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
