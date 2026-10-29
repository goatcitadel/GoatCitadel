import {
  ValidationError,
  type SlackSetupCheckInput,
  type SlackSetupCheckResult,
  type SlackSetupCodeSender,
} from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { assertDraftRevision, hydrateChannelSetupDraftSecrets } from "./channel-setup-draft-security.js";
import { channelSecretOwnerForDraft } from "./channel-secret-resolution.js";
import { buildEphemeralChannelConnection } from "./channel-setup-helpers.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";

/** Fixed sentences: an error here never carries a token, a socket address or anything Slack said. */
export const SLACK_BOT_TOKEN_REJECTED = "Slack didn't accept the bot token.";
export const SLACK_UNREACHABLE = "GoatCitadel couldn't reach Slack.";
export const SLACK_DRAFT_ONLY = "Choose a Slack setup draft to check.";

/** How many of the bot's direct-message conversations one ask reads, and how many of a conversation's newest messages. */
export const SLACK_SAY_HI_CONVERSATIONS = 5;
export const SLACK_HISTORY_LIMIT = 20;

const SLACK_API = "https://slack.com/api/";
const SLACK_CATALOG_ID = "channel.slack";
/** Slack's own stand-in for a person who isn't one: it never types a setup code. */
const SLACKBOT_USER_ID = "USLACKBOT";
const DIRECT_MESSAGE_PAGE_SIZE = "100";
/** Slack recommends no more than 200 conversations a page. The bot is found among them, so a few pages are read. */
const CHANNEL_PAGE_SIZE = "200";
const CHANNEL_PAGES = 5;
/** The largest answer is a page of channels with their topics and purposes. */
const MAX_ANSWER_BYTES = 1024 * 1024;

type SlackRecord = Record<string, unknown>;
type Named = { id: string; name: string };
interface AskOptions {
  query?: Record<string, string>;
  /** The one write-shaped call: `apps.connections.open`, a POST with no body. */
  post?: true;
}
/** Slack's answer when it said `ok`; undefined when it declined. Anything else is an error. */
type Ask = (token: string, method: string, options?: AskOptions) => Promise<SlackRecord | undefined>;
/** Like `Ask`, for a call whose refusal means Slack couldn't be used, not that a token was wrong. */
type Read = (token: string, method: string, options?: AskOptions) => Promise<SlackRecord>;

const fail = (message: string): ValidationError => new ValidationError({ message });

/**
 * Reads Slack's Web API with a setup draft's saved tokens and answers with names: the workspace and the bot, and, when
 * asked, whether the app-level token is accepted, who sent the setup code to the bot in a direct message and the
 * channels the bot is in. It only reads. Opening a Socket Mode connection is asked about, never done: the address
 * Slack answers with carries a one-time ticket, so it is never read, kept or returned.
 */
export async function checkSlackSetup(
  host: ChannelSetupHost,
  input: SlackSetupCheckInput,
): Promise<SlackSetupCheckResult> {
  const draft = await host.storage.channelSetupDrafts.get(input.draftId);
  if (draft.catalogId !== SLACK_CATALOG_ID) throw fail(SLACK_DRAFT_ONLY);
  assertDraftRevision(draft, input.expectedRevision);
  const connection = await buildEphemeralChannelConnection(host, hydrateChannelSetupDraftSecrets(host, draft));
  if (!host.fetchWithTimeout || !host.resolveConnectionSecret) throw fail(SLACK_UNREACHABLE);
  // A draft reads as the connection it will have and as itself.
  const owner = channelSecretOwnerForDraft(draft);
  const secret = (directKey: string, envKey: string): string | undefined =>
    host.resolveConnectionSecret!(connection.config, directKey, envKey, connection.catalogId, owner);
  const botToken = secret("botToken", "botTokenEnv");
  if (!botToken) throw fail(SLACK_BOT_TOKEN_REJECTED);

  const ask: Ask = (token, method, options) => askSlack(host.fetchWithTimeout!, token, method, options);
  const read: Read = async (token, method, options) => (await ask(token, method, options)) ?? failUnreachable();

  const identity = await ask(botToken, "auth.test");
  if (!identity) throw fail(SLACK_BOT_TOKEN_REJECTED);
  const workspace = namedOf(identity.team_id, identity.team);
  const bot = namedOf(identity.user_id, identity.user);
  if (!workspace || !bot) throw fail(SLACK_UNREACHABLE);

  // Nothing is asked for that wasn't wanted: Slack's reads are rate-limited and the page asks every few seconds.
  const appToken = input.checkAppToken ? await appTokenState(ask, secret("appToken", "appTokenEnv")) : undefined;
  const setupCode = input.setupCode?.trim();
  const sayHi = setupCode ? await findCodeSender(read, botToken, bot.id, setupCode) : undefined;
  const channels = input.listChannels ? await channelsBotIsIn(read, botToken) : undefined;

  return {
    workspace,
    bot: { userId: bot.id, name: bot.name },
    ...(appToken ? { appToken } : {}),
    ...(sayHi?.codeSender ? { codeSender: sayHi.codeSender } : {}),
    ...(sayHi?.manyConversations ? { manyConversations: true as const } : {}),
    ...(channels ? { channels } : {}),
  };
}

function failUnreachable(): never {
  throw fail(SLACK_UNREACHABLE);
}

/**
 * One Slack call. Returns the answer when Slack said `ok`, and undefined when it declined (`ok: false`, or a 401 or 403).
 * A busy or broken Slack, a call that never answered and an answer that isn't Slack's shape are `SLACK_UNREACHABLE`.
 * Whatever Slack said on a refusal is decided on and dropped, never quoted.
 */
async function askSlack(
  fetchWithTimeout: NonNullable<ChannelSetupHost["fetchWithTimeout"]>,
  token: string,
  method: string,
  options: AskOptions = {},
): Promise<SlackRecord | undefined> {
  const address = new URL(`${SLACK_API}${method}`);
  for (const [key, value] of Object.entries(options.query ?? {})) address.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetchWithTimeout(address.toString(), {
      method: options.post ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw fail(SLACK_UNREACHABLE);
  }
  if (response.status === 401 || response.status === 403) return undefined;
  if (!response.ok) throw fail(SLACK_UNREACHABLE);
  let answer: unknown;
  try {
    answer = await readBoundedResponseJson(response, {
      maxBytes: MAX_ANSWER_BYTES,
      timeoutMs: 5_000,
      label: "Slack setup check",
    });
  } catch {
    throw fail(SLACK_UNREACHABLE);
  }
  if (!isRecord(answer)) throw fail(SLACK_UNREACHABLE);
  if (answer.ok === true) return answer;
  if (answer.ok === false) return undefined;
  throw fail(SLACK_UNREACHABLE);
}

/** Whether Slack accepts the app-level token for Socket Mode. Only that it said `ok` is read from its answer. */
async function appTokenState(ask: Ask, token: string | undefined): Promise<"ok" | "rejected" | "missing"> {
  if (!token) return "missing";
  return (await ask(token, "apps.connections.open", { post: true })) ? "ok" : "rejected";
}

/**
 * Looks for `code` as the newest message a person sent the bot in a direct message, in the first few conversations.
 * Stops at the first one found, so a person who already said hi costs one history read, not five.
 */
async function findCodeSender(
  read: Read,
  token: string,
  botUserId: string,
  code: string,
): Promise<{ codeSender?: SlackSetupCodeSender; manyConversations?: true }> {
  const answer = await read(token, "conversations.list", {
    query: { types: "im", limit: DIRECT_MESSAGE_PAGE_SIZE },
  });
  const conversations = listOf(answer.channels).flatMap((value) => directMessageOf(value) ?? []);
  const manyConversations = conversations.length > SLACK_SAY_HI_CONVERSATIONS || nextCursorOf(answer) !== undefined;
  for (const conversation of conversations.slice(0, SLACK_SAY_HI_CONVERSATIONS)) {
    const history = await read(token, "conversations.history", {
      query: { channel: conversation.id, limit: String(SLACK_HISTORY_LIMIT) },
    });
    const actorId = listOf(history.messages)
      .map((message) => senderOfCode(message, botUserId, code))
      .find((sender) => sender !== undefined);
    if (actorId) {
      const displayName = await displayNameOf(read, token, actorId);
      return {
        codeSender: { actorId, directChannelId: conversation.id, ...(displayName ? { displayName } : {}) },
        ...(manyConversations ? { manyConversations: true as const } : {}),
      };
    }
  }
  return manyConversations ? { manyConversations: true } : {};
}

/** A direct-message conversation with a real person: not with Slackbot and not with someone whose account is gone. */
function directMessageOf(value: unknown): { id: string } | undefined {
  if (!isRecord(value) || !isFilled(value.id) || !isFilled(value.user)) return undefined;
  if (value.user === SLACKBOT_USER_ID || value.is_user_deleted === true) return undefined;
  return { id: value.id };
}

/**
 * Who sent `code` by itself in a message: a plain message from a person other than the bot, with no subtype (so not an
 * edit, a join or a file) and no `bot_id`, whose whole text is the code.
 */
function senderOfCode(message: unknown, botUserId: string, code: string): string | undefined {
  if (!isRecord(message) || message.type !== "message") return undefined;
  if (isPresent(message.subtype) || isPresent(message.bot_id)) return undefined;
  if (!isFilled(message.user) || message.user === botUserId) return undefined;
  return typeof message.text === "string" && message.text.trim() === code ? message.user : undefined;
}

/** A person's name as they chose to show it, else their real name, else their user name. */
async function displayNameOf(read: Read, token: string, userId: string): Promise<string | undefined> {
  const answer = await read(token, "users.info", { query: { user: userId } });
  const user = isRecord(answer.user) ? answer.user : undefined;
  const profile = isRecord(user?.profile) ? user.profile : undefined;
  return firstFilled([profile?.display_name, profile?.real_name, user?.name]);
}

/** The channels (public and private) the bot has been added to, in the order Slack lists them. */
async function channelsBotIsIn(read: Read, token: string): Promise<SlackChannel[]> {
  let channels: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CHANNEL_PAGES; page += 1) {
    const answer = await read(token, "conversations.list", {
      query: {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: CHANNEL_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
    });
    channels = [...channels, ...listOf(answer.channels).flatMap((value) => memberChannelOf(value) ?? [])];
    cursor = nextCursorOf(answer);
    if (!cursor) break;
  }
  return channels;
}

type SlackChannel = { id: string; name: string; private: boolean };

/** Slack lists every channel it can show; only the ones the bot is a member of are ones it can post in. */
function memberChannelOf(value: unknown): SlackChannel | undefined {
  if (!isRecord(value) || value.is_member !== true || !isFilled(value.id) || !isFilled(value.name)) return undefined;
  return { id: value.id, name: value.name, private: value.is_private === true };
}

/** The cursor of the next page, which Slack leaves empty on the last one. */
function nextCursorOf(answer: SlackRecord): string | undefined {
  const metadata = isRecord(answer.response_metadata) ? answer.response_metadata : undefined;
  return isFilled(metadata?.next_cursor) ? metadata.next_cursor : undefined;
}

/** An id with the name Slack gives it; the id stands in for a name Slack didn't give. */
function namedOf(id: unknown, name: unknown): Named | undefined {
  return isFilled(id) ? { id, name: firstFilled([name]) ?? id } : undefined;
}

function firstFilled(candidates: unknown[]): string | undefined {
  return candidates.find(isFilled)?.trim();
}

function listOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw fail(SLACK_UNREACHABLE);
  return value;
}

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is SlackRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
