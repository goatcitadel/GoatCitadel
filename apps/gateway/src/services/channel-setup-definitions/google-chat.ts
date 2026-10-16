import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  check,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

const GOOGLE_CHAT_VERSION = "2026.10.google-chat.app.v2";
const AUDIENCE_TYPES = new Set(["project_number", "endpoint_url"]);

/**
 * An inline service-account key is a credential: it lives only in secure draft custody
 * (secretState) or as a custody-hydrated value during validation/test, never in plain draft JSON.
 */
function hasServiceAccountKey(draft: ChannelSetupDraft): boolean {
  return Boolean(
    readString(draft.draft, "serviceAccountKeyEnv") ||
    readString(draft.draft, "serviceAccountKey") ||
    draft.secretState?.serviceAccountKey?.configured,
  );
}

export function createGoogleChatDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.google-chat");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: GOOGLE_CHAT_VERSION,
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect Google Chat with an incoming webhook for outbound posts, or as a Chat app (service account) that also receives messages and can reply and delete its own messages.",
      prerequisites: [
        "Access to the target Google Chat space.",
        "For webhook mode: permission to create or manage incoming webhooks for that space.",
        "For Chat app mode: a Google Cloud project with the Chat API enabled, a Chat app whose HTTP endpoint points at this connection's webhook URL, and a service-account JSON key stored in an environment variable.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "Webhook mode sends outbound operator messages to one Google Chat space through an incoming webhook. It cannot receive messages.",
            ),
            paragraph(
              "Chat app mode receives messages on the app's HTTP endpoint. GoatCitadel verifies Google's signed bearer token against the audience you configure before accepting anything, replies through the Chat API with the service account, and can delete only messages the app itself sent. Inbound is default-deny: only the senders you allow can start turns.",
            ),
            note(
              "warning",
              "Incoming webhook URLs and service-account keys are secrets. Keep the key in an environment variable and treat the webhook URL like a token.",
            ),
          ],
        },
        {
          id: "create-webhook",
          kind: "instruction",
          title: "Choose webhook or Chat app mode",
          body: [
            paragraph(
              "Webhook mode: open the target space, create an incoming webhook, and copy the full webhook URL.",
            ),
            paragraph(
              "Chat app mode: in the Google Cloud console configure the Chat app's HTTP endpoint URL as this connection's Google Chat webhook URL, choose the authentication audience (project number or endpoint URL), and store the service-account JSON key in an environment variable on the gateway host. Allow chat.googleapis.com and oauth2.googleapis.com in the network allowlist.",
            ),
          ],
          checklist: [
            check("space", "Open the target Google Chat space"),
            check("mode", "Create an incoming webhook, or configure the Chat app endpoint"),
            check("copied", "Copy the webhook URL, or store the service-account key in an environment variable"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "webhookUrl",
              label: "Webhook URL (webhook mode)",
              type: "url",
              required: false,
              explanation: "The full Google Chat incoming webhook URL. Leave empty in Chat app mode.",
              whyNeeded: "Used for outbound sends to the target space in webhook mode.",
              whereToFind: [paragraph("Copy the full URL from the Google Chat incoming webhook setup flow.")],
              looksLike: "https://chat.googleapis.com/v1/spaces/...",
              commonMistakes: ["Copying the space URL instead of the webhook URL."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "serviceAccountKeyEnv",
              label: "Service-account key environment variable (Chat app mode)",
              type: "text",
              required: false,
              explanation:
                "Name of the gateway environment variable that holds the service-account JSON key. The key is resolved only at the tool host boundary.",
              whyNeeded: "Chat app mode mints chat.bot tokens with this key to send, reply and delete app messages.",
              placeholder: "GOOGLE_CHAT_SA_KEY",
              canChangeLater: true,
            },
            {
              key: "audienceType",
              label: "Authentication audience type (Chat app mode)",
              type: "select",
              required: false,
              defaultValue: "project_number",
              explanation: "Must match the Chat app's 'Authentication audience' setting in the Google Cloud console.",
              whyNeeded: "Inbound requests are accepted only when Google's bearer token carries this audience.",
              options: [
                { value: "project_number", label: "Project number", hint: "Recommended" },
                { value: "endpoint_url", label: "HTTP endpoint URL" },
              ],
              canChangeLater: true,
            },
            {
              key: "audience",
              label: "Audience (Chat app mode)",
              type: "text",
              required: false,
              explanation:
                "The Google Cloud project number, or this connection's public HTTPS webhook URL when the audience type is endpoint URL.",
              whyNeeded: "Inbound tokens issued for any other audience are rejected.",
              looksLike: "123456789012",
              canChangeLater: true,
            },
            {
              key: "addOnProjectNumber",
              label: "Workspace add-on project number (add-on Chat apps only)",
              type: "text",
              required: false,
              explanation:
                "Only fill this in if your Chat app is built as a Google Workspace add-on. Enter the numeric project number of the add-on's Google Cloud project. Leave it empty for a regular Chat app.",
              whyNeeded:
                "Google signs add-on requests with that project's add-on service account instead of the Chat service account. GoatCitadel accepts that one account only, so tokens from any other project are still rejected. Requires the HTTP endpoint URL audience type.",
              looksLike: "123456789012",
              commonMistakes: ["Entering the project ID (a name) instead of the numeric project number."],
              canChangeLater: true,
            },
            {
              key: "defaultSpace",
              label: "Default space (Chat app mode)",
              type: "text",
              required: false,
              explanation: "Space resource name used for sends that do not name a space, such as approval delivery.",
              looksLike: "spaces/AAAAxxxx",
              canChangeLater: true,
            },
            {
              key: "defaultThreadKey",
              label: "Optional default thread key (webhook mode)",
              type: "text",
              required: false,
              explanation: "Optional thread key for grouping outbound webhook messages into a stable thread.",
              looksLike: "goatcitadel-ops",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the connection",
          body: [
            paragraph(
              "In webhook mode, GoatCitadel validates the webhook shape and sends a sandbox webhook probe during guided test and retest flows.",
            ),
            paragraph(
              "In Chat app mode, GoatCitadel validates the audience and key settings; confirm the app by sending it a message from an allowed sender and checking the reply.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "After finalizing, send a sandbox post (webhook mode) or message the app from an allowed sender (Chat app mode) and confirm the result in Google Chat.",
            ),
          ],
          successCriteria: [
            "A webhook URL or a service-account key environment variable is configured.",
            "Chat app mode has an audience that matches the Chat app configuration.",
            "Delivery or a reply is confirmed manually in Google Chat.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: GOOGLE_CHAT_VERSION,
      secretFieldKeys: ["webhookUrl", "serviceAccountKey"],
    },
    validation: {
      validationVersion: GOOGLE_CHAT_VERSION,
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: GOOGLE_CHAT_VERSION,
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.google_chat",
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
      officialDocsUrl: "https://developers.google.com/workspace/chat/authenticate-authorize-chat-app",
      lastReviewedAt: "2026-10-16",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Chat app (service account) or incoming webhook",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["webhookUrl"], ["serviceAccountKey"]]);
      return {
        draft: {
          defaultThreadKey: readString(config, "defaultThreadKey"),
          serviceAccountKeyEnv: readString(config, "serviceAccountKeyEnv"),
          audienceType: readString(config, "audienceType"),
          audience: readString(config, "audience"),
          addOnProjectNumber: readString(config, "addOnProjectNumber"),
          defaultSpace: readString(config, "defaultSpace"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            webhookUrl: readString(config, "webhookUrl") ? "configured" : "missing",
            serviceAccountKey: readString(config, "serviceAccountKey") ? "configured" : "unknown",
            defaultThreadKey: readString(config, "defaultThreadKey") ? "configured" : "unknown",
            serviceAccountKeyEnv: readString(config, "serviceAccountKeyEnv") ? "configured" : "unknown",
            audienceType: readString(config, "audienceType") ? "configured" : "unknown",
            audience: readString(config, "audience") ? "configured" : "unknown",
            addOnProjectNumber: readString(config, "addOnProjectNumber") ? "configured" : "unknown",
            defaultSpace: readString(config, "defaultSpace") ? "configured" : "unknown",
          },
          warnings: hasConfiguredSecret
            ? [
                "Saved webhook URLs and service-account keys are intentionally not rehydrated into the wizard. Replace them only if you need to change them.",
              ]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const appMode = hasServiceAccountKey(draft);
      return compactRecord({
        webhookUrl: readString(draft.draft, "webhookUrl"),
        // Present only on a custody-hydrated draft; finalize replaces it with the promoted secret reference.
        serviceAccountKey: readString(draft.draft, "serviceAccountKey"),
        defaultThreadKey: readString(draft.draft, "defaultThreadKey"),
        serviceAccountKeyEnv: readString(draft.draft, "serviceAccountKeyEnv"),
        audienceType: appMode ? (readString(draft.draft, "audienceType") ?? "project_number") : undefined,
        audience: appMode ? readString(draft.draft, "audience") : undefined,
        addOnProjectNumber: appMode ? readString(draft.draft, "addOnProjectNumber") : undefined,
        defaultSpace: appMode ? readString(draft.draft, "defaultSpace") : undefined,
        // Google Chat never had inbound: app inbound is default-deny and never inherits a legacy-open posture.
        ...(appMode ? { inboundAccessMode: "allowlist" } : {}),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const webhookUrl = readString(draft.draft, "webhookUrl");
      const appMode = hasServiceAccountKey(draft);
      if (!webhookUrl && !appMode) {
        issues.push(
          requiredFieldIssue("webhookUrl", "Add a webhook URL, or a service-account key variable for Chat app mode."),
        );
      } else if (webhookUrl && !/^https:\/\/chat\.googleapis\.com\/v1\/spaces\//.test(webhookUrl)) {
        issues.push(
          malformedFieldIssue("webhookUrl", "Webhook URL should look like a Google Chat incoming webhook URL."),
        );
      }
      if (appMode) {
        issues.push(...validateAppMode(draft.draft));
      }
      return issues;
    },
  };
}

function validateAppMode(values: Record<string, unknown>): ChannelSetupIssue[] {
  const issues: ChannelSetupIssue[] = [];
  const keyEnv = readString(values, "serviceAccountKeyEnv");
  if (keyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) {
    issues.push(
      malformedFieldIssue("serviceAccountKeyEnv", "Use an environment variable name such as GOOGLE_CHAT_SA_KEY."),
    );
  }
  const audienceType = readString(values, "audienceType") ?? "project_number";
  const audience = readString(values, "audience");
  if (!AUDIENCE_TYPES.has(audienceType)) {
    issues.push(malformedFieldIssue("audienceType", "Choose project number or endpoint URL."));
  }
  if (!audience) {
    issues.push(requiredFieldIssue("audience", "Chat app mode needs the audience Google signs inbound tokens for."));
  } else if (audienceType === "project_number" && !/^\d{6,20}$/.test(audience)) {
    issues.push(malformedFieldIssue("audience", "The project number is the numeric Google Cloud project number."));
  } else if (audienceType === "endpoint_url" && !/^https:\/\/[^\s]+$/.test(audience)) {
    issues.push(
      malformedFieldIssue("audience", "The endpoint URL audience must be this connection's public HTTPS URL."),
    );
  }
  const addOnProjectNumber = readString(values, "addOnProjectNumber");
  if (addOnProjectNumber && !/^\d{6,20}$/.test(addOnProjectNumber)) {
    issues.push(
      malformedFieldIssue(
        "addOnProjectNumber",
        "The add-on project number is the numeric Google Cloud project number, not the project ID.",
      ),
    );
  } else if (addOnProjectNumber && audienceType !== "endpoint_url") {
    issues.push(
      malformedFieldIssue(
        "addOnProjectNumber",
        "Workspace add-on Chat apps use the HTTP endpoint URL audience. Switch the audience type, or clear this field.",
      ),
    );
  }
  const defaultSpace = readString(values, "defaultSpace");
  if (defaultSpace && !/^spaces\/[^/\s]+$/.test(defaultSpace)) {
    issues.push(malformedFieldIssue("defaultSpace", "The default space looks like spaces/AAAAxxxx."));
  }
  return issues;
}
