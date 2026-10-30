import type { ReactNode } from "react";
import type { CapabilityConnectorItem } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { StatusBadge } from "../../../ui/StatusBadge";
import { CHAT_CONNECTORS_SETTINGS_HREF, WORKSPACE_CAPABILITIES_HREF } from "./connector-links";
import {
  chatBlockLine,
  connectorCategoryLabel,
  connectorKindLabel,
  describeConnection,
  presentConnectorState,
} from "./connector-view";

// The pieces every connector panel shows the same way: the details of a saved or listed connector, and the install
// panel of a template.

/**
 * The kind and category line, then the state badge with its reason. It is where focus lands when the panel changes
 * under a control that had it (`usePanelFocus`), such as the install panel turning into the saved server's view.
 */
export function ConnectorHeader({ item }: { item: CapabilityConnectorItem }) {
  const { showTechnicalDetails } = useUiPreferences();
  const state = presentConnectorState(item, "panel", { technicalDetailsShown: showTechnicalDetails });
  return (
    <div
      data-focus-landing
      tabIndex={-1}
      className="space-y-2 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <p className="text-sm text-fg-secondary">
        {connectorKindLabel(item.kind)} · {connectorCategoryLabel(item.category)}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge status={state} />
        <span className="text-sm text-fg-secondary">{state.reason}</span>
      </div>
    </div>
  );
}

/** "How it connects": where it signs in or runs, the exact command for a program on this computer, and its warning. */
export function ConnectionLines({ item, children }: { item: CapabilityConnectorItem; children?: ReactNode }) {
  const connection = describeConnection(item);
  return (
    <div className="space-y-2 text-sm text-fg-secondary">
      {connection.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {connection.command ? (
        <code className="block break-all rounded-md bg-sunken px-2 py-1.5 font-mono text-xs text-fg">
          {connection.command}
        </code>
      ) : null}
      {connection.warning ? <p>{connection.warning}</p> : null}
      {children}
    </div>
  );
}

/** Why Chat can't use connectors, with the way to Advanced setup. */
export function ChatBlockNote({ item }: { item: CapabilityConnectorItem }) {
  return (
    <p className="text-sm text-fg-secondary">
      {chatBlockLine(item.chat.blockedBy)}{" "}
      <NativeOwnerLink scope={item.id} href={CHAT_CONNECTORS_SETTINGS_HREF}>
        See Chat access in Advanced setup
      </NativeOwnerLink>
    </p>
  );
}

/** Said only when this workspace hides the connector from the AI. */
export function HiddenNote({ item }: { item: CapabilityConnectorItem }) {
  if (!item.hiddenInWorkspace) return null;
  return (
    <p className="text-sm text-fg-secondary">
      This workspace hides it from the AI.{" "}
      <NativeOwnerLink scope={item.id} href={WORKSPACE_CAPABILITIES_HREF}>
        Change workspace capabilities
      </NativeOwnerLink>
    </p>
  );
}

/** The ids and hosts behind a connector, for Technical details. `extra` rows follow, and empty rows are left out. */
export function TechnicalRows({
  item,
  extra = [],
}: {
  item: CapabilityConnectorItem;
  extra?: readonly [string, string | undefined][];
}) {
  const all: [string, string | undefined][] = [
    ["Connector", item.id],
    ["Server", item.serverId],
    ["Connection", item.connectionId],
    ["Template", item.templateId],
    ["Catalog", item.catalogId],
    ["Hosts", item.networkHosts.join(", ")],
    ["Saved version", item.serverRevision],
    ["Last error", item.lastError],
    ...extra,
  ];
  const rows = all.filter((row): row is [string, string] => Boolean(row[1]));
  return (
    <dl className="space-y-1">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-fg-muted">{label}</dt>
          <dd className="break-all font-mono text-xs text-fg-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
