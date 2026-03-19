import type {
  IntegrationCatalogEntry,
  IntegrationFormSchema,
  IntegrationFieldSchema,
} from "@goatcitadel/contracts";

const FORM_SCHEMA_OVERRIDES: Record<string, IntegrationFormSchema> = {
  "channel.discord": {
    catalogId: "channel.discord",
    title: "Discord Connection",
    description: "Connect a Discord bot token or webhook and default send target.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Discord" }),
      text("botTokenEnv", "Bot Token ENV Var", {
        placeholder: "DISCORD_BOT_TOKEN",
        secretRef: true,
      }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://discord.com/api/webhooks/...",
        advanced: true,
      }),
      text("defaultChannelId", "Default Channel ID", { required: true }),
      text("defaultGuildId", "Default Guild ID", { advanced: true }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.slack": {
    catalogId: "channel.slack",
    title: "Slack Connection",
    description: "Connect a Slack bot token and default destination.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Slack" }),
      text("botTokenEnv", "Bot Token ENV Var", {
        placeholder: "SLACK_BOT_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultChannel", "Default Channel", { placeholder: "#general" }),
      text("defaultThreadTs", "Default Thread TS", { advanced: true }),
      url("webhookUrl", "Incoming Webhook URL", {
        placeholder: "https://hooks.slack.com/services/...",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.telegram": {
    catalogId: "channel.telegram",
    title: "Telegram Connection",
    description: "Connect a Telegram bot token and default chat target.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Telegram" }),
      text("botTokenEnv", "Bot Token ENV Var", {
        placeholder: "TELEGRAM_BOT_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultChatId", "Default Chat ID", {
        placeholder: "123456789 or @channel_name",
        required: true,
      }),
      select("parseMode", "Parse Mode", ["Markdown", "MarkdownV2", "HTML"], "Markdown"),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.matrix": {
    catalogId: "channel.matrix",
    title: "Matrix Connection",
    description: "Connect a Matrix homeserver, access token, and default room.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Matrix" }),
      url("homeserverUrl", "Homeserver URL", {
        defaultValue: "https://matrix-client.matrix.org",
        required: true,
      }),
      text("accessTokenEnv", "Access Token ENV Var", {
        placeholder: "MATRIX_ACCESS_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultRoomId", "Default Room ID", {
        placeholder: "!room:matrix.org",
        required: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.google-chat": {
    catalogId: "channel.google-chat",
    title: "Google Chat Connection",
    description: "Connect a Google Chat incoming webhook and optional thread key.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Google Chat" }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://chat.googleapis.com/v1/spaces/...",
        required: true,
      }),
      text("defaultThreadKey", "Default Thread Key", {
        placeholder: "goatcitadel-thread",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.teams": {
    catalogId: "channel.teams",
    title: "Teams Connection",
    description: "Connect a Microsoft Teams incoming webhook for outbound operator messages.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Teams" }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://outlook.office.com/webhook/...",
        required: true,
      }),
      text("cardTitle", "Card Title", {
        placeholder: "GoatCitadel",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.webhooks": {
    catalogId: "automation.webhooks",
    title: "Webhook Connection",
    description: "Configure outbound webhook endpoint and optional signing secret.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Webhook" }),
      url("baseUrl", "Webhook Base URL", {
        required: true,
        placeholder: "https://example.com/webhooks",
      }),
      select("method", "HTTP Method", ["POST", "PUT"], "POST"),
      text("signingSecretEnv", "Signing Secret ENV Var", {
        placeholder: "WEBHOOK_SIGNING_SECRET",
        secretRef: true,
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.gmail": {
    catalogId: "automation.gmail",
    title: "Gmail Connection",
    description: "Configure Gmail integration using OAuth token handles or env references.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Gmail" }),
      select("authMode", "Auth Mode", ["oauth", "env"], "oauth"),
      text("clientIdEnv", "Client ID ENV Var", {
        placeholder: "GMAIL_CLIENT_ID",
        secretRef: true,
        advanced: true,
      }),
      text("clientSecretEnv", "Client Secret ENV Var", {
        placeholder: "GMAIL_CLIENT_SECRET",
        secretRef: true,
        advanced: true,
      }),
      text("refreshTokenHandle", "Refresh Token Handle", {
        placeholder: "gmail-primary",
        required: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "model_provider.openai": providerSchema("model_provider.openai", "OpenAI", "OPENAI_API_KEY", "https://api.openai.com/v1", "gpt-5.4-mini"),
  "model_provider.openrouter": providerSchema("model_provider.openrouter", "OpenRouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "openai/gpt-5.4-mini"),
  "model_provider.glm": providerSchema("model_provider.glm", "GLM (Z.AI)", "GLM_API_KEY", "https://api.z.ai/api/paas/v4", "glm-5"),
  "model_provider.moonshot": providerSchema("model_provider.moonshot", "Moonshot", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1", "kimi-k2.5"),
  "model_provider.lmstudio": providerSchema("model_provider.lmstudio", "LM Studio", "", "http://127.0.0.1:1234/v1", "local-model", true),
  "model_provider.ollama": providerSchema("model_provider.ollama", "Ollama", "", "http://127.0.0.1:11434/v1", "llama3.2", true),
  "model_provider.local-models": providerSchema("model_provider.local-models", "Local Models", "", "http://127.0.0.1:1234/v1", "local-model", true),
};

export const INTEGRATION_CATALOG: IntegrationCatalogEntry[] = [
  // Channels
  entry("channel", "tui", "Terminal/TUI", "Interactive terminal channel for local operations.", "native", ["local"], ["chat", "commands"]),
  entry("channel", "webchat", "Webchat", "Embedded web chat endpoint for browser clients.", "native", ["token", "basic"], ["chat", "sessions"]),
  entry("channel", "discord", "Discord", "Discord bot/webhook bridge.", "beta", ["oauth", "bot-token"], ["chat", "threads"]),
  entry("channel", "signal", "Signal", "Signal messenger bridge.", "planned", ["device-link"], ["chat"]),
  entry("channel", "whatsapp", "WhatsApp", "WhatsApp business bridge.", "planned", ["oauth", "token"], ["chat", "media"]),
  entry("channel", "telegram", "Telegram", "Telegram bot integration.", "beta", ["bot-token"], ["chat", "threads"]),
  entry("channel", "slack", "Slack", "Slack app/bot integration.", "beta", ["oauth"], ["chat", "threads", "mentions"]),
  entry("channel", "google-chat", "Google Chat", "Google Chat app and webhook integration.", "beta", ["oauth", "token"], ["chat", "spaces", "threads"]),
  entry("channel", "mattermost", "Mattermost", "Mattermost bot/webhook integration.", "planned", ["token"], ["chat", "channels", "threads"]),
  entry("channel", "imessage", "iMessage", "iMessage bridge (platform dependent).", "planned", ["local-agent"], ["chat", "attachments"]),
  entry("channel", "teams", "Microsoft Teams", "Teams bot/webhook integration.", "beta", ["oauth", "webhook"], ["chat", "threads"]),
  entry("channel", "nextcloud-talk", "Nextcloud Talk", "Nextcloud Talk channel bridge.", "planned", ["token"], ["chat", "rooms"]),
  entry("channel", "matrix", "Matrix", "Matrix room bot integration.", "beta", ["access-token"], ["chat", "rooms"]),

  // Model providers
  entry("model_provider", "openai", "OpenAI", "Direct OpenAI provider support.", "native", ["api-key"], ["chat-completions"]),
  entry("model_provider", "anthropic", "Anthropic", "Anthropic provider via adapter or compatible proxy.", "beta", ["api-key"], ["messages", "chat-completions"]),
  entry("model_provider", "google", "Google", "Google model provider via adapter/proxy.", "beta", ["api-key"], ["chat-completions"]),
  entry("model_provider", "minimax", "MiniMax", "MiniMax provider route.", "planned", ["api-key"], ["chat-completions"]),
  entry("model_provider", "vercel", "Vercel AI Gateway", "Vercel AI Gateway compatible endpoint.", "planned", ["api-key"], ["chat-completions"]),
  entry("model_provider", "openrouter", "OpenRouter", "OpenRouter aggregated model endpoint.", "native", ["api-key"], ["chat-completions"]),
  entry("model_provider", "mistral", "Mistral", "Mistral provider route.", "planned", ["api-key"], ["chat-completions"]),
  entry("model_provider", "deepseek", "DeepSeek", "DeepSeek provider route.", "planned", ["api-key"], ["chat-completions"]),
  entry("model_provider", "glm", "GLM (Z.AI)", "GLM provider route via Z.AI OpenAI-compatible API.", "beta", ["api-key"], ["chat-completions"]),
  entry("model_provider", "moonshot", "Moonshot (Kimi API)", "Moonshot Kimi OpenAI-compatible provider route.", "beta", ["api-key"], ["chat-completions"]),
  entry("model_provider", "ollama", "Ollama", "Ollama local runtime via OpenAI-compatible endpoint.", "native", ["local"], ["chat-completions"]),
  entry("model_provider", "perplexity", "Perplexity", "Perplexity provider route.", "planned", ["api-key"], ["chat-completions"]),
  entry("model_provider", "huggingface", "HuggingFace", "HuggingFace inference route.", "planned", ["api-key"], ["chat-completions"]),
  entry("model_provider", "local-models", "Local Models", "Local model backends (LM Studio/Ollama/LocalAI).", "native", ["local"], ["chat-completions"]),
  entry("model_provider", "npu-local", "NPU Local Sidecar", "Local ONNX Runtime GenAI sidecar for Windows ARM64 Snapdragon NPU acceleration.", "beta", ["local"], ["chat-completions", "npu"]),

  // Productivity
  entry("productivity", "apple-notes", "Apple Notes", "Sync or publish notes to Apple Notes.", "planned", ["local-agent"], ["read", "write"]),
  entry("productivity", "apple-reminders", "Apple Reminders", "Task/reminder sync with Apple Reminders.", "planned", ["local-agent"], ["read", "write"]),
  entry("productivity", "things3", "Things 3", "Things 3 task integration.", "planned", ["local-agent"], ["read", "write"]),
  entry("productivity", "notion", "Notion", "Notion workspace integration.", "beta", ["oauth", "token"], ["read", "write", "search"]),
  entry("productivity", "obsidian", "Obsidian", "Obsidian vault integration.", "beta", ["local"], ["read", "write", "search"]),
  entry("productivity", "bear", "Bear Notes", "Bear notes integration.", "planned", ["local-agent"], ["read", "write"]),
  entry("productivity", "trello", "Trello", "Trello board/task integration.", "planned", ["oauth"], ["read", "write"]),
  entry("productivity", "github", "GitHub", "GitHub issue/pr/repo automation integration.", "native", ["token"], ["read", "write", "webhooks"]),

  // Automation tools
  entry("automation", "browser-chrome-control", "Browser Control", "Chrome/Chromium automation and capture flows.", "beta", ["local"], ["browse", "automation", "screenshots"]),
  entry("automation", "canvas-a2ui", "Canvas + A2UI", "Visual canvas workspace and agent-to-ui interactions.", "planned", ["local"], ["visual-workspace"]),
  entry("automation", "voice-wake-talk", "Voice Wake + Talk", "Wake-word and voice interaction pipeline.", "planned", ["local"], ["voice"]),
  entry("automation", "gmail", "Gmail", "Gmail read/send integration.", "planned", ["oauth"], ["read", "write"]),
  entry("automation", "cron", "Cron Jobs", "Scheduled task orchestration.", "native", ["local"], ["scheduling"]),
  entry("automation", "webhooks", "Webhooks", "Inbound/outbound webhook automation.", "native", ["token"], ["events", "automation"]),
  entry("automation", "weather", "Weather", "Weather data integration.", "native", ["none"], ["data"]),
  entry("automation", "image-gen", "Image Generation", "Image generation model integration.", "planned", ["api-key"], ["generation"]),
  entry("automation", "gif-search", "GIF Search", "GIF search integration.", "planned", ["api-key"], ["search"]),
  entry("automation", "peekaboo-screen", "Peekaboo Screen", "Screen capture and remote control integration.", "planned", ["local-agent"], ["capture", "control"]),
  entry("automation", "camera-photo-video", "Camera", "Photo/video capture integration.", "planned", ["local-agent"], ["capture"]),

  // Platforms
  entry("platform", "macos-menubar-voice", "macOS Menu Bar + Voice", "Native macOS app integration target.", "planned", ["local-agent"], ["voice", "tray"]),
  entry("platform", "ios-canvas-camera-voice", "iOS Canvas/Camera/Voice", "Native iOS companion capabilities.", "planned", ["app-auth"], ["canvas", "camera", "voice"]),
  entry("platform", "android-canvas-camera-screen", "Android Canvas/Camera/Screen", "Native Android companion capabilities.", "planned", ["app-auth"], ["canvas", "camera", "screen"]),
  entry("platform", "windows-wsl2", "Windows (WSL2 Recommended)", "Windows host platform support.", "native", ["local"], ["desktop"]),
  entry("platform", "linux-native", "Linux Native", "Linux native platform support.", "native", ["local"], ["desktop"]),
];

validateCatalogSchemas(INTEGRATION_CATALOG);

export function getIntegrationFormSchema(catalogId: string): IntegrationFormSchema | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.catalogId === catalogId)?.formSchema;
}

function entry(
  kind: IntegrationCatalogEntry["kind"],
  key: string,
  label: string,
  description: string,
  maturity: IntegrationCatalogEntry["maturity"],
  authMethods: string[],
  capabilities: string[],
): IntegrationCatalogEntry {
  const catalogId = `${kind}.${key}`;
  return {
    catalogId,
    kind,
    key,
    label,
    description,
    maturity,
    authMethods,
    capabilities,
    formSchema: FORM_SCHEMA_OVERRIDES[catalogId] ?? buildDefaultFormSchema(catalogId, label, kind, key),
  };
}

function buildDefaultFormSchema(
  catalogId: string,
  label: string,
  kind: IntegrationCatalogEntry["kind"],
  key: string,
): IntegrationFormSchema {
  const fields: IntegrationFieldSchema[] = [
    text("label", "Connection Label", { defaultValue: label }),
    bool("enabled", "Enabled", true),
  ];

  if (kind === "model_provider") {
    fields.push(
      url("baseUrl", "Base URL", { placeholder: "https://api.example.com/v1", required: true }),
      text("model", "Default Model", { placeholder: "model-name", required: true }),
      text("apiKeyEnv", "API Key ENV Var", {
        placeholder: `${key.toUpperCase().replaceAll("-", "_")}_API_KEY`,
        secretRef: true,
      }),
    );
  } else if (kind === "channel") {
    fields.push(
      text("target", "Default Target", { placeholder: "channel/thread/peer id" }),
      text("tokenEnv", "Token ENV Var", {
        placeholder: `${key.toUpperCase().replaceAll("-", "_")}_TOKEN`,
        secretRef: true,
        advanced: true,
      }),
    );
  } else if (kind === "automation") {
    fields.push(
      text("endpoint", "Endpoint", { placeholder: "Optional endpoint override" }),
      text("apiKeyEnv", "API Key ENV Var", {
        placeholder: `${key.toUpperCase().replaceAll("-", "_")}_API_KEY`,
        secretRef: true,
        advanced: true,
      }),
    );
  }

  fields.push(text("notes", "Notes", { advanced: true, placeholder: "Optional operator note" }));

  return {
    catalogId,
    title: `${label} Connection`,
    description: "Guided setup form. Advanced JSON is available for non-standard options.",
    allowAdvancedJson: true,
    fields,
  };
}

function validateCatalogSchemas(entries: IntegrationCatalogEntry[]): void {
  const keyPattern = /^[a-zA-Z0-9_.-]+$/;
  for (const entry of entries) {
    const schema = entry.formSchema;
    if (!schema) {
      continue;
    }
    for (const field of schema.fields) {
      if (!keyPattern.test(field.key)) {
        throw new Error(
          `Invalid integration form key "${field.key}" for catalog "${entry.catalogId}".`,
        );
      }
    }
  }
}

function providerSchema(
  catalogId: string,
  label: string,
  apiKeyEnvDefault: string,
  baseUrl: string,
  defaultModel: string,
  localNoKey = false,
): IntegrationFormSchema {
  return {
    catalogId,
    title: `${label} Provider`,
    description: "Register model provider connection settings.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: label }),
      url("baseUrl", "Base URL", { defaultValue: baseUrl, required: true }),
      text("model", "Default Model", { defaultValue: defaultModel, required: true }),
      text("apiKeyEnv", "API Key ENV Var", {
        defaultValue: apiKeyEnvDefault || undefined,
        placeholder: localNoKey ? "Not required for local runtime" : "OPENAI_API_KEY",
        required: !localNoKey,
        secretRef: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  };
}

function text(
  key: string,
  label: string,
  options: Partial<IntegrationFieldSchema> = {},
): IntegrationFieldSchema {
  return { key, label, type: "text", ...options };
}

function url(
  key: string,
  label: string,
  options: Partial<IntegrationFieldSchema> = {},
): IntegrationFieldSchema {
  return { key, label, type: "url", ...options };
}

function bool(key: string, label: string, defaultValue = false): IntegrationFieldSchema {
  return { key, label, type: "boolean", defaultValue };
}

function select(
  key: string,
  label: string,
  values: string[],
  defaultValue?: string,
): IntegrationFieldSchema {
  return {
    key,
    label,
    type: "select",
    options: values.map((value) => ({ value, label: value })),
    defaultValue,
  };
}
