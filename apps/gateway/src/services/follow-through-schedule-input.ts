import {
  type CronAgentTurnConfig,
  type CronFollowThroughEventConfig,
  type FollowThroughChannelDestination,
  type IntegrationConnection,
} from "@goatcitadel/contracts";

export function resolveFollowThroughDestination(
  connection: IntegrationConnection,
  workspaceId: string,
): FollowThroughChannelDestination | undefined {
  if (!connection.enabled || connection.status !== "connected" || (connection.workspaceId ?? "default") !== workspaceId)
    return undefined;
  const channelKey = connection.key;
  if (channelKey !== "discord" && channelKey !== "ntfy") return undefined;
  if (
    channelKey === "discord" &&
    (connection.config.runtimeMode !== "gateway" || connection.config.webhookUrl || connection.config.webhookUrlEnv)
  )
    return undefined;
  const { defaultChannelId, defaultDiscordChannelId, topic } = connection.config;
  const candidate = channelKey === "discord" ? (defaultChannelId ?? defaultDiscordChannelId) : topic;
  const target = typeof candidate === "string" ? candidate.trim() : "";
  if (channelKey === "discord" ? !/^\d{10,25}$/u.test(target) : !/^[\w-]{1,64}$/u.test(target)) return undefined;
  return {
    connectionId: connection.connectionId,
    revision: connection.revision,
    channelKey,
    target,
    label: connection.label,
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Invalid reviewed follow-through trigger.");
  return value;
}
function identifier(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new Error("Follow-through trigger requires an exact owner identifier.");
  return value.trim();
}
function timestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/T.*(?:Z|[+-]\d\d:\d\d)$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Choose an exact follow-through time with a timezone offset.");
  return new Date(value).toISOString();
}
function zone(value: unknown) {
  const timezone = identifier(value);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("Choose a supported IANA timezone for follow-through.");
  }
  return timezone;
}
export function normalizeFollowThroughSchedule(
  raw: Record<string, unknown>,
  sessionId: string | undefined,
): Pick<CronAgentTurnConfig, "eventWake" | "oneShot"> {
  if (raw.eventWake !== undefined && raw.oneShot !== undefined)
    throw new Error("Choose one event or one-shot trigger.");
  if (raw.eventWake !== undefined) {
    const input = exact(raw.eventWake, [
      "version",
      "eventType",
      "hookId",
      "workspaceId",
      "sourceSessionId",
      "notBefore",
      "timezone",
    ]);
    if (input.version !== 1 || input.eventType !== "subagent.end" || !sessionId || input.sourceSessionId !== sessionId)
      throw new Error("The event trigger must name this conversation and a supported server event.");
    const eventWake: CronFollowThroughEventConfig = {
      version: 1,
      eventType: "subagent.end",
      hookId: identifier(input.hookId),
      workspaceId: identifier(input.workspaceId),
      sourceSessionId: sessionId,
      notBefore: timestamp(input.notBefore),
      timezone: zone(input.timezone),
    };
    return { eventWake };
  }
  if (raw.oneShot !== undefined) {
    const input = exact(raw.oneShot, ["at", "timezone"]);
    return { oneShot: { at: timestamp(input.at), timezone: zone(input.timezone) } };
  }
  return {};
}
