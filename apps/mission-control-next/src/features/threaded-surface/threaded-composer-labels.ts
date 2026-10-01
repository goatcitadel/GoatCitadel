import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import type { ContextStripMode } from "../native-routes/primitives";

/** Drops the default "Command" source and generic "Available" state, which every row would repeat. */
export function formatPaletteItemMeta(item: { sourceLabel?: string; availabilityLabel?: string }): string | null {
  const source = item.sourceLabel && item.sourceLabel !== "Command" ? item.sourceLabel : null;
  const availability = item.availabilityLabel && item.availabilityLabel !== "Available" ? item.availabilityLabel : null;
  return [source, availability].filter(Boolean).join(" · ") || null;
}

export function getPlaceholder(mode: MissionThreadedActiveSessionSurfaceProps["mode"]): string {
  if (mode === "code") {
    return "Describe the implementation task, constraints, or review goal…";
  }
  if (mode === "cowork") {
    return "Describe the work to coordinate, research, or move forward…";
  }
  return "Ask GoatCitadel anything…";
}

export function getSendLabel(props: MissionThreadedActiveSessionSurfaceProps): string {
  if (props.mode === "cowork") {
    if (
      props.selectedTurn?.trace.status === "waiting_for_approval" ||
      props.selectedTurn?.trace.status === "waiting_for_user_input"
    ) {
      return "Resolve blocker";
    }
    if (props.editingTurnId) {
      return "Delegate branch";
    }
    return props.sending ? "Delegating..." : "Delegate";
  }

  if (props.mode === "code") {
    if (props.editingTurnId) {
      return "Implement branch";
    }
    return props.sending ? "Implementing..." : "Implement";
  }

  if (props.editingTurnId) {
    return "Send branch";
  }
  return props.sending ? "Sending..." : "Send";
}

export function formatDelegationConfidence(confidence?: number): string | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return null;
  }
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}% confidence`;
}

const IN_PROGRESS_MEMORY_TRACE_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "streaming",
  "in_progress",
  "waiting_for_approval",
  "waiting_for_user_input",
]);

export function toContextStripMode(mode: MissionThreadedActiveSessionSurfaceProps["mode"]): ContextStripMode {
  return mode === "code" || mode === "cowork" ? mode : "chat";
}

export function formatHistoricalMemoryLabel(
  thread: MissionThreadedActiveSessionSurfaceProps["thread"],
): string | undefined {
  const lastTurn = thread?.turns?.at(-1);
  const memoryMode = lastTurn?.trace?.memoryMode?.trim();
  if (!memoryMode || memoryMode === "off") {
    return undefined;
  }
  const status = lastTurn?.trace?.status;
  if (status && IN_PROGRESS_MEMORY_TRACE_STATUSES.has(status)) {
    return undefined;
  }
  return `Last turn: ${memoryMode}`;
}

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatCompactList(values: Set<string>, fallbackLabel: string): string {
  const items = Array.from(values).filter(Boolean);
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return `${fallbackLabel}: ${items[0]}`;
  }
  return `${fallbackLabel}: ${items.length}`;
}

export function getComposerCapabilityUseChips(props: MissionThreadedActiveSessionSurfaceProps) {
  const selectedIds = new Set(props.selectedContextTurnIds ?? []);
  const turns = props.thread?.turns.filter((turn) => selectedIds.size > 0 && selectedIds.has(turn.turnId)) ?? [];
  const scopedTurns =
    turns.length > 0
      ? turns
      : props.selectedTurn
        ? [props.selectedTurn]
        : props.thread?.turns.at(-1)
          ? [props.thread.turns.at(-1)!]
          : [];
  const skills = new Set<string>();
  const connectors = new Set<string>();
  const mcpServers = new Set<string>();

  for (const turn of scopedTurns) {
    for (const toolRun of turn.toolRuns ?? []) {
      const args = toolRun.args ?? {};
      const skillId = readStringField(args.skillId) ?? readStringField(args.skill);
      if (skillId || /^skills?\./i.test(toolRun.toolName)) {
        skills.add(skillId ?? toolRun.toolName);
      }

      const connectorId =
        readStringField(args.connectorId) ??
        readStringField(args.connectionId) ??
        readStringField(args.integrationConnectionId);
      if (connectorId || /\b(connector|integration)\b/i.test(toolRun.toolName)) {
        connectors.add(connectorId ?? toolRun.toolName);
      }

      const serverId =
        readStringField(args.serverId) ?? readStringField(args.mcpServerId) ?? readStringField(args.server);
      if (serverId || /\bmcp\b/i.test(toolRun.toolName)) {
        mcpServers.add(serverId ?? toolRun.toolName);
      }
    }
  }

  return [
    formatCompactList(skills, "Skills"),
    formatCompactList(connectors, "Connectors"),
    formatCompactList(mcpServers, "MCP"),
  ].filter(Boolean);
}
