import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  linkBlock,
  check,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
  looksLikeHttpUrl,
} from "./common.js";

function isTruthyFlag(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

export function createNtfyDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.ntfy");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: "2026.08.ntfy.outbound.v2",
      estimatedMinutes: 4,
      difficulty: "beginner",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect ntfy as an outbound notification target for operator-visible status, approvals, and dry-run validation, with optional inbound over a token-protected topic subscription.",
      prerequisites: [
        "An ntfy.sh topic or a self-hosted ntfy base URL.",
        "A topic name that is safe for GoatCitadel to publish to.",
        "An optional token stored in an environment variable if the topic requires auth (required for inbound).",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel can send outbound notifications to an ntfy topic using the HTTP publish API."),
            note(
              "warning",
              "ntfy is outbound-only unless you opt in to inbound. Inbound subscribes to the topic's JSON stream and requires a token-protected topic, because ntfy carries no sender identity: the topic is the sender. Outbound publishes are tagged and ignored on the way back in. Webhooks and remote commands are not supported.",
            ),
          ],
        },
        {
          id: "prepare-topic",
          kind: "instruction",
          title: "Prepare the topic",
          body: [
            paragraph(
              "Choose an ntfy topic and decide whether it should use the public ntfy.sh service or a local/self-hosted server.",
            ),
            linkBlock("ntfy publish API", "https://docs.ntfy.sh/publish/"),
          ],
          checklist: [
            check("base-url", "Choose the base URL, such as https://ntfy.sh or your self-hosted origin"),
            check("topic", "Choose the exact topic GoatCitadel may publish to"),
            check("token-env", "Store any token in an environment variable instead of pasting it into prompts"),
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
              explanation: "HTTP origin for the ntfy server.",
              whyNeeded: "Used as the publish API base before appending the topic path.",
              looksLike: "https://ntfy.sh or https://ntfy.example.com",
              canChangeLater: true,
            },
            {
              key: "topic",
              label: "Topic",
              type: "text",
              required: true,
              explanation: "The ntfy topic GoatCitadel will publish to.",
              whyNeeded: "Keeps outbound notifications scoped to a visible operator-approved destination.",
              looksLike: "goatcitadel-ops",
              canChangeLater: true,
            },
            {
              key: "tokenEnv",
              label: "Token ENV var",
              type: "text",
              required: false,
              explanation: "Optional environment variable that contains the ntfy bearer token.",
              whyNeeded: "Lets protected ntfy topics authenticate without storing the token in the connection config.",
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
              explanation:
                "Subscribe to the topic's JSON stream so messages published to it start conversations. Requires a token-protected topic.",
              whyNeeded:
                "ntfy has no sender identity, so anyone who can publish to an unprotected topic could start turns. Inbound is therefore opt-in and needs a token.",
              canChangeLater: true,
            },
            {
              key: "subscribeTopic",
              label: "Subscribe topic",
              type: "text",
              required: false,
              explanation: "Topic to receive from. Defaults to the publish topic.",
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
              explanation: "Validate routing without sending a real ntfy publish request.",
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
              "Guided test publishes a sandbox notification to the configured topic through the ntfy publish API. Enable dry-run first if you only want routing validation without a visible notification.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "After finalizing, send a sandbox notification or enable dry-run mode first if you only want setup validation.",
            ),
          ],
          successCriteria: [
            "The base URL is an HTTP or HTTPS origin.",
            "A topic is configured.",
            "Dry-run behavior is intentional when enabled.",
            "Inbound is enabled only for a token-protected topic; no webhook or remote command behavior is claimed.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.06.ntfy.outbound.v1",
      secretFieldKeys: ["token"],
    },
    validation: {
      validationVersion: "2026.06.ntfy.outbound.v1",
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
          ? { allowedSenders: [`ntfy-topic:${defaultSender}`] }
          : {}),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl") ?? "https://ntfy.sh";
      const topic = readString(draft.draft, "topic") ?? readString(draft.draft, "defaultTopic");
      const priority = readString(draft.draft, "priority");
      if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Base URL must start with http:// or https://."));
      }
      if (!topic) {
        issues.push(requiredFieldIssue("topic", "Topic is required."));
      } else if (!/^[A-Za-z0-9._-]{1,128}$/.test(topic)) {
        issues.push(malformedFieldIssue("topic", "Topic may contain letters, numbers, dots, underscores, and dashes."));
      }
      const subscribeTopic = readString(draft.draft, "subscribeTopic");
      if (subscribeTopic && !/^[A-Za-z0-9._-]{1,128}$/.test(subscribeTopic)) {
        issues.push(
          malformedFieldIssue(
            "subscribeTopic",
            "Subscribe topic may contain letters, numbers, dots, underscores, and dashes.",
          ),
        );
      }
      if (
        isTruthyFlag(draft.draft.inboundStreamEnabled) &&
        !readString(draft.draft, "tokenEnv") &&
        !readString(draft.draft, "token") &&
        !readLegacyString(draft, "token", "tokenEnv")
      ) {
        issues.push(requiredFieldIssue("tokenEnv", "ntfy inbound requires a token-protected topic (tokenEnv)."));
      }
      if (priority && !/^[1-5]$/.test(priority)) {
        issues.push(malformedFieldIssue("priority", "Priority must be an integer from 1 to 5."));
      }
      return issues;
    },
  };
}
