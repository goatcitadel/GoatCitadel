import type {
  ChatGeneratedArtifactRecord,
  ChatMode,
  ChatProjectRecord,
  ChatSessionRecord,
} from "@goatcitadel/contracts";

export type ProjectCounts = Record<ChatMode, number>;
type ProjectReadinessStatus = "ready" | "attention";
export type ProjectIntakeModeId = "ask" | "plan" | "implement" | "review" | "research" | "summarize" | "release-proof";

type ProjectReadinessItem = {
  id: string;
  label: string;
  detail: string;
  status: ProjectReadinessStatus;
};

export type ProjectHome = {
  latestByMode: Record<ChatMode, ChatSessionRecord | null>;
  recentSessions: ChatSessionRecord[];
  readiness: ProjectReadinessItem[];
  activeCount: number;
  artifactCount: number;
  artifactCountsBySessionId: Record<string, number>;
  artifactCountSource: "records" | "session_refs";
  lastActivityLabel: string;
  healthLabel: string;
  healthDetail: string;
};

const EMPTY_COUNTS: ProjectCounts = {
  chat: 0,
  cowork: 0,
  code: 0,
};

export const SURFACES: Array<{ mode: ChatMode; label: string; action: string }> = [
  { mode: "chat", label: "Conversation", action: "New Conversation" },
  { mode: "cowork", label: "Plan", action: "New Plan" },
  { mode: "code", label: "Build", action: "New Build" },
];

export type ProjectIntakeMode = {
  id: ProjectIntakeModeId;
  label: string;
  mode: ChatMode;
  titlePrefix: string;
  tag: string;
  detail: string;
};

export const PROJECT_INTAKE_MODES: ProjectIntakeMode[] = [
  {
    id: "ask",
    label: "Ask",
    mode: "chat",
    titlePrefix: "Ask",
    tag: "intent:ask",
    detail: "Start a fast project question, draft, or decision thread.",
  },
  {
    id: "plan",
    label: "Plan",
    mode: "cowork",
    titlePrefix: "Plan",
    tag: "intent:plan",
    detail: "Open supervised planning with phases, risks, and approvals in view.",
  },
  {
    id: "implement",
    label: "Implement",
    mode: "code",
    titlePrefix: "Implement",
    tag: "intent:implement",
    detail: "Start Build for edits, debugging, and validation evidence.",
  },
  {
    id: "review",
    label: "Review",
    mode: "code",
    titlePrefix: "Review",
    tag: "intent:review",
    detail: "Create a review lane for diffs, tests, residual risk, and handoff notes.",
  },
  {
    id: "research",
    label: "Research",
    mode: "cowork",
    titlePrefix: "Research",
    tag: "intent:research",
    detail: "Use Plan for multi-step investigation, source capture, and synthesis.",
  },
  {
    id: "summarize",
    label: "Summarize",
    mode: "chat",
    titlePrefix: "Summarize",
    tag: "intent:summarize",
    detail: "Summarize project state, recent work, documents, or next decisions.",
  },
  {
    id: "release-proof",
    label: "Release proof",
    mode: "code",
    titlePrefix: "Release proof",
    tag: "intent:release-proof",
    detail: "Collect validation, artifacts, dirty-tree truth, and publish readiness.",
  },
];

export function deriveProjectHome(
  project: ChatProjectRecord,
  sessions: ChatSessionRecord[],
  artifacts?: ChatGeneratedArtifactRecord[],
): ProjectHome {
  const sortedSessions = [...sessions].sort(
    (left, right) => dateValue(right.lastActivityAt) - dateValue(left.lastActivityAt),
  );
  const latestByMode = createEmptyLatestByMode();
  for (const session of sortedSessions) {
    const mode = normalizeMode(session.mode);
    if (!latestByMode[mode]) {
      latestByMode[mode] = session;
    }
  }
  const artifactCountsBySessionId =
    artifacts === undefined
      ? countSessionReferenceArtifacts(sortedSessions)
      : countProjectArtifactRecords(project.projectId, artifacts);
  const artifactCount = Object.values(artifactCountsBySessionId).reduce((total, count) => total + count, 0);
  const activeCount = sortedSessions.filter((session) => session.lifecycleStatus !== "archived").length;
  const hasSourcePath = Boolean(project.workspacePath?.trim());
  const hasChat = Boolean(latestByMode.chat);
  const hasCowork = Boolean(latestByMode.cowork);
  const hasCode = Boolean(latestByMode.code);
  const hasArtifacts = artifactCount > 0;

  const readiness: ProjectReadinessItem[] = [
    {
      id: "source",
      label: "Project source",
      status: hasSourcePath ? "ready" : "attention",
      detail: hasSourcePath
        ? `Bound to ${project.workspacePath}.`
        : "Add a workspace path before Build can become a practical workbench.",
    },
    {
      id: "chat",
      label: "Conversation continuity",
      status: hasChat ? "ready" : "attention",
      detail: hasChat
        ? "A project conversation is ready to continue."
        : "Start a project conversation for fast context and drafting.",
    },
    {
      id: "cowork",
      label: "Plan run",
      status: hasCowork ? "ready" : "attention",
      detail: hasCowork
        ? "A supervised planning run is available from this project."
        : "Start the plan posture when this project needs a durable plan and approval loop.",
    },
    {
      id: "code",
      label: "Build workbench",
      status: hasCode ? "ready" : "attention",
      detail: hasCode
        ? "A build thread is available for implementation work."
        : "Open the build posture when this project needs edits, validation, or patch artifacts.",
    },
    {
      id: "artifacts",
      label: "Proof artifacts",
      status: hasArtifacts ? "ready" : "attention",
      detail: hasArtifacts
        ? `${artifactCount} generated artifacts are bound to this project.`
        : "No validation or output artifacts are attached yet.",
    },
    {
      id: "knowledge",
      label: "Knowledge and provenance",
      status: "attention",
      detail: "Project-scoped memory review still lives in Library; inspect or remove knowledge there.",
    },
  ];

  const health = deriveProjectHealth({
    hasSourcePath,
    hasChat,
    hasCowork,
    hasCode,
    hasArtifacts,
    sessionCount: sessions.length,
  });

  return {
    latestByMode,
    recentSessions: sortedSessions.slice(0, 4),
    readiness,
    activeCount,
    artifactCount,
    artifactCountsBySessionId,
    artifactCountSource: artifacts === undefined ? "session_refs" : "records",
    lastActivityLabel: sortedSessions[0] ? formatDateTime(sortedSessions[0].lastActivityAt) : "None",
    ...health,
  };
}

export function normalizeMode(mode?: ChatMode): ChatMode {
  return mode === "cowork" || mode === "code" ? mode : "chat";
}

export function createEmptyCounts(): ProjectCounts {
  return { ...EMPTY_COUNTS };
}

function createEmptyLatestByMode(): Record<ChatMode, ChatSessionRecord | null> {
  return {
    chat: null,
    cowork: null,
    code: null,
  };
}

function countArtifacts(session: ChatSessionRecord): number {
  return session.generatedArtifacts?.length ?? 0;
}

export function countHomeArtifacts(home: ProjectHome, session: ChatSessionRecord): number {
  return home.artifactCountSource === "records"
    ? (home.artifactCountsBySessionId[session.sessionId] ?? 0)
    : countArtifacts(session);
}

function countSessionReferenceArtifacts(sessions: ChatSessionRecord[]): Record<string, number> {
  return Object.fromEntries(sessions.map((session) => [session.sessionId, countArtifacts(session)]));
}

function countProjectArtifactRecords(
  projectId: string,
  artifacts: ChatGeneratedArtifactRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const artifact of artifacts) {
    if (artifact.projectId !== projectId) {
      continue;
    }
    counts[artifact.sessionId] = (counts[artifact.sessionId] ?? 0) + 1;
  }
  return counts;
}

function deriveProjectHealth(input: {
  hasSourcePath: boolean;
  hasChat: boolean;
  hasCowork: boolean;
  hasCode: boolean;
  hasArtifacts: boolean;
  sessionCount: number;
}): Pick<ProjectHome, "healthLabel" | "healthDetail"> {
  if (!input.hasSourcePath) {
    return {
      healthLabel: "Needs source",
      healthDetail: "Add a workspace path before this project can anchor Build and evidence.",
    };
  }
  if (input.sessionCount === 0) {
    return {
      healthLabel: "Ready for first thread",
      healthDetail: "The project exists; start Work to create a continuation point.",
    };
  }
  if (!input.hasCowork || !input.hasCode) {
    return {
      healthLabel: "Needs Work postures",
      healthDetail: "Add Plan or Build when this project needs durable execution or implementation proof.",
    };
  }
  if (!input.hasArtifacts) {
    return {
      healthLabel: "Needs proof",
      healthDetail: "Run validation or produce artifacts so future sessions have evidence to inspect.",
    };
  }
  if (!input.hasChat) {
    return {
      healthLabel: "Needs conversation",
      healthDetail: "Add a lightweight conversation thread for fast project questions and drafting.",
    };
  }
  return {
    healthLabel: "Ready to continue",
    healthDetail: "Conversation, planning, build, and evidence are all represented for this project.",
  };
}

export function labelForMode(mode: ChatMode): string {
  return mode === "cowork" ? "Plan" : mode === "code" ? "Build" : "Conversation";
}

export function dateValue(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
