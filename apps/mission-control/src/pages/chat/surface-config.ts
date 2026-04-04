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
}

const EMPTY_CONFIG: Record<ChatMode, Omit<MissionControlSurfaceConfig, "mode" | "label">> = {
  chat: {
    shellEyebrow: "Conversation lane",
    stageTitle: "Clear, calm chat for real work",
    stageSummary: "Stay focused on the thread. Reach for context only when it helps.",
    emptyTitle: "Start with the thing you actually need",
    emptyBody: "Chat is the lightest Mission Control surface: fast questions, drafting, synthesis, and follow-ups without orchestration overload.",
    emptyPrompts: [
      "Draft a launch update from my notes",
      "Summarize this problem before we act",
      "Help me think through tradeoffs",
    ],
    dockTitle: "Chat context",
    dockSummary: "Trace, memory, and controls stay nearby without crowding the thread.",
  },
  cowork: {
    shellEyebrow: "Workflow lane",
    stageTitle: "Guide the work, not just the words",
    stageSummary: "Cowork keeps the conversation grounded in tasks, progress, and next actions.",
    emptyTitle: "Frame the work and move it forward",
    emptyBody: "Cowork is for multi-step runs, orchestration, research, and active collaboration with visible state instead of vague progress.",
    emptyPrompts: [
      "Break this objective into a staged plan",
      "Research the space, then recommend a direction",
      "Coordinate next steps across roles",
    ],
    dockTitle: "Cowork context",
    dockSummary: "Active tasks, orchestration state, and approvals live here so the main thread stays readable.",
  },
  code: {
    shellEyebrow: "Implementation lane",
    stageTitle: "Build with a steadier operator surface",
    stageSummary: "Code mode keeps project context, heavier prompts, and execution posture visible without turning into an IDE clone.",
    emptyTitle: "Anchor the implementation before you execute",
    emptyBody: "Code is for serious implementation help: long prompts, code-heavy output, planning, review, and project-aware execution.",
    emptyPrompts: [
      "Review this area for bugs and missing tests",
      "Implement the smallest safe fix",
      "Plan the refactor before touching files",
    ],
    dockTitle: "Code context",
    dockSummary: "Project binding, execution posture, and workbench details stay visible while the transcript remains primary.",
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
  };
}

export function defaultDockOpenForMode(mode: ChatMode): boolean {
  return mode !== "chat";
}
