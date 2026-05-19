/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useMemo, useState } from "react";
import type { ToolAccessEvaluateResponse, ToolCatalogEntry, ToolGrantRecord } from "@goatcitadel/contracts";
import {
  createToolGrant,
  evaluateToolAccess,
  fetchAgents,
  fetchChatSessions,
  fetchSettings,
  fetchToolCatalog,
  fetchToolGrants,
  invokeTool,
  patchSettings,
  revokeToolGrant,
} from "../api/client";
import { PageGuideCard } from "../components/PageGuideCard";
import { CardSkeleton } from "../components/CardSkeleton";
import { HelpHint } from "../components/HelpHint";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { GCCombobox, GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { useUiPreferences } from "../state/ui-preferences";
import { ToolAccessModesPanel } from "./tools/ToolAccessModesPanel";
import { ToolActiveGrantsPanel } from "./tools/ToolActiveGrantsPanel";
import { ToolCatalogPanel } from "./tools/ToolCatalogPanel";
import {
  dedupeOptions,
  ensureCurrentOption,
  formatSessionOption,
  toDatetimeLocalValue,
  type IdOption,
} from "./tools/tools-page-helpers";

type GrantScope = "global" | "session" | "workspace" | "agent" | "task";
type GrantType = "one_time" | "ttl" | "persistent";
type GrantDecision = "allow" | "deny";
type QuickPreset = "web" | "files-read" | "devops";

interface ToolProfilePreset {
  id: string;
  label: string;
  helper: string;
}

const QUICK_PRESET_TOOLS: Record<QuickPreset, string[]> = {
  web: ["browser.search", "browser.navigate", "browser.extract", "http.get"],
  "files-read": ["fs.list", "fs.read", "fs.stat"],
  devops: ["git.status", "git.diff", "tests.run", "lint.run", "build.run"],
};

const TOOL_ARG_EXAMPLES: Record<string, Record<string, unknown>> = {
  "fs.list": { path: "./workspace" },
  "fs.read": { path: "./workspace/README.md" },
  "fs.stat": { path: "./workspace" },
  "browser.search": { query: "weather 91303 today", maxResults: 5 },
  "browser.navigate": { url: "https://weather.gov" },
  "browser.extract": { url: "https://weather.gov", selector: "body", maxChars: 3000 },
  "http.get": { url: "https://api.github.com/repos/openai/openai-node" },
  "git.status": {},
  "git.diff": { staged: false },
  "tests.run": { manager: "pnpm", filter: "@goatcitadel/gateway" },
};

const TOOL_PROFILE_PRESETS: ToolProfilePreset[] = [
  { id: "minimal", label: "Safe Day", helper: "Minimal tool access. Best for cautious tasks and review days." },
  { id: "standard", label: "Balanced Day", helper: "General purpose profile for normal operations." },
  { id: "coding", label: "Builder Day", helper: "Stronger coding/toolchain focus for implementation work." },
  { id: "ops", label: "Ops Day", helper: "Operational tooling for deployment, diagnostics, and maintenance." },
  { id: "research", label: "Research Day", helper: "Discovery and information gathering focused workflows." },
  { id: "danger", label: "Power Day", helper: "High-risk profile. Use only when you intentionally need broad power." },
];

export function ToolsPage() {
  const { mode: uiMode, showTechnicalDetails, setShowTechnicalDetails, activeWorkspaceId } = useUiPreferences();
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  const [grants, setGrants] = useState<ToolGrantRecord[]>([]);
  const [agentOptions, setAgentOptions] = useState<IdOption[]>([{ value: "operator", label: "operator (you)" }]);
  const [sessionOptions, setSessionOptions] = useState<IdOption[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [grantFilter, setGrantFilter] = useState("");
  const [catalogFilter, setCatalogFilter] = useState("");
  const [currentToolProfile, setCurrentToolProfile] = useState("standard");
  const [profileSwitchBusy, setProfileSwitchBusy] = useState<string | null>(null);

  const [toolPattern, setToolPattern] = useState("fs.list");
  const [decision, setDecision] = useState<GrantDecision>("allow");
  const [scope, setScope] = useState<GrantScope>("session");
  const [scopeRef, setScopeRef] = useState("demo-session");
  const [grantType, setGrantType] = useState<GrantType>("ttl");
  const [expiresAt, setExpiresAt] = useState("");
  const [workingPreset, setWorkingPreset] = useState<QuickPreset | null>(null);
  const [creatingGrant, setCreatingGrant] = useState(false);
  const [grantWizardStep, setGrantWizardStep] = useState<1 | 2 | 3>(1);
  const [grantAdvanced, setGrantAdvanced] = useState(false);

  const [evaluateForm, setEvaluateForm] = useState({
    toolName: "fs.list",
    agentId: "operator",
    sessionId: "demo-session",
    taskId: "",
  });
  const [evaluateResult, setEvaluateResult] = useState<ToolAccessEvaluateResponse | null>(null);

  const [dryRunForm, setDryRunForm] = useState({
    toolName: "fs.list",
    argsJson: JSON.stringify({ path: "./workspace" }, null, 2),
    agentId: "operator",
    sessionId: "demo-session",
    taskId: "",
  });
  const [dryRunResult, setDryRunResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!showTechnicalDetails && grantAdvanced) {
      setGrantAdvanced(false);
    }
  }, [grantAdvanced, showTechnicalDetails]);

  const catalogByPack = useMemo(() => {
    const q = catalogFilter.trim().toLowerCase();
    const source =
      q.length > 0
        ? catalog.filter((item) => `${item.toolName} ${item.category} ${item.description}`.toLowerCase().includes(q))
        : catalog;
    return {
      core: source.filter((item) => item.pack === "core"),
      devops: source.filter((item) => item.pack === "devops"),
      knowledge: source.filter((item) => item.pack === "knowledge"),
      comms: source.filter((item) => item.pack === "comms"),
    };
  }, [catalog, catalogFilter]);

  const visibleGrants = useMemo(() => {
    const q = grantFilter.trim().toLowerCase();
    if (!q) {
      return grants;
    }
    return grants.filter((grant) =>
      `${grant.toolPattern} ${grant.decision} ${grant.scope}:${grant.scopeRef} ${grant.grantType}`
        .toLowerCase()
        .includes(q),
    );
  }, [grantFilter, grants]);

  const selectedTool = useMemo(() => catalog.find((entry) => entry.toolName === toolPattern), [catalog, toolPattern]);
  const selectedDryRunTool = useMemo(
    () => catalog.find((entry) => entry.toolName === dryRunForm.toolName),
    [catalog, dryRunForm.toolName],
  );
  const scopeRefHint =
    scope === "global"
      ? "Global grants apply everywhere. Scope ref is not needed."
      : scope === "session"
        ? "Pick a session from the dropdown (scoped to one conversation)."
        : scope === "workspace"
          ? `Workspace grants apply across ${activeWorkspaceId} until you revoke them.`
          : scope === "agent"
            ? "Pick an agent from the dropdown."
            : "Task ID example: task_abc123... (most specific scope).";
  const recommendedScope: GrantScope = "session";
  const isRecommendedScope = scope === recommendedScope;
  const grantSummary = `${decision.toUpperCase()} ${toolPattern}${scope === "global" ? " globally" : ` for ${scope} ${scopeRef || "(missing scope ref)"}`}`;
  const canProceedStep1 = scope === "global" || scopeRef.trim().length > 0;
  const canProceedStep2 = toolPattern.trim().length > 0;
  const requiresTtlExpiration = grantType === "ttl";
  const canCreateGrant = canProceedStep1 && canProceedStep2 && (!requiresTtlExpiration || expiresAt.trim().length > 0);

  useEffect(() => {
    if (grantAdvanced) {
      return;
    }
    setDecision("allow");
    if (grantType === "ttl") {
      setGrantType("persistent");
      setExpiresAt("");
    }
  }, [grantAdvanced, grantType]);

  useEffect(() => {
    void load({ background: false });
  }, []);

  useRefreshSubscription(
    "tools",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 900,
      staleMs: 20000,
      pollIntervalMs: 15000,
    },
  );

  async function load(options?: { background?: boolean }) {
    const background = options?.background ?? false;
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    setError(null);
    try {
      const sessionsPromise = background
        ? Promise.resolve<Awaited<ReturnType<typeof fetchChatSessions>> | null>(null)
        : fetchChatSessions({ scope: "all", view: "all", limit: 500 });
      const agentsPromise = background
        ? Promise.resolve<Awaited<ReturnType<typeof fetchAgents>> | null>(null)
        : fetchAgents("all", 300);
      const settingsPromise = background
        ? Promise.resolve<Awaited<ReturnType<typeof fetchSettings>> | null>(null)
        : fetchSettings();
      const [catalogRes, grantsRes, sessionsRes, agentsRes, settingsRes] = await Promise.all([
        fetchToolCatalog(),
        fetchToolGrants({ limit: 500 }),
        sessionsPromise,
        agentsPromise,
        settingsPromise,
      ]);
      setCatalog(catalogRes.items);
      setGrants(grantsRes.items);
      if (settingsRes) {
        setCurrentToolProfile(settingsRes.defaultToolProfile || "standard");
      }
      setSuccess(null);
      if (sessionsRes && agentsRes) {
        const nextSessionOptions = sessionsRes.items.map((session) => ({
          value: session.sessionId,
          label: formatSessionOption(session),
        }));
        const nextAgentOptions = dedupeOptions([
          { value: "operator", label: "operator (you)" },
          ...agentsRes.items.map((agent) => ({
            value: agent.agentId,
            label: `${agent.name} (${agent.agentId})`,
          })),
        ]);
        setSessionOptions(nextSessionOptions);
        setAgentOptions(nextAgentOptions);
        const defaultSession = nextSessionOptions[0]?.value;
        const defaultAgent =
          nextAgentOptions.find((option) => option.value === "operator")?.value ??
          nextAgentOptions[0]?.value ??
          "operator";
        setScopeRef((current) => {
          if (scope === "session" && (current === "demo-session" || !current.trim()) && defaultSession) {
            return defaultSession;
          }
          if (scope === "workspace" && (!current.trim() || current === "demo-session")) {
            return activeWorkspaceId;
          }
          if (scope === "agent" && (current === "demo-session" || !current.trim())) {
            return defaultAgent;
          }
          return current;
        });
        setEvaluateForm((current) => ({
          ...current,
          agentId: current.agentId === "operator" || !current.agentId.trim() ? defaultAgent : current.agentId,
          sessionId:
            (current.sessionId === "demo-session" || !current.sessionId.trim()) && defaultSession
              ? defaultSession
              : current.sessionId,
        }));
        setDryRunForm((current) => ({
          ...current,
          agentId: current.agentId === "operator" || !current.agentId.trim() ? defaultAgent : current.agentId,
          sessionId:
            (current.sessionId === "demo-session" || !current.sessionId.trim()) && defaultSession
              ? defaultSession
              : current.sessionId,
        }));
      }
      if (catalogRes.items.length > 0) {
        const first = catalogRes.items[0]?.toolName;
        if (first) {
          setToolPattern((current) => current || first);
          setEvaluateForm((current) => ({ ...current, toolName: current.toolName || first }));
          setDryRunForm((current) => ({ ...current, toolName: current.toolName || first }));
        }
      }
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (background) {
        setIsRefreshing(false);
      } else {
        setIsInitialLoading(false);
      }
    }
  }

  async function onCreateGrant() {
    const normalizedScopeRef = scope === "global" ? undefined : scopeRef.trim();
    if (scope !== "global" && !normalizedScopeRef) {
      setError("Scope ref is required for session, workspace, agent, and task grants.");
      return;
    }
    if (!toolPattern.trim()) {
      setError("Select a tool first.");
      return;
    }
    setCreatingGrant(true);
    try {
      setError(null);
      const input = {
        toolPattern: toolPattern.trim(),
        decision,
        scope,
        scopeRef: normalizedScopeRef || undefined,
        grantType,
        expiresAt: expiresAt.trim() || undefined,
      } as const;
      await createToolGrant(input);
      await load({ background: true });
      setSuccess(`Grant created: ${input.decision} ${input.toolPattern}`);
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setCreatingGrant(false);
    }
  }

  async function onApplyQuickPreset(preset: QuickPreset) {
    const normalizedScopeRef = scope === "global" ? undefined : scopeRef.trim();
    if (scope !== "global" && !normalizedScopeRef) {
      setError("Enter a scope ref before applying a quick preset.");
      return;
    }
    setWorkingPreset(preset);
    setError(null);
    setSuccess(null);
    try {
      const tools = QUICK_PRESET_TOOLS[preset];
      for (const tool of tools) {
        await createToolGrant({
          toolPattern: tool,
          decision: "allow",
          scope,
          scopeRef: normalizedScopeRef || undefined,
          grantType: "persistent",
        });
      }
      await load({ background: true });
      setSuccess(`Applied preset "${preset}" (${tools.length} grants).`);
    } catch (presetError) {
      setError((presetError as Error).message);
    } finally {
      setWorkingPreset(null);
    }
  }

  async function onApplyToolProfile(profileId: string) {
    if (!profileId.trim()) {
      return;
    }
    setProfileSwitchBusy(profileId);
    setError(null);
    setSuccess(null);
    try {
      const settings = await patchSettings({
        defaultToolProfile: profileId.trim(),
      });
      setCurrentToolProfile(settings.defaultToolProfile || profileId.trim());
      setSuccess(`Active tool profile switched to "${settings.defaultToolProfile || profileId.trim()}".`);
    } catch (profileError) {
      setError((profileError as Error).message);
    } finally {
      setProfileSwitchBusy(null);
    }
  }

  async function onRevoke(grantId: string) {
    try {
      setError(null);
      await revokeToolGrant(grantId);
      await load({ background: true });
      setSuccess(`Grant revoked: ${grantId}`);
    } catch (revokeError) {
      setError((revokeError as Error).message);
    }
  }

  async function onEvaluate() {
    try {
      setError(null);
      const result = await evaluateToolAccess({
        toolName: evaluateForm.toolName.trim(),
        agentId: evaluateForm.agentId.trim(),
        sessionId: evaluateForm.sessionId.trim(),
        workspaceId: activeWorkspaceId,
        taskId: evaluateForm.taskId.trim() || undefined,
      });
      setEvaluateResult(result);
      setSuccess("Access check complete.");
    } catch (evaluateError) {
      setError((evaluateError as Error).message);
    }
  }

  async function onDryRun() {
    try {
      setError(null);
      const args = JSON.parse(dryRunForm.argsJson) as Record<string, unknown>;
      const result = await invokeTool({
        toolName: dryRunForm.toolName.trim(),
        args,
        agentId: dryRunForm.agentId.trim(),
        sessionId: dryRunForm.sessionId.trim(),
        workspaceId: activeWorkspaceId,
        taskId: dryRunForm.taskId.trim() || undefined,
        dryRun: true,
        consentContext: {
          source: "ui",
          reason: "tool access dry-run",
        },
      });
      setDryRunResult(result as unknown as Record<string, unknown>);
      setSuccess("Dry-run completed.");
    } catch (dryRunError) {
      setError((dryRunError as Error).message);
    }
  }

  function onUseDryRunExample() {
    const example = TOOL_ARG_EXAMPLES[dryRunForm.toolName] ?? {};
    setDryRunForm((current) => ({
      ...current,
      argsJson: JSON.stringify(example, null, 2),
    }));
  }

  function onWizardNext() {
    if (grantWizardStep === 1 && !canProceedStep1) {
      setError("Enter scope ref before continuing.");
      return;
    }
    if (grantWizardStep === 2 && !canProceedStep2) {
      setError("Pick a tool before continuing.");
      return;
    }
    setError(null);
    setGrantWizardStep((current) => (current < 3 ? ((current + 1) as 1 | 2 | 3) : current));
  }

  function onWizardBack() {
    setGrantWizardStep((current) => (current > 1 ? ((current - 1) as 1 | 2 | 3) : current));
  }

  function onWizardJump(step: 1 | 2 | 3) {
    if (step > 1 && !canProceedStep1) {
      setError("Complete step 1 first.");
      return;
    }
    if (step > 2 && !canProceedStep2) {
      setError("Complete step 2 first.");
      return;
    }
    setError(null);
    setGrantWizardStep(step);
  }

  function onApplyRecommendedScope() {
    setScope("session");
    if (!scopeRef.trim() || scopeRef === "demo-session") {
      setScopeRef(sessionOptions[0]?.value ?? "");
    }
  }

  function onScopeChange(nextScope: GrantScope) {
    setScope(nextScope);
    if (nextScope === "global") {
      setScopeRef("");
      return;
    }
    if (nextScope === "workspace") {
      setScopeRef(activeWorkspaceId);
      return;
    }
    if (nextScope === "session") {
      if (sessionOptions.some((option) => option.value === scopeRef)) {
        return;
      }
      setScopeRef(sessionOptions[0]?.value ?? scopeRef);
      return;
    }
    if (nextScope === "agent") {
      if (agentOptions.some((option) => option.value === scopeRef)) {
        return;
      }
      setScopeRef(agentOptions[0]?.value ?? scopeRef);
      return;
    }
  }

  const selectedScopeRefOptions = useMemo(() => {
    if (scope === "workspace") {
      return [{ value: activeWorkspaceId, label: `Workspace (${activeWorkspaceId})` }];
    }
    if (scope === "session") {
      return ensureCurrentOption(sessionOptions, scopeRef, "Current session");
    }
    if (scope === "agent") {
      return ensureCurrentOption(agentOptions, scopeRef, "Current agent");
    }
    return [];
  }, [activeWorkspaceId, agentOptions, scope, scopeRef, sessionOptions]);

  const evaluateAgentOptions = useMemo(
    () => ensureCurrentOption(agentOptions, evaluateForm.agentId, "Current agent"),
    [agentOptions, evaluateForm.agentId],
  );
  const evaluateSessionOptions = useMemo(
    () => ensureCurrentOption(sessionOptions, evaluateForm.sessionId, "Current session"),
    [evaluateForm.sessionId, sessionOptions],
  );
  const dryRunAgentOptions = useMemo(
    () => ensureCurrentOption(agentOptions, dryRunForm.agentId, "Current agent"),
    [agentOptions, dryRunForm.agentId],
  );
  const dryRunSessionOptions = useMemo(
    () => ensureCurrentOption(sessionOptions, dryRunForm.sessionId, "Current session"),
    [dryRunForm.sessionId, sessionOptions],
  );

  useEffect(() => {
    if (scope === "workspace") {
      setScopeRef(activeWorkspaceId);
    }
  }, [activeWorkspaceId, scope]);

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Operate"
        title={pageCopy.tools.title}
        subtitle={pageCopy.tools.subtitle}
        hint="Use profiles, scoped grants, and dry-runs to widen tool access deliberately instead of all at once."
        density="compact"
      />

      <PageGuideCard
        pageId="tools"
        what={pageCopy.tools.guide?.what ?? ""}
        when={pageCopy.tools.guide?.when ?? ""}
        actions={pageCopy.tools.guide?.actions ?? []}
        terms={pageCopy.tools.guide?.terms}
      />

      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {success ? <p className="status-banner">{success}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing tool access data...</p> : null}
        <p className="office-subtitle">
          {currentToolProfile} profile · {grants.length} scoped grants · {catalog.length} tools in catalog
        </p>
      </div>
      {isInitialLoading ? <CardSkeleton lines={8} /> : null}

      <div className="tools-command-center">
        <div className="tools-command-main">
          <ToolAccessModesPanel
            currentToolProfile={currentToolProfile}
            profileSwitchBusy={profileSwitchBusy}
            presets={TOOL_PROFILE_PRESETS}
            showTechnicalDetails={showTechnicalDetails}
            setShowTechnicalDetails={setShowTechnicalDetails}
            uiMode={uiMode}
            onApplyToolProfile={onApplyToolProfile}
          />

          <Panel
            title="Create Grant"
            subtitle="Use this wizard for most cases. Turn on advanced settings only when you need wildcard patterns or custom duration."
          >
            <div className="tools-wizard-steps">
              <button
                type="button"
                className={["gc-button", grantWizardStep === 1 ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => onWizardJump(1)}
              >
                1. Who
              </button>
              <button
                type="button"
                className={["gc-button", grantWizardStep === 2 ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => onWizardJump(2)}
              >
                2. What
              </button>
              <button
                type="button"
                className={["gc-button", grantWizardStep === 3 ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => onWizardJump(3)}
              >
                3. How Long
              </button>
            </div>

            {showTechnicalDetails ? (
              <label className="tools-advanced-toggle">
                <input
                  type="checkbox"
                  checked={grantAdvanced}
                  onChange={(event) => setGrantAdvanced(event.target.checked)}
                />
                Advanced settings
              </label>
            ) : (
              <p className="tools-helper">
                Advanced settings are hidden. Turn on technical controls above to customize more.
              </p>
            )}

            {grantWizardStep === 1 ? (
              <div className="advanced-block">
                <div className="controls-row">
                  <label>
                    Scope
                    <HelpHint
                      label="Scope help"
                      text="More specific scopes win. Order is task > agent > session > workspace > global."
                    />
                  </label>
                  <GCSelect
                    value={scope}
                    onChange={(value) => onScopeChange(value as GrantScope)}
                    options={[
                      { value: "global", label: "Global" },
                      { value: "session", label: "Session" },
                      { value: "workspace", label: "Workspace" },
                      { value: "agent", label: "Agent" },
                      { value: "task", label: "Task" },
                    ]}
                  />
                </div>
                <div className={`tools-recommend ${isRecommendedScope ? "ok" : "warn"}`}>
                  <p>
                    Recommended for most new grants: <strong>Session</strong> scope. It limits access to one
                    conversation while you test safely.
                  </p>
                  {!isRecommendedScope ? (
                    <button type="button" onClick={onApplyRecommendedScope} className="gc-button">
                      Use recommended scope
                    </button>
                  ) : (
                    <span className="token-chip">Using recommended scope</span>
                  )}
                </div>
                <div className="controls-row">
                  <label>
                    Scope ref
                    <HelpHint
                      label="Scope reference help"
                      text="Choose exactly where this grant applies. Session, workspace, and agent options are loaded for you."
                    />
                  </label>
                  {scope === "session" || scope === "workspace" || scope === "agent" ? (
                    <GCCombobox
                      value={scopeRef}
                      onChange={setScopeRef}
                      disabled={selectedScopeRefOptions.length === 0}
                      options={
                        selectedScopeRefOptions.length === 0
                          ? [{ value: "", label: `No ${scope} options found` }]
                          : selectedScopeRefOptions
                      }
                      placeholder={`Choose ${scope}`}
                    />
                  ) : (
                    <input
                      value={scopeRef}
                      onChange={(event) => setScopeRef(event.target.value)}
                      placeholder={scope === "global" ? "Not required for global" : "task id"}
                      disabled={scope === "global"}
                    />
                  )}
                </div>
                <p className="tools-helper">{scopeRefHint}</p>
              </div>
            ) : null}

            {grantWizardStep === 2 ? (
              <div className="advanced-block">
                <div className="actions">
                  <button
                    type="button"
                    disabled={workingPreset !== null}
                    onClick={() => void onApplyQuickPreset("web")}
                    className="gc-button"
                  >
                    {workingPreset === "web" ? "Applying..." : "Quick: Web Assistant"}
                  </button>
                  <button
                    type="button"
                    disabled={workingPreset !== null}
                    onClick={() => void onApplyQuickPreset("files-read")}
                    className="gc-button"
                  >
                    {workingPreset === "files-read" ? "Applying..." : "Quick: File Read"}
                  </button>
                  <button
                    type="button"
                    disabled={workingPreset !== null}
                    onClick={() => void onApplyQuickPreset("devops")}
                    className="gc-button"
                  >
                    {workingPreset === "devops" ? "Applying..." : "Quick: DevOps Read"}
                  </button>
                </div>
                <div className="controls-row">
                  <label>
                    Tool
                    <HelpHint
                      label="Tool help"
                      text="Pick the exact tool to allow or deny. Use * only for advanced wildcard rules."
                    />
                  </label>
                  <GCCombobox
                    value={toolPattern}
                    onChange={setToolPattern}
                    placeholder="Pick tool"
                    options={[
                      ...catalog.map((entry) => ({
                        value: entry.toolName,
                        label: `${entry.toolName} (${entry.riskLevel})`,
                      })),
                      ...(grantAdvanced ? [{ value: "*", label: "*" }] : []),
                    ]}
                  />
                </div>
                {selectedTool ? (
                  <p className="tools-helper">
                    Risk: <strong>{selectedTool.riskLevel}</strong> | Category: {selectedTool.category} |{" "}
                    {selectedTool.description}
                  </p>
                ) : null}
                {grantAdvanced ? (
                  <div className="controls-row">
                    <label>
                      Decision
                      <HelpHint
                        label="Decision help"
                        text="Allow lets the tool run in this scope. Deny blocks it, even if broader scopes allow it."
                      />
                    </label>
                    <GCSelect
                      value={decision}
                      onChange={(value) => setDecision(value as GrantDecision)}
                      options={[
                        { value: "allow", label: "Allow" },
                        { value: "deny", label: "Deny" },
                      ]}
                    />
                  </div>
                ) : (
                  <p className="tools-helper">
                    Decision: <strong>Allow</strong> (basic mode)
                  </p>
                )}
              </div>
            ) : null}

            {grantWizardStep === 3 ? (
              <div className="advanced-block">
                <div className="controls-row">
                  <label>
                    Duration
                    <HelpHint
                      label="Grant type help"
                      text="One-time expires after one use. Persistent remains until revoked. TTL is available in advanced settings."
                    />
                  </label>
                  <GCSelect
                    value={grantType}
                    onChange={(value) => setGrantType(value as GrantType)}
                    options={[
                      { value: "one_time", label: "One-time" },
                      { value: "persistent", label: "Persistent" },
                      ...(grantAdvanced ? [{ value: "ttl", label: "Expires at time (TTL)" }] : []),
                    ]}
                  />
                </div>
                {grantType === "ttl" ? (
                  <div className="controls-row">
                    <label>
                      Expires at (UTC)
                      <HelpHint label="Expiration help" text="Required for TTL grants. Pick a time after now." />
                    </label>
                    <input
                      type="datetime-local"
                      value={toDatetimeLocalValue(expiresAt)}
                      onChange={(event) =>
                        setExpiresAt(event.target.value ? new Date(event.target.value).toISOString() : "")
                      }
                    />
                  </div>
                ) : null}
                {grantAdvanced ? (
                  <div className="controls-row">
                    <label>
                      Grant provenance
                      <HelpHint
                        label="Grant provenance help"
                        text="The gateway stamps the authenticated operator when it creates the grant."
                      />
                    </label>
                    <p className="tools-summary">Stamped by the gateway from the current operator session.</p>
                  </div>
                ) : null}
                <p className="tools-summary">Summary: {grantSummary}</p>
              </div>
            ) : null}

            <div className="actions tools-wizard-actions">
              <button type="button" onClick={onWizardBack} disabled={grantWizardStep === 1} className="gc-button">
                Back
              </button>
              {grantWizardStep < 3 ? (
                <button type="button" onClick={onWizardNext} className="gc-button">
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  disabled={creatingGrant || !canCreateGrant}
                  onClick={() => void onCreateGrant()}
                  className="gc-button"
                >
                  {creatingGrant ? "Creating..." : "Create Grant"}
                </button>
              )}
            </div>
          </Panel>
        </div>

        <div className="tools-command-side">
          <Panel title="Check Access" subtitle="Confirm whether a tool call would be allowed before you run it.">
            <div className="controls-row">
              <label>
                Tool
                <HelpHint
                  label="Evaluate tool help"
                  text="Choose the tool you want to test against current policy and grants."
                />
              </label>
              <GCSelect
                value={evaluateForm.toolName}
                onChange={(value) => setEvaluateForm((current) => ({ ...current, toolName: value }))}
                options={catalog.map((entry) => ({ value: entry.toolName, label: entry.toolName }))}
              />
            </div>
            <div className="controls-row">
              <label>Agent ID</label>
              <GCCombobox
                value={evaluateForm.agentId}
                onChange={(value) => setEvaluateForm((current) => ({ ...current, agentId: value }))}
                options={
                  evaluateAgentOptions.length === 0 ? [{ value: "", label: "No agents found" }] : evaluateAgentOptions
                }
                placeholder="Pick agent"
              />
            </div>
            <div className="controls-row">
              <label>Session ID</label>
              <GCCombobox
                value={evaluateForm.sessionId}
                onChange={(value) => setEvaluateForm((current) => ({ ...current, sessionId: value }))}
                options={
                  evaluateSessionOptions.length === 0
                    ? [{ value: "", label: "No sessions found" }]
                    : evaluateSessionOptions
                }
                placeholder="Pick session"
              />
            </div>
            <details className="advanced-panel">
              <summary>Advanced fields</summary>
              <div className="controls-row">
                <label>Task ID</label>
                <input
                  value={evaluateForm.taskId}
                  onChange={(event) => setEvaluateForm((current) => ({ ...current, taskId: event.target.value }))}
                />
              </div>
            </details>
            <div className="actions">
              <button type="button" onClick={() => void onEvaluate()} className="gc-button">
                Check Access
              </button>
            </div>
            {evaluateResult ? (
              <div className="replay-box">
                <p className="tools-summary">
                  Result: <strong>{evaluateResult.allowed ? "Allowed" : "Blocked"}</strong>
                  {" | "}
                  Risk: <strong>{evaluateResult.riskLevel}</strong>
                  {" | "}
                  Approval required: <strong>{evaluateResult.requiresApproval ? "Yes" : "No"}</strong>
                </p>
                {showTechnicalDetails ? (
                  <details>
                    <summary>Raw response</summary>
                    <pre>{JSON.stringify(evaluateResult, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
          </Panel>
        </div>
      </div>

      <div className="split-grid">
        <Panel
          title="Dry-Run Tool"
          subtitle="Simulate a tool call and inspect the response safely before live execution."
          collapsible
          defaultExpanded={false}
          rank="muted"
          padding="compact"
        >
          <div className="controls-row">
            <label>
              Tool
              <HelpHint
                label="Dry-run tool help"
                text="Dry-run calls the tool with validation/safety checks so you can confirm behavior before live use."
              />
            </label>
            <GCSelect
              value={dryRunForm.toolName}
              onChange={(value) => setDryRunForm((current) => ({ ...current, toolName: value }))}
              options={catalog.map((entry) => ({ value: entry.toolName, label: entry.toolName }))}
            />
          </div>
          {selectedDryRunTool ? <p className="tools-helper">{selectedDryRunTool.description}</p> : null}
          <div className="controls-row">
            <label>Agent ID</label>
            <GCCombobox
              value={dryRunForm.agentId}
              onChange={(value) => setDryRunForm((current) => ({ ...current, agentId: value }))}
              options={dryRunAgentOptions.length === 0 ? [{ value: "", label: "No agents found" }] : dryRunAgentOptions}
              placeholder="Pick agent"
            />
          </div>
          <div className="controls-row">
            <label>Session ID</label>
            <GCCombobox
              value={dryRunForm.sessionId}
              onChange={(value) => setDryRunForm((current) => ({ ...current, sessionId: value }))}
              options={
                dryRunSessionOptions.length === 0 ? [{ value: "", label: "No sessions found" }] : dryRunSessionOptions
              }
              placeholder="Pick session"
            />
          </div>
          <details className="advanced-panel">
            <summary>Advanced fields</summary>
            <div className="controls-row">
              <label>Task ID</label>
              <input
                value={dryRunForm.taskId}
                onChange={(event) => setDryRunForm((current) => ({ ...current, taskId: event.target.value }))}
              />
            </div>
          </details>
          <div className="actions">
            <button type="button" onClick={onUseDryRunExample} className="gc-button">
              Load Example Args
            </button>
          </div>
          <label>
            Args JSON
            <HelpHint
              label="Args help"
              text="Use valid JSON object syntax. Example args are available with the button above."
            />
          </label>
          <textarea
            className="full-textarea"
            rows={8}
            value={dryRunForm.argsJson}
            onChange={(event) => setDryRunForm((current) => ({ ...current, argsJson: event.target.value }))}
          />
          <div className="actions">
            <button type="button" onClick={() => void onDryRun()} className="gc-button">
              Run Dry-Run
            </button>
          </div>
          {dryRunResult ? (
            <div className="replay-box">
              <pre>{JSON.stringify(dryRunResult, null, 2)}</pre>
            </div>
          ) : null}
        </Panel>

        <ToolActiveGrantsPanel
          grantFilter={grantFilter}
          setGrantFilter={setGrantFilter}
          visibleGrants={visibleGrants}
          onRevoke={onRevoke}
        />
      </div>

      <ToolCatalogPanel
        showTechnicalDetails={showTechnicalDetails}
        catalogFilter={catalogFilter}
        setCatalogFilter={setCatalogFilter}
        catalogCount={catalog.length}
        catalogByPack={catalogByPack}
      />
    </section>
  );
}
