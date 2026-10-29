import type { ComponentType } from "react";
import { checkDiscordSetup, checkSlackSetup } from "@goatcitadel/mission-control-shared/api/client";
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
import { DiscordTokenFields, SlackTokenFields, type TokenFieldsProps } from "./TokenChangeFields";
import type { TurnOnWording } from "./TurnOnStep";

/** The draft a check reads its stored tokens from, at the version the page is looking at. */
export interface TokenCheckDraft {
  draftId: string;
  expectedRevision: number;
}

/** Everything that differs between changing Discord's token and changing Slack's two. */
export interface TokenChangeChannel {
  /** The channel's catalog key, as a connection carries it. */
  key: "discord" | "slack";
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

/** The channels whose tokens are changed on `ChannelTokenChange`, by catalog key. A map, so no name is taken for one. */
export const TOKEN_CHANGE_CHANNELS: ReadonlyMap<string, TokenChangeChannel> = new Map([
  [DISCORD.key, DISCORD],
  [SLACK.key, SLACK],
]);
