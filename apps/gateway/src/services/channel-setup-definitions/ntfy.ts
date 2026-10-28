import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  PASTED_SECRET_EXPLANATION,
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  linkBlock,
  check,
  troubleshoot,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
  looksLikeHttpUrl,
  requireSecureUrl,
} from "./common.js";

function isTruthyFlag(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

/** What ntfy allows in a topic name: https://docs.ntfy.sh/publish/ (letters, numbers, underscores and dashes, up to 64). */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOPIC_MESSAGE = "Topics use letters, numbers, _ and -, up to 64 characters.";

/** Why receiving needs a topic nobody else can post to. It warns; it does not refuse (N9). */
const RECEIVING_WARNING =
  "Receiving is only safe on a topic nobody else can post to: one on your own ntfy server with access control, or a reserved topic that others can't write to. On public ntfy.sh, anyone who knows an unreserved topic's name can post and start conversations. Use a long random topic name.";

export function createNtfyDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.ntfy");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: "2026.10.ntfy.stream.v3",
      estimatedMinutes: 4,
      difficulty: "beginner",
      manualModePolicy: "available-secondary",
      introSummary:
        "Send notifications to an ntfy topic. Optionally, messages posted to a topic can start conversations; only do that on a topic nobody else can post to. No public web address is needed.",
      prerequisites: [
        "An ntfy server (ntfy.sh or your own) and a topic name.",
        "The ntfy app subscribed to that topic, to see the test.",
        "To receive: an access token that can read the topic.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "Sending. ntfy is send-only unless you turn on Receive messages. GoatCitadel publishes notifications to a topic with ntfy's HTTP publish API. No public web address is needed.",
            ),
            paragraph(
              "Receiving (optional). With Receive messages on, GoatCitadel connects out to the topic's stream and starts a conversation from each message posted there. It needs an access token that can read the topic. ntfy messages carry no sender identity: the topic is the sender, so anyone who can post to the topic can start conversations. Messages posted while GoatCitadel isn't running, or is restarting, are skipped. GoatCitadel's own notifications are tagged and ignored on the way back in.",
            ),
            paragraph(
              "Limits. Webhooks and remote commands aren't supported. The test notification stays on the topic.",
            ),
            note("warning", RECEIVING_WARNING),
            note(
              "info",
              "GoatCitadel can reach your ntfy server only once the server is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that.",
            ),
          ],
        },
        {
          id: "prepare-topic",
          kind: "instruction",
          createOnly: true,
          title: "Prepare the topic",
          body: [
            paragraph(
              "Choose an ntfy topic, and whether it lives on the public ntfy.sh service or on a server of your own.",
            ),
            paragraph(
              "On public ntfy.sh a topic name works like a password: anyone who knows it can read and post. Pick a long random name, using letters, numbers, _ and -, up to 64 characters.",
            ),
            paragraph("If the topic needs a token, have it ready. Receiving always needs one that can read the topic."),
            linkBlock("ntfy publish API", "https://docs.ntfy.sh/publish/"),
            linkBlock("ntfy configuration and access control", "https://docs.ntfy.sh/config/"),
          ],
          // Only what every setup needs. The token is plain guidance above: a public topic needs none, and each box here
          // blocks Continue.
          checklist: [
            check("base-url", "Choose the base URL, such as https://ntfy.sh or your self-hosted origin"),
            check("topic", "Choose the exact topic GoatCitadel may publish to"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Configure outbound delivery",
          fields: [
            {
              key: "baseUrl",
              label: "Base URL",
              type: "url",
              required: true,
              defaultValue: "https://ntfy.sh",
              explanation:
                "The address of your ntfy server. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
              whyNeeded: "Used as the publish API base before appending the topic path.",
              looksLike: "https://ntfy.sh or https://ntfy.example.com",
              canChangeLater: true,
            },
            {
              key: "topic",
              label: "Topic",
              type: "text",
              required: true,
              explanation:
                "The ntfy topic GoatCitadel publishes to. Use letters, numbers, _ and -, up to 64 characters.",
              whyNeeded: "Keeps outbound notifications scoped to a visible operator-approved destination.",
              looksLike: "goatcitadel-ops",
              commonMistakes: [
                "A short, guessable name on public ntfy.sh. Anyone who knows the name can read and post to it.",
                "A dot or a space in the name. ntfy topics use letters, numbers, _ and - only.",
              ],
              canChangeLater: true,
            },
            {
              key: "token",
              label: "Access token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded:
                "A protected topic needs one to publish. Receiving needs one that can read the topic: GoatCitadel won't listen without a token.",
              whereToFind: [
                paragraph(
                  "Create one with ntfy token add <user> on your server, or in the ntfy web app under Account when you're logged in. It starts with tk_.",
                ),
                linkBlock("ntfy: access tokens", "https://docs.ntfy.sh/publish/#access-tokens"),
              ],
              commonMistakes: ["Pasting your account password. This field takes an access token (it starts with tk_)."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "tokenEnv",
              label: "Token ENV var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the ntfy access token.",
              looksLike: "NTFY_TOKEN",
              placeholder: "NTFY_TOKEN",
              canChangeLater: true,
            },
            {
              key: "inboundStreamEnabled",
              label: "Receive messages from the topic",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation: `Listen to the topic so messages posted to it start conversations. Needs an access token that can read the topic. ${RECEIVING_WARNING} Messages posted while GoatCitadel isn't running are skipped.`,
              whyNeeded:
                "ntfy carries no sender identity, so the topic is the sender and anyone who can post to it can start a conversation. Receiving stays off unless you turn it on.",
              canChangeLater: true,
            },
            {
              key: "subscribeTopic",
              label: "Subscribe topic",
              type: "text",
              required: false,
              explanation:
                "Topic to receive from, if it isn't the publish topic. Use letters, numbers, _ and -, up to 64 characters.",
              whyNeeded: "Lets inbound messages arrive on a different topic than outbound notifications.",
              looksLike: "goatcitadel-inbox",
              canChangeLater: true,
              advanced: true,
            },
            {
              key: "priority",
              label: "Priority",
              type: "select",
              required: false,
              defaultValue: "3",
              explanation: "Default ntfy priority for sent notifications.",
              options: [
                { value: "1", label: "1" },
                { value: "2", label: "2" },
                { value: "3", label: "3" },
                { value: "4", label: "4" },
                { value: "5", label: "5" },
              ],
              canChangeLater: true,
            },
            {
              key: "dryRun",
              label: "Dry run only",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Check the settings without sending a notification. With dry run on, nothing is ever sent. Turn it off after testing.",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph(
              'The test publishes one notification titled "GoatCitadel channel setup probe" to the topic and doesn\'t delete it, so it stays on the topic: check that it arrived in your ntfy app. With dry run on, the test sends nothing.',
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "token-rejected",
              "ntfy refused the notification (401 or 403)",
              "The topic needs an access token that can publish to it. Paste one (it starts with tk_), or set the variable your token is in. Create one with ntfy token add <user> on your server, or in the ntfy web app under Account.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says GoatCitadel can't reach your ntfy server yet",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add your ntfy server (ntfy.sh if you use the public one), then run the test again.",
            ),
            troubleshoot(
              "topic-rejected",
              "It says the topic isn't valid",
              "Topics use letters, numbers, _ and -, up to 64 characters. Remove dots, spaces and slashes.",
            ),
            troubleshoot(
              "nothing-arrived",
              "The test passed but nothing shows on your phone",
              "Check that the ntfy app is subscribed to this exact topic on this server, and that dry run is off: with dry run on, nothing is sent.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the token is missing, and you used an environment variable",
              "A variable's name must start with NTFY_ (for example NTFY_TOKEN), and you must restart GoatCitadel after you set it. Or paste the token instead.",
            ),
            troubleshoot(
              "no-reply",
              "You post to the topic and nothing comes back",
              "Check these in order. Receive messages from the topic must be on, with an access token that can read the topic. Post to the subscribe topic (the publish topic, if you set no other) from another device. Under Who may message this bot, the entry must be ntfy-topic: followed by the subscribe topic; if you changed the topic, change it there too. GoatCitadel must be running: messages posted while it isn't are skipped. And your ntfy server must be in the hosts GoatCitadel may reach.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can publish to the topic. With dry run on, nothing is ever sent. Turn it off after testing.",
            ),
          ],
          successCriteria: [
            "The server address is https, or http for this computer only.",
            "A topic is set.",
            "Dry run is off once you've tested, so notifications are really sent.",
            "Receiving is on only for a topic nobody else can post to, with an access token that can read it.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.10.ntfy.stream.v2",
      secretFieldKeys: ["token"],
    },
    validation: {
      validationVersion: "2026.10.ntfy.stream.v2",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.06.ntfy.outbound.v1",
      levels: ["semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.ntfy",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://docs.ntfy.sh/publish/",
      lastReviewedAt: "2026-06-02",
      volatility: "low",
      deprecationRisk: "low",
      preferredPathLabel: "HTTP publish API",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["token", "tokenEnv"]]);
      return {
        draft: {
          baseUrl: readString(config, "baseUrl") ?? "https://ntfy.sh",
          topic: readString(config, "topic") ?? readString(config, "defaultTopic"),
          tokenEnv: readString(config, "tokenEnv"),
          priority: readString(config, "priority") ?? "3",
          dryRun: config.dryRun === true,
          inboundStreamEnabled: isTruthyFlag(config.inboundStreamEnabled),
          subscribeTopic: readString(config, "subscribeTopic"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") ? "configured" : "unknown",
            topic: readString(config, "topic") || readString(config, "defaultTopic") ? "configured" : "missing",
            token: readString(config, "token") || readString(config, "tokenEnv") ? "configured" : "unknown",
            tokenEnv: readString(config, "tokenEnv") ? "configured" : "unknown",
            priority: readString(config, "priority") ? "configured" : "unknown",
            dryRun: config.dryRun === true ? "configured" : "unknown",
            inboundStreamEnabled: config.inboundStreamEnabled === undefined ? "unknown" : "configured",
            subscribeTopic: readString(config, "subscribeTopic") ? "configured" : "unknown",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if needed."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedToken = readLegacyString(draft, "token");
      const preservedTokenEnv = readLegacyString(draft, "tokenEnv");
      const dryRun = draft.draft.dryRun === true || readString(draft.draft, "dryRun") === "true";
      const inboundStreamEnabled = isTruthyFlag(draft.draft.inboundStreamEnabled);
      const topic = readString(draft.draft, "topic") ?? readString(draft.draft, "defaultTopic");
      const subscribeTopic = readString(draft.draft, "subscribeTopic");
      const hasSavedSenders =
        draft.draft.allowedSenders !== undefined ||
        (draft.hydration?.rawLegacyConfig as Record<string, unknown> | undefined)?.allowedSenders !== undefined;
      // ntfy has no sender identity: the topic is the sender, so seed the allowlist with it.
      const defaultSender = subscribeTopic ?? topic;
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl") ?? "https://ntfy.sh",
        topic: readString(draft.draft, "topic") ?? readString(draft.draft, "defaultTopic"),
        tokenEnv: readString(draft.draft, "tokenEnv") ?? preservedTokenEnv,
        token: readString(draft.draft, "token") ?? preservedToken,
        priority: readString(draft.draft, "priority") ?? "3",
        dryRun,
        inboundStreamEnabled: inboundStreamEnabled ? true : undefined,
        subscribeTopic,
        ...(inboundStreamEnabled && defaultSender && !hasSavedSenders
          ? { inboundAccessMode: "allowlist", allowedSenders: [`ntfy-topic:${defaultSender}`] }
          : {}),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl") ?? "https://ntfy.sh";
      const topic = readString(draft.draft, "topic") ?? readString(draft.draft, "defaultTopic");
      const priority = readString(draft.draft, "priority");
      // Plain http is refused the same way the live test refuses it. That rule lets "ftp://localhost" through, so the
      // scheme is checked here too.
      const insecure = requireSecureUrl(baseUrl, "baseUrl", "Base URL");
      if (insecure) {
        issues.push(insecure);
      } else if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Base URL should start with https://."));
      }
      if (!topic) {
        issues.push(requiredFieldIssue("topic", "Topic is required."));
      } else if (!TOPIC_PATTERN.test(topic)) {
        issues.push(malformedFieldIssue("topic", TOPIC_MESSAGE));
      }
      const subscribeTopic = readString(draft.draft, "subscribeTopic");
      if (subscribeTopic && !TOPIC_PATTERN.test(subscribeTopic)) {
        issues.push(malformedFieldIssue("subscribeTopic", TOPIC_MESSAGE));
      }
      if (
        isTruthyFlag(draft.draft.inboundStreamEnabled) &&
        !readString(draft.draft, "tokenEnv") &&
        !readString(draft.draft, "token") &&
        !readLegacyString(draft, "token", "tokenEnv")
      ) {
        // The pasted field is where a person goes to fix this, not the expert variable name.
        issues.push(
          requiredFieldIssue("token", "Paste the ntfy access token. Receiving needs one that can read the topic."),
        );
      }
      if (priority && !/^[1-5]$/.test(priority)) {
        issues.push(malformedFieldIssue("priority", "Priority must be an integer from 1 to 5."));
      }
      return issues;
    },
  };
}
