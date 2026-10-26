import { useQuery } from "@tanstack/react-query";
import {
  mcpCallAsksFirst,
  type CapabilityConnectorItem,
  type CapabilityConnectorsResponse,
  type McpApprovalPosture,
  type McpToolRecord,
} from "@goatcitadel/contracts";
import { fetchMcpTools } from "@goatcitadel/mission-control-shared/api/mcp-operations";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { connectorListQuery } from "../../../data/capability-connectors-query";
import { queryKeys } from "../../../data/query-keys";
import { recordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { ConnectorServerControls } from "./ConnectorServerControls";
import { WhatAsksFirst } from "./WhatAsksFirst";
import { CHAT_CONNECTORS_SETTINGS_HREF, connectorSettingsHref, WORKSPACE_CAPABILITIES_HREF } from "./connector-links";
import {
  chatBlockLine,
  connectorCategoryLabel,
  connectorKindLabel,
  describeConnection,
  presentConnectorState,
} from "./connector-view";

/**
 * The tools a saved server offers, as it last listed them, each marked with whether it asks first under the server's
 * saved setting. Other connectors have no tool list of their own.
 */
function ConnectorTools({ serverId, posture }: { serverId: string; posture: McpApprovalPosture | undefined }) {
  const query = useQuery({
    queryKey: queryKeys.capabilityConnectorTools(serverId),
    queryFn: () => fetchMcpTools(serverId),
  });
  const view = recordView(query);
  const tools: readonly McpToolRecord[] | undefined = view.record?.items;
  if (!tools) {
    if (view.phase === "error") {
      return (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-fg">The tool list couldn't load.</p>
          <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      );
    }
    return <p className="mt-2 text-sm text-fg-muted">Reading its tools…</p>;
  }
  if (tools.length === 0) {
    return <p className="mt-2 text-sm text-fg-muted">No tools listed yet. They show up once it connects.</p>;
  }
  return (
    <ul className="mt-2 divide-y divide-line-subtle">
      {tools.map((tool) => (
        <li key={tool.toolName} className="py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <code className="break-all font-mono text-xs text-fg">{tool.toolName}</code>
            {tool.enabled ? null : <span className="text-xs text-fg-muted">Switched off</span>}
            {/* The same rule the Gateway decides with, so what the panel says is what happens. */}
            <span className="text-xs text-fg-secondary">
              {mcpCallAsksFirst(posture, tool.annotations) ? "Asks first" : "Runs freely"}
            </span>
          </div>
          {tool.description ? <p className="text-sm text-fg-secondary">{tool.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function TechnicalRows({ item }: { item: CapabilityConnectorItem }) {
  const all: [string, string | undefined][] = [
    ["Connector", item.id],
    ["Server", item.serverId],
    ["Connection", item.connectionId],
    ["Template", item.templateId],
    ["Catalog", item.catalogId],
    ["Hosts", item.networkHosts.join(", ")],
    ["Saved version", item.serverRevision],
    ["Last error", item.lastError],
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

function ConnectorDetails({ item, onRemoved }: { item: CapabilityConnectorItem; onRemoved?: () => void }) {
  const { showTechnicalDetails } = useUiPreferences();
  const state = presentConnectorState(item, "panel", { technicalDetailsShown: showTechnicalDetails });
  const connection = describeConnection(item);
  const savedServer = item.source === "mcp_server" && Boolean(item.serverId);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-fg-secondary">
          {connectorKindLabel(item.kind)} · {connectorCategoryLabel(item.category)}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge status={state} />
          <span className="text-sm text-fg-secondary">{state.reason}</span>
        </div>
      </div>

      <Section title="What it does" headingLevel={3}>
        {item.description ? <p className="text-sm text-fg-secondary">{item.description}</p> : null}
        {savedServer && item.serverId ? (
          <ConnectorTools serverId={item.serverId} posture={item.approvalPosture} />
        ) : null}
      </Section>

      <Section title="How it connects" headingLevel={3}>
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
        </div>
      </Section>

      {savedServer ? (
        <Section title="What asks first" headingLevel={3}>
          <WhatAsksFirst key={item.id} item={item} />
        </Section>
      ) : null}

      {item.chat.available ? null : (
        <p className="text-sm text-fg-secondary">
          {chatBlockLine(item.chat.blockedBy)}{" "}
          <NativeOwnerLink scope={item.id} href={CHAT_CONNECTORS_SETTINGS_HREF}>
            See Chat access in Settings
          </NativeOwnerLink>
        </p>
      )}
      {item.hiddenInWorkspace ? (
        <p className="text-sm text-fg-secondary">
          This workspace hides it from the AI.{" "}
          <NativeOwnerLink scope={item.id} href={WORKSPACE_CAPABILITIES_HREF}>
            Change workspace capabilities
          </NativeOwnerLink>
        </p>
      ) : null}

      {savedServer ? <ConnectorServerControls item={item} onRemoved={onRemoved} /> : null}

      <NativeOwnerLink scope={item.id} href={connectorSettingsHref(item)} className="text-sm">
        Advanced setup in Settings
      </NativeOwnerLink>

      <TechnicalDetails>
        <TechnicalRows item={item} />
      </TechnicalDetails>
    </div>
  );
}

/**
 * The details panel of one connector, shown in the inspector. It reads the connector from the list the Connectors tab
 * keeps, so the switch and the state follow every change to that list. It never reads the list itself (`enabled:
 * false`) but carries the same options as the tab: observers write their options onto the one shared query, and one
 * without a `queryFn` would leave the tab's next re-read with nothing to run.
 */
export function ConnectorPanel({ itemId, onRemoved }: { itemId: string; onRemoved?: () => void }) {
  const { activeWorkspaceId } = useUiPreferences();
  const live = useQuery({
    ...connectorListQuery(activeWorkspaceId),
    enabled: false,
    select: (list: CapabilityConnectorsResponse) => list.items.find((entry) => entry.id === itemId),
  });
  if (!live.data) return <p className="text-sm text-fg-muted">This connector isn't in the list anymore.</p>;
  return <ConnectorDetails item={live.data} onRemoved={onRemoved} />;
}
