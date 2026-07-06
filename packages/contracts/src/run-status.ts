// Canonical run-status vocabulary (review Finding 7).
//
// GoatCitadel has three genuinely distinct, independently-persisted run-status
// unions — durable runs, orchestration runs, and chat-turn lifecycle — that were
// each re-deriving their own terminal/waiting/active predicates in-line across
// several services. Divergence between those hand-maintained predicates is the
// documented root cause of the recurring "false-terminal / false-resume" bug
// class. This module is the single source of truth for classifying each enum.
//
// IMPORTANT: this is an additive, behavior-preserving layer. It does NOT merge or
// rename the persisted enum *values* (e.g. it keeps `waiting_for_tool` distinct
// from `waiting`, and `dead_lettered`/`stopped_by_limit` distinct) — those are
// wire/storage values and unifying them is a separate migration. Here we only
// provide shared predicates and a lattice bridge over the existing values.

import type { DurableRunStatus } from "./durable.js";
import type { OrchestrationRunStatus } from "./orchestration.js";
import type { ChatTurnLifecycleStatus } from "./chat.js";

/**
 * The small shared lattice every run-status enum maps into. This is a coarse
 * classification for cross-cutting UI/logic ("is this run done / working /
 * blocked / not-yet-started"); it is not a replacement for the precise per-enum
 * value when exact semantics matter.
 */
export type CanonicalRunPhase = "pending" | "active" | "waiting" | "terminal";

// --- Durable runs -----------------------------------------------------------

// Exhaustive by construction: `satisfies Record<DurableRunStatus, …>` fails to
// compile if a new DurableRunStatus value is added without a phase here.
export const DURABLE_RUN_PHASE = {
  queued: "pending",
  running: "active",
  waiting: "waiting",
  paused: "waiting",
  completed: "terminal",
  failed: "terminal",
  cancelled: "terminal",
  dead_lettered: "terminal",
} as const satisfies Record<DurableRunStatus, CanonicalRunPhase>;

export function toCanonicalRunPhaseFromDurable(status: DurableRunStatus): CanonicalRunPhase {
  return DURABLE_RUN_PHASE[status];
}

/** Terminal durable statuses: completed | failed | cancelled | dead_lettered. */
export function isDurableRunTerminal(status: DurableRunStatus): boolean {
  return DURABLE_RUN_PHASE[status] === "terminal";
}

/** Waiting/parked durable statuses: waiting | paused. */
export function isDurableRunWaiting(status: DurableRunStatus): boolean {
  return DURABLE_RUN_PHASE[status] === "waiting";
}

/** Actively-executing durable status: running. */
export function isDurableRunActive(status: DurableRunStatus): boolean {
  return DURABLE_RUN_PHASE[status] === "active";
}

const DURABLE_RUN_STATUS_VALUES = Object.keys(DURABLE_RUN_PHASE) as DurableRunStatus[];

/** Runtime type guard for an unknown string being a DurableRunStatus. */
export function isDurableRunStatus(status: string | undefined): status is DurableRunStatus {
  return status !== undefined && (DURABLE_RUN_STATUS_VALUES as readonly string[]).includes(status);
}

// --- Orchestration runs -----------------------------------------------------

export const ORCHESTRATION_RUN_PHASE = {
  queued: "pending",
  running: "active",
  paused: "waiting",
  failed: "terminal",
  completed: "terminal",
  stopped_by_limit: "terminal",
  cancelled: "terminal",
} as const satisfies Record<OrchestrationRunStatus, CanonicalRunPhase>;

export function toCanonicalRunPhaseFromOrchestration(status: OrchestrationRunStatus): CanonicalRunPhase {
  return ORCHESTRATION_RUN_PHASE[status];
}

/** Terminal orchestration statuses: failed | completed | stopped_by_limit | cancelled. */
export function isOrchestrationRunTerminal(status: OrchestrationRunStatus): boolean {
  return ORCHESTRATION_RUN_PHASE[status] === "terminal";
}

// --- Chat-turn lifecycle ----------------------------------------------------
//
// NOTE: chat.ts already owns `isChatTurnTerminalStatus` / `isChatTurnActiveStatus`
// (and treats `partial` as terminal). Those remain the authority for chat-turn
// terminal/active checks; we add only the phase map and the waiting predicate,
// which no shared helper covered before.

export const CHAT_TURN_PHASE = {
  queued: "pending",
  running: "active",
  waiting_for_tool: "waiting",
  waiting_for_approval: "waiting",
  waiting_for_user_input: "waiting",
  completed: "terminal",
  partial: "terminal",
  failed: "terminal",
  cancelled: "terminal",
} as const satisfies Record<ChatTurnLifecycleStatus, CanonicalRunPhase>;

export function toCanonicalRunPhaseFromChatTurn(status: ChatTurnLifecycleStatus): CanonicalRunPhase {
  return CHAT_TURN_PHASE[status];
}

/** Waiting chat-turn statuses: waiting_for_tool | waiting_for_approval | waiting_for_user_input. */
export function isChatTurnWaitingStatus(status: ChatTurnLifecycleStatus): boolean {
  return CHAT_TURN_PHASE[status] === "waiting";
}
