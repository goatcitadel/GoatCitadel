import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PermissionSurface } from "@goatcitadel/contracts";
import { fetchPermissionProfiles, fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { usePermissionProfileActivation } from "../../../features/native-routes/settings/use-permission-profile-activation";
import { profileCanBeSelected } from "../../../features/native-routes/settings/permission-activation-binding";
import { describeToolApprovalMode } from "../../../features/native-routes/settings/helpers/permission-helpers";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { PermissionProfileEditor } from "./PermissionProfileEditor";
import { LocalOperatorOverrides } from "./LocalOperatorOverrides";
import { readEffectivePermissionContexts } from "../../../features/native-routes/settings/effective-permission-contexts";
import { PERMISSION_CONTEXT_PRESENTATION } from "../../../features/native-routes/settings/sections/PermissionProfileDraftFields";
import { EffectivePermissionContexts } from "./EffectivePermissionContexts";
import { AutonomousGrantsSettings } from "./AutonomousGrantsSettings";

const PAGE_SIZE = 30;

/** Profile selection is a workspace Chat default, not a grant for any particular tool action. */
export function PermissionProfileSettings({ workspaceId }: { workspaceId: string }) {
  const [selectedId, setSelectedId] = useState("");
  const [surface, setSurface] = useState<PermissionSurface>("chat");
  const contextLabel = PERMISSION_CONTEXT_PRESENTATION[surface].label;
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const snapshot = useQuery({
    queryKey: ["settings", "permission-selection", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      const [profiles, effective, settings] = await Promise.all([
        fetchPermissionProfiles({ workspaceId }),
        readEffectivePermissionContexts(workspaceId),
        fetchSettings(),
      ]);
      return { profiles: profiles.items, effective, settings };
    },
  });
  const available = Boolean(workspaceId && snapshot.data && !snapshot.isError && !snapshot.isFetching);
  const profiles = snapshot.isError
    ? []
    : (snapshot.data?.profiles ?? []).filter((item) => profileCanBeSelected(item, workspaceId));
  const selected = profiles.find((item) => item.profileId === selectedId);
  const control = usePermissionProfileActivation({
    key: JSON.stringify([workspaceId, selectedId, surface]),
    workspaceId,
    profile: selected,
    available,
    deploymentProfile: snapshot.data?.settings.deploymentProfile,
    reload: () => snapshot.refetch(),
  });
  const filtered = profiles.filter((item) =>
    `${item.label} ${item.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const reviewed = control.review;
  return (
    <section
      id="permission-profile"
      aria-label="Chat permission profile"
      className="mt-4 space-y-3 rounded-lg border border-line bg-sunken p-4"
    >
      <header>
        <h3 className="font-display text-base font-semibold text-fg">Chat permission profile</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Choose an existing profile for a policy context in the selected workspace. Session-specific selections, hard
          denies, scoped grants, auth and path boundaries still apply.
        </p>
      </header>
      <Button
        size="sm"
        disabled={!workspaceId || snapshot.isFetching || control.pending}
        onClick={() => void snapshot.refetch()}
      >
        Refresh permission profiles
      </Button>
      {!workspaceId ? <p role="status">Select a workspace before reviewing permission profiles.</p> : null}
      {snapshot.isFetching ? (
        <p role="status" className="text-sm text-fg-muted">
          Reading current permission evidence…
        </p>
      ) : null}
      {snapshot.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {describeApiError(snapshot.error).summary}
        </p>
      ) : null}
      {snapshot.data && !snapshot.isError ? (
        <p className="text-sm text-fg-secondary">
          Current effective workspace Chat profile:{" "}
          <strong className="text-fg">
            {snapshot.data.effective.find((item) => item.surface === "chat")?.profileLabel ?? "Unavailable"}
          </strong>
        </p>
      ) : null}
      {available ? (
        <>
          <label className="block text-sm text-fg-secondary">
            Selection policy context
            <select
              aria-label="Selection policy context"
              value={surface}
              disabled={control.locked || control.reviewing}
              className="mt-1 min-h-10 w-full rounded border border-line bg-canvas px-3 text-fg"
              onChange={(event) => {
                control.clear();
                setSurface(event.target.value as PermissionSurface);
              }}
            >
              {(["chat", "tools", "mcp", "all"] as const).map((value) => (
                <option key={value} value={value}>
                  {PERMISSION_CONTEXT_PRESENTATION[value].label}
                </option>
              ))}
              <optgroup label="Legacy compatibility only">
                {(["cowork", "code"] as const).map((value) => (
                  <option key={value} value={value}>
                    {PERMISSION_CONTEXT_PRESENTATION[value].label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <p className="text-xs text-fg-muted">{PERMISSION_CONTEXT_PRESENTATION[surface].description}</p>
          <label className="block text-sm text-fg-secondary">
            Find permission profile
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(PAGE_SIZE);
              }}
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-fg"
            />
          </label>
          <p className="text-xs text-fg-muted">
            Showing {Math.min(limit, filtered.length)} of {filtered.length} eligible loaded profiles.
          </p>
          <ul className="space-y-2">
            {filtered.slice(0, limit).map((item) => (
              <li key={item.profileId} className="rounded-md border border-line-subtle bg-raised p-3">
                <label className="flex items-start gap-2 text-sm text-fg">
                  <input
                    type="radio"
                    name="workspace-chat-profile"
                    checked={selectedId === item.profileId}
                    disabled={control.locked || control.reviewing}
                    onChange={() => {
                      control.clear();
                      setSelectedId(item.profileId);
                    }}
                  />
                  <span className="min-w-0">
                    <strong className="break-words">{item.label}</strong>
                    <span className="mt-1 block break-words text-fg-secondary">
                      {item.description || describeToolApprovalMode(item.approvalMode)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Show more profiles
            </Button>
          ) : null}
          {!filtered.length ? <p className="text-sm text-fg-muted">No eligible profiles match this search.</p> : null}
          <Button
            variant="primary"
            disabled={!control.ready || control.locked || control.reviewing}
            onClick={() => void control.request(surface)}
          >
            Review {contextLabel} profile selection
          </Button>
        </>
      ) : null}
      {control.restriction ? (
        <p role="status" className="text-sm text-status-waiting">
          {control.restriction}
        </p>
      ) : null}
      {control.reviewing ? (
        <p role="status" className="text-sm text-fg-muted">
          Reviewing the current selection…
        </p>
      ) : null}
      {control.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {control.error}
        </p>
      ) : null}
      {control.notice ? (
        <p role={control.uncertain ? "alert" : "status"} className="text-sm text-fg-secondary">
          {control.notice}
        </p>
      ) : null}
      {reviewed?.profile ? (
        <div
          role="group"
          aria-label={`Reviewed ${contextLabel} profile selection`}
          className="space-y-3 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary"
        >
          <p>
            Apply <strong className="text-fg">{reviewed.profile.label}</strong> to {contextLabel} in the selected
            workspace?
          </p>
          <p>
            {describeToolApprovalMode(reviewed.profile.approvalMode)}. This selects saved policy; it does not approve a
            tool execution.
          </p>
          <dl className="grid gap-2 sm:grid-cols-2">
            {[
              ["Tool patterns", reviewed.profile.toolPatterns],
              ["Allow patterns", reviewed.profile.allow],
              ["Deny patterns", reviewed.profile.deny],
            ].map(([label, patterns]) => (
              <div key={String(label)}>
                <dt className="font-medium text-fg">{label}</dt>
                <dd className="break-words">
                  {(patterns as string[]).slice(0, 12).join(", ") || "None"}
                  {(patterns as string[]).length > 12 ? " · Additional rules in detailed settings" : ""}
                </dd>
              </div>
            ))}
          </dl>
          <p>
            {reviewed.activeProfiles.length} current explicit selection{reviewed.activeProfiles.length === 1 ? "" : "s"}{" "}
            in the reviewed scope.
          </p>
          <details>
            <summary>Reviewed identity</summary>
            <code className="block break-all font-mono">
              Workspace {reviewed.target.workspaceId} · Profile {reviewed.profile.profileId} · Selection revision{" "}
              {reviewed.revision}
            </code>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!available || control.locked} onClick={() => void control.confirm()}>
              Apply reviewed {contextLabel} profile
            </Button>
            <Button disabled={control.pending} onClick={control.clear}>
              Cancel selection
            </Button>
          </div>
        </div>
      ) : null}
      {snapshot.data && !snapshot.isError ? (
        <EffectivePermissionContexts contexts={snapshot.data.effective} refreshing={snapshot.isFetching} />
      ) : null}
      <PermissionProfileEditor
        workspaceId={workspaceId}
        profiles={snapshot.data?.profiles ?? []}
        available={available}
        deploymentProfile={snapshot.data?.settings.deploymentProfile}
        reload={() => snapshot.refetch()}
      />
      <LocalOperatorOverrides workspaceId={workspaceId} />
      <AutonomousGrantsSettings workspaceId={workspaceId} />
      <ClassicOwnerLink
        href="/settings/permissions?shell=classic"
        scope={workspaceId}
        label="Open classic permission settings"
      />
    </section>
  );
}
