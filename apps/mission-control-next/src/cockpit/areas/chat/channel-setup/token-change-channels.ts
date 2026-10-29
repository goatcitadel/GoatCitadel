import type { ComponentType } from "react";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  checkDiscordSetup,
  checkSlackSetup,
  checkWhatsAppSetup,
  fetchChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  DISCORD_CATALOG_ID,
  DISCORD_INTENT_OFF,
  DISCORD_TOKEN_FAILED,
  DISCORD_TURN_ON_WORDING,
  discordTokenWorks,
} from "./discord-setup-model";
import {
  SLACK_APP_TOKEN_FAILED,
  SLACK_BOT_TOKEN_FAILED,
  SLACK_CATALOG_ID,
  SLACK_TURN_ON_WORDING,
  slackTokensWork,
} from "./slack-setup-model";
import { saveKeyWording, type TokenCheckOutcome, type TokenInputs } from "./token-change-model";
import { DiscordTokenFields, SlackTokenFields, WhatsAppTokenFields, type TokenFieldsProps } from "./TokenChangeFields";
import type { TurnOnWording } from "./TurnOnStep";
import { WHATSAPP_CATALOG_ID, WHATSAPP_CHECK_FAILED, WHATSAPP_TURN_ON_WORDING } from "./whatsapp-setup-model";

/** The draft a check reads its stored tokens from, at the version the page is looking at. */
export interface TokenCheckDraft {
  draftId: string;
  expectedRevision: number;
}

/** Everything that differs between changing Discord's token, Slack's two and WhatsApp's access token. */
export interface TokenChangeChannel {
  /** The channel's catalog key, as a connection carries it. */
  key: "discord" | "slack" | "whatsapp";
  catalogId: string;
  title: string;
  pasteTitle: string;
  saveTitle: string;
  /** What the page tells a screen reader while the tokens are being checked. */
  checking: string;
  /** The one sentence any failure comes to. */
  failed: string;
  /** More than one token: the warning says "these tokens", "them". */
  many: boolean;
  /** The saved setting that names the bot the channel uses now. */
  savedBotKey: string;
  /** What the running channel reports about its bot under this key, when it does. */
  runningBotNameKey?: string;
  /** What saving sends, as the one line the save step lists, when it is not the line the key pages share. */
  testMessage?: string;
  wording: TurnOnWording;
  /** The secrets to store, or nothing when a token is still empty. Blanks around a token are not part of it. */
  secretValues(tokens: TokenInputs): Record<string, string> | null;
  /** Asks the channel's own service about the stored tokens. A failure throws; the caller says it in `failed`. */
  check(draft: TokenCheckDraft): Promise<TokenCheckOutcome>;
  Fields: ComponentType<TokenFieldsProps>;
}

const DISCORD: TokenChangeChannel = {
  key: "discord",
  catalogId: DISCORD_CATALOG_ID,
  title: "Change Discord's token",
  pasteTitle: "Paste the new token",
  saveTitle: "Save the new token",
  checking: "Checking your token…",
  failed: DISCORD_TOKEN_FAILED,
  many: false,
  savedBotKey: "applicationId",
  runningBotNameKey: "connectedBotTag",
  wording: saveKeyWording({
    done: "Saved. Discord uses the new token now.",
    doneLink: "Back to Discord's page",
    cleanup: DISCORD_TURN_ON_WORDING.cleanup,
  }),
  secretValues: ({ botToken }) => (botToken.trim() ? { botToken: botToken.trim() } : null),
  async check(draft) {
    const found = await checkDiscordSetup(draft);
    return {
      kind: "checked",
      checked: {
        botId: found.applicationId,
        botName: found.bot.name,
        works: discordTokenWorks(found.bot.name),
        // GoatCitadel's connection to Discord asks for Message Content Intent, and Discord refuses it without.
        ...(found.messageContentIntent ? {} : { inTheWay: DISCORD_INTENT_OFF }),
      },
      // The invite link and the bot people message follow the application, so the draft keeps the new one.
      draftValues: { applicationId: found.applicationId },
    };
  },
  Fields: DiscordTokenFields,
};

const SLACK: TokenChangeChannel = {
  key: "slack",
  catalogId: SLACK_CATALOG_ID,
  title: "Change Slack's tokens",
  pasteTitle: "Paste the new tokens",
  saveTitle: "Save the new tokens",
  checking: "Checking your tokens…",
  failed: SLACK_BOT_TOKEN_FAILED,
  many: true,
  savedBotKey: "slackBotUserId",
  wording: saveKeyWording({
    done: "Saved. Slack uses the new tokens now.",
    doneLink: "Back to Slack's page",
    cleanup: SLACK_TURN_ON_WORDING.cleanup,
  }),
  secretValues: ({ botToken, appToken }) =>
    botToken.trim() && appToken.trim() ? { botToken: botToken.trim(), appToken: appToken.trim() } : null,
  async check(draft) {
    const found = await checkSlackSetup({ ...draft, checkAppToken: true });
    if (found.appToken !== "ok") return { kind: "rejected", error: SLACK_APP_TOKEN_FAILED };
    return {
      kind: "checked",
      checked: {
        botId: found.bot.userId,
        botName: `@${found.bot.name}`,
        works: slackTokensWork(found.bot.name, found.workspace.name),
      },
      // The gateway takes a Slack channel's workspace and bot only from its own authorization receipt (it refuses these
      // three on any Slack draft), so nothing is written: the warning is how a switch is made visible.
      draftValues: {},
    };
  },
  Fields: SlackTokenFields,
};

/** WhatsApp cannot take a test message back, so the save step does not say it will. */
const WHATSAPP_KEY_CHANGE_TEST_MESSAGE =
  "GoatCitadel sends a test message where your bot posts. WhatsApp can't remove it afterwards.";

const whatsAppTokenWorks = ({ displayNumber, verifiedName }: { displayNumber: string; verifiedName: string }) =>
  `Token works for ${displayNumber} (${verifiedName}).`;

/**
 * The number the draft follows: the one the saved channel sends from, which the draft was made with. Meta's answer to
 * a check names the number and its verified name but not its ID, so the ID comes from the draft. Undefined when the draft
 * holds none.
 */
function followedPhoneNumberId(draft: Pick<ChannelSetupDraft, "draft">): string | undefined {
  const value: unknown = draft.draft.phoneNumberId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The access token is WhatsApp's one key on this page. The other four details (the App secret, App ID, account ID and
 * phone number ID) stay with the saved channel: the draft is made with its IDs, and the gateway's check reads the App
 * secret from the connection that owns it, so the page asks for none of them. `TokenInputs` names its first field
 * `botToken`, which is where the one masked field's value arrives.
 */
const WHATSAPP: TokenChangeChannel = {
  key: "whatsapp",
  catalogId: WHATSAPP_CATALOG_ID,
  title: "Change WhatsApp's access token",
  pasteTitle: "Paste the new token",
  saveTitle: "Save the new token",
  checking: "Checking your token…",
  failed: WHATSAPP_CHECK_FAILED,
  many: false,
  savedBotKey: "phoneNumberId",
  testMessage: WHATSAPP_KEY_CHANGE_TEST_MESSAGE,
  wording: saveKeyWording({
    done: "Saved. WhatsApp uses the new token now.",
    doneLink: "Back to WhatsApp's page",
    cleanup: WHATSAPP_TURN_ON_WORDING.cleanup,
  }),
  secretValues: ({ botToken }) => (botToken.trim() ? { accessToken: botToken.trim() } : null),
  async check({ draftId, expectedRevision }) {
    try {
      const { number } = await checkWhatsAppSetup({ draftId, expectedRevision, askMeta: true });
      if (!number) throw new Error(WHATSAPP_CHECK_FAILED);
      const phoneNumberId = followedPhoneNumberId(await fetchChannelSetupDraft(draftId));
      if (!phoneNumberId) throw new Error(WHATSAPP_CHECK_FAILED);
      return {
        kind: "checked",
        checked: { botId: phoneNumberId, botName: number.verifiedName, works: whatsAppTokenWorks(number) },
        // The draft already holds the number it follows, so there is nothing to keep on it. A token that expires is
        // saved without a note on this page.
        draftValues: {},
      };
    } catch {
      // What a failure carried is never kept: it can quote the request the token travelled in.
      throw new Error(WHATSAPP_CHECK_FAILED);
    }
  },
  Fields: WhatsAppTokenFields,
};

/** The channels whose tokens are changed on `ChannelTokenChange`, by catalog key. A map, so no name is taken for one. */
export const TOKEN_CHANGE_CHANNELS: ReadonlyMap<string, TokenChangeChannel> = new Map([
  [DISCORD.key, DISCORD],
  [SLACK.key, SLACK],
  [WHATSAPP.key, WHATSAPP],
]);
