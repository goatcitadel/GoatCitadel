import { ConflictError, ValidationError, type ChannelSetupDiscoveryInput, type ChannelSetupDiscoveryResult, type ChannelSetupDiscoveredTarget } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { assertDraftRevision, hydrateChannelSetupDraftSecrets } from "./channel-setup-draft-security.js";
import { requireReviewedChannelConnection } from "./channel-setup-connection-review.js";
import { buildEphemeralChannelConnection } from "./channel-setup-helpers.js";
import { buildTelegramTargetDirectory } from "./channel-target-directory.js";
import { parseTelegramUpdateTargets } from "./telegram-target-discovery.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";

export async function discoverChannelSetupTelegramTargets(host: ChannelSetupHost, input: ChannelSetupDiscoveryInput): Promise<ChannelSetupDiscoveryResult> {
  const draft = input.source === "draft" ? await host.storage.channelSetupDrafts.get(input.draftId) : undefined;
  if (draft && input.source === "draft") assertDraftRevision(draft, input.expectedRevision);
  if (draft) await requireReviewedChannelConnection(host, draft);
  const connection = draft ? await buildEphemeralChannelConnection(host, hydrateChannelSetupDraftSecrets(host, draft)) : await host.getIntegrationConnection((input as Extract<ChannelSetupDiscoveryInput, { source: "connection" }>).connectionId);
  if (connection.kind !== "channel" || connection.key !== "telegram") throw new ValidationError({ message: "Target discovery requires a Telegram channel." });
  if (input.source === "connection" && connection.revision !== input.expectedConnectionRevision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "The Telegram connection changed. Reload before discovering targets." });
  if (!host.fetchWithTimeout || !host.isConnectionUrlAllowlisted || !host.resolveConnectionSecret) throw new ValidationError({ message: "Governed Telegram target discovery is unavailable." });
  if (!host.isConnectionUrlAllowlisted("https://api.telegram.org")) throw new ValidationError({ message: "Telegram API host is not in the outbound allowlist." });
  const token = host.resolveConnectionSecret(connection.config, "botToken", "botTokenEnv", connection.catalogId);
  if (!token) throw new ValidationError({ message: "Configure the Telegram bot token through secure input before discovering targets." });
  const call = async (method: string): Promise<Record<string, unknown>> => {
    try {
    const response = await host.fetchWithTimeout!(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(8_000) });
    const body = await readBoundedResponseJson(response, { maxBytes: 256 * 1024, timeoutMs: 5_000, label: "Telegram target discovery" });
    if (response.status === 409 && method === "getUpdates") return { conflict: true };
    if (!response.ok || !isRecord(body) || body.ok === false) throw new ValidationError({ message: `Telegram target discovery could not complete (HTTP ${response.status}). Check bot credentials and provider availability.` });
    return body;
    } catch { throw new ValidationError({ message: "Telegram target discovery could not complete. Check bot credentials, provider availability and current delivery mode." }); }
  };
  const identity = await call("getMe");
  const webhook = await call("getWebhookInfo");
  const webhookResult = isRecord(webhook.result) ? webhook.result : {};
  const webhookActive = typeof webhookResult.url === "string" && webhookResult.url.length > 0;
  const warnings: string[] = [];
  const byTarget = new Map<string, ChannelSetupDiscoveredTarget>();
  const directory = buildTelegramTargetDirectory({ connectionId: connection.connectionId, connectionConfig: connection.config });
  for (const entry of directory.entries) byTarget.set(entry.targetId, { id: `telegram:${entry.targetId}`, label: entry.displayLabel, chatId: entry.targetId, kind: asKind(entry.kind), source: "connection_config" });
  const pairing = isRecord(connection.config.telegramPairing) ? connection.config.telegramPairing : {};
  for (const entry of Array.isArray(pairing.pending) ? pairing.pending.slice(0, 12) : []) {
    if (!isRecord(entry) || typeof entry.chatId !== "string") continue;
    byTarget.set(entry.chatId, { id: `telegram:${entry.chatId}`, label: typeof entry.displayName === "string" ? entry.displayName.slice(0, 128) : entry.chatId, chatId: entry.chatId, kind: "private", source: "pending_pairing" });
  }
  const persistedConnectionId = draft?.connectionId ?? (input.source === "connection" ? input.connectionId : undefined);
  if (persistedConnectionId && host.storage.inboundChannelEvents) {
    for (const event of await host.storage.inboundChannelEvents.listByConnection({ connectionId: persistedConnectionId, channelKey: "telegram", limit: 50 })) {
      const message = isRecord(event.payload.message) ? event.payload.message : {};
      const target = typeof message.room === "string" ? message.room : typeof message.peer === "string" ? message.peer : undefined;
      if (!target) continue;
      byTarget.set(target, { id: `telegram:${target}`, label: byTarget.get(target)?.label ?? target, chatId: target, kind: typeof message.room === "string" ? "group" : "private", source: "accepted_ingress" });
    }
  }
  if (webhookActive) warnings.push("Telegram update polling is unavailable while a webhook is active. Showing configured, paired and accepted destinations; the webhook has been preserved.");
  else {
    const updates = await call("getUpdates");
    if (updates.conflict) warnings.push("Telegram reports another active update consumer. Keep its delivery mode and choose a configured destination or enter one manually.");
    else for (const target of parseTelegramUpdateTargets(updates, input.setupCode)) byTarget.set(target.chatId, { ...target, source: "recent_update" });
  }
  if (draft && input.source === "draft") { assertDraftRevision(await host.storage.channelSetupDrafts.get(input.draftId), input.expectedRevision); await requireReviewedChannelConnection(host, draft); }
  if (input.source === "connection" && (await host.getIntegrationConnection(input.connectionId)).revision !== input.expectedConnectionRevision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "The Telegram connection changed during discovery. Reload before selecting targets." });
  const bot = isRecord(identity.result) ? identity.result : {};
  return { items: [...byTarget.values()].slice(0, 100), warnings, webhookActive, ...(typeof bot.id === "number" || typeof bot.id === "string" ? { botIdentity: { id: String(bot.id), ...(typeof bot.username === "string" ? { username: bot.username } : {}), ...(typeof bot.first_name === "string" ? { label: bot.first_name } : {}) } } : {}) };
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function asKind(value: string): ChannelSetupDiscoveredTarget["kind"] { return ["private", "group", "supergroup", "channel"].includes(value) ? value as ChannelSetupDiscoveredTarget["kind"] : "unknown"; }
