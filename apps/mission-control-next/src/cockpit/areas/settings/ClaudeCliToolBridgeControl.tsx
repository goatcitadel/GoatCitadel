import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSettings, isApiRequestError, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import {
  settingsChangeIsConfirmed,
  useSettingsChange,
} from "../../../features/native-routes/settings/use-settings-change";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { ApprovedSettingsContinuation } from "./ApprovedSettingsContinuation";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { presentChangeStatusLabel } from "./settings-vocabulary";

export const CLAUDE_CLI_TOOL_BRIDGE_ANCHOR = "claude-cli-tool-bridge";
const FLAG = "claudeCliToolBridgeEnabled";
/**
 * What the switch changes today. Tools run in the Gateway's governed runner, and every tool step
 * is its own `claude -p` run, so the copy must not suggest Claude Code runs or isolates the tools.
 */
const BRIDGE_FACTS = [
  "Tools run in GoatCitadel, not inside Claude Code. Your permissions, tool grants and approvals still decide what may run.",
  "Each tool step is a separate claude -p run with your own Claude sign-in, so a turn that uses tools counts more against your Claude subscription.",
  "Tools are not sandboxed by this setting. It is a GoatCitadel option, not an Anthropic feature.",
];
const onOff = (value: boolean) => (value ? "On" : "Off");

export function ClaudeCliToolBridgeControl() {
  const route = useCockpitRoute();
  const parameters = new URLSearchParams(route.search);
  parameters.delete("shell");
  parameters.delete("shellScope");
  const recoveryHref = `/settings/models${parameters.size ? `?${parameters}` : ""}#${CLAUDE_CLI_TOOL_BRIDGE_ANCHOR}`;
  const settings = useQuery({
    queryKey: ["system", "settings-claude-cli-tool-bridge"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const saved = settings.data?.features?.[FLAG];
  const current = saved === true;
  const ready = Boolean(
    settings.data &&
    !settings.isError &&
    typeof saved === "boolean" &&
    Number.isSafeInteger(settings.data.revision) &&
    settings.data.revision > 0,
  );
  const draft = useSessionDraft("features:system:claude-cli-tool-bridge", current, settings.data?.revision, {
    label: "Claude Code CLI tools",
    available: ready,
    onSave: () => save(),
  });
  const change = useSettingsChange<boolean>({
    key: draft.key,
    operation: "feature_flag",
    matchesPlan: (plan, submitted) =>
      plan.kind === "runtime_configuration" &&
      plan.request.kind === "runtime_configuration" &&
      plan.request.change.operation === "feature_flag" &&
      plan.request.change.flag === FLAG &&
      plan.request.change.enabled === submitted &&
      plan.target.ownerId === "runtime_settings",
    matches: (savedSettings, submitted) => savedSettings.features?.[FLAG] === submitted,
    acceptSaved: draft.acceptSaved,
    reload: () => settings.refetch(),
  });
  const [busy, setBusy] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [notice, setNotice] = useState<{ tone: "done" | "waiting" | "failed"; message: string } | null>(null);
  const confirmed = settingsChangeIsConfirmed(change.change);

  async function save(): Promise<boolean> {
    if (
      !ready ||
      !settings.data ||
      settings.isFetching ||
      draft.hasRemoteChanges ||
      !draft.isDirty ||
      outcomeUncertain ||
      !change.beginSave()
    )
      return false;
    setBusy(true);
    setNotice(null);
    const submitted = draft.value;
    const baseRevision = Number(draft.baseRevision);
    let mutationAttempted = false;
    try {
      const latest = await fetchSettings();
      if (latest.revision !== baseRevision || latest.features?.[FLAG] !== current) {
        await settings.refetch();
        setNotice({
          tone: "waiting",
          message:
            "Settings changed. Your draft started from an older version. Review the current setting, then apply your draft to the latest version before retrying.",
        });
        return false;
      }
      mutationAttempted = true;
      const response = await patchSettings({ expectedRevision: baseRevision, features: { [FLAG]: submitted } });
      const accepted = change.receive(response, submitted, baseRevision);
      setNotice({
        tone: accepted ? "done" : "waiting",
        message: accepted ? "Setting saved." : "Change submitted. Review its Gateway status before another save.",
      });
      await settings.refetch();
      return accepted;
    } catch (error) {
      if (isApiRequestError(error) && error.status === 409) {
        await settings.refetch();
        setNotice({ tone: "waiting", message: "Settings changed elsewhere. Your draft is preserved for review." });
      } else {
        if (mutationAttempted) setOutcomeUncertain(true);
        setNotice({
          tone: "failed",
          message: mutationAttempted
            ? `Save outcome is uncertain. Inspect Settings activity before another request. ${describeApiError(error).summary}`
            : `Could not confirm current settings. ${describeApiError(error).summary}`,
        });
      }
      return false;
    } finally {
      change.endSave();
      setBusy(false);
    }
  }

  const locked = busy || change.hasPending || outcomeUncertain;
  return (
    <section
      id={CLAUDE_CLI_TOOL_BRIDGE_ANCHOR}
      aria-labelledby="claude-cli-tool-bridge-title"
      className="mt-4 border-t border-line-subtle pt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="claude-cli-tool-bridge-title" className="text-md font-semibold text-fg">
            Claude Code CLI: let it use GoatCitadel tools
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Experimental and off by default. When on, Chat turns on the Claude Code CLI provider can ask for GoatCitadel
            tools.
          </p>
        </div>
        <Button
          size="sm"
          disabled={settings.isFetching || busy}
          onClick={() => {
            void settings.refetch();
            if (change.change) void change.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {settings.isLoading ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          Loading setting…
        </p>
      ) : null}
      {settings.isError ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {describeApiError(settings.error).summary}
        </p>
      ) : null}
      {settings.data && !settings.isError && !ready ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          Gateway did not report this setting. Refresh, or update the Gateway, before changing it.
        </p>
      ) : null}
      {ready ? (
        <>
          <p className="mt-3 text-xs text-fg-muted">Current: {onOff(current)}</p>
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">
              features.{FLAG} · Settings version {settings.data?.revision}
            </p>
          </TechnicalDetails>
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={draft.value}
              aria-describedby="claude-cli-tool-bridge-facts"
              disabled={locked}
              onChange={(event) => {
                setNotice(null);
                draft.setValue(event.target.checked);
              }}
            />
            Let the Claude Code CLI use GoatCitadel tools
          </label>
          <ul id="claude-cli-tool-bridge-facts" className="mt-2 list-inside list-disc space-y-1 text-xs text-fg-muted">
            {BRIDGE_FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          {draft.isDirty ? (
            <p role="status" className="mt-2 text-xs text-status-waiting">
              Unsaved draft: {onOff(draft.value)}
            </p>
          ) : null}
          {draft.hasRemoteChanges ? (
            <div role="status" className="mt-2 space-y-2 text-sm text-fg-secondary">
              <p>The saved setting changed after this draft began. Current: {onOff(current)}.</p>
              <Button size="sm" onClick={draft.rebaseToCurrent}>
                Apply draft to latest version
              </Button>
            </div>
          ) : null}
          <Button
            variant="primary"
            className="mt-3"
            disabled={!draft.isDirty || draft.hasRemoteChanges || settings.isFetching || locked}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save setting"}
          </Button>
        </>
      ) : null}
      {change.change ? (
        <div className="mt-3 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
          <p role="status">
            <strong className="text-fg">{presentChangeStatusLabel(change.change.receipt.status)}</strong> ·{" "}
            {change.change.message}
          </p>
          {change.change.error ? (
            <p role="alert" className="mt-1 text-status-failed">
              {change.change.error}
            </p>
          ) : null}
          {change.change.blocking ? (
            <p className="mt-1">The draft remains unsaved until the Gateway confirms the change.</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void change.refresh()}>
              Refresh change status
            </Button>
            {change.change.receipt.requiredAction?.kind === "approval" && !confirmed ? (
              <SettingsApprovalOwnerAction
                plan={change.change.plan}
                receipt={change.change.receipt}
                owner="claude-cli-tool-bridge"
                workspaceId="default"
                viewIdentity={draft.key}
                label="Review approval"
              />
            ) : null}
          </div>
          {!confirmed ? <ApprovedSettingsContinuation plan={change.change.plan} onSettled={change.refresh} /> : null}
        </div>
      ) : null}
      {notice && !(confirmed && notice.message.startsWith("Change submitted.")) ? (
        <p
          role={notice.tone === "failed" ? "alert" : "status"}
          className={`mt-3 text-sm ${notice.tone === "failed" ? "text-status-failed" : notice.tone === "waiting" ? "text-status-waiting" : "text-status-done"}`}
        >
          {notice.message}
        </p>
      ) : null}
      {outcomeUncertain ? (
        <NativeOwnerLink
          href={recoveryHref}
          scope={[draft.key, change.change?.receipt.planId, change.change?.receipt.revision]}
          className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
        >
          Inspect Claude Code CLI tool setting activity
        </NativeOwnerLink>
      ) : null}
    </section>
  );
}
