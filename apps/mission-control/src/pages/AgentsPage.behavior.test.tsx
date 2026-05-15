import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  archiveAgentProfile: vi.fn(),
  createAgentProfile: vi.fn(),
  evaluateUiChangeRisk: vi.fn(),
  fetchAgents: vi.fn(),
  hardDeleteAgentProfile: vi.fn(),
  restoreAgentProfile: vi.fn(),
  updateAgentProfile: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);
vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: (props: {
    overall: string;
    criticalConfirmed?: boolean;
    onCriticalConfirmChange?: (checked: boolean) => void;
  }) => (
    <div>
      Agent Change Review:{props.overall}
      <button type="button" onClick={() => props.onCriticalConfirmChange?.(!props.criticalConfirmed)}>
        Confirm critical
      </button>
    </div>
  ),
}));
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: (props: {
    open: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    onCancel: () => void;
    onConfirm: () => void;
  }) =>
    props.open ? (
      <div>
        {props.title}
        {props.message}
        <button type="button" onClick={props.onCancel}>
          Cancel modal
        </button>
        <button type="button" onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));
vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({
    primary,
    center,
    secondary,
  }: {
    primary?: React.ReactNode;
    center?: React.ReactNode;
    secondary?: React.ReactNode;
  }) => (
    <div>
      {primary}
      {center}
      {secondary}
    </div>
  ),
}));
vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({ primary, inspector }: { primary?: React.ReactNode; inspector?: React.ReactNode }) => (
    <div>
      {primary}
      {inspector}
    </div>
  ),
}));
vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <header>
      {title}
      {actions}
    </header>
  ),
}));
vi.mock("../components/Panel", () => ({
  Panel: ({ title, children }: { title?: string; children?: React.ReactNode }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  ),
}));
vi.mock("../components/SelectOrCustom", () => ({
  SelectOrCustom: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    options?: Array<{ value: string; label: string }>;
  }) => (
    <input
      id={props.id}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
      list={`${props.id}-options`}
    />
  ),
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/ui", () => ({
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
vi.mock("../components/ui/GCEmptyState", () => ({
  GCEmptyState: ({ title, subtitle }: { title?: string; subtitle?: string }) => (
    <div>
      {title}
      {subtitle}
    </div>
  ),
}));

import { AgentsPage } from "./AgentsPage";

const coderAgent = {
  agentId: "agent-1",
  roleId: "coder-custom",
  name: "Coder",
  title: "Implementation Engineer",
  summary: "Writes patches",
  specialties: ["typescript"],
  defaultTools: ["shell"],
  aliases: ["dev"],
  lifecycleStatus: "active",
  status: "idle",
  activeSessions: 0,
  sessionCount: 2,
  isBuiltin: false,
};

function makeAgentsResponse(items = [coderAgent], view = "active") {
  return { items, view };
}

function input(renderer: ReactTestRenderer, id: string) {
  const node = renderer.root
    .findAll(
      (candidate) =>
        (candidate.type === "input" || candidate.type === "select" || candidate.type === "textarea") &&
        candidate.props.id === id,
    )
    .at(0);
  if (!node) {
    throw new Error(`Unable to find input ${id}`);
  }
  return node;
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((node) => node.props.children === label);
}

function lastButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType("button")
    .filter((node) => node.props.children === label)
    .at(-1);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("AgentsPage behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
    apiMocks.fetchAgents.mockResolvedValue(makeAgentsResponse());
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({ overall: "safe", items: [] });
    apiMocks.createAgentProfile.mockResolvedValue({
      ...coderAgent,
      agentId: "agent-created",
      roleId: "review-goat",
      name: "Review Goat",
    });
    apiMocks.updateAgentProfile.mockResolvedValue({ ...coderAgent, name: "Coder Prime" });
    apiMocks.archiveAgentProfile.mockResolvedValue({ ...coderAgent, lifecycleStatus: "archived" });
    apiMocks.restoreAgentProfile.mockResolvedValue({ ...coderAgent, lifecycleStatus: "active" });
    apiMocks.hardDeleteAgentProfile.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty inspector when no agents are returned", async () => {
    apiMocks.fetchAgents.mockResolvedValueOnce(makeAgentsResponse([]));
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsPage />);
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("Select an agent");
    } finally {
      renderer.unmount();
    }
  });

  it("creates a custom agent and supports canceling the create form", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsPage />);
      });
      await flush();

      await act(async () => {
        button(renderer, "Create Custom Agent")?.props.onClick();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Creating a new custom agent profile.");

      await act(async () => {
        button(renderer, "Cancel")?.props.onClick();
      });
      expect(JSON.stringify(renderer.toJSON())).not.toContain("Creating a new custom agent profile.");

      await act(async () => {
        button(renderer, "Create Custom Agent")?.props.onClick();
      });
      await act(async () => {
        input(renderer, "agentRoleId").props.onChange({ target: { value: "Review Goat" } });
        input(renderer, "agentName").props.onChange({ target: { value: "Review Goat" } });
        input(renderer, "agentTitle").props.onChange({ target: { value: "Verification Lead" } });
        input(renderer, "agentSummary").props.onChange({ target: { value: "Reviews risky changes" } });
        input(renderer, "agentSpecialties").props.onChange({ target: { value: "review\ncoverage" } });
      });
      await act(async () => {
        button(renderer, "Create Agent")?.props.onClick();
      });
      await flush();

      expect(apiMocks.fetchAgents).toHaveBeenCalledWith("all", 1000);
      expect(apiMocks.createAgentProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          roleId: "review-goat",
          name: "Review Goat",
          title: "Verification Lead",
          summary: "Reviews risky changes",
          specialties: ["review", "coverage"],
        }),
      );
      const text = JSON.stringify(renderer.toJSON());
      expect(text).toContain("Created agent");
      expect(text).toContain("Review Goat");
    } finally {
      renderer.unmount();
    }
  });

  it("updates, archives, restores, and deletes selected custom agents", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsPage />);
      });
      await flush();

      await act(async () => {
        input(renderer, "agentName").props.onChange({ target: { value: "Coder Prime" } });
      });
      await act(async () => {
        button(renderer, "Save Changes")?.props.onClick();
      });
      await flush();

      expect(apiMocks.updateAgentProfile).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ name: "Coder Prime" }),
      );

      await act(async () => {
        button(renderer, "Archive")?.props.onClick();
      });
      await act(async () => {
        lastButton(renderer, "Archive")?.props.onClick();
      });
      await flush();

      expect(apiMocks.archiveAgentProfile).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ archivedBy: "mission-control" }),
      );

      apiMocks.fetchAgents.mockResolvedValue(
        makeAgentsResponse([{ ...coderAgent, lifecycleStatus: "archived" }], "archived"),
      );
      await act(async () => {
        input(renderer, "agentView").props.onChange({ target: { value: "archived" } });
      });
      await flush();
      await act(async () => {
        button(renderer, "Restore")?.props.onClick();
      });
      await flush();
      expect(apiMocks.restoreAgentProfile).toHaveBeenCalledWith("agent-1");

      await act(async () => {
        button(renderer, "Delete Permanently")?.props.onClick();
      });
      await act(async () => {
        lastButton(renderer, "Delete Permanently")?.props.onClick();
      });
      await flush();
      expect(apiMocks.hardDeleteAgentProfile).toHaveBeenCalledWith("agent-1");
    } finally {
      renderer.unmount();
    }
  });

  it("handles keyboard selection, advanced preset defaults, and critical risk confirmation", async () => {
    const presetAgent = {
      ...coderAgent,
      agentId: "agent-2",
      roleId: "preset-coder",
      name: "Preset Coder",
      presetDefaults: {
        presetLabel: "Patch mode",
        presetSummary: "Focused implementation",
        routeHint: "code",
        preferredProviderId: "openai",
        preferredModel: "gpt-5.4",
        toolsPosture: "manual",
        knowledgeAttachmentIds: ["repo", "release"],
        promptFraming: "Stay surgical.",
      },
    };
    apiMocks.fetchAgents.mockResolvedValue(makeAgentsResponse([coderAgent, presetAgent]));
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "critical",
      items: [{ field: "summary", level: "critical", hint: "High impact posture change" }],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsPage />);
      });
      await flush();

      const presetRow = renderer.root
        .findAll((node) => node.type === "tr" && node.props.role === "button")
        .find((node) => node.findAllByType("td").some((cell) => cell.props.children === "Preset Coder"));
      expect(presetRow).toBeTruthy();

      await act(async () => {
        presetRow?.props.onKeyDown({ key: "Escape", preventDefault: vi.fn() });
      });
      expect(input(renderer, "agentName").props.value).toBe("Coder");

      const preventDefault = vi.fn();
      await act(async () => {
        presetRow?.props.onKeyDown({ key: "Enter", preventDefault });
      });
      expect(preventDefault).toHaveBeenCalled();
      expect(input(renderer, "agentName").props.value).toBe("Preset Coder");
      expect(JSON.stringify(renderer.toJSON())).toContain("Hide advanced defaults");
      expect(input(renderer, "agentPresetProvider").props.value).toBe("openai");

      await act(async () => {
        input(renderer, "agentSummary").props.onChange({ target: { value: "Changes runtime posture" } });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 430));
      });
      await flush();

      await act(async () => {
        button(renderer, "Save Changes")?.props.onClick();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Critical change requires confirmation before saving.");
      expect(apiMocks.updateAgentProfile).not.toHaveBeenCalled();

      await act(async () => {
        button(renderer, "Confirm critical")?.props.onClick();
      });
      await act(async () => {
        button(renderer, "Save Changes")?.props.onClick();
      });
      await flush();

      expect(apiMocks.updateAgentProfile).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          summary: "Changes runtime posture",
          presetDefaults: expect.objectContaining({
            preferredProviderId: "openai",
            preferredModel: "gpt-5.4",
            toolsPosture: "manual",
            knowledgeAttachmentIds: ["repo", "release"],
            promptFraming: "Stay surgical.",
          }),
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces load and save failures without leaving creation mode", async () => {
    apiMocks.fetchAgents.mockRejectedValueOnce(new Error("agents offline"));
    apiMocks.createAgentProfile.mockRejectedValueOnce(new Error("already exists"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsPage />);
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("agents offline");

      await act(async () => {
        button(renderer, "Create Custom Agent")?.props.onClick();
      });
      await act(async () => {
        input(renderer, "agentRoleId").props.onChange({ target: { value: "Unique Goat" } });
        input(renderer, "agentName").props.onChange({ target: { value: "Unique Goat" } });
        input(renderer, "agentTitle").props.onChange({ target: { value: "Runtime Operator" } });
        input(renderer, "agentSummary").props.onChange({ target: { value: "Operates the runtime" } });
      });
      await act(async () => {
        button(renderer, "Create Agent")?.props.onClick();
      });
      await flush();

      expect(JSON.stringify(renderer.toJSON())).toContain("That Role ID was just claimed. Pick another.");
      expect(JSON.stringify(renderer.toJSON())).toContain("Create Custom Agent");
    } finally {
      renderer.unmount();
    }
  });
});
