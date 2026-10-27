import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { ConnectorInstallPanel } from "./ConnectorInstallPanel";
import { InstallStatus } from "./ConnectorInstallProgress";
import { ChatBlockNote, ConnectionLines, ConnectorHeader, HiddenNote, TechnicalRows } from "./ConnectorPanelParts";
import { ConnectorResumeControls } from "./ConnectorResumeControls";
import { ConnectorServerControls } from "./ConnectorServerControls";
import { WhatAsksFirst } from "./WhatAsksFirst";
import { connectorSettingsHref, savedConnectorForTemplate } from "./connector-links";
import { isActiveInstallState } from "./connector-install-store";
import { approvalPostureInEffect } from "./connector-view";
import { useConnectorInstall } from "./use-connector-install";
import { usePanelFocus } from "./use-panel-focus";

/**
 * The tools a saved server offers, as it last listed them, each switched-on tool marked with whether it asks first under
 * the setting the Gateway decides its calls by. A server whose tools are listed per chat has no list here and never has
 * its setting applied. A switched-off connector runs nothing, so its tools carry no label. Other connectors have no tool
 * list of their own.
 */
function ConnectorTools({
  serverId,
  perChat,
  posture,
  labelled,
}: {
  serverId: string;
  perChat: boolean;
  posture: McpApprovalPosture | undefined;
  labelled: boolean;
}) {
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
    return (
      <p className="mt-2 text-sm text-fg-muted">
        {perChat ? "Its tools are listed per chat." : "No tools listed yet. They show up once it connects."}
      </p>
    );
  }
  // The Gateway lets a tool name run on its own only when every entry with that name allows it, switched on or off.
  const asksByName = new Map<string, boolean>();
  for (const tool of tools) {
    asksByName.set(
      tool.toolName,
      asksByName.get(tool.toolName) === true || mcpCallAsksFirst(posture, tool.annotations),
    );
  }
  return (
    <ul className="mt-2 divide-y divide-line-subtle">
      {tools.map((tool, index) => (
        // A server can list one name twice, so the position keeps each row's key apart.
        <li key={`${tool.toolName}:${index}`} className="py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <code className="break-all font-mono text-xs text-fg">{tool.toolName}</code>
            {!tool.enabled ? (
              <span className="text-xs text-fg-muted">Switched off</span>
            ) : labelled ? (
              // The rule the Gateway applies to a call, read from the labels the server gave this tool when it last
              // connected. A tool that is switched off never runs, so it carries no label.
              <span className="text-xs text-fg-secondary">
                {asksByName.get(tool.toolName) === true ? "Asks first" : "Runs freely"}
              </span>
            ) : null}
          </div>
          {tool.description ? <p className="text-sm text-fg-secondary">{tool.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function ConnectorDetails({
  item,
  reliefAvailable,
  onRemoved,
  panelId,
  announceFlow = true,
}: {
  item: CapabilityConnectorItem;
  reliefAvailable: boolean;
  onRemoved?: () => void;
  /** The connector the panel was opened for, when it shows the saved server installed from that template. */
  panelId?: string;
  /** Off when the panel around it already reads the install flow out. */
  announceFlow?: boolean;
}) {
  const savedServer = item.source === "mcp_server" && Boolean(item.serverId);
  return (
    <div className="space-y-4">
      <ConnectorHeader item={item} />
      {savedServer ? <ConnectorResumeControls item={item} announce={announceFlow} /> : null}

      <Section title="What it does" headingLevel={3}>
        {item.description ? <p className="text-sm text-fg-secondary">{item.description}</p> : null}
        {savedServer && item.serverId ? (
          <ConnectorTools
            serverId={item.serverId}
            perChat={item.requesterScoped === true}
            posture={approvalPostureInEffect(item, reliefAvailable)}
            labelled={item.state !== "turned_off"}
          />
        ) : null}
      </Section>

      <Section title="How it connects" headingLevel={3}>
        <ConnectionLines item={item} />
      </Section>

      {savedServer ? (
        <Section title="What asks first" headingLevel={3}>
          <WhatAsksFirst key={item.id} item={item} reliefAvailable={reliefAvailable} />
        </Section>
      ) : null}

      {item.chat.available ? null : <ChatBlockNote item={item} />}
      <HiddenNote item={item} />

      {savedServer ? <ConnectorServerControls item={item} panelId={panelId} onRemoved={onRemoved} /> : null}

      <NativeOwnerLink scope={item.id} href={connectorSettingsHref(item)} className="text-sm">
        Advanced setup in Settings
      </NativeOwnerLink>

      <TechnicalDetails>
        <TechnicalRows item={item} />
      </TechnicalDetails>
    </div>
  );
}

const NOT_LISTED = <p className="text-sm text-fg-muted">This connector isn't in the list anymore.</p>;

/** An MCP template that isn't installed yet: its panel is the install panel. */
const installable = (item: CapabilityConnectorItem) => item.source === "mcp_template" && item.state === "available";

interface ListView {
  items: readonly CapabilityConnectorItem[];
  reliefAvailable: boolean;
  /** When the list was last read, to tell a list that caught up after an install from one read before it ended. */
  readAt: number;
}

/**
 * A template's panel through its install (R80). The address keeps naming the template, because a new address would
 * close the inspector, so the panel follows the install instead: the install panel while it runs (from the last row
 * it had, after the list has swapped the template for the saved server), then the saved server's Manage view. A
 * template that was installed elsewhere opens its saved server. An old Done whose server is gone (the template is
 * listed again, and a read since shows no server) is forgotten, so the template can be installed again.
 */
function TemplateConnectorPanel({
  template,
  listed,
  list,
  onRemoved,
}: {
  template: CapabilityConnectorItem;
  /** Whether the list still holds the template row. */
  listed: boolean;
  list: ListView;
  onRemoved?: () => void;
}) {
  const client = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const install = useConnectorInstall(template);
  const { state } = install;
  const { items, readAt } = list;
  const serverRow = install.serverId
    ? items.find((entry) => entry.source === "mcp_server" && entry.serverId === install.serverId)
    : undefined;
  const doneServerId = state.phase === "done" ? state.serverId : undefined;
  // When this panel first saw the install done without its server in the list, and whether it forgot that Done.
  const doneSeen = useRef<{ serverId: string; at: number; forgotten: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!doneServerId || serverRow) return;
    const seen = doneSeen.current;
    if (seen?.serverId !== doneServerId) {
      doneSeen.current = { serverId: doneServerId, at: Date.now(), forgotten: false };
      // A panel opened on an old Done reads the list again, so the check below gets its answer.
      void client.invalidateQueries({ queryKey: queryKeys.capabilityConnectors(activeWorkspaceId) });
      return;
    }
    if (!listed || seen.forgotten || readAt <= seen.at) return;
    doneSeen.current = { ...seen, forgotten: true };
    install.cancel();
  }, [doneServerId, serverRow, listed, readAt, client, activeWorkspaceId, install]);

  // The saved server's view. Showing the server this install saved, it leaves reading the flow out to this panel.
  const details = (item: CapabilityConnectorItem, ownFlow: boolean) => (
    <ConnectorDetails
      item={item}
      reliefAvailable={list.reliefAvailable}
      onRemoved={onRemoved}
      panelId={template.id}
      announceFlow={!ownFlow}
    />
  );
  const view = (() => {
    if (isActiveInstallState(state)) return null;
    // Done, failed or stopped once the list shows the server it saved: that server's view, with the result.
    if (state.phase !== "idle" && serverRow) return details(serverRow, true);
    if (state.phase !== "idle" || listed) return null;
    const saved = savedConnectorForTemplate(items, template.id);
    return saved ? details(saved, false) : NOT_LISTED;
  })();
  // Turning into the saved server's view, focus lands on its header; in the install panel, on the install button.
  const anchor = useRef<HTMLParagraphElement>(null);
  usePanelFocus(anchor, view ? "landing" : "primary");
  return (
    <>
      {view ?? <ConnectorInstallPanel item={template} install={install} reliefAvailable={list.reliefAvailable} />}
      <InstallStatus anchor={anchor} state={state} doneWords="Installed." />
    </>
  );
}

/**
 * The details panel of one connector, shown in the inspector. It reads the connector from the list the Connectors tab
 * keeps, so the switch and the state follow every change to that list. It never reads the list itself (`enabled:
 * false`) but carries the same options as the tab: observers write their options onto the one shared query, and one
 * without a `queryFn` would leave the tab's next re-read with nothing to run.
 * A template that isn't installed shows its install panel. An address that names a template the list no longer has
 * opens the saved server installed from it.
 */
export function ConnectorPanel({ itemId, onRemoved }: { itemId: string; onRemoved?: () => void }) {
  // The root `usePanelFocus` keeps focus inside of.
  return (
    <div data-connector-panel>
      <ConnectorPanelBody itemId={itemId} onRemoved={onRemoved} />
    </div>
  );
}

function ConnectorPanelBody({ itemId, onRemoved }: { itemId: string; onRemoved?: () => void }) {
  const { activeWorkspaceId } = useUiPreferences();
  const live = useQuery({
    ...connectorListQuery(activeWorkspaceId),
    enabled: false,
    select: (list: CapabilityConnectorsResponse) => ({
      items: list.items,
      // A list that doesn't say so is read as an install where every action asks.
      reliefAvailable: list.approvalReliefAvailable === true,
    }),
  });
  const listed = live.data?.items.find((entry) => entry.id === itemId);
  // The template row this panel last had, kept so an install stays on screen after the list swaps it for its server.
  const [lastTemplate, setLastTemplate] = useState<CapabilityConnectorItem | undefined>(undefined);
  if (listed && installable(listed) && listed !== lastTemplate) setLastTemplate(listed);
  if (!live.data) return NOT_LISTED;
  const list: ListView = { ...live.data, readAt: live.dataUpdatedAt };
  const template = listed ? (installable(listed) ? listed : undefined) : lastTemplate;
  if (template?.id === itemId) {
    return <TemplateConnectorPanel template={template} listed={Boolean(listed)} list={list} onRemoved={onRemoved} />;
  }
  const item = listed ?? savedConnectorForTemplate(list.items, itemId);
  if (!item) return NOT_LISTED;
  return <ConnectorDetails item={item} reliefAvailable={list.reliefAvailable} onRemoved={onRemoved} panelId={itemId} />;
}
