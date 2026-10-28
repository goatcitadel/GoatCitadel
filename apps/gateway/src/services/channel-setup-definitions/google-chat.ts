import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  check,
  linkBlock,
  troubleshoot,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  requiredFieldIssue,
  malformedFieldIssue,
  PASTED_SECRET_EXPLANATION,
} from "./common.js";

const GOOGLE_CHAT_VERSION = "2026.10.google-chat.app.v2";
const AUDIENCE_TYPES = new Set(["project_number", "endpoint_url"]);
const WEBHOOKS_DOC = "https://developers.google.com/workspace/chat/quickstart/webhooks";
const CONFIGURE_DOC = "https://developers.google.com/workspace/chat/configure-chat-api";
const AUTHENTICATE_DOC = "https://developers.google.com/workspace/chat/authenticate-authorize-chat-app";
const SPACES_DOC = "https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces";

/** The two products one form sets up. The saved connection keeps no mode: which keys it holds says which it is. */
type GoogleChatMode = "webhook" | "app";
const FOR_WEBHOOK = { fieldKey: "mode", value: "webhook" } as const;
const FOR_APP = { fieldKey: "mode", value: "app" } as const;

/** The saved keys only a Chat app holds, and the ones only an incoming webhook holds. A mode change clears the other set. */
const APP_ONLY_KEYS = [
  "serviceAccountKeyEnv",
  "serviceAccountKey",
  "audienceType",
  "audience",
  "addOnProjectNumber",
  "defaultSpace",
] as const;
const WEBHOOK_ONLY_KEYS = ["webhookUrl", "defaultThreadKey"] as const;

/**
 * Whether the saved connection this draft changes already holds a key. A change to a saved connection never carries
 * the saved key (it stays in secure storage under the connection's reference); it only records that the key is there,
 * and Finalize keeps it unless a new one is pasted. Without this, changing a setting would ask for the key again.
 */
function savedConnectionHoldsKey(draft: ChannelSetupDraft, fieldKey: "webhookUrl" | "serviceAccountKey"): boolean {
  return draft.hydration?.fieldState[fieldKey] === "configured";
}

/**
 * An inline service-account key is a credential: it lives only in secure draft custody
 * (secretState) or as a custody-hydrated value during validation/test, never in plain draft JSON.
 * A saved connection's own key counts too (see `savedConnectionHoldsKey`).
 */
function hasServiceAccountKey(draft: ChannelSetupDraft): boolean {
  return Boolean(
    readString(draft.draft, "serviceAccountKeyEnv") ||
    readString(draft.draft, "serviceAccountKey") ||
    draft.secretState?.serviceAccountKey?.configured ||
    savedConnectionHoldsKey(draft, "serviceAccountKey"),
  );
}

/** The mode a person chose, or, for a draft that never chose one, the mode its service-account key implies. */
function connectionMode(draft: ChannelSetupDraft): GoogleChatMode {
  const chosen = readString(draft.draft, "mode");
  if (chosen === "webhook" || chosen === "app") return chosen;
  return hasServiceAccountKey(draft) ? "app" : "webhook";
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
        "Incoming webhook: send messages into one Google Chat space (sends only). Chat app: send and receive, with a Google Cloud project and a public HTTPS address.",
      prerequisites: [
        "Incoming webhook: a Google Workspace Business or Enterprise account and permission to add webhooks to the space.",
        "Chat app: a Google Cloud project with the Chat API on, a service account key, and a public HTTPS address for this Gateway.",
        "Chat app: the Google user ids (users/…) allowed to message it.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph("An incoming webhook sends messages into one Google Chat space. It cannot receive messages."),
            paragraph(
              "A Chat app receives messages on the app's HTTP endpoint. GoatCitadel checks Google's signed token against the audience you set before it accepts anything, replies through the Chat API with the service account, and can delete only messages the app itself sent. Only the senders you allow can start a conversation.",
            ),
            note(
              "warning",
              "Incoming webhook URLs and service-account keys are secrets. GoatCitadel keeps what you paste in this computer's secure storage.",
            ),
          ],
        },
        {
          id: "create-webhook",
          kind: "instruction",
          createOnly: true,
          title: "Create the webhook or the Chat app",
          body: [
            paragraph(
              "Pick one. An incoming webhook only sends messages into one space. A Chat app can also receive messages and reply, but it needs more setup.",
            ),
            paragraph(
              "Incoming webhook. Needs a Google Workspace Business or Enterprise account, and your admin must allow webhooks. Personal Gmail accounts can't add them. On a computer: open the space › its name › Apps & integrations › Add webhooks › name it › Save › More › Copy link.",
            ),
            paragraph("Chat app. Set it up in Google Cloud:"),
            {
              kind: "list",
              ordered: true,
              items: [
                "In Google Cloud, create a project and turn on the Google Chat API.",
                "On the Chat API Configuration page set the app name, avatar and description, turn on interactive features, choose HTTP endpoint URL, choose the authentication audience, and set who can see it.",
                "Create a service account and download its JSON key.",
                "Add the app to your space.",
              ],
            },
            paragraph(
              "Pick Project number as the audience (the endpoint-URL audience needs this connection's address, which the Verify the first conversation step shows before you finish). After you finish, paste this connection's webhook address into the Chat app's HTTP endpoint URL, then message the app from an allowed sender and check that it replies.",
            ),
            paragraph(
              "GoatCitadel doesn't provide a public address. A Chat app needs your own public HTTPS address (a reverse proxy or tunnel) in front of this Gateway.",
            ),
            linkBlock("Google Chat incoming webhooks", WEBHOOKS_DOC),
            linkBlock("Configure the Chat API", CONFIGURE_DOC),
            linkBlock("Authenticate as a Chat app", AUTHENTICATE_DOC),
          ],
          checklist: [
            check("space", "Open the Google Chat space you want to use"),
            check("mode", "Create the incoming webhook, or create the Chat app and its service account"),
            check("copied", "Copy the webhook link, or download the service account's JSON key"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "mode",
              label: "Connect with",
              type: "select",
              required: true,
              defaultValue: "webhook",
              explanation:
                "An incoming webhook only sends messages into one space. A Chat app can also receive messages and reply.",
              options: [
                { value: "webhook", label: "Incoming webhook (sends only)" },
                { value: "app", label: "Chat app (sends and receives)" },
              ],
              canChangeLater: true,
            },
            {
              key: "webhookUrl",
              label: "Incoming webhook URL",
              type: "url",
              required: false,
              explanation: "The full link Google Chat gave you when you made the webhook.",
              whyNeeded: "Used for every message GoatCitadel sends into the space.",
              whereToFind: [
                paragraph(
                  "After you save the webhook in the space's Apps & integrations, click More, then Copy link. Copy the whole link.",
                ),
              ],
              looksLike: "https://chat.googleapis.com/v1/spaces/...",
              commonMistakes: [
                "Copying the space URL instead of the webhook link.",
                "Copying only part of the link. It keeps a key and a token after the ?.",
              ],
              sensitive: true,
              canChangeLater: true,
              visibleWhenFieldEquals: FOR_WEBHOOK,
            },
            {
              key: "serviceAccountKey",
              label: "Service-account key (paste the JSON)",
              type: "textarea",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded:
                "A Chat app signs in as its service account with this key to send, reply and delete its own messages.",
              whereToFind: [
                paragraph(
                  "In Google Cloud, open IAM & Admin › Service Accounts and select your service account. Then open Keys › Add key › Create new key, choose JSON, and click Create. Open the downloaded file and paste all of it here.",
                ),
                linkBlock("Authenticate as a Chat app", AUTHENTICATE_DOC),
              ],
              looksLike:
                "The whole JSON key file from Google Cloud. It starts with { and names your project and the service account's email.",
              commonMistakes: [
                "Pasting only the private key. Paste the whole file.",
                "Using an API key or an OAuth client instead of a service-account key.",
              ],
              sensitive: true,
              canChangeLater: true,
              visibleWhenFieldEquals: FOR_APP,
            },
            {
              key: "serviceAccountKeyEnv",
              label: "Service-account key from an environment variable",
              type: "text",
              required: false,
              explanation: "Name of the environment variable that holds the whole JSON key.",
              whyNeeded:
                "A Chat app signs in as its service account with this key to send, reply and delete its own messages.",
              placeholder: "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY",
              canChangeLater: true,
              visibleWhenFieldEquals: FOR_APP,
            },
            {
              key: "audienceType",
              label: "Authentication audience type",
              type: "select",
              required: false,
              defaultValue: "project_number",
              explanation:
                "Must match the Chat app's Authentication audience setting in the Google Cloud console. Project number is the easy choice: the endpoint URL option needs this connection's address, which the Verify the first conversation step shows before you finish.",
              whyNeeded: "Inbound requests are accepted only when Google's bearer token carries this audience.",
              options: [
                { value: "project_number", label: "Project number", hint: "Recommended" },
                { value: "endpoint_url", label: "HTTP endpoint URL" },
              ],
              canChangeLater: true,
              visibleWhenFieldEquals: FOR_APP,
            },
            {
              key: "audience",
              label: "Audience",
              type: "text",
              required: false,
              explanation:
                "The Google Cloud project number. With the endpoint URL type, use this connection's public HTTPS webhook address instead.",
              whyNeeded: "Inbound tokens issued for any other audience are rejected.",
              looksLike: "123456789012",
              canChangeLater: true,
              visibleWhenFieldEquals: FOR_APP,
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
              visibleWhenFieldEquals: FOR_APP,
            },
            {
              key: "defaultSpace",
              label: "Default space",
              type: "text",
              required: false,
              explanation: "The space the app posts to when a message does not name one, such as approval delivery.",
              whereToFind: [
                paragraph(
                  "Open the space in Google Chat on the web. In its address, the text after /space/ is the space ID. For https://mail.google.com/mail/u/0/#chat/space/AAAAAAAAA the default space is spaces/AAAAAAAAA.",
                ),
                linkBlock("Chat API spaces", SPACES_DOC),
              ],
              looksLike: "spaces/AAAAxxxx",
              canChangeLater: true,
              visibleWhenFieldEquals: FOR_APP,
            },
            {
              key: "defaultThreadKey",
              label: "Optional default thread key",
              type: "text",
              required: false,
              explanation: "Optional thread key for grouping outbound webhook messages into a stable thread.",
              looksLike: "goatcitadel-ops",
              canChangeLater: true,
              visibleWhenFieldEquals: FOR_WEBHOOK,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the connection",
          body: [
            paragraph("Incoming webhook: GoatCitadel sends one test message into the space. Check that it appears."),
            paragraph(
              "Chat app: GoatCitadel checks that the key is set and the audience looks right. It doesn't contact Google or send a test message in this mode, so the result carries a note about that. You can still finish. After you finish, message the app from an allowed sender and check that it replies.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "webhook-refused",
              "Google Chat refused the webhook",
              "The link is usually cut short, or the webhook was deleted, or your admin turned webhooks off. Copy the full link again from the space's Apps & integrations. It needs everything after the ?.",
            ),
            troubleshoot(
              "incomplete-url",
              "It says the URL should look like a Google Chat webhook",
              "Copy the whole link. It starts with https://chat.googleapis.com/v1/spaces/ and keeps its key and token after the ?.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says a host is not in the outbound allowlist",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add chat.googleapis.com (and oauth2.googleapis.com for a Chat app), then run the test again.",
            ),
            troubleshoot(
              "message-missing",
              "The test passed but nothing appeared in the space",
              "A passing test means Google Chat accepted the message. Check that you are looking at the space you made the webhook in, and open the thread if you set a thread key.",
            ),
            troubleshoot(
              "app-not-checked",
              "It says GoatCitadel can't send a test message in Chat app mode",
              "That is expected. GoatCitadel can't send a test message in Chat app mode, and you can still finish setup. After you finish, message the app from an allowed sender and check that it replies. If it does not reply, see: You message the app and nothing comes back.",
            ),
            troubleshoot(
              "no-reply",
              "You message the app and nothing comes back",
              "Check these in order. The Chat app's HTTP endpoint URL must be this connection's webhook address. The authentication audience in Google Cloud must match the audience here. Your users/… id must be listed under Who may message this bot. And this Gateway must be reachable at a public HTTPS address you set up.",
            ),
            troubleshoot(
              "key-not-found",
              "It says the service-account key is missing",
              "Paste the whole JSON key, or give the name of a variable that holds it. A variable's name must start with GOOGLE_CHAT_, and you must restart GoatCitadel after you set it.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection. For an incoming webhook, the test already posted a message; check that it appeared in the space. A Chat app gets no test message. After you finish, message the app from an allowed sender and check that it replies.",
            ),
          ],
          successCriteria: [
            "An incoming webhook URL or a service-account key is set.",
            "A Chat app has an audience that matches the Chat app's setting.",
            "Incoming webhook: the test message appeared in the space.",
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
      officialDocsUrl: AUTHENTICATE_DOC,
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
      const mode: GoogleChatMode =
        readString(config, "serviceAccountKey") || readString(config, "serviceAccountKeyEnv") ? "app" : "webhook";
      return {
        draft: {
          mode,
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
      const appMode = connectionMode(draft) === "app";
      // The mode itself is never saved: the Gateway and the diagnostics tell a Chat app from a webhook by its key.
      // So the other mode's keys are cleared (null), or an edited connection would keep them and stay in its old mode.
      const otherModeKeys = appMode ? WEBHOOK_ONLY_KEYS : APP_ONLY_KEYS;
      const clearedOtherMode = Object.fromEntries(otherModeKeys.map((key) => [key, null]));
      return {
        ...clearedOtherMode,
        ...compactRecord({
          webhookUrl: appMode ? undefined : readString(draft.draft, "webhookUrl"),
          defaultThreadKey: appMode ? undefined : readString(draft.draft, "defaultThreadKey"),
          // Present only on a custody-hydrated draft; finalize replaces it with the promoted secret reference.
          serviceAccountKey: appMode ? readString(draft.draft, "serviceAccountKey") : undefined,
          serviceAccountKeyEnv: appMode ? readString(draft.draft, "serviceAccountKeyEnv") : undefined,
          audienceType: appMode ? (readString(draft.draft, "audienceType") ?? "project_number") : undefined,
          audience: appMode ? readString(draft.draft, "audience") : undefined,
          addOnProjectNumber: appMode ? readString(draft.draft, "addOnProjectNumber") : undefined,
          defaultSpace: appMode ? readString(draft.draft, "defaultSpace") : undefined,
          // Google Chat never had inbound: app inbound is default-deny and never inherits a legacy-open posture.
          ...(appMode ? { inboundAccessMode: "allowlist" } : {}),
        }),
      };
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      if (connectionMode(draft) === "app") {
        if (!hasServiceAccountKey(draft)) {
          issues.push(
            requiredFieldIssue("serviceAccountKey", "Paste the service-account key (the JSON file from Google Cloud)."),
          );
        }
        issues.push(...validateAppMode(draft.draft));
        return issues;
      }
      // A key kept in secure storage stays on the draft, so it would make the saved connection a Chat app.
      if (readString(draft.draft, "mode") === "webhook" && draft.secretState?.serviceAccountKey?.configured) {
        issues.push({
          key: "mode_conflict",
          fieldKey: "mode",
          level: "error",
          failureCategory: "malformed_value",
          message:
            "This draft already holds a service-account key, so it is a Chat app. Choose Chat app, or start a new connection.",
        });
      }
      const webhookUrl = readString(draft.draft, "webhookUrl");
      if (!webhookUrl && !draft.secretState?.webhookUrl?.configured && !savedConnectionHoldsKey(draft, "webhookUrl")) {
        issues.push(requiredFieldIssue("webhookUrl", "Paste the incoming webhook URL."));
      } else if (webhookUrl && !/^https:\/\/chat\.googleapis\.com\/v1\/spaces\//.test(webhookUrl)) {
        issues.push(
          malformedFieldIssue(
            "webhookUrl",
            "Incoming webhook URL should look like https://chat.googleapis.com/v1/spaces/…",
          ),
        );
      }
      return issues;
    },
  };
}

function validateAppMode(values: Record<string, unknown>): ChannelSetupIssue[] {
  const issues: ChannelSetupIssue[] = [];
  // The key variable's name is checked for every guide by withGuidedJourney, against what the Gateway can read.
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
