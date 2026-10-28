import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG } from "../integration-catalog.js";
import {
  NOT_A_VARIABLE_NAME,
  envNameForLog,
  isPermittedIntegrationSecretEnvVarName,
  printableEnvVarName,
  refusedEnvVarNameMessage,
} from "./integration-secret-envvar-guard.js";

describe("a variable name is shown or logged only when it has the shape of one", () => {
  it("gives back a well-formed name, trimmed", () => {
    expect(printableEnvVarName("MATTERMOST_BOT_TOKEN")).toBe("MATTERMOST_BOT_TOKEN");
    expect(printableEnvVarName("  SLACK_BOT_TOKEN \n")).toBe("SLACK_BOT_TOKEN");
    expect(envNameForLog("DISCORD_BOT_TOKEN")).toBe("DISCORD_BOT_TOKEN");
  });

  it.each([
    ["a Slack-style token", "xoxb-1234-abcd-not-a-name"],
    ["a lowercase string", "pasted_token_value"],
    ["a name that starts with a digit", "1MATTERMOST_TOKEN"],
    ["a name with a dash", "MATTERMOST-BOT-TOKEN"],
    ["a name with a dot", "MATTERMOST.BOT.TOKEN"],
    ["a two-character name", "AB"],
    ["a name over 128 characters", `A${"B".repeat(128)}`],
    ["text with a space", "MATTERMOST BOT TOKEN"],
    ["a blank", "   "],
  ])("hides %s", (_label, value) => {
    expect(printableEnvVarName(value)).toBeUndefined();
    expect(envNameForLog(value)).toBe(NOT_A_VARIABLE_NAME);
    expect(envNameForLog(value)).not.toContain(value.trim() || "never-matches");
  });

  it("hides a missing name", () => {
    expect(printableEnvVarName(undefined)).toBeUndefined();
  });

  it("uses the marker the task names", () => {
    expect(NOT_A_VARIABLE_NAME).toBe("(not a variable name)");
  });
});

describe("the names the IMAP/SMTP mail connection may read", () => {
  const MAIL = "automation.imap-smtp";

  it.each(["SMTP_PASSWORD", "IMAP_PASSWORD", "IMAP_SMTP_PASSWORD", "INTEGRATION_IMAP_SMTP_PASSWORD"])(
    "accepts %s",
    (name) => {
      expect(isPermittedIntegrationSecretEnvVarName(name, MAIL)).toBe(true);
    },
  );

  it.each([
    "OPENAI_API_KEY",
    "GOATCITADEL_AUTH_TOKEN",
    "POSTGRES_PASSWORD",
    "AWS_SECRET_ACCESS_KEY",
    "SLACK_BOT_TOKEN",
    "MAIL_PASSWORD",
    "smtp_password",
    "SMTP",
  ])("still refuses %s", (name) => {
    expect(isPermittedIntegrationSecretEnvVarName(name, MAIL)).toBe(false);
  });

  it.each(["channel.mattermost", "channel.slack", "automation.webhooks", "automation.gif-search", "channel.qqbot"])(
    "does not extend SMTP_ and IMAP_ to %s",
    (catalogId) => {
      expect(isPermittedIntegrationSecretEnvVarName("SMTP_PASSWORD", catalogId)).toBe(false);
      expect(isPermittedIntegrationSecretEnvVarName("IMAP_PASSWORD", catalogId)).toBe(false);
    },
  );

  it("accepts neither without a catalog entry", () => {
    expect(isPermittedIntegrationSecretEnvVarName("SMTP_PASSWORD")).toBe(false);
  });

  it("tells the person the prefixes the mail connection takes", () => {
    expect(refusedEnvVarNameMessage(MAIL)).toBe(
      "The variable name must start with SMTP_ or IMAP_. Rename it and restart GoatCitadel.",
    );
  });
});

describe("the sentence a refused variable name gets", () => {
  it("names the prefix the catalog entry needs and holds no name", () => {
    expect(refusedEnvVarNameMessage("channel.mattermost")).toBe(
      "The variable name must start with MATTERMOST_. Rename it and restart GoatCitadel.",
    );
    expect(refusedEnvVarNameMessage("channel.google-chat")).toBe(
      "The variable name must start with GOOGLE_CHAT_. Rename it and restart GoatCitadel.",
    );
    expect(refusedEnvVarNameMessage("channel.nextcloud-talk")).toContain("NEXTCLOUD_TALK_");
  });

  it("says plainly that the name is not allowed when there is no catalog entry to take a prefix from", () => {
    for (const catalogId of [undefined, "", "   "]) {
      expect(refusedEnvVarNameMessage(catalogId)).toBe(
        "That variable name is not allowed for this connection. Rename it and restart GoatCitadel.",
      );
    }
  });

  it("states only prefixes the rule really accepts, for every catalog entry", () => {
    for (const entry of INTEGRATION_CATALOG) {
      const stated = /must start with (\w+_(?: or \w+_)*)\./u.exec(refusedEnvVarNameMessage(entry.catalogId))?.[1];
      expect(stated, entry.catalogId).toBeDefined();
      for (const prefix of (stated ?? "").split(" or ")) {
        expect(
          isPermittedIntegrationSecretEnvVarName(`${prefix}EXAMPLE_TOKEN`, entry.catalogId),
          `${entry.catalogId} ${prefix}`,
        ).toBe(true);
      }
    }
  });
});
