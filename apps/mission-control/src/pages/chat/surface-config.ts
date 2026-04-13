import { CHAT_MODE_PRESETS, type ChatMode } from "@goatcitadel/contracts";

export interface MissionControlSurfaceConfig {
  mode: ChatMode;
  label: string;
  shellEyebrow: string;
  stageTitle: string;
  stageSummary: string;
  emptyTitle: string;
  emptyBody: string;
  emptyPrompts: string[];
  dockTitle: string;
  dockSummary: string;
  layout: {
    dominantArtifact: "conversation" | "workflow" | "workbench";
    sessionRailVisibility: "secondary" | "tertiary";
    threadPlacement: "primary" | "support";
    threadPanelRank: "primary" | "muted" | "inset";
    supportThreadBehavior: "persistent" | "collapsible" | "stacked";
    workflowPlacement: "none" | "primary";
    dockPlacement: "support";
    dockBehavior: "persistent" | "collapsible" | "drawer";
    desktopDensity: "chat" | "cowork" | "code";
    defaultColumnWidths: string;
    shellClassName: string;
    sessionRailClassName: string;
    mainGridClassName: string;
    primaryColumnClassName: string;
    workflowColumnClassName?: string;
    dockClassName: string;
  };
}

const EMPTY_CONFIG: Record<ChatMode, Omit<MissionControlSurfaceConfig, "mode" | "label">> = {
  chat: {
    shellEyebrow: "Conversation lane",
    stageTitle: "Conversation stays primary",
    stageSummary: "Read the thread, answer quickly, and only surface extra context when it changes the next move.",
    emptyTitle: "Start with the thing you actually need",
    emptyBody:
      "Chat is the lightest Mission Control surface: fast questions, drafting, synthesis, and follow-ups without orchestration overload.",
    emptyPrompts: [
      "Draft a launch update from my notes",
      "Summarize this problem before we act",
      "Help me think through tradeoffs",
    ],
    dockTitle: "Chat context",
    dockSummary:
      "Trace, memory, and controls stay nearby as supporting context instead of competing with the conversation.",
    layout: {
      dominantArtifact: "conversation",
      sessionRailVisibility: "secondary",
      threadPlacement: "primary",
      threadPanelRank: "primary",
      supportThreadBehavior: "persistent",
      workflowPlacement: "none",
      dockPlacement: "support",
      dockBehavior: "collapsible",
      desktopDensity: "chat",
      defaultColumnWidths: "thread | dock",
      shellClassName: "surface-layout-chat",
      sessionRailClassName: "surface-rail-chat",
      mainGridClassName: "surface-grid-chat",
      primaryColumnClassName: "surface-primary-chat",
      dockClassName: "surface-dock-chat",
    },
  },
  cowork: {
    shellEyebrow: "Workflow lane",
    stageTitle: "Orchestration leads the surface",
    stageSummary:
      "Cowork should read like active coordination: what is running, what is blocked, and what the operator should steer next.",
    emptyTitle: "Frame the work and move it forward",
    emptyBody:
      "Cowork is for multi-step runs, orchestration, research, and active collaboration with visible state instead of vague progress.",
    emptyPrompts: [
      "Break this objective into a staged plan",
      "Research the space, then recommend a direction",
      "Coordinate next steps across roles",
    ],
    dockTitle: "Cowork context",
    dockSummary:
      "Workflow state, delegation opportunities, and approvals lead here so the thread stays readable while the system stays transparent.",
    layout: {
      dominantArtifact: "workflow",
      sessionRailVisibility: "tertiary",
      threadPlacement: "support",
      threadPanelRank: "muted",
      supportThreadBehavior: "stacked",
      workflowPlacement: "primary",
      dockPlacement: "support",
      dockBehavior: "drawer",
      desktopDensity: "cowork",
      defaultColumnWidths: "workflow | thread | dock",
      shellClassName: "surface-layout-cowork",
      sessionRailClassName: "surface-rail-cowork",
      mainGridClassName: "surface-grid-cowork",
      primaryColumnClassName: "surface-primary-cowork",
      workflowColumnClassName: "surface-workflow-cowork",
      dockClassName: "surface-dock-cowork",
    },
  },
  code: {
    shellEyebrow: "Implementation lane",
    stageTitle: "Execution posture stays exact",
    stageSummary:
      "Code should feel denser and more deliberate, with project binding, artifact handling, and review posture kept close at hand.",
    emptyTitle: "Anchor the implementation before you execute",
    emptyBody:
      "Code is for serious implementation help: long prompts, code-heavy output, planning, review, and project-aware execution.",
    emptyPrompts: [
      "Review this area for bugs and missing tests",
      "Implement the smallest safe fix",
      "Plan the refactor before touching files",
    ],
    dockTitle: "Code context",
    dockSummary:
      "Workbench state, project binding, and execution controls stay visible so implementation decisions are precise instead of conversational.",
    layout: {
      dominantArtifact: "workbench",
      sessionRailVisibility: "tertiary",
      threadPlacement: "support",
      threadPanelRank: "inset",
      supportThreadBehavior: "stacked",
      workflowPlacement: "primary",
      dockPlacement: "support",
      dockBehavior: "drawer",
      desktopDensity: "code",
      defaultColumnWidths: "workbench | thread | dock",
      shellClassName: "surface-layout-code",
      sessionRailClassName: "surface-rail-code",
      mainGridClassName: "surface-grid-code",
      primaryColumnClassName: "surface-primary-code",
      workflowColumnClassName: "surface-workflow-code",
      dockClassName: "surface-dock-code",
    },
  },
};

export function getMissionControlSurfaceConfig(mode: ChatMode): MissionControlSurfaceConfig {
  const preset = CHAT_MODE_PRESETS[mode];
  const config = EMPTY_CONFIG[mode];
  return {
    mode,
    label: preset.label,
    shellEyebrow: config.shellEyebrow,
    stageTitle: config.stageTitle,
    stageSummary: config.stageSummary,
    emptyTitle: config.emptyTitle,
    emptyBody: config.emptyBody,
    emptyPrompts: config.emptyPrompts,
    dockTitle: config.dockTitle,
    dockSummary: config.dockSummary,
    layout: config.layout,
  };
}

export function defaultDockOpenForMode(_mode: ChatMode): boolean {
  return false;
}
