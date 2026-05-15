import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const uiPreferencesState = vi.hoisted(() => ({
  showTechnicalDetails: true,
}));

const apiMocks = vi.hoisted(() => ({
  createToolGrant: vi.fn(),
  evaluateToolAccess: vi.fn(),
  fetchAgents: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchSettings: vi.fn(),
  fetchToolCatalog: vi.fn(),
  fetchToolGrants: vi.fn(),
  invokeTool: vi.fn(),
  patchSettings: vi.fn(),
  revokeToolGrant: vi.fn(),
}));

vi.mock("../api/client", () => ({
  createToolGrant: apiMocks.createToolGrant,
  evaluateToolAccess: apiMocks.evaluateToolAccess,
  fetchAgents: apiMocks.fetchAgents,
  fetchChatSessions: apiMocks.fetchChatSessions,
  fetchSettings: apiMocks.fetchSettings,
  fetchToolCatalog: apiMocks.fetchToolCatalog,
  fetchToolGrants: apiMocks.fetchToolGrants,
  invokeTool: apiMocks.invokeTool,
  patchSettings: apiMocks.patchSettings,
  revokeToolGrant: apiMocks.revokeToolGrant,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: unknown) => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../state/ui-preferences", () => ({
  useUiPreferences: () => ({
    mode: "advanced",
    showTechnicalDetails: uiPreferencesState.showTechnicalDetails,
    activeWorkspaceId: "default",
    setShowTechnicalDetails: () => undefined,
  }),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      {primary}
      {secondary}
    </div>
  ),
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/HelpHint", () => ({
  HelpHint: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: () => <div>CardSkeleton</div>,
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/ui", () => ({
  GCCombobox: (props: {
    value: string;
    onChange: (value: string) => void;
    options?: Array<{ value: string; label: string }>;
    placeholder?: string;
  }) => (
    <input
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.target.value)}
      data-options={props.options?.length ?? 0}
    />
  ),
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("./tools/ToolAccessModesPanel", () => ({
  ToolAccessModesPanel: (props: {
    presets: Array<{ id: string; label: string }>;
    onApplyToolProfile: (profileId: string) => void;
  }) => (
    <section>
      {props.presets.map((preset) => (
        <button key={preset.id} type="button" onClick={() => props.onApplyToolProfile(preset.id)}>
          Profile {preset.id}
        </button>
      ))}
    </section>
  ),
}));

vi.mock("./tools/ToolActiveGrantsPanel", () => ({
  ToolActiveGrantsPanel: (props: {
    grantFilter: string;
    setGrantFilter: (value: string) => void;
    visibleGrants: Array<{ grantId: string; toolPattern: string }>;
    onRevoke: (grantId: string) => void;
  }) => (
    <section>
      <input
        aria-label="Grant filter"
        value={props.grantFilter}
        onChange={(event) => props.setGrantFilter(event.target.value)}
      />
      {props.visibleGrants.map((grant) => (
        <button key={grant.grantId} type="button" onClick={() => props.onRevoke(grant.grantId)}>
          Revoke {grant.toolPattern}
        </button>
      ))}
    </section>
  ),
}));

vi.mock("./tools/ToolCatalogPanel", () => ({
  ToolCatalogPanel: (props: {
    catalogFilter: string;
    setCatalogFilter: (value: string) => void;
    catalogCount: number;
  }) => (
    <section>
      <input
        aria-label="Catalog filter"
        value={props.catalogFilter}
        onChange={(event) => props.setCatalogFilter(event.target.value)}
      />
      <span>{props.catalogCount} catalog entries</span>
    </section>
  ),
}));

import { ToolsPage } from "./ToolsPage";

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map((child) => instanceText(child)).join(" ");
}

async function clickButton(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  await act(async () => {
    button.props.onClick();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("ToolsPage load discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    uiPreferencesState.showTechnicalDetails = true;
    apiMocks.fetchToolCatalog.mockResolvedValue({
      items: [
        {
          toolName: "fs.list",
          category: "filesystem",
          description: "List files",
          pack: "core",
          riskLevel: "low",
        },
        {
          toolName: "fs.read",
          category: "filesystem",
          description: "Read files",
          pack: "core",
          riskLevel: "low",
        },
        {
          toolName: "browser.search",
          category: "browser",
          description: "Search the web",
          pack: "knowledge",
          riskLevel: "medium",
        },
      ],
    });
    apiMocks.fetchToolGrants.mockResolvedValue({
      items: [
        {
          grantId: "grant-1",
          toolPattern: "fs.list",
          decision: "allow",
          scope: "session",
          scopeRef: "sess-1",
          grantType: "persistent",
          createdBy: "operator",
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchChatSessions.mockResolvedValue({
      items: [
        {
          sessionId: "sess-1",
          title: "Session 1",
          workspaceId: "default",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchAgents.mockResolvedValue({
      items: [
        {
          agentId: "operator",
          name: "Operator",
        },
      ],
    });
    apiMocks.fetchSettings.mockResolvedValue({
      defaultToolProfile: "standard",
    });
    apiMocks.createToolGrant.mockResolvedValue({ ok: true });
    apiMocks.evaluateToolAccess.mockResolvedValue({
      allowed: true,
      riskLevel: "low",
      requiresApproval: false,
      matchedGrantId: "grant-1",
    });
    apiMocks.invokeTool.mockResolvedValue({ ok: true, dryRun: true });
    apiMocks.patchSettings.mockResolvedValue({ defaultToolProfile: "coding" });
    apiMocks.revokeToolGrant.mockResolvedValue({ ok: true });
  });

  it("skips static scope-source fetches during background refresh", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      expect(apiMocks.fetchToolCatalog).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchToolGrants).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchChatSessions).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "tools",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchToolCatalog).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchToolGrants).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchChatSessions).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });

  it("drives grant creation, quick presets, profile switch, evaluation, dry-run, and revoke handlers", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      await clickButton(renderer, "Profile coding");
      await flush();

      await clickButton(renderer, "Next");
      await flush();
      await clickButton(renderer, "Quick: File Read");
      await flush();
      await clickButton(renderer, "Next");
      await flush();
      await clickButton(renderer, "Create Grant");
      await flush();

      await clickButton(renderer, "Check Access");
      await flush();
      await clickButton(renderer, "Load Example Args");
      await flush();
      await clickButton(renderer, "Run Dry-Run");
      await flush();
      await clickButton(renderer, "Revoke fs.list");
      await flush();

      expect(apiMocks.patchSettings).toHaveBeenCalledWith({ defaultToolProfile: "coding" });
      expect(apiMocks.createToolGrant).toHaveBeenCalledWith({
        toolPattern: "fs.list",
        decision: "allow",
        scope: "session",
        scopeRef: "sess-1",
        grantType: "persistent",
        createdBy: "operator",
        expiresAt: undefined,
      });
      expect(apiMocks.createToolGrant).toHaveBeenCalledWith({
        toolPattern: "fs.read",
        decision: "allow",
        scope: "session",
        scopeRef: "sess-1",
        grantType: "persistent",
        createdBy: "operator",
      });
      expect(apiMocks.evaluateToolAccess).toHaveBeenCalledWith({
        toolName: "fs.list",
        agentId: "operator",
        sessionId: "sess-1",
        workspaceId: "default",
        taskId: undefined,
      });
      expect(apiMocks.invokeTool).toHaveBeenCalledWith({
        toolName: "fs.list",
        args: { path: "./workspace" },
        agentId: "operator",
        sessionId: "sess-1",
        workspaceId: "default",
        taskId: undefined,
        dryRun: true,
        consentContext: {
          source: "ui",
          operatorId: "operator",
          reason: "tool access dry-run",
        },
      });
      expect(apiMocks.revokeToolGrant).toHaveBeenCalledWith("grant-1");
    } finally {
      renderer.unmount();
    }
  });

  it("shows the initial loading skeleton while tool sources are pending", async () => {
    apiMocks.fetchToolCatalog.mockImplementationOnce(() => new Promise(() => undefined));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });

      expect(JSON.stringify(renderer.toJSON())).toContain("CardSkeleton");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces tool source load errors and keeps the page usable", async () => {
    apiMocks.fetchToolCatalog.mockRejectedValueOnce(new Error("tool-service-down"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      const text = instanceText(renderer.toJSON()).replace(/\s+/g, " ");
      expect(text).toContain("tool-service-down");
      expect(text).toContain("0 catalog entries");
    } finally {
      renderer.unmount();
    }
  });

  it("drives wizard scope guards, recommended scope reset, and invalid dry-run errors", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      const scopeSelect = renderer.root.findAllByType("select")[0];
      if (!scopeSelect) {
        throw new Error("Expected grant scope select");
      }
      await act(async () => {
        scopeSelect.props.onChange({ target: { value: "task" } });
      });
      const taskInput = renderer.root.findAllByType("input").find((node) => node.props.placeholder === "task id");
      await act(async () => {
        taskInput?.props.onChange({ target: { value: "" } });
      });
      await clickButton(renderer, "2. What");
      expect(instanceText(renderer.toJSON())).toContain("Complete step 1 first.");

      await act(async () => {
        taskInput?.props.onChange({ target: { value: "task-123" } });
      });
      await clickButton(renderer, "2. What");
      expect(instanceText(renderer.toJSON())).toContain("Quick: Web Assistant");

      await clickButton(renderer, "Back");
      const nextScopeSelect = renderer.root.findAllByType("select")[0];
      if (!nextScopeSelect) {
        throw new Error("Expected grant scope select after returning to the scope step");
      }
      await act(async () => {
        nextScopeSelect.props.onChange({ target: { value: "workspace" } });
      });
      expect(instanceText(renderer.toJSON())).toContain("Workspace grants apply across default");
      await clickButton(renderer, "Use recommended scope");
      expect(instanceText(renderer.toJSON())).toContain("Using recommended scope");

      const argsTextarea = renderer.root.findByType("textarea");
      await act(async () => {
        argsTextarea.props.onChange({ target: { value: "{" } });
      });
      await clickButton(renderer, "Run Dry-Run");
      await flush();

      expect(apiMocks.invokeTool).not.toHaveBeenCalled();
      expect(instanceText(renderer.toJSON())).toContain("Expected property name");
    } finally {
      renderer.unmount();
    }
  });

  it("supports advanced deny ttl grants, global scope, and action error states", async () => {
    apiMocks.patchSettings.mockRejectedValueOnce(new Error("profile locked"));
    apiMocks.createToolGrant.mockRejectedValueOnce(new Error("grant service down"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      await clickButton(renderer, "Profile ops");
      await flush();
      expect(instanceText(renderer.toJSON())).toContain("profile locked");

      const advancedToggle = renderer.root.findAllByType("input").find((node) => node.props.type === "checkbox");
      if (!advancedToggle) {
        throw new Error("Expected advanced settings checkbox");
      }
      await act(async () => {
        advancedToggle.props.onChange({ target: { checked: true } });
      });

      const scopeSelect = renderer.root.findAllByType("select")[0];
      if (!scopeSelect) {
        throw new Error("Expected scope select");
      }
      await act(async () => {
        scopeSelect.props.onChange({ target: { value: "global" } });
      });
      expect(instanceText(renderer.toJSON())).toContain("Global grants apply everywhere");

      await clickButton(renderer, "Next");
      const toolPicker = renderer.root
        .findAllByType("input")
        .find((node) => node.props.value === "fs.list" && Number(node.props["data-options"] ?? 0) >= 3);
      if (!toolPicker) {
        throw new Error("Expected tool picker");
      }
      await act(async () => {
        toolPicker.props.onChange({ target: { value: "git.status" } });
      });
      const decisionSelect = renderer.root
        .findAllByType("select")
        .find((node) =>
          node
            .findAllByType("option")
            .some((option) => option.props.value === "deny" && option.props.children === "Deny"),
        );
      if (!decisionSelect) {
        throw new Error("Expected decision select");
      }
      await act(async () => {
        decisionSelect.props.onChange({ target: { value: "deny" } });
      });

      await clickButton(renderer, "Next");
      const durationSelect = renderer.root
        .findAllByType("select")
        .find((node) => node.findAllByType("option").some((option) => option.props.value === "ttl"));
      if (!durationSelect) {
        throw new Error("Expected duration select");
      }
      await act(async () => {
        durationSelect.props.onChange({ target: { value: "ttl" } });
      });
      const expiresInput = renderer.root.findAllByType("input").find((node) => node.props.type === "datetime-local");
      const createdByInput = renderer.root
        .findAllByType("input")
        .find((node) => node.props.value === "operator" && node.props.type !== "checkbox");
      if (!expiresInput || !createdByInput) {
        throw new Error("Expected ttl and created-by inputs");
      }
      await act(async () => {
        expiresInput.props.onChange({ target: { value: "2026-05-14T15:30" } });
        createdByInput.props.onChange({ target: { value: "" } });
      });

      await clickButton(renderer, "Create Grant");
      await flush();
      expect(instanceText(renderer.toJSON())).toContain("grant service down");
      expect(apiMocks.createToolGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          toolPattern: "git.status",
          decision: "deny",
          scope: "global",
          scopeRef: undefined,
          grantType: "ttl",
          createdBy: "operator",
          expiresAt: "2026-05-14T22:30:00.000Z",
        }),
      );

      apiMocks.evaluateToolAccess.mockRejectedValueOnce(new Error("policy unavailable"));
      await clickButton(renderer, "Check Access");
      await flush();
      expect(instanceText(renderer.toJSON())).toContain("policy unavailable");

      apiMocks.invokeTool.mockRejectedValueOnce(new Error("runtime unavailable"));
      await clickButton(renderer, "Load Example Args");
      await clickButton(renderer, "Run Dry-Run");
      await flush();
      expect(instanceText(renderer.toJSON())).toContain("runtime unavailable");
    } finally {
      renderer.unmount();
    }
  });

  it("updates wizard jumps, quick presets, and check/dry-run target fields", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      await clickButton(renderer, "2. What");
      await clickButton(renderer, "Quick: Web Assistant");
      await flush();
      expect(instanceText(renderer.toJSON())).toContain('Applied preset "web"');

      await clickButton(renderer, "Quick: DevOps Read");
      await flush();
      expect(instanceText(renderer.toJSON())).toContain('Applied preset "devops"');

      await clickButton(renderer, "3. How Long");
      expect(instanceText(renderer.toJSON())).toContain("Create Grant");
      await clickButton(renderer, "1. Who");
      expect(instanceText(renderer.toJSON())).toContain("Scope ref");

      const selects = renderer.root.findAllByType("select");
      const evaluateToolSelect = selects.at(1);
      const dryRunToolSelect = selects.at(2);
      const agentInputs = renderer.root.findAllByProps({ placeholder: "Pick agent" });
      const sessionInputs = renderer.root.findAllByProps({ placeholder: "Pick session" });
      const taskInputs = renderer.root.findAll(
        (node) =>
          node.type === "input" &&
          node.props.value === "" &&
          !node.props.placeholder &&
          !node.props["aria-label"] &&
          node.props.type !== "checkbox",
      );
      if (!evaluateToolSelect || !dryRunToolSelect || agentInputs.length < 2 || sessionInputs.length < 2) {
        throw new Error("Expected check access and dry-run controls");
      }
      if (taskInputs.length < 2) {
        throw new Error("Expected advanced task inputs");
      }

      await act(async () => {
        evaluateToolSelect.props.onChange({ target: { value: "browser.search" } });
        agentInputs.forEach((input) => input.props.onChange({ target: { value: "agent-runner" } }));
        sessionInputs.forEach((input) => input.props.onChange({ target: { value: "sess-run" } }));
        taskInputs[0]?.props.onChange({ target: { value: "task-review" } });

        dryRunToolSelect.props.onChange({ target: { value: "browser.search" } });
        taskInputs[1]?.props.onChange({ target: { value: "task-run" } });
      });

      await clickButton(renderer, "Check Access");
      await flush();
      await clickButton(renderer, "Load Example Args");
      await clickButton(renderer, "Run Dry-Run");
      await flush();

      expect(apiMocks.evaluateToolAccess).toHaveBeenCalledWith({
        toolName: "browser.search",
        agentId: "agent-runner",
        sessionId: "sess-run",
        workspaceId: "default",
        taskId: "task-review",
      });
      expect(apiMocks.invokeTool).toHaveBeenCalledWith({
        toolName: "browser.search",
        args: { query: "weather 91303 today", maxResults: 5 },
        agentId: "agent-runner",
        sessionId: "sess-run",
        workspaceId: "default",
        taskId: "task-run",
        dryRun: true,
        consentContext: {
          source: "ui",
          operatorId: "operator",
          reason: "tool access dry-run",
        },
      });
      expect(apiMocks.createToolGrant).toHaveBeenCalledWith(
        expect.objectContaining({ toolPattern: "browser.search", scopeRef: "sess-1" }),
      );
      expect(apiMocks.createToolGrant).toHaveBeenCalledWith(
        expect.objectContaining({ toolPattern: "git.status", scopeRef: "sess-1" }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("keeps nontechnical operators on the guided grant path and still refreshes tool data", async () => {
    uiPreferencesState.showTechnicalDetails = false;

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      const text = instanceText(renderer.toJSON());
      expect(text).toContain("Advanced settings are hidden. Turn on technical controls above to customize more.");

      const catalogFilter = renderer.root.findByProps({ "aria-label": "Catalog filter" });
      const grantFilter = renderer.root.findByProps({ "aria-label": "Grant filter" });
      await act(async () => {
        catalogFilter.props.onChange({ target: { value: "browser" } });
        grantFilter.props.onChange({ target: { value: "fs.read" } });
      });
      await flush();

      expect(instanceText(renderer.toJSON())).not.toContain("Revoke fs.list");

      await act(async () => {
        await refreshState.callback?.({
          topic: "tools",
          timestamp: Date.now(),
          reason: "operator-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchToolCatalog).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchToolGrants).toHaveBeenCalledTimes(2);
    } finally {
      renderer.unmount();
    }
  });
});
