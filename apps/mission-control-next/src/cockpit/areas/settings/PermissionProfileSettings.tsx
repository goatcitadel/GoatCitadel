import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PermissionSurface } from "@goatcitadel/contracts";
import { fetchPermissionProfiles, fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { usePermissionProfileActivation } from "../../../features/native-routes/settings/use-permission-profile-activation";
import { profileCanBeSelected } from "../../../features/native-routes/settings/permission-activation-binding";
import { describeToolApprovalMode } from "../../../features/native-routes/settings/helpers/permission-helpers";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { StatusBadge } from "../../ui/StatusBadge";
import { PermissionProfileEditor } from "./PermissionProfileEditor";
import { LocalOperatorOverrides } from "./LocalOperatorOverrides";
import { readEffectivePermissionContexts } from "../../../features/native-routes/settings/effective-permission-contexts";
import { PERMISSION_CONTEXT_PRESENTATION } from "../../../features/native-routes/settings/sections/PermissionProfileDraftFields";
import { EffectivePermissionContexts } from "./EffectivePermissionContexts";
import { AutonomousGrantsSettings } from "./AutonomousGrantsSettings";
import { RulesPrecedenceExplainer } from "./RulesPrecedence";

/** Current policy contexts. Legacy Cowork and Code keys stay readable under Advanced but are not offered here. */
const SELECTABLE_CONTEXTS = ["chat", "tools", "mcp", "all"] as const;

const PAGE_SIZE = 30;

/** Profile selection is a workspace Chat default, not a grant for any particular tool action. */
export function PermissionProfileSettings({ workspaceId }: { workspaceId: string }) {
  const [selectedId, setSelectedId] = useState("");
  const [surface, setSurface] = useState<PermissionSurface>("chat");
  const contextLabel = PERMISSION_CONTEXT_PRESENTATION[surface].label;
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [changing, setChanging] = useState(false);
  const changeButton = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLSelectElement>(null);
  const focusAfterToggle = useRef(false);
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
  const effectiveProfileId = snapshot.isError
    ? undefined
    : snapshot.data?.effective.find((item) => item.surface === surface)?.profileId;
  const shownProfileId = selectedId || effectiveProfileId || "";
  // Re-selecting the profile already in effect is not a change to review.
  const selected =
    selectedId && selectedId !== effectiveProfileId
      ? profiles.find((item) => item.profileId === selectedId)
      : undefined;
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
  // Opening the choices moves focus to the first choice; closing them returns focus to the Change button.
  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (changing ? firstChoice.current : changeButton.current)?.focus();
  }, [changing]);
  const toggleChanging = (next: boolean) => {
    control.clear();
    if (!next) {
      setSelectedId("");
      setSurface("chat");
    }
    focusAfterToggle.current = true;
    setChanging(next);
  };
  return (
    <section
      id="permission-profile"
      aria-label="Chat permission profile"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <header>
        <h3 className="text-base font-semibold text-fg">Chat permission profile</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          The profile sets which tools Chat can use in this workspace. Deny rules, tool grants, sign-in and path limits
          still apply.
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
          Loading permissions…
        </p>
      ) : null}
      {snapshot.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {describeApiError(snapshot.error).summary}
        </p>
      ) : null}
      {snapshot.data && !snapshot.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-secondary">
            Current effective workspace Chat profile:{" "}
            <strong className="text-fg">
              {snapshot.data.effective.find((item) => item.surface === "chat")?.profileLabel ?? "Unavailable"}
            </strong>
          </p>
          <Button
            ref={changeButton}
            size="sm"
            aria-expanded={changing}
            disabled={control.pending}
            onClick={() => toggleChanging(!changing)}
          >
            {changing ? "Close profile choices" : "Change profile"}
          </Button>
        </div>
      ) : null}
      {available && changing ? (
        <>
          <Field label="Selection policy context" help={PERMISSION_CONTEXT_PRESENTATION[surface].description}>
            {(fieldProps) => (
              <select
                {...fieldProps}
                ref={firstChoice}
                value={surface}
                disabled={control.locked || control.reviewing}
                className={cockpitInputClass}
                onChange={(event) => {
                  control.clear();
                  setSurface(event.target.value as PermissionSurface);
                }}
              >
                {SELECTABLE_CONTEXTS.map((value) => (
                  <option key={value} value={value}>
                    {PERMISSION_CONTEXT_PRESENTATION[value].label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Find permission profile">
            {(fieldProps) => (
              <input
                {...fieldProps}
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(PAGE_SIZE);
                }}
                className={cockpitInputClass}
              />
            )}
          </Field>
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
                    value={item.profileId}
                    checked={shownProfileId === item.profileId}
                    disabled={control.locked || control.reviewing}
                    onChange={() => {
                      control.clear();
                      setSelectedId(item.profileId);
                    }}
                  />
                  <span className="min-w-0">
                    <strong className="break-words">{item.label}</strong>
                    {item.profileId === effectiveProfileId ? (
                      <StatusBadge className="ml-2" status={{ label: "Current", tone: "done" }} />
                    ) : null}
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
            disabled={!selected || !control.ready || control.locked || control.reviewing}
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
          <p>{plural(reviewed.activeProfiles.length, "current explicit selection")} in the reviewed scope.</p>
          <TechnicalDetails label="Reviewed identity">
            <code className="block break-all font-mono">
              Workspace {reviewed.target.workspaceId} · Profile {reviewed.profile.profileId} · Selection version{" "}
              {reviewed.revision}
            </code>
          </TechnicalDetails>
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
      <RulesPrecedenceExplainer />
      {/* Expert detail stays mounted, so drafts and reviews survive, but it is collapsed until asked for. */}
      <details className="border-t border-line-subtle pt-4">
        <summary className="cursor-pointer text-sm font-medium text-fg">
          Advanced: policy contexts, profiles, temporary overrides and autonomous grants
        </summary>
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
      </details>
    </section>
  );
}
