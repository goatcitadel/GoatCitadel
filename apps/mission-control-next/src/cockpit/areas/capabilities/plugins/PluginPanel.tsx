import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CapabilityPluginDetail, CapabilityPluginListItem } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { pluginDetailQuery, pluginListQuery } from "../../../data/capability-plugins-query";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { WhatItIs, WhereItComesFrom } from "./PluginInstallAbout";
import { PluginUninstall } from "./PluginUninstall";
import { PLUGIN_PIECE_KIND_LABELS, presentPieceState } from "./plugin-install-view";
import { usePluginUninstallEntry } from "./plugin-uninstall-store";
import { PLUGIN_TRUST_LABELS, presentPluginState } from "./plugin-view";

const NOT_INSTALLED = "This plugin isn't installed.";

export interface PluginPanelProps {
  pluginId: string;
  /** A built-in plugin's Install, from the panel of one that isn't installed yet. */
  onInstall: (item: CapabilityPluginListItem) => void;
}

/**
 * One plugin's panel, in the inspector, at `?item=plugin:<id>`. A built-in plugin that isn't installed shows from the
 * list the tab keeps, with Install, and nothing else is read. An installed plugin shows its detail: what it is, where
 * it comes from, what it added (each piece with its state and the link GoatCitadel wrote for it), Uninstall, and the
 * ids, the full pin and the manifest's hash in Technical details. Every state and link is GoatCitadel's.
 */
export function PluginPanel({ pluginId, onInstall }: PluginPanelProps) {
  const { activeWorkspaceId } = useUiPreferences();
  // The tab keeps the list; the panel follows its cache entry and never reads it itself.
  const list = useQuery({ ...pluginListQuery(activeWorkspaceId), enabled: false }).data;
  const installed = list?.installed.find((item) => item.pluginId === pluginId);
  const builtIn = installed ? undefined : list?.builtIn.find((item) => item.pluginId === pluginId);
  if (builtIn) return <AvailableBuiltIn item={builtIn} onInstall={onInstall} />;
  return <InstalledPlugin pluginId={pluginId} workspaceId={installed?.workspaceId ?? activeWorkspaceId} />;
}

/** A built-in plugin not installed yet, from the cached list alone: it has no detail to read. */
function AvailableBuiltIn({
  item,
  onInstall,
}: {
  item: CapabilityPluginListItem;
  onInstall: (item: CapabilityPluginListItem) => void;
}) {
  return (
    <div className="space-y-4 text-sm text-fg-secondary">
      <StatusBadge status={presentPluginState(item)} />
      <WhatItIs plugin={item} />
      <Section title="Where it comes from" headingLevel={3}>
        <div className="space-y-1">
          <p>{item.sourceDisplay}</p>
          <p>{PLUGIN_TRUST_LABELS[item.trust]}</p>
        </div>
      </Section>
      {/* The name comes last so the accessible name starts with the visible word. */}
      <Button variant="primary" aria-label={`Install ${item.name}`} onClick={() => onInstall(item)}>
        Install
      </Button>
    </div>
  );
}

function InstalledPlugin({ pluginId, workspaceId }: { pluginId: string; workspaceId: string }) {
  const read = useQuery(pluginDetailQuery(workspaceId, pluginId));
  const uninstall = usePluginUninstallEntry(pluginId);
  if (uninstall?.phase === "gone") return <p className="text-sm text-fg">{NOT_INSTALLED}</p>;
  if (!read.data) return <DetailReadLine read={read} />;
  return <PluginDetailView detail={read.data} />;
}

/** The detail on its way, why it can't be read, or that the plugin isn't installed. */
function DetailReadLine({ read }: { read: UseQueryResult<CapabilityPluginDetail> }) {
  if (!read.isError) return <p className="text-sm text-fg-muted">Reading the plugin…</p>;
  if (isApiRequestError(read.error) && read.error.status === 404) {
    return <p className="text-sm text-fg">{NOT_INSTALLED}</p>;
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="text-fg">This plugin couldn&apos;t be read. {describeApiError(read.error).summary}</p>
      <Button size="sm" loading={read.isFetching} loadingLabel="Trying…" onClick={() => void read.refetch()}>
        Try again
      </Button>
    </div>
  );
}

function PluginDetailView({ detail }: { detail: CapabilityPluginDetail }) {
  return (
    <div className="space-y-4 text-sm text-fg-secondary">
      <StatusBadge status={presentPluginState(detail)} />
      <WhatItIs plugin={detail} />
      <WhereItComesFrom plugin={detail} />
      <Section title="What it added" headingLevel={3}>
        <WhatItAdded detail={detail} />
      </Section>
      <PluginUninstall detail={detail} />
      <TechnicalDetails>
        <div className="space-y-1 font-mono">
          <p>{detail.pluginId}</p>
          <p>{detail.workspaceId}</p>
          <p>{detail.pin.kind === "commit" ? detail.pin.commit : detail.pin.treeSha256}</p>
          <p>{detail.manifestSha256}</p>
          <p>{detail.installPlanId}</p>
        </div>
      </TechnicalDetails>
    </div>
  );
}

/** Each piece, in the manifest's order, with its kind, its state and the link to its own item where it has one. */
function WhatItAdded({ detail }: { detail: CapabilityPluginDetail }) {
  return (
    <ul className="divide-y divide-line-subtle">
      {detail.pieces.map((piece) => (
        <li key={piece.pieceId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2 first:pt-0">
          <span className="text-xs text-fg-muted">{PLUGIN_PIECE_KIND_LABELS[piece.kind]}</span>
          {piece.href ? (
            <NativeOwnerLink scope={`${detail.pluginId}:${piece.pieceId}`} href={piece.href} className="font-medium">
              {piece.label}
            </NativeOwnerLink>
          ) : (
            <span className="min-w-0 font-medium text-fg">{piece.label}</span>
          )}
          <StatusBadge status={presentPieceState(piece.state)} />
        </li>
      ))}
    </ul>
  );
}
