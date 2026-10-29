import {
  ValidationError,
  type ChannelSetupPerson,
  type DiscordSetupCheckInput,
  type DiscordSetupCheckResult,
} from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { assertDraftRevision, hydrateChannelSetupDraftSecrets } from "./channel-setup-draft-security.js";
import { channelSecretOwnerForDraft } from "./channel-secret-resolution.js";
import { buildEphemeralChannelConnection } from "./channel-setup-helpers.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";

/** Fixed sentences: an error here never carries a token, a URL or anything Discord said. */
export const DISCORD_TOKEN_REJECTED = "Discord didn't accept the bot token.";
export const DISCORD_UNREACHABLE = "GoatCitadel couldn't reach Discord.";
export const DISCORD_DM_REFUSED = "GoatCitadel opens a direct message only with someone who made the bot.";
export const DISCORD_DRAFT_ONLY = "Choose a Discord setup draft to check.";

const DISCORD_API = "https://discord.com/api/v10";
/** `GATEWAY_MESSAGE_CONTENT` (1 << 18) and `GATEWAY_MESSAGE_CONTENT_LIMITED` (1 << 19): either one means the intent is on. */
const MESSAGE_CONTENT_INTENT_FLAGS = (1 << 18) | (1 << 19);
const TEXT_CHANNEL_TYPE = 0;
const ACCEPTED_TEAM_MEMBER = 2;
/** A server's channel list is the largest answer: a few hundred channels with their permission overwrites. */
const MAX_ANSWER_BYTES = 1024 * 1024;

type DiscordRecord = Record<string, unknown>;

const fail = (message: string): ValidationError => new ValidationError({ message });

/**
 * Reads Discord's REST API with a setup draft's saved bot token and answers with names: the bot, who made it, its
 * servers and, when asked, one server's text channels or a direct-message channel with someone who made the bot.
 * The one write is opening that direct-message channel, which sends nothing.
 */
export async function checkDiscordSetup(
  host: ChannelSetupHost,
  input: DiscordSetupCheckInput,
): Promise<DiscordSetupCheckResult> {
  const draft = await host.storage.channelSetupDrafts.get(input.draftId);
  if (draft.catalogId !== "channel.discord") throw fail(DISCORD_DRAFT_ONLY);
  assertDraftRevision(draft, input.expectedRevision);
  const connection = await buildEphemeralChannelConnection(host, hydrateChannelSetupDraftSecrets(host, draft));
  if (!host.fetchWithTimeout || !host.resolveConnectionSecret) throw fail(DISCORD_UNREACHABLE);
  // A draft reads as the connection it will have and as itself.
  const token = host.resolveConnectionSecret(
    connection.config,
    "botToken",
    "botTokenEnv",
    connection.catalogId,
    channelSecretOwnerForDraft(draft),
  );
  if (!token) throw fail(DISCORD_TOKEN_REJECTED);

  const ask = async (path: string, openDirectMessageWith?: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await host.fetchWithTimeout!(`${DISCORD_API}${path}`, {
        headers: {
          Authorization: `Bot ${token}`,
          ...(openDirectMessageWith ? { "Content-Type": "application/json" } : {}),
        },
        ...(openDirectMessageWith
          ? { method: "POST", body: JSON.stringify({ recipient_id: openDirectMessageWith }) }
          : {}),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw fail(DISCORD_UNREACHABLE);
    }
    if (response.status === 401) throw fail(DISCORD_TOKEN_REJECTED);
    if (!response.ok) throw fail(DISCORD_UNREACHABLE);
    try {
      return await readBoundedResponseJson(response, {
        maxBytes: MAX_ANSWER_BYTES,
        timeoutMs: 5_000,
        label: "Discord setup check",
      });
    } catch {
      throw fail(DISCORD_UNREACHABLE);
    }
  };

  const bot = personOf(await ask("/users/@me"));
  if (!bot) throw fail(DISCORD_UNREACHABLE);
  const application = await ask("/applications/@me");
  if (!isRecord(application) || typeof application.id !== "string" || !application.id) throw fail(DISCORD_UNREACHABLE);
  const makers = makersOf(application);
  const servers = listOf(await ask("/users/@me/guilds")).flatMap((guild) => personOf(guild) ?? []);

  // Only a server the bot is in is asked about: Discord's refusal for any other says nothing a person can use.
  const guildId = input.guildId;
  const channels =
    guildId && servers.some((server) => server.id === guildId)
      ? textChannelsOf(listOf(await ask(`/guilds/${encodeURIComponent(guildId)}/channels`)))
      : undefined;
  let directChannelId: string | undefined;
  if (input.directMessageWith) {
    if (!makers.some((maker) => maker.id === input.directMessageWith)) throw fail(DISCORD_DM_REFUSED);
    const opened = await ask("/users/@me/channels", input.directMessageWith);
    if (!isRecord(opened) || typeof opened.id !== "string" || !opened.id) throw fail(DISCORD_UNREACHABLE);
    directChannelId = opened.id;
  }

  return {
    bot,
    applicationId: application.id,
    messageContentIntent:
      typeof application.flags === "number" &&
      Number.isInteger(application.flags) &&
      (application.flags & MESSAGE_CONTENT_INTENT_FLAGS) !== 0,
    makers,
    servers,
    ...(channels ? { channels } : {}),
    ...(directChannelId ? { directChannelId } : {}),
  };
}

/** The app's owner, or its team's owner first and then the team's accepted members. */
function makersOf(application: DiscordRecord): ChannelSetupPerson[] {
  const team = isRecord(application.team) ? application.team : undefined;
  const accepted = (Array.isArray(team?.members) ? (team.members as unknown[]) : []).flatMap((member) =>
    isRecord(member) && member.membership_state === ACCEPTED_TEAM_MEMBER ? (personOf(member.user) ?? []) : [],
  );
  if (accepted.length === 0) {
    const owner = personOf(application.owner);
    return owner ? [owner] : [];
  }
  return [
    ...accepted.filter((member) => member.id === team?.owner_user_id),
    ...accepted.filter((member) => member.id !== team?.owner_user_id),
  ];
}

/** A server's text channels in the order Discord shows them. */
function textChannelsOf(channels: unknown[]): ChannelSetupPerson[] {
  return channels
    .filter((channel): channel is DiscordRecord => isRecord(channel) && channel.type === TEXT_CHANNEL_TYPE)
    .sort((a, b) => positionOf(a) - positionOf(b))
    .flatMap((channel) => personOf(channel) ?? []);
}

const positionOf = (channel: DiscordRecord): number => (typeof channel.position === "number" ? channel.position : 0);

/** A person, bot, server or channel by its name: `global_name ?? username` for a user, `name` for the rest. */
function personOf(value: unknown): ChannelSetupPerson | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return undefined;
  const name = [value.global_name, value.username, value.name].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
  );
  return { id: value.id, name: name ?? value.id };
}

function listOf(answer: unknown): unknown[] {
  if (!Array.isArray(answer)) throw fail(DISCORD_UNREACHABLE);
  return answer;
}

function isRecord(value: unknown): value is DiscordRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
