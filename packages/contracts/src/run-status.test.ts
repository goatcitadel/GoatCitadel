import { describe, expect, it } from "vitest";
import type { DurableRunStatus } from "./durable.js";
import type { OrchestrationRunStatus } from "./orchestration.js";
import type { ChatTurnLifecycleStatus } from "./chat.js";
import {
  CHAT_TURN_PHASE,
  DURABLE_RUN_PHASE,
  ORCHESTRATION_RUN_PHASE,
  isChatTurnWaitingStatus,
  isDurableRunActive,
  isDurableRunStatus,
  isDurableRunTerminal,
  isDurableRunWaiting,
  isOrchestrationRunTerminal,
  toCanonicalRunPhaseFromChatTurn,
  toCanonicalRunPhaseFromDurable,
  toCanonicalRunPhaseFromOrchestration,
  type CanonicalRunPhase,
} from "./run-status.js";

// The canonical enum value sets. If a new status value is added to any enum,
// the `satisfies Record<Status, …>` in run-status.ts fails to compile AND this
// test fails until the value is classified here — the point of Finding 7.
const DURABLE_STATUSES: DurableRunStatus[] = [
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "dead_lettered",
];
const ORCHESTRATION_STATUSES: OrchestrationRunStatus[] = [
  "queued",
  "running",
  "paused",
  "failed",
  "completed",
  "stopped_by_limit",
  "cancelled",
];
const CHAT_TURN_STATUSES: ChatTurnLifecycleStatus[] = [
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "waiting_for_user_input",
  "completed",
  "partial",
  "failed",
  "cancelled",
];

const VALID_PHASES: CanonicalRunPhase[] = ["pending", "active", "waiting", "terminal"];

describe("run-status canonical vocabulary", () => {
  it("maps every durable status to a valid phase and nothing else", () => {
    expect(Object.keys(DURABLE_RUN_PHASE).sort()).toEqual([...DURABLE_STATUSES].sort());
    for (const status of DURABLE_STATUSES) {
      expect(VALID_PHASES).toContain(toCanonicalRunPhaseFromDurable(status));
    }
  });

  it("maps every orchestration status to a valid phase and nothing else", () => {
    expect(Object.keys(ORCHESTRATION_RUN_PHASE).sort()).toEqual([...ORCHESTRATION_STATUSES].sort());
    for (const status of ORCHESTRATION_STATUSES) {
      expect(VALID_PHASES).toContain(toCanonicalRunPhaseFromOrchestration(status));
    }
  });

  it("maps every chat-turn status to a valid phase and nothing else", () => {
    expect(Object.keys(CHAT_TURN_PHASE).sort()).toEqual([...CHAT_TURN_STATUSES].sort());
    for (const status of CHAT_TURN_STATUSES) {
      expect(VALID_PHASES).toContain(toCanonicalRunPhaseFromChatTurn(status));
    }
  });

  it("classifies durable terminal statuses exactly (locks the 3 previously-duplicated predicates)", () => {
    const terminal = DURABLE_STATUSES.filter(isDurableRunTerminal);
    expect(terminal.sort()).toEqual(["cancelled", "completed", "dead_lettered", "failed"]);
  });

  it("classifies durable waiting/active statuses", () => {
    expect(DURABLE_STATUSES.filter(isDurableRunWaiting).sort()).toEqual(["paused", "waiting"]);
    expect(DURABLE_STATUSES.filter(isDurableRunActive)).toEqual(["running"]);
  });

  it("classifies orchestration terminal statuses exactly", () => {
    const terminal = ORCHESTRATION_STATUSES.filter(isOrchestrationRunTerminal);
    expect(terminal.sort()).toEqual(["cancelled", "completed", "failed", "stopped_by_limit"]);
  });

  it("classifies chat-turn waiting statuses exactly (locks the previously-local isWaitingTraceStatus)", () => {
    const waiting = CHAT_TURN_STATUSES.filter(isChatTurnWaitingStatus);
    expect(waiting.sort()).toEqual(["waiting_for_approval", "waiting_for_tool", "waiting_for_user_input"]);
  });

  it("predicates agree with the phase maps for every status", () => {
    for (const status of DURABLE_STATUSES) {
      expect(isDurableRunTerminal(status)).toBe(DURABLE_RUN_PHASE[status] === "terminal");
      expect(isDurableRunWaiting(status)).toBe(DURABLE_RUN_PHASE[status] === "waiting");
      expect(isDurableRunActive(status)).toBe(DURABLE_RUN_PHASE[status] === "active");
    }
    for (const status of ORCHESTRATION_STATUSES) {
      expect(isOrchestrationRunTerminal(status)).toBe(ORCHESTRATION_RUN_PHASE[status] === "terminal");
    }
    for (const status of CHAT_TURN_STATUSES) {
      expect(isChatTurnWaitingStatus(status)).toBe(CHAT_TURN_PHASE[status] === "waiting");
    }
  });

  it("isDurableRunStatus guards unknown strings", () => {
    expect(isDurableRunStatus("running")).toBe(true);
    expect(isDurableRunStatus("dead_lettered")).toBe(true);
    expect(isDurableRunStatus("nope")).toBe(false);
    expect(isDurableRunStatus(undefined)).toBe(false);
  });
});
