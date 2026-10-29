import {
  DISCORD_POSTING_LEGEND,
  DISCORD_SERVER_LEGEND,
  DISCORD_TEAM_LEGEND,
  discordPostingOptions,
  discordPostingValue,
  postingFromValue,
} from "./discord-setup-model";
import { PostingChoice } from "./PostingChoice";
import type { DiscordSetupState } from "./use-discord-setup";

/**
 * Step 4: who may message the bot and where it posts. Each question is asked only when the answer is not already
 * known: a team is asked which member the bot is for, several servers which one to list channels from. Where it posts
 * starts on direct messages, chosen for you, and every choice is saved as soon as it is made. People, servers and
 * channels are named, never numbered. Nothing here is a live region.
 */
export function DiscordPostingStep({ setup, disabled }: { setup: DiscordSetupState; disabled: boolean }) {
  const { check, makerId, serverId, channels, posting } = setup;
  if (!check) return null;
  const maker = check.makers.find((candidate) => candidate.id === makerId);
  return (
    <>
      {check.makers.length > 1 ? (
        <PostingChoice
          legend={DISCORD_TEAM_LEGEND}
          options={check.makers.map((person) => ({ value: person.id, label: person.name }))}
          value={makerId ?? ""}
          onChange={(id) => void setup.chooseMaker(id)}
          disabled={disabled}
        />
      ) : null}
      {check.servers.length > 1 ? (
        <PostingChoice
          legend={DISCORD_SERVER_LEGEND}
          options={check.servers.map((server) => ({ value: server.id, label: server.name }))}
          value={serverId ?? ""}
          onChange={(id) => void setup.chooseServer(id)}
          disabled={disabled}
        />
      ) : null}
      {maker ? (
        <PostingChoice
          legend={DISCORD_POSTING_LEGEND}
          options={discordPostingOptions(maker.name, channels)}
          value={discordPostingValue(posting)}
          onChange={(value) => {
            const next = postingFromValue(value, serverId);
            if (next) void setup.choosePosting(next);
          }}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}
