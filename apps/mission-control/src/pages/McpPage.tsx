import { useCallback, useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  fetchConnectorRecords,
  connectMcpServer,
  createMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  fetchSettings,
  fetchMcpTemplateDiscovery,
  fetchMcpTemplates,
  fetchMcpServers,
  fetchMcpTools,
  invokeMcpTool,
  runMcpServerHealthCheck,
  startMcpOAuth,
  updateMcpServerPolicy,
} from "../api/client";
import type { ApprovalInboxItemRecord, ConnectorRecord } from "@goatcitadel/contracts";
import { ActionButton } from "../components/ActionButton";
import { CardSkeleton } from "../components/CardSkeleton";
import { ConfirmModal } from "../components/ConfirmModal";
import { DataToolbar } from "../components/DataToolbar";
import { HelpHint } from "../components/HelpHint";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { StatusChip } from "../components/StatusChip";
import { GCSelect, GCSwitch } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

type Transport = "stdio" | "http" | "sse";
type McpCategory = "development" | "browser" | "automation" | "research" | "data" | "creative" | "orchestration" | "other";
type McpTrustTier = "trusted" | "restricted" | "quarantined";
type McpCostTier = "free" | "mixed" | "paid" | "unknown";
type McpTemplateRecord = Awaited<ReturnType<typeof fetchMcpTemplates>>["items"][number];
type McpTemplateDiscoveryRecord = Awaited<ReturnType<typeof fetchMcpTemplateDiscovery>>["items"][number];
type ApprovalInboxFilterState = "all" | ApprovalInboxItemRecord["state"];

const INTERNAL_APPROVAL_INBOX_URL = "goatcitadel://approval-inbox";
const APPROVAL_INBOX_LIST_TOOL_NAME = "goatcitadel.approval.remote_action_inbox.list";
const APPROVAL_INBOX_RESOLVE_TOOL_NAME = "goatcitadel.approval.remote_action_inbox.resolve";
const FEATURED_MCP_TEMPLATE_IDS = ["github", "approval-inbox", "stripe"] as const;

const FEATURED_MCP_NOTES: Record<(typeof FEATURED_MCP_TEMPLATE_IDS)[number], {
  why: string;
  setup: string;
}> = {
  github: {
    why: "Best first MCP for code-heavy work: repos, issues, pull requests, and code navigation.",
    setup: "Review auth and trust policy before first live use. This is the official GitHub endpoint shape, not the older deprecated local package.",
  },
  "approval-inbox": {
    why: "Turns durable remote approvals into a real non-browser MCP inbox with pending actions, retries, and explicit operator resolution.",
    setup: "Use this when you want approval delivery outside Mission Control realtime. Connect it once, then resolve approvals from the inbox panel below.",
  },
  stripe: {
    why: "High-value if your site runs on Stripe and you want billing, customer, and subscription workflows inside GoatCitadel.",
    setup: "Treat this as restricted and keep first-use approval on. Billing data and account actions deserve a tighter policy posture.",
  },
};

type FeaturedMcpTemplateCard = {
  template: McpTemplateRecord;
  discovery: McpTemplateDiscoveryRecord | undefined;
  note: (typeof FEATURED_MCP_NOTES)[(typeof FEATURED_MCP_TEMPLATE_IDS)[number]];
};

export function McpPage() {
  const [servers, setServers] = useState<Array<{
    serverId: string;
    label: string;
    transport: Transport;
    status: "disconnected" | "connecting" | "connected" | "error";
    enabled: boolean;
    category: McpCategory;
    trustTier: McpTrustTier;
    costTier: McpCostTier;
    policy: {
      requireFirstToolApproval: boolean;
      redactionMode: "off" | "basic" | "strict";
      allowedToolPatterns: string[];
      blockedToolPatterns: string[];
      notes?: string;
    };
    command?: string;
    url?: string;
    authType: "none" | "token" | "oauth2";
    verifiedAt?: string;
    lastError?: string;
  }>>([]);
  const [templates, setTemplates] = useState<McpTemplateRecord[]>([]);
  const [templateDiscovery, setTemplateDiscovery] = useState<McpTemplateDiscoveryRecord[]>([]);
  const [templateDiscoveryEnabled, setTemplateDiscoveryEnabled] = useState(true);
  const [templateDiscoveryError, setTemplateDiscoveryError] = useState<string | null>(null);
  const [connectorRecords, setConnectorRecords] = useState<ConnectorRecord[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [tools, setTools] = useState<Array<{
    serverId: string;
    toolName: string;
    description?: string;
    enabled: boolean;
    updatedAt: string;
  }>>([]);
  const [toolName, setToolName] = useState("");
  const [toolArgs, setToolArgs] = useState("{}");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<"none" | "token" | "oauth2">("none");
  const [category, setCategory] = useState<McpCategory>("development");
  const [trustTier, setTrustTier] = useState<McpTrustTier>("restricted");
  const [costTier, setCostTier] = useState<McpCostTier>("unknown");
  const [policyRequireFirst, setPolicyRequireFirst] = useState(false);
  const [policyRedaction, setPolicyRedaction] = useState<"off" | "basic" | "strict">("basic");
  const [policyAllowed, setPolicyAllowed] = useState("");
  const [policyBlocked, setPolicyBlocked] = useState("");
  const [policyNotes, setPolicyNotes] = useState("");
  const [policyDirty, setPolicyDirty] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxItems, setInboxItems] = useState<ApprovalInboxItemRecord[]>([]);
  const [inboxFilterState, setInboxFilterState] = useState<ApprovalInboxFilterState>("pending");
  const [pendingInboxActionId, setPendingInboxActionId] = useState<string | null>(null);
  const [confirmDeleteServer, setConfirmDeleteServer] = useState<{
    serverId: string;
    label: string;
  } | null>(null);
  const [diagnosticByServerId, setDiagnosticByServerId] = useState<Record<string, {
    connectorType: "mcp_server" | "integration_connection";
    connectorId: string;
    status: "ok" | "warn" | "error";
    checks: Array<{
      key: string;
      status: "pass" | "warn" | "fail";
      message: string;
    }>;
    recommendedNextAction?: string;
    checkedAt: string;
  }>>({});

  const loadServers = useCallback(async () => {
    const [response, templateResponse, connectorResponse, settingsResponse] = await Promise.all([
      fetchMcpServers(),
      fetchMcpTemplates(),
      fetchConnectorRecords("mcp_server"),
      fetchSettings(),
    ]);
    const nextTemplateDiscoveryEnabled = settingsResponse.features.connectorDiagnosticsV1Enabled;
    setTemplateDiscoveryEnabled(nextTemplateDiscoveryEnabled);
    if (nextTemplateDiscoveryEnabled) {
      try {
        const discoveryResponse = await fetchMcpTemplateDiscovery();
        setTemplateDiscovery(discoveryResponse.items);
        setTemplateDiscoveryError(null);
      } catch (err) {
        setTemplateDiscovery([]);
        setTemplateDiscoveryError(formatMcpError((err as Error).message));
      }
    } else {
      setTemplateDiscovery([]);
      setTemplateDiscoveryError(null);
    }
    setServers(response.items);
    setTemplates(templateResponse.items);
    setConnectorRecords(connectorResponse.items);
    setSelectedServerId((current) => {
      if (current && response.items.some((item) => item.serverId === current)) {
        return current;
      }
      return response.items[0]?.serverId ?? null;
    });
  }, []);

  const loadTools = useCallback(async (serverId: string) => {
    const response = await fetchMcpTools(serverId);
    setTools(response.items);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsInitialLoading(true);
    void loadServers()
      .then(() => {
        if (!cancelled) {
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(formatMcpError(err.message));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsInitialLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadServers]);

  useRefreshSubscription(
    "mcp",
    async () => {
      setIsRefreshing(true);
      try {
        await loadServers();
        if (selectedServerId) {
          await loadTools(selectedServerId);
        }
        if (selected && selectedIsInternalApprovalInbox && selected.status === "connected") {
          await loadApprovalInbox(selected.serverId, inboxFilterState);
        }
      } catch (err) {
        setError(formatMcpError((err as Error).message));
      } finally {
        setIsRefreshing(false);
      }
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1000,
      staleMs: 20000,
      pollIntervalMs: 15000,
    },
  );

  useEffect(() => {
    if (!selectedServerId) {
      setTools([]);
      return;
    }
    void loadTools(selectedServerId).catch((err: Error) => {
      const message = formatMcpError(err.message);
      setError(message);
      if (err.message.includes("Unknown MCP server")) {
        const fallback = servers.find((item) => item.serverId !== selectedServerId)?.serverId ?? null;
        setSelectedServerId(fallback);
        if (!fallback) {
          setTools([]);
        }
      }
    });
  }, [loadTools, selectedServerId, servers]);

  const selected = useMemo(
    () => servers.find((item) => item.serverId === selectedServerId) ?? null,
    [selectedServerId, servers],
  );
  const selectedConnector = useMemo(
    () => connectorRecords.find((item) => item.sourceId === selectedServerId) ?? null,
    [connectorRecords, selectedServerId],
  );
  const selectedIsInternalApprovalInbox = selected?.url?.trim().toLowerCase() === INTERNAL_APPROVAL_INBOX_URL;
  const templatesById = useMemo(
    () => new Map(templates.map((template) => [template.templateId, template])),
    [templates],
  );
  const templateDiscoveryById = useMemo(
    () => new Map(templateDiscovery.map((item) => [item.templateId, item])),
    [templateDiscovery],
  );
  const orderedTemplates = useMemo(() => {
    const featured = new Set(FEATURED_MCP_TEMPLATE_IDS);
    return [...templates].sort((left, right) => {
      const leftRank = featured.has(left.templateId as (typeof FEATURED_MCP_TEMPLATE_IDS)[number]) ? 0 : 1;
      const rightRank = featured.has(right.templateId as (typeof FEATURED_MCP_TEMPLATE_IDS)[number]) ? 0 : 1;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.label.localeCompare(right.label);
    });
  }, [templates]);
  const featuredTemplates = useMemo(
    () => FEATURED_MCP_TEMPLATE_IDS
      .map((templateId) => {
        const template = templatesById.get(templateId);
        if (!template) {
          return null;
        }
        return {
          template,
          discovery: templateDiscoveryById.get(templateId),
          note: FEATURED_MCP_NOTES[templateId],
        };
      })
      .filter((item): item is FeaturedMcpTemplateCard => item !== null),
    [templateDiscoveryById, templatesById],
  );
  const selectedDiagnostic = selected ? diagnosticByServerId[selected.serverId] : undefined;
  const connectedServerCount = useMemo(
    () => servers.filter((item) => item.status === "connected").length,
    [servers],
  );
  const mcpHeaderActions = useMemo(
    () => (
      <div className="workflow-summary-strip">
        <StatusChip tone="live">{connectedServerCount} connected</StatusChip>
        <StatusChip>{servers.length} servers</StatusChip>
        <StatusChip>{templates.length} templates</StatusChip>
        {selected ? <StatusChip tone={selected.status === "connected" ? "success" : "muted"}>{selected.status}</StatusChip> : null}
        {isRefreshing ? <StatusChip tone="warning">Refreshing</StatusChip> : null}
      </div>
    ),
    [connectedServerCount, isRefreshing, selected, servers.length, templates.length],
  );

  useEffect(() => {
    if (!selected) {
      return;
    }
    setPolicyRequireFirst(selected.policy.requireFirstToolApproval);
    setPolicyRedaction(selected.policy.redactionMode);
    setPolicyAllowed(selected.policy.allowedToolPatterns.join(", "));
    setPolicyBlocked(selected.policy.blockedToolPatterns.join(", "));
    setPolicyNotes(selected.policy.notes ?? "");
    setPolicyDirty(false);
  }, [selected?.serverId]);

  const loadApprovalInbox = useCallback(async (
    serverId: string,
    state: ApprovalInboxFilterState,
  ) => {
    setInboxBusy(true);
    try {
      const response = await invokeMcpTool({
        serverId,
        toolName: APPROVAL_INBOX_LIST_TOOL_NAME,
        arguments: state === "all" ? { limit: 50 } : { state, limit: 50 },
      });
      if (!response.ok) {
        throw new Error(response.error ?? "Unable to load approval inbox.");
      }
      setInboxItems(parseApprovalInboxItems(response.output?.items));
      setInboxError(null);
    } catch (err) {
      setInboxItems([]);
      setInboxError(formatMcpError((err as Error).message));
    } finally {
      setInboxBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!selected || !selectedIsInternalApprovalInbox || selected.status !== "connected") {
      setInboxItems([]);
      setInboxError(null);
      return;
    }
    void loadApprovalInbox(selected.serverId, inboxFilterState);
  }, [inboxFilterState, loadApprovalInbox, selected, selectedIsInternalApprovalInbox]);

  const handleResolveInboxItem = useCallback(async (
    item: ApprovalInboxItemRecord,
    decision: "approve" | "reject",
  ) => {
    if (!selected) {
      return;
    }
    setPendingInboxActionId(item.inboxItemId);
    try {
      const response = await invokeMcpTool({
        serverId: selected.serverId,
        toolName: APPROVAL_INBOX_RESOLVE_TOOL_NAME,
        arguments: {
          inboxItemId: item.inboxItemId,
          decision,
          resolvedBy: "mission-control:mcp",
        },
      });
      if (!response.ok) {
        throw new Error(response.error ?? `Unable to ${decision} approval inbox item.`);
      }
      setResult(JSON.stringify(response, null, 2));
      setInboxError(null);
      await loadApprovalInbox(selected.serverId, inboxFilterState);
    } catch (err) {
      setInboxError(formatMcpError((err as Error).message));
    } finally {
      setPendingInboxActionId(null);
    }
  }, [inboxFilterState, loadApprovalInbox, selected]);

  const handleCreateServer = useCallback(async () => {
    if (!label.trim()) {
      return;
    }
    setBusy(true);
    try {
      await createMcpServer({
        label: label.trim(),
        transport,
        command: transport === "stdio" ? command.trim() || undefined : undefined,
        url: transport !== "stdio" ? url.trim() || undefined : undefined,
        authType,
        category,
        trustTier,
        costTier,
      });
      setLabel("");
      await loadServers();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [authType, category, command, costTier, label, loadServers, transport, trustTier, url]);

  const handleCreateFromTemplate = useCallback(async (templateId: string) => {
    const template = templates.find((item) => item.templateId === templateId);
    if (!template || template.installed) {
      return;
    }
    setBusy(true);
    try {
      await createMcpServer({
        label: template.label,
        transport: template.transport,
        command: template.command,
        args: template.args,
        url: template.url,
        authType: template.authType,
        enabled: template.enabledByDefault,
        category: template.category,
        trustTier: template.trustTier,
        costTier: template.costTier,
        policy: template.policy,
      });
      await loadServers();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [loadServers, templates]);

  if (isInitialLoading) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Integrate"
          title={pageCopy.mcp.title}
          subtitle={pageCopy.mcp.subtitle}
          hint="Register adapters, validate trust policy, then test one tool before broader use."
          actions={mcpHeaderActions}
        />
        <CardSkeleton lines={8} />
      </section>
    );
  }

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Integrate"
        title={pageCopy.mcp.title}
        subtitle={pageCopy.mcp.subtitle}
        hint="MCP adapters should stay explicit, policy-bound, and easy to inspect before first live use."
        actions={mcpHeaderActions}
      />
      <PageGuideCard
        pageId="mcp"
        what={pageCopy.mcp.guide?.what ?? ""}
        when={pageCopy.mcp.guide?.when ?? ""}
        mostCommonAction={pageCopy.mcp.guide?.mostCommonAction}
        actions={pageCopy.mcp.guide?.actions ?? []}
        terms={pageCopy.mcp.guide?.terms}
      />

      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing MCP servers...</p> : null}
      </div>

      <Panel
        title="MCP basics"
        subtitle="Start with one disabled template, connect it, then validate trust and policy before first live use."
      >
        <p className="office-subtitle">
          MCP servers are adapters that let GoatCitadel use outside tools safely. Start disabled, test one server, then expand.
        </p>
        <ol>
          <li>Choose a template in the library below and add it.</li>
          <li>Connect the server and confirm status is <strong>connected</strong>.</li>
          <li>Set trust/policy rules before first live invocation.</li>
          <li>Invoke one low-risk tool to validate behavior.</li>
        </ol>
        <p className="office-subtitle">
          If something fails, disconnect and review policy/tool patterns before trying again.
        </p>
      </Panel>

      <Panel
        title="Recommended Stack"
        subtitle="A practical first stack for repo work, billing operations, live docs, and local knowledge."
      >
        <p className="office-subtitle">
          Start with GitHub, the Approval Inbox, and Stripe here. If you already use Obsidian locally, use the native
          Obsidian connection in <strong>Connections</strong> instead of adding a generic notes MCP.
        </p>
        <div className="stack-md">
          {featuredTemplates.map(({ template, discovery, note }) => (
            <div key={template.templateId} className="prompt-lab-run-summary">
              <p>
                <strong>{template.label}</strong>
                <span className={`token-chip ${template.installed ? "token-chip-active" : ""}`} style={{ marginLeft: 8 }}>
                  {template.installed ? "Installed" : "Not installed"}
                </span>
                {discovery ? (
                  <span className="token-chip" style={{ marginLeft: 8 }}>
                    {discovery.readiness}
                  </span>
                ) : null}
              </p>
              <p className="office-subtitle">{note.why}</p>
              <p className="office-subtitle">
                {template.transport} | auth: {template.authType} | trust: {template.trustTier}
              </p>
              <p className="office-subtitle">{note.setup}</p>
              {discovery?.dependencyChecks.length ? (
                <p className="office-subtitle">
                  {discovery.dependencyChecks.map((check) => `${check.key}:${check.status}`).join(", ")}
                </p>
              ) : null}
              <ActionButton
                label={template.installed ? "Installed" : `Add ${template.label}`}
                pending={busy}
                disabled={busy || template.installed}
                onClick={() => void handleCreateFromTemplate(template.templateId)}
              />
            </div>
          ))}
          <div className="prompt-lab-run-summary">
            <p>
              <strong>Obsidian</strong>
              <span className="token-chip" style={{ marginLeft: 8 }}>Native connection</span>
            </p>
            <p className="office-subtitle">
              GoatCitadel already has a built-in local Obsidian path in <strong>Connections</strong>. That keeps your
              vault local, supports read-only or read-append mode, and includes inbox capture without an extra MCP hop.
            </p>
          </div>
        </div>
      </Panel>

      <Panel
        title="Template Library"
        subtitle="Known MCP templates stay disabled by default until you choose to add them."
      >
        <p className="office-subtitle">
          Start from a known MCP server template, then connect and customize policy before first use.
        </p>
        <div className="stack-md">
          {orderedTemplates.map((template) => (
            <div key={template.templateId} className="prompt-lab-run-summary">
              <p>
                <strong>{template.label}</strong> - {template.description}
              </p>
              <p className="office-subtitle">
                {template.transport} | trust: {template.trustTier} | auth: {template.authType}
                {" | "}
                default enabled: {template.enabledByDefault ? "yes" : "no"}
              </p>
              <ActionButton
                label={template.installed ? "Installed" : "Add Template"}
                pending={busy}
                disabled={busy || template.installed}
                onClick={() => void handleCreateFromTemplate(template.templateId)}
              />
            </div>
          ))}
          {templates.length === 0 ? <p className="office-subtitle">No templates available.</p> : null}
        </div>
      </Panel>

      <Panel
        title="Where to Find More MCP Servers"
        subtitle="Use official sources first, and treat community listings as review-before-install leads."
      >
        <p className="office-subtitle">
          GoatCitadel does not audit third-party MCP servers for you. Review the command, URL, auth, maintainer, and
          policy before you enable anything new.
        </p>
        <div className="stack-md">
          {[
            {
              label: "Official MCP Registry",
              trust: "Official / Primary",
              href: "https://registry.modelcontextprotocol.io/",
              note: "Use this first for current registry-listed MCP servers.",
            },
            {
              label: "MCP Registry About",
              trust: "Official / Primary",
              href: "https://modelcontextprotocol.io/registry/about",
              note: "Policy context and how the registry is curated.",
            },
            {
              label: "Anthropic MCP Security Guidance",
              trust: "Official / Primary",
              href: "https://docs.anthropic.com/s/claude-code-security",
              note: "Operator guidance for reviewing server trust, auth, and side effects.",
            },
            {
              label: "MCP Directory",
              trust: "Community Directory",
              href: "https://mcpdir.dev/",
              note: "Broader community directory. Treat entries as review-before-install.",
            },
          ].map((source) => (
            <div key={source.href} className="prompt-lab-run-summary">
              <p>
                <strong>{source.label}</strong> <span className="token-chip">{source.trust}</span>
              </p>
              <p className="office-subtitle">{source.note}</p>
              <p>
                <a href={source.href} target="_blank" rel="noreferrer">
                  {source.href}
                </a>
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Template Discovery Readiness"
        subtitle="Check auth, command, and URL prerequisites before you install a template."
      >
        <p className="office-subtitle">
          Before installing a template, check whether required auth, command, or URL settings are ready.
        </p>
        {!templateDiscoveryEnabled ? (
          <p className="office-subtitle">Template discovery readiness is disabled right now. You can still install templates manually.</p>
        ) : templateDiscoveryError ? (
          <p className="error">{templateDiscoveryError}</p>
        ) : templateDiscovery.length === 0 ? (
          <p className="office-subtitle">Discovery metadata is unavailable right now. You can still install templates manually.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Installed</th>
                <th>Readiness</th>
                <th>Dependency checks</th>
              </tr>
            </thead>
            <tbody>
              {templateDiscovery.map((item) => (
                <tr key={item.templateId}>
                  <td>{item.label}</td>
                  <td>{item.installed ? "yes" : "no"}</td>
                  <td>{item.readiness}</td>
                  <td>
                    {item.dependencyChecks.length === 0
                      ? "No checks reported"
                      : item.dependencyChecks.map((check) => `${check.key}:${check.status}`).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="split-grid">
        <Panel
          title="Register MCP Server"
          subtitle="Use this for adapters that are not already covered by the template library."
        >
          <div className="controls-row">
            <label htmlFor="mcpLabel">Label <HelpHint label="Server label help" text="Human-readable name used in server list and logs." /></label>
            <input id="mcpLabel" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Docs MCP" />
          </div>
          <div className="controls-row">
            <label htmlFor="mcpTransport">Transport</label>
            <GCSelect
              id="mcpTransport"
              value={transport}
              onChange={(value) => setTransport(value as Transport)}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "http" },
                { value: "sse", label: "sse" },
              ]}
            />
            <label htmlFor="mcpAuth">Auth</label>
            <GCSelect
              id="mcpAuth"
              value={authType}
              onChange={(value) => setAuthType(value as "none" | "token" | "oauth2")}
              options={[
                { value: "none", label: "none" },
                { value: "token", label: "token" },
                { value: "oauth2", label: "oauth2" },
              ]}
            />
          </div>
          <div className="controls-row">
            <label htmlFor="mcpCategory">Category</label>
            <GCSelect
              id="mcpCategory"
              value={category}
              onChange={(value) => setCategory(value as McpCategory)}
              options={[
                { value: "development", label: "development" },
                { value: "browser", label: "browser" },
                { value: "automation", label: "automation" },
                { value: "research", label: "research" },
                { value: "data", label: "data" },
                { value: "creative", label: "creative" },
                { value: "orchestration", label: "orchestration" },
                { value: "other", label: "other" },
              ]}
            />
            <label htmlFor="mcpTrustTier">Trust</label>
            <GCSelect
              id="mcpTrustTier"
              value={trustTier}
              onChange={(value) => setTrustTier(value as McpTrustTier)}
              options={[
                { value: "trusted", label: "trusted" },
                { value: "restricted", label: "restricted" },
                { value: "quarantined", label: "quarantined" },
              ]}
            />
            <label htmlFor="mcpCostTier">Cost</label>
            <GCSelect
              id="mcpCostTier"
              value={costTier}
              onChange={(value) => setCostTier(value as McpCostTier)}
              options={[
                { value: "free", label: "free" },
                { value: "mixed", label: "mixed" },
                { value: "paid", label: "paid" },
                { value: "unknown", label: "unknown" },
              ]}
            />
          </div>
          {transport === "stdio" ? (
            <div className="controls-row">
              <label htmlFor="mcpCommand">Command <HelpHint label="stdio command help" text="Absolute path or command on PATH used to start the local MCP process." /></label>
              <input id="mcpCommand" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx @modelcontextprotocol/server-filesystem" />
            </div>
          ) : (
            <div className="controls-row">
              <label htmlFor="mcpUrl">URL</label>
              <input id="mcpUrl" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/stream" />
            </div>
          )}
          <ActionButton label="Add Server" pending={busy} onClick={handleCreateServer} />
        </Panel>

        <Panel
          title="Servers"
          subtitle="Select a server to connect it, run health checks, and tune first-use policy."
        >
          <div className="virtual-list-shell">
            <Virtuoso
              data={servers}
              itemContent={(_index, server) => (
                <div className="virtual-list-item chat-list-item" key={server.serverId}>
                  <button
                    type="button"
                    className={`chat-list-button${selectedServerId === server.serverId ? " active" : ""}`}
                    onClick={() => setSelectedServerId(server.serverId)}
                  >
                    {server.label}
                  </button>
                  <p className="chat-item-meta">
                    {server.transport} | {server.status} | {server.trustTier} | {server.costTier}
                  </p>
                </div>
              )}
            />
          </div>
          {selected ? (
            <div className="stack-md">
              <div className="actions">
                <ActionButton
                  label={selected.status === "connected" ? "Disconnect" : "Connect"}
                  pending={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      if (selected.status === "connected") {
                        await disconnectMcpServer(selected.serverId);
                      } else {
                        await connectMcpServer(selected.serverId);
                      }
                      await loadServers();
                      if (selectedServerId) {
                        await loadTools(selectedServerId);
                      }
                      setError(null);
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                {selected.authType === "oauth2" ? (
                  <ActionButton
                    label="Start OAuth"
                    pending={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const oauth = await startMcpOAuth(selected.serverId);
                        setResult(`Open OAuth URL: ${oauth.authorizeUrl}`);
                        setError(null);
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                ) : null}
                <ActionButton
                  label="Delete"
                  pending={busy}
                  danger
                  onClick={() => {
                    setConfirmDeleteServer({
                      serverId: selected.serverId,
                      label: selected.label,
                    });
                  }}
                />
                <ActionButton
                  label="Health Check"
                  pending={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const diagnostic = await runMcpServerHealthCheck(selected.serverId);
                      setDiagnosticByServerId((current) => ({
                        ...current,
                        [selected.serverId]: diagnostic,
                      }));
                      setError(null);
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              </div>
              <p className="office-subtitle">{describeMcpBlockReason(selected)}</p>
              {selectedConnector ? (
                <div className="prompt-lab-run-summary">
                  <p>
                    <strong>Approval delivery</strong> {" "}
                    <span className={`token-chip ${readConnectorApprovalReady(selectedConnector) ? "token-chip-active" : ""}`}>
                      {readConnectorApprovalReady(selectedConnector) ? "ready" : "not ready"}
                    </span>
                  </p>
                  <p className="office-subtitle">{describeConnectorApprovalDelivery(selectedConnector)}</p>
                </div>
              ) : null}
              {selectedDiagnostic ? (
                <details open>
                  <summary>
                    Latest health check: {selectedDiagnostic.status}
                    {" • "}
                    {new Date(selectedDiagnostic.checkedAt).toLocaleString()}
                  </summary>
                  <ul className="improvement-simple-list">
                    {selectedDiagnostic.checks.map((check) => (
                      <li key={`${check.key}:${check.message}`}>
                        <strong>{check.key}</strong> [{check.status}] - {check.message}
                      </li>
                    ))}
                  </ul>
                  {selectedDiagnostic.recommendedNextAction ? (
                    <p className="office-subtitle">
                      Next step: {selectedDiagnostic.recommendedNextAction}
                    </p>
                  ) : null}
                </details>
              ) : null}
              <div className="controls-row">
                <label className="checkbox-inline">
                  <GCSwitch
                    checked={policyRequireFirst}
                    onCheckedChange={(checked) => {
                      setPolicyRequireFirst(checked);
                      setPolicyDirty(true);
                    }}
                    label="Require first-use approval"
                  />
                </label>
                <label htmlFor="mcpPolicyRedaction">Redaction mode</label>
                <GCSelect
                  id="mcpPolicyRedaction"
                  value={policyRedaction}
                  onChange={(value) => {
                    setPolicyRedaction(value as "off" | "basic" | "strict");
                    setPolicyDirty(true);
                  }}
                  options={[
                    { value: "off", label: "off" },
                    { value: "basic", label: "basic" },
                    { value: "strict", label: "strict" },
                  ]}
                />
              </div>
              <div className="controls-row">
                <label htmlFor="mcpAllowedPatterns">Allow patterns</label>
                <input
                  id="mcpAllowedPatterns"
                  placeholder="search.*, fetch"
                  value={policyAllowed}
                  onChange={(event) => {
                    setPolicyAllowed(event.target.value);
                    setPolicyDirty(true);
                  }}
                />
              </div>
              <div className="controls-row">
                <label htmlFor="mcpBlockedPatterns">Block patterns</label>
                <input
                  id="mcpBlockedPatterns"
                  placeholder="admin.*, shell.*"
                  value={policyBlocked}
                  onChange={(event) => {
                    setPolicyBlocked(event.target.value);
                    setPolicyDirty(true);
                  }}
                />
              </div>
              <div className="controls-row">
                <label htmlFor="mcpPolicyNotes">Notes</label>
                <input
                  id="mcpPolicyNotes"
                  placeholder="Optional policy note"
                  value={policyNotes}
                  onChange={(event) => {
                    setPolicyNotes(event.target.value);
                    setPolicyDirty(true);
                  }}
                />
                <ActionButton
                  label="Save Policy"
                  pending={busy}
                  disabled={!policyDirty}
                  onClick={async () => {
                    if (!selected) {
                      return;
                    }
                    setBusy(true);
                    try {
                      await updateMcpServerPolicy(selected.serverId, {
                        requireFirstToolApproval: policyRequireFirst,
                        redactionMode: policyRedaction,
                        allowedToolPatterns: policyAllowed.split(",").map((item) => item.trim()).filter(Boolean),
                        blockedToolPatterns: policyBlocked.split(",").map((item) => item.trim()).filter(Boolean),
                        notes: policyNotes.trim() || undefined,
                      });
                      setPolicyDirty(false);
                      await loadServers();
                      setError(null);
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              </div>
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel
        title="Tool Catalog"
        subtitle="Inspect exposed tools for the selected server and do low-risk invocation checks."
      >
        {!selected ? <p className="office-subtitle">Select a server to inspect and invoke tools.</p> : null}
        <div className="virtual-list-shell">
          <Virtuoso
            data={tools}
            itemContent={(_index, tool) => (
              <div className="virtual-list-item" key={`${tool.serverId}:${tool.toolName}`}>
                <strong>{tool.toolName}</strong>
                {tool.description ? <p className="chat-item-meta">{tool.description}</p> : null}
              </div>
            )}
          />
        </div>
        {selected ? (
          <DataToolbar
            primary={(
              <div className="controls-row">
                <input value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder="tool name" />
                <input value={toolArgs} onChange={(event) => setToolArgs(event.target.value)} placeholder='{"query":"hello"}' />
              </div>
            )}
            secondary={(
              <ActionButton
                label="Invoke Tool"
                pending={busy}
                onClick={async () => {
                  if (!selected || !toolName.trim()) {
                    return;
                  }
                  setBusy(true);
                  try {
                    const parsedArgs = toolArgs.trim() ? JSON.parse(toolArgs) as Record<string, unknown> : {};
                    const response = await invokeMcpTool({
                      serverId: selected.serverId,
                      toolName: toolName.trim(),
                      arguments: parsedArgs,
                    });
                    setResult(JSON.stringify(response, null, 2));
                    setError(null);
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}
          />
        ) : null}
        {result ? (
          <pre>{result}</pre>
        ) : null}
      </Panel>
      {selected && selectedIsInternalApprovalInbox ? (
        <Panel
          title="Approval Inbox"
          subtitle="Resolve non-browser approval deliveries that arrive through the internal MCP approval inbox."
        >
          <div className="controls-row">
            <label htmlFor="approvalInboxState">State</label>
            <GCSelect
              id="approvalInboxState"
              value={inboxFilterState}
              onChange={(value) => setInboxFilterState(value as ApprovalInboxFilterState)}
              options={[
                { value: "pending", label: "pending" },
                { value: "all", label: "all" },
                { value: "approved", label: "approved" },
                { value: "rejected", label: "rejected" },
                { value: "edited", label: "edited" },
                { value: "expired", label: "expired" },
                { value: "failed", label: "failed" },
              ]}
            />
            <ActionButton
              label="Refresh Inbox"
              pending={inboxBusy}
              onClick={() => void loadApprovalInbox(selected.serverId, inboxFilterState)}
            />
          </div>
          <p className="office-subtitle">
            This inbox is the internal non-browser receiver for durable approval actions. Each item keeps token state,
            delivery count, and terminal resolution details for later debugging.
          </p>
          {selected.status !== "connected" ? (
            <p className="office-subtitle">Connect this server before loading approval inbox items.</p>
          ) : null}
          {inboxError ? <p className="error">{inboxError}</p> : null}
          <div className="stack-md">
            {inboxItems.map((item) => (
              <div key={item.inboxItemId} className="prompt-lab-run-summary">
                <p>
                  <strong>{item.approvalKind}</strong>
                  <span className="token-chip" style={{ marginLeft: 8 }}>{item.state}</span>
                  <span className="token-chip" style={{ marginLeft: 8 }}>{item.riskLevel}</span>
                  <span className="token-chip" style={{ marginLeft: 8 }}>deliveries {item.deliveryCount}</span>
                </p>
                <p className="office-subtitle">{summarizeApprovalPreview(item.preview)}</p>
                <p className="office-subtitle">
                  Approval {item.approvalId} | token {item.tokenId} | expires {new Date(item.expiresAt).toLocaleString()}
                </p>
                {item.lastError ? (
                  <p className="office-subtitle">Last error: {item.lastError}</p>
                ) : null}
                {item.state === "pending" ? (
                  <div className="actions">
                    <ActionButton
                      label="Approve"
                      pending={pendingInboxActionId === item.inboxItemId}
                      disabled={pendingInboxActionId !== null && pendingInboxActionId !== item.inboxItemId}
                      onClick={() => void handleResolveInboxItem(item, "approve")}
                    />
                    <ActionButton
                      label="Reject"
                      pending={pendingInboxActionId === item.inboxItemId}
                      disabled={pendingInboxActionId !== null && pendingInboxActionId !== item.inboxItemId}
                      danger
                      onClick={() => void handleResolveInboxItem(item, "reject")}
                    />
                  </div>
                ) : (
                  <p className="office-subtitle">
                    Resolved {item.resolvedAt ? new Date(item.resolvedAt).toLocaleString() : "pending timestamp"}
                    {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
                  </p>
                )}
              </div>
            ))}
            {!inboxBusy && inboxItems.length === 0 && selected.status === "connected" ? (
              <p className="office-subtitle">No approval inbox items matched the current filter.</p>
            ) : null}
          </div>
        </Panel>
      ) : null}
      <ConfirmModal
        open={Boolean(confirmDeleteServer)}
        title="Delete MCP Server"
        message={`Delete "${confirmDeleteServer?.label ?? "this MCP server"}"? This cannot be undone.`}
        confirmLabel={busy ? "Deleting..." : "Delete"}
        danger
        onCancel={() => setConfirmDeleteServer(null)}
        onConfirm={() => {
          const target = confirmDeleteServer;
          if (!target) {
            return;
          }
          setConfirmDeleteServer(null);
          void (async () => {
            setBusy(true);
            try {
              await deleteMcpServer(target.serverId);
              await loadServers();
              setError(null);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          })();
        }}
      />
    </section>
  );
}

function formatMcpError(message: string): string {
  if (message.includes("Unknown MCP server")) {
    return "That MCP server no longer exists. Select another server from the list or add one from the template library.";
  }
  if (message.startsWith("API error")) {
    return `MCP request failed: ${message}`;
  }
  return message;
}

function describeMcpBlockReason(server: {
  status: "disconnected" | "connecting" | "connected" | "error";
  enabled: boolean;
  trustTier: "trusted" | "restricted" | "quarantined";
  policy: {
    requireFirstToolApproval: boolean;
    blockedToolPatterns: string[];
    allowedToolPatterns: string[];
  };
}): string {
  if (!server.enabled) {
    return "Server is disabled. Enable it before any MCP tools can run.";
  }
  if (server.status !== "connected") {
    return "Server is not connected yet. Connect first, then invoke tools.";
  }
  if (server.trustTier === "quarantined") {
    return "Trust tier is quarantined, so all tool execution is blocked.";
  }
  if (server.policy.requireFirstToolApproval) {
    return "First tool execution requires explicit approval.";
  }
  if (server.policy.blockedToolPatterns.length > 0) {
    return "Some tool names are blocked by policy patterns.";
  }
  if (server.policy.allowedToolPatterns.length > 0) {
    return "Only tool names matching allow patterns can run.";
  }
  return "No active policy blocks detected.";
}

function parseApprovalInboxItems(value: unknown): ApprovalInboxItemRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ApprovalInboxItemRecord => (
    Boolean(item)
    && typeof item === "object"
    && typeof (item as ApprovalInboxItemRecord).inboxItemId === "string"
    && typeof (item as ApprovalInboxItemRecord).approvalId === "string"
  ));
}

function readConnectorApprovalReady(connector: ConnectorRecord): boolean {
  return connector.metadata?.approvalDeliveryReady === true;
}

function describeConnectorApprovalDelivery(connector: ConnectorRecord): string {
  const reason = typeof connector.metadata?.approvalDeliveryReason === "string"
    ? connector.metadata.approvalDeliveryReason
    : "No approval delivery details reported.";
  const mode = typeof connector.metadata?.approvalDeliveryMode === "string"
    ? connector.metadata.approvalDeliveryMode
    : undefined;
  if (!mode) {
    return reason;
  }
  return `${mode}: ${reason}`;
}

function summarizeApprovalPreview(preview: Record<string, unknown>): string {
  const summary = preview.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim();
  }
  const serialized = JSON.stringify(preview);
  if (!serialized || serialized === "{}") {
    return "No preview summary provided.";
  }
  return serialized.length <= 220 ? serialized : `${serialized.slice(0, 217)}...`;
}
