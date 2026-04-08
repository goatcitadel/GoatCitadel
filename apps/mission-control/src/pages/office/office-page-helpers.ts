/**
 * Pure helpers extracted from OfficePage.tsx as part of Step 10
 * (page decomposition). These functions have no React or DOM
 * side effects and can be unit-tested in isolation.
 */

import type { RealtimeEvent } from "../../api/client";
import type { AgentDirectoryRecord } from "../../data/agent-roster";
import type { OfficeAttentionLevel, OfficeMotionMode, OperatorPreset } from "../../components/OfficeCanvas";

import { HOT_AGENT_WINDOW_MS, WARM_AGENT_WINDOW_MS, type OperatorPreferences } from "./office-page-constants";

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseTimestamp(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortEvents(events: RealtimeEvent[]): RealtimeEvent[] {
  return [...events].sort((left, right) => parseTimestamp(right.timestamp) - parseTimestamp(left.timestamp));
}

export function statusScore(status: AgentDirectoryRecord["status"]): number {
  if (status === "active") {
    return 3;
  }
  if (status === "idle") {
    return 2;
  }
  return 1;
}

export function classifyAgentHeat(lastSeenAt?: string): "hot" | "warm" | "cold" {
  const timestamp = parseTimestamp(lastSeenAt);
  const age = Date.now() - timestamp;
  if (timestamp > 0 && age <= HOT_AGENT_WINDOW_MS) {
    return "hot";
  }
  if (timestamp > 0 && age <= WARM_AGENT_WINDOW_MS) {
    return "warm";
  }
  return "cold";
}

export function formatClock(value?: string): string {
  const parsed = parseTimestamp(value);
  if (parsed <= 0) {
    return "-";
  }
  return new Date(parsed).toLocaleTimeString();
}

export function formatRelative(value?: string): string {
  const timestamp = parseTimestamp(value);
  if (!timestamp) {
    return "-";
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m ago`;
  }
  if (diffSeconds < 24 * 3600) {
    return `${Math.floor(diffSeconds / 3600)}h ago`;
  }
  return `${Math.floor(diffSeconds / (24 * 3600))}d ago`;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "AG";
  }
  if (parts.length === 1) {
    return (parts[0] ?? "AG").slice(0, 2).toUpperCase();
  }
  const left = parts[0]?.[0] ?? "A";
  const right = parts[1]?.[0] ?? "G";
  return `${left}${right}`.toUpperCase();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Step 10 round 3: additional pure helpers extracted from OfficePage.tsx
// ---------------------------------------------------------------------------

export function summarizeEvent(event: RealtimeEvent): string {
  const payload = asRecord(event.payload);
  if (event.eventType === "tool_invoked") {
    const toolName = asString(payload.toolName) ?? "tool";
    const outcome = asString(payload.outcome) ?? "executed";
    return `${toolName} -> ${outcome}`;
  }
  if (event.eventType === "approval_created") {
    const kind = asString(payload.kind) ?? "approval";
    const riskLevel = asString(payload.riskLevel) ?? "unknown";
    return `${kind} (${riskLevel})`;
  }
  if (event.eventType === "activity_logged") {
    const activity = asRecord(payload.activity);
    return truncate(asString(activity.message) ?? "task activity", 80);
  }
  if (event.eventType === "task_updated" || event.eventType === "task_created") {
    const task = asRecord(payload.task);
    const title = asString(task.title) ?? asString(task.taskId) ?? "task";
    return truncate(title, 80);
  }
  return truncate(JSON.stringify(payload), 80);
}

export function extractTaskId(event: RealtimeEvent): string | undefined {
  const payload = asRecord(event.payload);
  const taskId = asString(payload.taskId);
  if (taskId) {
    return taskId;
  }
  const task = asRecord(payload.task);
  return asString(task.taskId);
}

export function extractSessionId(event: RealtimeEvent): string | undefined {
  const payload = asRecord(event.payload);
  const sessionId = asString(payload.sessionId);
  if (sessionId) {
    return sessionId;
  }
  const session = asRecord(payload.session);
  return asString(session.agentSessionId);
}

export function attentionLabel(attentionLevel: OfficeAttentionLevel): string {
  if (attentionLevel === "priority") {
    return "Priority";
  }
  if (attentionLevel === "watch") {
    return "Watch";
  }
  return "Stable";
}

export function attentionPillClass(attentionLevel: OfficeAttentionLevel): string {
  if (attentionLevel === "priority") {
    return "office-pill-priority";
  }
  if (attentionLevel === "watch") {
    return "office-pill-watch";
  }
  return "office-pill-active";
}

export function sanitizeOperatorName(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().slice(0, 40);
  return trimmed || undefined;
}

export function isOperatorPreset(value: unknown): value is OperatorPreset {
  return value === "trailblazer" || value === "strategist" || value === "nightwatch";
}

export function isOfficeMotionMode(value: unknown): value is OfficeMotionMode {
  return value === "cinematic" || value === "balanced" || value === "subtle" || value === "reduced";
}

export function asBooleanOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

export function readOperatorPreferences(storageKey: string, defaults: OperatorPreferences): OperatorPreferences {
  if (typeof window === "undefined") {
    return { ...defaults };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return { ...defaults };
    }
    const parsed = JSON.parse(raw) as Partial<OperatorPreferences>;
    return {
      name: sanitizeOperatorName(parsed.name) || defaults.name,
      preset: isOperatorPreset(parsed.preset) ? parsed.preset : defaults.preset,
      layoutMode: "immersive",
      motionMode: isOfficeMotionMode(parsed.motionMode) ? parsed.motionMode : defaults.motionMode,
      showCollabOverlay: asBooleanOr(parsed.showCollabOverlay, defaults.showCollabOverlay),
      showInspectorDock: asBooleanOr(parsed.showInspectorDock, defaults.showInspectorDock),
      showRailDock: asBooleanOr(parsed.showRailDock, defaults.showRailDock),
      idleMillingEnabled: asBooleanOr(parsed.idleMillingEnabled, defaults.idleMillingEnabled),
      focusMode: asBooleanOr(parsed.focusMode, defaults.focusMode),
      quietMode: asBooleanOr(parsed.quietMode, defaults.quietMode),
      followSelection: asBooleanOr(parsed.followSelection, defaults.followSelection),
    };
  } catch {
    return { ...defaults };
  }
}

export function buildOperatorThought(input: {
  activeAgents: number;
  blockedAgents: number;
  pendingApprovals: number;
  eventFlow: number;
}): string {
  if (input.blockedAgents > 0) {
    return `${input.blockedAgents} goats are blocked. Prioritize approvals and clear policy conflicts.`;
  }
  if (input.pendingApprovals > 0) {
    return `${input.pendingApprovals} approvals pending while ${input.activeAgents} goats stay in motion.`;
  }
  if (input.activeAgents === 0) {
    return "No goats are currently active. Ready to assign a fresh wave.";
  }
  return `${input.activeAgents} goats are running at ${input.eventFlow.toFixed(1)} events per minute.`;
}

export function persistOperatorPreferences(
  storageKey: string,
  value: OperatorPreferences,
  defaults: OperatorPreferences,
): void {
  if (typeof window === "undefined") {
    return;
  }
  const payload: OperatorPreferences = {
    name: sanitizeOperatorName(value.name) || defaults.name,
    preset: isOperatorPreset(value.preset) ? value.preset : defaults.preset,
    layoutMode: "immersive",
    motionMode: isOfficeMotionMode(value.motionMode) ? value.motionMode : defaults.motionMode,
    showCollabOverlay: value.showCollabOverlay,
    showInspectorDock: value.showInspectorDock,
    showRailDock: value.showRailDock,
    idleMillingEnabled: value.idleMillingEnabled,
    focusMode: value.focusMode,
    quietMode: value.quietMode,
    followSelection: value.followSelection,
  };
  window.localStorage.setItem(storageKey, JSON.stringify(payload));
}
