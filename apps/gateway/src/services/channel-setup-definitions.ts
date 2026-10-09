import { withGuidedJourney } from "./channel-setup-definitions/guided-journey.js";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
import { createDiscordDefinition } from "./channel-setup-definitions/discord.js";
import { createSlackDefinition } from "./channel-setup-definitions/slack.js";
import { createTelegramDefinition } from "./channel-setup-definitions/telegram.js";
import { createNtfyDefinition } from "./channel-setup-definitions/ntfy.js";
import { createGoogleChatDefinition } from "./channel-setup-definitions/google-chat.js";
import { createTeamsDefinition } from "./channel-setup-definitions/teams.js";
import { createWhatsAppDefinition } from "./channel-setup-definitions/whatsapp.js";
import { createSignalDefinition } from "./channel-setup-definitions/signal.js";
import { createMattermostDefinition } from "./channel-setup-definitions/mattermost.js";
import { createIMessageDefinition } from "./channel-setup-definitions/imessage.js";
import { createNextcloudTalkDefinition } from "./channel-setup-definitions/nextcloud-talk.js";
import { createLineDefinition } from "./channel-setup-definitions/line.js";
import { createZaloDefinition } from "./channel-setup-definitions/zalo.js";
import { createZaloUserDefinition } from "./channel-setup-definitions/zalouser.js";
import type { ChannelSetupRuntimeDefinition } from "./channel-setup-definitions/common.js";

export type { ChannelSetupRuntimeDefinition } from "./channel-setup-definitions/common.js";

const RUNTIME_DEFINITIONS: Record<string, ChannelSetupRuntimeDefinition> = {
  "channel.discord": withGuidedJourney(createDiscordDefinition()),
  "channel.slack": withGuidedJourney(createSlackDefinition()),
  "channel.telegram": withGuidedJourney(createTelegramDefinition()),
  "channel.ntfy": withGuidedJourney(createNtfyDefinition()),
  "channel.google-chat": withGuidedJourney(createGoogleChatDefinition()),
  "channel.teams": withGuidedJourney(createTeamsDefinition()),
  "channel.whatsapp": withGuidedJourney(createWhatsAppDefinition()),
  "channel.signal": withGuidedJourney(createSignalDefinition()),
  "channel.mattermost": withGuidedJourney(createMattermostDefinition()),
  "channel.imessage": withGuidedJourney(createIMessageDefinition()),
  "channel.nextcloud-talk": withGuidedJourney(createNextcloudTalkDefinition()),
  "channel.line": withGuidedJourney(createLineDefinition()),
  "channel.zalo": withGuidedJourney(createZaloDefinition()),
  "channel.zalouser": withGuidedJourney(createZaloUserDefinition()),
};

export function getChannelSetupDefinition(catalogId: string): ChannelSetupDefinition | undefined {
  return RUNTIME_DEFINITIONS[catalogId]?.definition;
}

export function requireChannelSetupDefinition(catalogId: string): ChannelSetupRuntimeDefinition {
  const definition = RUNTIME_DEFINITIONS[catalogId];
  if (!definition) {
    throw new Error(`No channel setup definition is available for ${catalogId}.`);
  }
  return definition;
}

export function listChannelSetupDefinitions(): ChannelSetupDefinition[] {
  return Object.values(RUNTIME_DEFINITIONS)
    .map((item) => item.definition)
    .sort(
      (left, right) => channelSetupSortRank(left.catalog.catalogId) - channelSetupSortRank(right.catalog.catalogId),
    );
}

function channelSetupSortRank(catalogId: string): number {
  if (catalogId === "channel.slack") {
    return 0;
  }
  if (catalogId === "channel.telegram") {
    return 1;
  }
  if (catalogId === "channel.ntfy") {
    return 2;
  }
  return 10;
}
