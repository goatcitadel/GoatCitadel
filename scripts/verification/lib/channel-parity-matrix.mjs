const SHARED_OUTBOUND_PROOF = "apps/gateway/src/services/channel-delivery-runtime-service.test.ts";
const SHARED_INBOUND_PROOF = "apps/gateway/src/services/inbound-channel-event-service.test.ts";
const CAPABILITY_PROOF = "packages/gateway-core/src/channel-core.test.ts";
const SETUP_PROOF = "apps/gateway/src/services/channel-setup-definitions.test.ts";

export const REQUIRED_CHANNEL_FAMILIES = Object.freeze([
  "slack",
  "discord",
  "telegram",
  "ntfy",
  "google-chat",
  "teams",
  "whatsapp",
  "signal",
  "mattermost",
  "imessage",
  "nextcloud-talk",
  "line",
  "zalo",
  "zalouser",
]);

function adapterRow(input) {
  const inboundCapable = input.inboundMode !== "none";
  return Object.freeze({
    ...input,
    expected: Object.freeze({
      ...input.expected,
      inboundModes: Object.freeze([input.inboundMode]),
    }),
    durability: Object.freeze({
      outboundCommitBeforeSend: input.callability === "callable",
      inboundCommitBeforeAck: inboundCapable,
      dedupeReplay: inboundCapable ? "persistent_provider_identity" : "outbound_idempotency",
      restartRecovery:
        input.expected.lifecycle === "persistent"
          ? "persistent_runtime_plus_shared_durable_recovery"
          : "shared_durable_recovery",
      unknownAfterSend: input.callability === "callable" ? "manual_reconciliation_required" : "blocked_before_send",
      finalReplyRecovery: inboundCapable ? "deterministic_delivery_idempotency" : "not_applicable",
    }),
    proof: Object.freeze({
      capability: CAPABILITY_PROOF,
      setup: SETUP_PROOF,
      sharedOutbound: input.callability === "callable" ? SHARED_OUTBOUND_PROOF : undefined,
      sharedInbound: inboundCapable ? SHARED_INBOUND_PROOF : undefined,
      ...input.proof,
    }),
    liveEnvironment: Object.freeze({
      status: input.liveEnvironmentStatus ?? "not_run",
      reason:
        input.liveEnvironmentReason ??
        "Deterministic provider-contract tests use controlled transports; no external account or credential was used by this lane.",
    }),
  });
}

export const ADVERTISED_CHANNEL_PARITY_MATRIX = Object.freeze([
  adapterRow({
    id: "slack.bot-signed",
    family: "slack",
    catalogId: "channel.slack",
    channelKey: "slack",
    variant: "bot token plus signed Events API",
    callability: "callable",
    config: { botTokenEnv: "SLACK_BOT_TOKEN", signingSecretEnv: "SLACK_SIGNING_SECRET", defaultChannel: "#ops" },
    inboundMode: "webhook",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      inboundAdapter: "apps/gateway/src/routes/integrations.webhooks.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "slack.bot-outbound",
    family: "slack",
    catalogId: "channel.slack",
    channelKey: "slack",
    variant: "bot token without signing secret",
    callability: "callable",
    config: { botTokenEnv: "SLACK_BOT_TOKEN", defaultChannel: "#ops" },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "slack.webhook-signed",
    family: "slack",
    catalogId: "channel.slack",
    channelKey: "slack",
    variant: "incoming webhook plus signed Events API",
    callability: "callable",
    config: {
      webhookUrl: "https://hooks.slack.test/services/example",
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      defaultChannel: "#ops",
    },
    inboundMode: "webhook",
    expected: { outboundTransport: "webhook", lifecycle: "stateless", attachmentSources: ["url"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor-edges.coverage.test.ts",
      inboundAdapter: "apps/gateway/src/routes/integrations.webhooks.test.ts",
      diagnostics: "apps/gateway/src/services/integration-diagnostics-service.live-checks.test.ts",
    },
  }),
  adapterRow({
    id: "slack.webhook-outbound",
    family: "slack",
    catalogId: "channel.slack",
    channelKey: "slack",
    variant: "incoming webhook only",
    callability: "callable",
    config: { webhookUrl: "https://hooks.slack.test/services/example", defaultChannel: "#ops" },
    inboundMode: "none",
    expected: { outboundTransport: "webhook", lifecycle: "stateless", attachmentSources: ["url"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor-edges.coverage.test.ts",
      diagnostics: "apps/gateway/src/services/integration-diagnostics-service.live-checks.test.ts",
    },
  }),
  adapterRow({
    id: "discord.gateway",
    family: "discord",
    catalogId: "channel.discord",
    channelKey: "discord",
    variant: "persistent gateway",
    callability: "callable",
    config: {
      runtimeMode: "gateway",
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "1234567890",
      guilds: { 9876543210: { channels: ["1234567890"] } },
    },
    inboundMode: "gateway",
    expected: { outboundTransport: "api", lifecycle: "persistent", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      inboundAdapter: "apps/gateway/src/services/discord-runtime-bridge-service.contract.test.ts",
      reconnect: "apps/gateway/src/services/discord-runtime-service.loop27.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "discord.bridge",
    family: "discord",
    catalogId: "channel.discord",
    channelKey: "discord",
    variant: "stateless bot-token bridge",
    callability: "callable",
    config: { runtimeMode: "bridge", botTokenEnv: "DISCORD_BOT_TOKEN", defaultChannelId: "1234567890" },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "discord.webhook",
    family: "discord",
    catalogId: "channel.discord",
    channelKey: "discord",
    variant: "outbound webhook",
    callability: "callable",
    config: { runtimeMode: "bridge", webhookUrl: "https://discord.com/api/webhooks/123/example" },
    inboundMode: "none",
    expected: { outboundTransport: "webhook", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "telegram.bot-webhook",
    family: "telegram",
    catalogId: "channel.telegram",
    channelKey: "telegram",
    variant: "Bot API plus secret-token webhook",
    callability: "callable",
    config: {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
      defaultChatId: "-1001234567890",
    },
    inboundMode: "webhook",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      inboundAdapter: "apps/gateway/src/routes/integrations.webhooks.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "ntfy.publish",
    family: "ntfy",
    catalogId: "channel.ntfy",
    channelKey: "ntfy",
    variant: "outbound topic publish",
    callability: "callable",
    config: { baseUrl: "https://ntfy.example.test", topic: "goatcitadel-ops", tokenEnv: "NTFY_TOKEN" },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor-edges.coverage.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.ntfy.test.ts",
    },
  }),
  adapterRow({
    id: "google-chat.webhook",
    family: "google-chat",
    catalogId: "channel.google-chat",
    channelKey: "google-chat",
    variant: "outbound incoming webhook",
    callability: "callable",
    config: { webhookUrl: "https://chat.googleapis.com/v1/spaces/example", defaultThreadKey: "ops" },
    inboundMode: "none",
    expected: { outboundTransport: "webhook", lifecycle: "stateless", attachmentSources: ["url"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-webhook-probes.test.ts",
    },
  }),
  adapterRow({
    id: "teams.webhook",
    family: "teams",
    catalogId: "channel.teams",
    channelKey: "teams",
    variant: "outbound incoming webhook",
    callability: "callable",
    config: { webhookUrl: "https://teams.example.test/webhook" },
    inboundMode: "none",
    expected: { outboundTransport: "webhook", lifecycle: "stateless", attachmentSources: ["url"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-webhook-probes.test.ts",
    },
  }),
  adapterRow({
    id: "whatsapp.cloud-webhook",
    family: "whatsapp",
    catalogId: "channel.whatsapp",
    channelKey: "whatsapp",
    variant: "Cloud API plus signed webhook",
    callability: "callable",
    config: {
      accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
      phoneNumberId: "1234567890",
      defaultTarget: "+15551234567",
      appSecretEnv: "WHATSAPP_APP_SECRET",
      webhookVerifyTokenEnv: "WHATSAPP_VERIFY_TOKEN",
    },
    inboundMode: "webhook",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      inboundAdapter: "apps/gateway/src/services/whatsapp-webhook.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "signal.bridge-outbound",
    family: "signal",
    catalogId: "channel.signal",
    channelKey: "signal",
    variant: "outbound JSON-RPC bridge",
    callability: "callable",
    config: {
      baseUrl: "http://127.0.0.1:8080",
      accountId: "+15551234567",
      defaultRecipient: "+15557654321",
      inboundEnabled: true,
      pollIntervalSeconds: 5,
    },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: [] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      inboundQuarantine: "apps/gateway/src/services/signal-inbound-runtime-service.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "mattermost.bot",
    family: "mattermost",
    catalogId: "channel.mattermost",
    channelKey: "mattermost",
    variant: "outbound bot API",
    callability: "callable",
    config: { serverUrl: "https://mattermost.example.test", botTokenEnv: "MATTERMOST_TOKEN" },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "imessage.bluebubbles",
    family: "imessage",
    catalogId: "channel.imessage",
    channelKey: "imessage",
    variant: "callable BlueBubbles bridge",
    callability: "callable",
    config: {
      bridgeProvider: "bluebubbles",
      bridgeUrl: "http://127.0.0.1:1234",
      passwordEnv: "BLUEBUBBLES_PASSWORD",
      defaultHandle: "+15551234567",
    },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "imessage.photon-diagnostics",
    family: "imessage",
    catalogId: "channel.imessage",
    channelKey: "imessage",
    variant: "Photon/Spectrum metadata only",
    callability: "diagnostic_only",
    config: {
      bridgeProvider: "photon",
      bridgeUrl: "http://127.0.0.1:4317",
      password: "diagnostic-placeholder",
      defaultHandle: "+15551234567",
    },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url", "inline"] },
    proof: {
      outboundBlocked: "packages/policy-engine/src/tool-executor-channel-failures.coverage.test.ts",
      diagnostics: "apps/gateway/src/services/integration-diagnostics-service.contract.test.ts",
    },
    liveEnvironmentStatus: "not_applicable",
    liveEnvironmentReason: "Photon/Spectrum is intentionally non-callable until a governed adapter is installed.",
  }),
  adapterRow({
    id: "nextcloud-talk.bot-webhook",
    family: "nextcloud-talk",
    catalogId: "channel.nextcloud-talk",
    channelKey: "nextcloud-talk",
    variant: "bot API plus signed webhook",
    callability: "callable",
    config: { baseUrl: "https://cloud.example.test", tokenEnv: "NEXTCLOUD_TALK_TOKEN" },
    inboundMode: "webhook",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: [] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      inboundAdapter: "apps/gateway/src/routes/integrations.webhooks.test.ts",
      diagnostics: "apps/gateway/src/services/integration-diagnostics-service.contract.test.ts",
    },
  }),
  adapterRow({
    id: "line.messaging-webhook",
    family: "line",
    catalogId: "channel.line",
    channelKey: "line",
    variant: "Messaging API plus signed webhook",
    callability: "callable",
    config: {
      channelAccessTokenEnv: "LINE_ACCESS_TOKEN",
      channelSecretEnv: "LINE_CHANNEL_SECRET",
      defaultTarget: "U1234567890",
    },
    inboundMode: "webhook",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: [] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      inboundAdapter: "apps/gateway/src/services/line-webhook.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "zalo.official-account",
    family: "zalo",
    catalogId: "channel.zalo",
    channelKey: "zalo",
    variant: "Official Account outbound API",
    callability: "callable",
    config: { accessTokenEnv: "ZALO_ACCESS_TOKEN" },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: [] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
  adapterRow({
    id: "zalouser.zca-bridge",
    family: "zalouser",
    catalogId: "channel.zalouser",
    channelKey: "zalouser",
    variant: "Zalo user zca bridge",
    callability: "callable",
    config: {
      baseUrl: "http://127.0.0.1:4545",
      authTokenEnv: "ZALOUSER_AUTH_TOKEN",
      defaultTarget: "user:123",
    },
    inboundMode: "none",
    expected: { outboundTransport: "api", lifecycle: "stateless", attachmentSources: ["url"] },
    proof: {
      outboundAdapter: "packages/policy-engine/src/tool-executor.test.ts",
      diagnostics: "apps/gateway/src/services/channel-bot-live-probes.test.ts",
    },
  }),
]);

export function validateAdvertisedChannelParityMatrix(rows = ADVERTISED_CHANNEL_PARITY_MATRIX) {
  const errors = [];
  const ids = new Set();
  const families = new Set();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) {
      errors.push(`duplicate or missing row id: ${row.id ?? "<missing>"}`);
    }
    ids.add(row.id);
    families.add(row.family);
    for (const key of ["outboundTransport", "lifecycle", "attachmentSources"]) {
      if (row.expected[key] === undefined) {
        errors.push(`${row.id} is missing expected.${key}`);
      }
    }
    for (const key of [
      "outboundCommitBeforeSend",
      "inboundCommitBeforeAck",
      "dedupeReplay",
      "restartRecovery",
      "unknownAfterSend",
      "finalReplyRecovery",
    ]) {
      if (row.durability[key] === undefined) {
        errors.push(`${row.id} is missing durability.${key}`);
      }
    }
    if (!row.proof.capability || !row.proof.setup || !row.proof.diagnostics) {
      errors.push(`${row.id} is missing capability, setup, or diagnostics proof`);
    }
    if (!row.liveEnvironment?.status || !row.liveEnvironment?.reason) {
      errors.push(`${row.id} is missing explicit live-environment truth`);
    }
  }
  for (const family of REQUIRED_CHANNEL_FAMILIES) {
    if (!families.has(family)) {
      errors.push(`missing required channel family: ${family}`);
    }
  }
  return errors;
}
