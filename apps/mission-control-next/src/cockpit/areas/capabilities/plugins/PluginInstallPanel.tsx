import { useEffect, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { PluginSource } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { pluginDetailQuery, pluginInspectionQuery, pluginListQuery } from "../../../data/capability-plugins-query";
import { Button } from "../../../ui/Button";
import { Section } from "../../../ui/Section";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { CANT_BE_INSTALLED } from "./plugin-check-copy";
import { ClaudeCodeDetails, WhatHappensNext, WhatItIs, WhereItComesFrom, type ShownPlugin } from "./PluginInstallAbout";
import { PluginLeftOut } from "./PluginLeftOut";
import { PluginInstallProgress } from "./PluginInstallProgress";
import { PluginPieceList } from "./PluginPieceList";
import { PluginSourceForm } from "./PluginSourceForm";
import { PluginUninstall } from "./PluginUninstall";
import { signingSecretProblem } from "./plugin-install-view";
import {
  isDraftPluginInstallKey,
  isInspectionKey,
  pluginIdOfInstallKey,
  usePluginInstallEntry,
} from "./plugin-install-store";
import type { PluginSourceFormKind } from "./plugin-links";
import { shownOf, takePluginInstallMove, usePluginInstall, type PluginInstall } from "./use-plugin-install";

export interface PluginInstallPanelProps {
  /** `draft:<kind>` before a check answers, an inspection's id, or `plugin:<id>` for an install that has a record. */
  installKey: string;
  /** The form a source button opened, shown until its check answers. */
  form?: PluginSourceFormKind;
  /** The workspace an unfinished plugin was installed in, from its list row: its detail is read there. */
  pluginWorkspaceId?: string;
  /** Moves the panel to the key its flow moved to: a check's own, then the plugin's. */
  onMove: (target: string) => void;
}

/** A key named by the address that nothing here follows yet: read from the Gateway, or why it can't be. */
function ReadingLine({ query, what }: { query: UseQueryResult<unknown>; what: "check" | "plugin" }) {
  if (query.isError) {
    if (isApiRequestError(query.error) && query.error.status === 404) {
      return (
        <p className="text-fg">
          {what === "check" ? "This check can't be found anymore." : "This plugin isn't installed."}
        </p>
      );
    }
    return (
      <div className="space-y-2">
        <p className="text-fg">
          {what === "check" ? "This check couldn't be read." : "This plugin couldn't be read."}{" "}
          {describeApiError(query.error).summary}
        </p>
        <Button size="sm" loading={query.isFetching} loadingLabel="Trying…" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return <p className="text-fg-muted">{what === "check" ? "Reading the check…" : "Reading the plugin…"}</p>;
}

/** The ids, the full pin, the manifest's hash and the folder path as typed: for Technical details only. */
function SourceDetails({ plugin, source }: { plugin: ShownPlugin; source: PluginSource | undefined }) {
  return (
    <TechnicalDetails>
      <div className="space-y-1 font-mono">
        <p>{plugin.sourceDisplay}</p>
        {source?.kind === "folder" ? <p>{source.path}</p> : null}
        <p>{plugin.pin.kind === "commit" ? plugin.pin.commit : plugin.pin.treeSha256}</p>
        {plugin.manifestSha256 ? <p>{plugin.manifestSha256}</p> : null}
        <ClaudeCodeDetails plugin={plugin} />
      </div>
    </TechnicalDetails>
  );
}

/** What GoatCitadel's checks and the flow said in their own words and codes, for Technical details. */
function FlowDetails({ flow, plugin, installKey }: { flow: PluginInstall; plugin?: ShownPlugin; installKey: string }) {
  const technical = flow.state.phase === "check_failed" ? flow.state.technical : undefined;
  const blocked = (plugin?.pieces ?? []).flatMap((piece) =>
    piece.check.status === "blocked" ? [`${piece.pieceId}: ${piece.check.code}`] : [],
  );
  const inspectionId = plugin && "inspectionId" in plugin ? plugin.inspectionId : undefined;
  if (!plugin && !technical) return null;
  return (
    <TechnicalDetails>
      <div className="space-y-1 font-mono">
        {plugin?.pluginId ? <p>{plugin.pluginId}</p> : null}
        {inspectionId || isInspectionKey(installKey) ? <p>{inspectionId ?? installKey}</p> : null}
        {technical ? <p>{technical}</p> : null}
        {blocked.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </TechnicalDetails>
  );
}

/** "What it adds": each piece, and, for a check with a piece GoatCitadel's checks blocked, why it can't be installed. */
function WhatItAdds({
  plugin,
  blocked,
  secrets,
  onSecret,
}: {
  plugin: ShownPlugin;
  blocked: boolean;
  secrets?: Readonly<Record<string, string>>;
  onSecret?: (pieceId: string, value: string) => void;
}) {
  return (
    <Section title="What it adds" headingLevel={3}>
      <PluginPieceList pieces={plugin.pieces} {...(secrets && onSecret ? { secrets, onSecret } : {})} />
      {blocked ? <p className="mt-2">{CANT_BE_INSTALLED}</p> : null}
    </Section>
  );
}

/**
 * The signing secrets typed for the hook pieces of a check that can be installed, held in the panel's own state only.
 * Install sends one per hook; once the request answers they are dropped, and with no answer they stay, for a retry
 * under the same attempt key.
 */
function useHookSecrets(flow: PluginInstall) {
  const [values, setValues] = useState<Record<string, string>>({});
  const { state } = flow;
  const ids =
    state.phase === "ready" && state.inspection.installable
      ? state.inspection.pieces.flatMap((piece) => (piece.needsSecret ? [piece.pieceId] : []))
      : [];
  return {
    ids,
    values,
    set: (id: string, value: string) => setValues((all) => ({ ...all, [id]: value })),
    ready: ids.every((id) => signingSecretProblem(values[id] ?? "") === undefined),
    install: () => {
      const sent = Object.fromEntries(ids.map((id) => [id, values[id] ?? ""]));
      void flow.confirm(sent).then((spent) => {
        if (spent) setValues({});
      });
    },
  };
}

/**
 * The install panel, in the inspector: it checks a source, shows what the plugin is, where it comes from and what it
 * adds, then installs every piece from one confirmation, with each approval in place when the operator's skip setting
 * is off, and goes on through each skill's two steps. The flow lives in a store, so closing the panel loses nothing;
 * after a reload, the Gateway's inspection or the plugin's detail is the truth. Every check, state and refusal is the
 * Gateway's; the panel only words them.
 */
export function PluginInstallPanel({ installKey, form, pluginWorkspaceId, onMove }: PluginInstallPanelProps) {
  const { flow, refused, inspectionKey, inspectionRead, detailRead } = usePanelFlow(installKey, pluginWorkspaceId);

  useEffect(() => {
    if (!flow.movedTo) return;
    const target = takePluginInstallMove(installKey);
    if (target) onMove(target);
  }, [flow.movedTo, installKey, onMove]);

  const { state } = flow;
  const shown = shownOf(state);
  if (form && !shown && !refused) {
    return (
      <PluginSourceForm
        kind={form}
        checking={state.phase === "checking"}
        error={state.phase === "check_failed" ? state.message : undefined}
        onCheck={flow.inspect}
      />
    );
  }
  if (state.phase === "idle") {
    if (isDraftPluginInstallKey(installKey)) return null;
    return (
      <ReadingLine query={inspectionKey ? inspectionRead : detailRead} what={inspectionKey ? "check" : "plugin"} />
    );
  }
  const plugin = shown ?? (refused ? inspectionRead.data : undefined);
  return <PluginInstallBody flow={flow} installKey={installKey} offerCheckAgain={!form} plugin={plugin} />;
}

/** The panel's flow, with the Gateway reads that seed it: the check an address names, or the plugin's detail. */
function usePanelFlow(installKey: string, pluginWorkspaceId: string | undefined) {
  const { activeWorkspaceId } = useUiPreferences();
  const entry = usePluginInstallEntry(installKey);
  const pluginId = pluginIdOfInstallKey(installKey);
  const inspectionKey = isInspectionKey(installKey);
  const refused = entry?.state.phase === "check_failed" && entry.state.inspectionId === installKey;
  // Read only for a key nothing here follows yet (an address after a reload), and for a refused manifest's source.
  const inspectionRead = useQuery({
    ...pluginInspectionQuery(installKey),
    enabled: inspectionKey && (!entry || refused),
  });
  // An install this session saw finish or stop is read again whenever its panel opens: a skill may have been switched
  // off since, and then the Gateway reads it as not finished.
  const ended = entry?.state.phase === "done" || entry?.state.phase === "failed";
  const shownDetail = entry && "detail" in entry.state ? entry.state.detail : undefined;
  const detailRead = useQuery({
    ...pluginDetailQuery(pluginWorkspaceId ?? shownDetail?.workspaceId ?? activeWorkspaceId, pluginId ?? ""),
    enabled: pluginId !== undefined && (!entry || ended),
  });
  const flow = usePluginInstall(installKey, {
    inspection: inspectionRead.data,
    // Only a read made after the install ended replaces what the session holds; an older answer in the cache can't.
    detail: !entry || (ended && detailRead.dataUpdatedAt > (entry.endedAt ?? 0)) ? detailRead.data : undefined,
    reread: ended,
  });
  return { flow, refused, inspectionKey, inspectionRead, detailRead };
}

/**
 * What the panel shows once there is something to show: the plugin's sections, what happens next, where the install
 * stands and the technical details. A hook's signing secret lives here, in the panel's own state, until the install
 * request answers.
 */
function PluginInstallBody({
  flow,
  installKey,
  offerCheckAgain,
  plugin,
}: {
  flow: PluginInstall;
  installKey: string;
  /** Without a source form of its own, the panel checks its source again from a button. */
  offerCheckAgain: boolean;
  plugin: ShownPlugin | undefined;
}) {
  const { activeWorkspaceId } = useUiPreferences();
  // Whether the operator's skip applies, for "What happens next"; unknown when the list can't be read.
  const skip = useQuery(pluginListQuery(activeWorkspaceId)).data?.operatorApprovalSkip;
  const secrets = useHookSecrets(flow);
  const { state, source } = flow;
  return (
    <div className="space-y-4 text-sm text-fg-secondary">
      {plugin?.name ? <WhatItIs plugin={plugin} /> : null}
      {plugin ? (
        <WhereItComesFrom plugin={plugin}>
          <SourceDetails plugin={plugin} source={source} />
        </WhereItComesFrom>
      ) : null}
      {plugin && plugin.pieces.length > 0 ? (
        <WhatItAdds
          plugin={plugin}
          blocked={state.phase === "ready" && !state.inspection.installable}
          {...(secrets.ids.length > 0 ? { secrets: secrets.values, onSecret: secrets.set } : {})}
        />
      ) : null}
      {/* Before what happens next, and above a refusal's lines: what GoatCitadel leaves out of a Claude Code plugin. */}
      {plugin ? <PluginLeftOut ignored={plugin.ignored} /> : null}
      {state.phase === "ready" ? <WhatHappensNext inspection={state.inspection} skip={skip} /> : null}
      <PluginInstallProgress
        flow={flow}
        name={plugin?.name || "this plugin"}
        secretsReady={secrets.ready}
        onInstall={secrets.install}
        {...(offerCheckAgain && source ? { onCheckAgain: () => flow.inspect(source) } : {})}
      />
      {/* A stopped install that left a record can only be cleaned up by uninstalling it, which is offered here. */}
      {state.phase === "failed" && state.detail ? <PluginUninstall detail={state.detail} /> : null}
      <FlowDetails flow={flow} installKey={installKey} {...(plugin ? { plugin } : {})} />
    </div>
  );
}
