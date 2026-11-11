import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  type ChatApprovalAuthority,
  type ChatApprovalModeState,
  type ChatApprovalModeUpdate,
  type ChatAutoBinding,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

/** Both storage backends retain the revision and approval effects used by Auto. */
export function isChatAutoApprovalEnabled(storage: Pick<AsyncStorage, "db">): boolean {
  const { dialect } = storage.db;
  return dialect === "sqlite" || dialect === "postgres";
}

export interface ChatApprovalModeDependencies {
  readonly storage: Pick<
    AsyncStorage,
    | "chatSessionMeta"
    | "chatSessionPrefs"
    | "chatSessionProjects"
    | "chatProjects"
    | "sessions"
    | "chatDelegationSteps"
    | "runImmediateTransaction"
  >;
  readonly chatAutoApprovalEnabled?: boolean;
}

type CurrentChatApprovalAuthority =
  | Readonly<{ mode: "standard" }>
  | Readonly<{ mode: "auto"; binding: ChatAutoBinding }>;

export async function getChatApprovalMode(
  deps: ChatApprovalModeDependencies,
  sessionId: string,
): Promise<ChatApprovalModeState> {
  return await deps.storage.runImmediateTransaction(async () => {
    const live = await readLiveMode(deps, sessionId);
    if (!live) throw new NotFoundError({ entity: "Chat session", id: sessionId });
    return live.state;
  });
}

export async function updateChatApprovalMode(
  deps: ChatApprovalModeDependencies,
  sessionId: string,
  input: ChatApprovalModeUpdate,
): Promise<ChatApprovalModeState> {
  return await deps.storage.runImmediateTransaction(async () => {
    const live = await readLiveMode(deps, sessionId);
    if (!live) throw new NotFoundError({ entity: "Chat session", id: sessionId });
    const { state, persisted, projectRevision, aggregateRevision } = live;
    if (state.modeRevision !== input.expectedModeRevision) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "Chat approval mode or project changed. Reload the session and try again.",
      });
    }
    if (input.mode === "auto" && !state.autoAvailable) {
      throw new ConflictError({ message: "Auto approval is unavailable for this Chat session." });
    }
    if (state.mode === input.mode && (persisted?.mode ?? "standard") === input.mode) return state;
    await deps.storage.chatSessionPrefs.updateApprovalMode(
      sessionId,
      aggregateRevision,
      input.mode,
      state.projectId,
      projectRevision,
    );
    return (await readLiveMode(deps, sessionId))!.state;
  });
}

/** The admission owner calls this while holding the advisory and session row locks. */
export async function readChatApprovalAdmission(
  deps: ChatApprovalModeDependencies,
  sessionId: string,
  workspaceId: string,
  directLocalOperator: boolean,
  expectedModeRevision?: string,
): Promise<ChatApprovalAuthority | undefined> {
  if ((!deps.chatAutoApprovalEnabled && expectedModeRevision === undefined) || !directLocalOperator) return undefined;
  const live = await readLiveMode(deps, sessionId);
  if (
    expectedModeRevision !== undefined &&
    (!live?.localSession ||
      live.state.workspaceId !== workspaceId ||
      live.state.modeRevision !== expectedModeRevision ||
      (live.state.mode === "auto" && !live.state.autoAvailable))
  ) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "Chat approval mode or project changed. Reload the session and try again.",
      details: { reason: "chat_approval_mode_changed" },
    });
  }
  if (!deps.chatAutoApprovalEnabled || !live || live.state.workspaceId !== workspaceId || !live.localSession)
    return undefined;
  const { mode, projectId, modeRevision } = live.state;
  return mode === "auto" && projectId
    ? { version: 1, mode: "auto", binding: { sessionId, workspaceId, projectId, modeRevision } }
    : { version: 1, mode: "standard", projectId, modeRevision };
}

/**
 * Accepts only already-verified durable payload authority. The callback must
 * perform only the bounded final commit. The transaction holds the session and
 * current project locks until it settles, so commands, outbound calls, and
 * preparatory work belong outside the callback. Reentrant transactions join
 * the current context. Commit a recovery journal before entering any enclosing
 * transaction, then settle its receipt once this transaction has committed.
 * Callers must handle stale as terminal for this turn.
 */
export async function withCurrentChatApprovalAuthority<T>(
  deps: ChatApprovalModeDependencies,
  turn: Readonly<{
    sessionId: string;
    workspaceId: string;
    admissionAggregateRevision: number;
    chatApprovalAuthority?: ChatApprovalAuthority;
  }>,
  commitBoundary: (authority: CurrentChatApprovalAuthority) => Promise<T>,
): Promise<
  { status: "current"; value: T } | { status: "stale"; reason: "chat_approval_authority_changed"; message: string }
> {
  const stale = {
    status: "stale",
    reason: "chat_approval_authority_changed",
    message: "Chat approval mode or project changed. Start a new turn.",
  } as const;
  return await deps.storage.runImmediateTransaction(async () => {
    const live = await readLiveMode(deps, turn.sessionId);
    if (!live || live.state.workspaceId !== turn.workspaceId) return stale;
    const { mode, projectId, modeRevision, autoAvailable } = live.state;
    const frozen = turn.chatApprovalAuthority;
    if (!frozen) {
      if (
        live.persisted?.mode === "auto" ||
        !Number.isSafeInteger(turn.admissionAggregateRevision) ||
        turn.admissionAggregateRevision < (live.persisted?.lastChangeAggregateRevision ?? 1)
      )
        return stale;
      return { status: "current", value: await commitBoundary({ mode: "standard" }) };
    }
    if (frozen.mode !== mode || !live.localSession) return stale;
    if (frozen.mode === "standard") {
      if (frozen.projectId !== projectId || frozen.modeRevision !== modeRevision) return stale;
      return { status: "current", value: await commitBoundary({ mode: "standard" }) };
    }
    const { binding } = frozen;
    if (
      !autoAvailable ||
      binding.sessionId !== turn.sessionId ||
      binding.workspaceId !== turn.workspaceId ||
      binding.projectId !== projectId ||
      binding.modeRevision !== modeRevision
    )
      return stale;
    return { status: "current", value: await commitBoundary({ mode: "auto", binding }) };
  });
}

async function readLiveMode(deps: ChatApprovalModeDependencies, sessionId: string) {
  const { storage } = deps;
  const meta = await storage.chatSessionMeta.getForUpdate(sessionId);
  if (!meta) return undefined;
  const persisted = await storage.chatSessionPrefs.getApprovalMode(sessionId);
  const assignment = await storage.chatSessionProjects.get(sessionId);
  const project = assignment && (await storage.chatProjects.findForUpdate(assignment.projectId));
  const scopedProject =
    project?.workspaceId === meta.workspaceId && project.lifecycleStatus === "active" ? project : undefined;
  const projectId = scopedProject?.projectId ?? null;
  const projectRevision = scopedProject?.revision ?? null;
  const localSession =
    meta.lifecycleStatus === "active" &&
    meta.origin !== "system" &&
    (await isDirectMissionSession(storage, sessionId, meta.workspaceId));
  const mode =
    persisted?.mode === "auto" &&
    localSession &&
    projectId &&
    persisted.workspaceId === meta.workspaceId &&
    persisted.projectId === projectId &&
    persisted.projectRevision === projectRevision
      ? "auto"
      : "standard";
  const state: ChatApprovalModeState = {
    mode,
    modeRevision: createHash("sha256")
      .update(canonicalJsonString([persisted?.modeRevision ?? null, meta.workspaceId, projectId, projectRevision]))
      .digest("hex"),
    workspaceId: meta.workspaceId,
    projectId,
    autoAvailable: deps.chatAutoApprovalEnabled === true && localSession && projectId !== null,
  };
  return { state, persisted, localSession, projectRevision, aggregateRevision: meta.revision };
}

async function isDirectMissionSession(
  storage: ChatApprovalModeDependencies["storage"],
  sessionId: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    const session = await storage.sessions.getBySessionId(sessionId);
    if (session.channel !== "mission" || session.kind !== "dm") return false;
    const parents = await storage.chatDelegationSteps.listParentsByChildSessionIds([sessionId], workspaceId);
    return !parents.has(sessionId);
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}
