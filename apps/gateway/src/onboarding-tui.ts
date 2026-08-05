/* eslint-disable no-console */
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { confirm, input, password, select } from "@inquirer/prompts";
import type {
  LlmModelPreviewResponse,
  LlmRuntimeConfig,
  OnboardingBootstrapResult,
  OnboardingState,
} from "@goatcitadel/contracts";
import { providerTemplates } from "@goatcitadel/contracts";
import {
  buildWindowsCommand,
  clampOption,
  parseCommaSeparated,
  resolvePnpmCommandForPlatform,
  safeHostnameFromUrl,
} from "./onboarding-tui-helpers.js";
import { resolveGoatCitadelAppDir } from "./onboarding-tui-paths.js";
import { renderBox, renderBulletList, renderKeyValueSummary, renderSection } from "./tui/render.js";
import { tuiTheme } from "./tui/theme.js";

interface GatewayAuthInput {
  mode: "none" | "token" | "basic";
  token?: string;
  username?: string;
  password?: string;
}

interface ProviderTemplate {
  providerId: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  envVar: string;
  note: string;
}

const PROVIDER_TEMPLATE_META: Record<string, { envVar: string; note: string }> = {
  openai: {
    envVar: "OPENAI_API_KEY",
    note: "General-purpose default. Higher cost than GLM for many everyday tasks.",
  },
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    note: "Good for long-form reasoning. Cloud provider.",
  },
  google: {
    envVar: "GOOGLE_API_KEY",
    note: "Fast multimodal option. Cloud provider.",
  },
  minimax: {
    envVar: "MINIMAX_API_KEY",
    note: "Cloud provider with OpenAI-compatible endpoint support.",
  },
  vercel: {
    envVar: "VERCEL_AI_GATEWAY_API_KEY",
    note: "Brokered gateway if you already route traffic through Vercel AI Gateway.",
  },
  lmstudio: {
    envVar: "",
    note: "Local endpoint. Good for private single-machine testing.",
  },
  ollama: {
    envVar: "",
    note: "Local endpoint with built-in model management.",
  },
  llamacpp: {
    envVar: "",
    note: "Local OpenAI-compatible llama.cpp server. Good for raw GGUF performance and manual tuning.",
  },
  localai: {
    envVar: "LOCALAI_API_KEY",
    note: "Local or self-hosted OpenAI-compatible endpoint.",
  },
  "genie-ir20": {
    envVar: "",
    note: "Tailnet-accessible shared runtime. Use only if you intentionally connect to that remote node.",
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    note: "Brokered access to many providers.",
  },
  mistral: {
    envVar: "MISTRAL_API_KEY",
    note: "Cloud provider optimized for lighter-weight reasoning and chat.",
  },
  deepseek: {
    envVar: "DEEPSEEK_API_KEY",
    note: "Cost-oriented cloud provider for coding and general chat.",
  },
  glm: {
    envVar: "GLM_API_KEY",
    note: "Recommended cost-oriented cloud default. Good first choice for beta testing.",
  },
  moonshot: {
    envVar: "MOONSHOT_API_KEY",
    note: "Useful second cloud option when you want Kimi models.",
  },
  perplexity: {
    envVar: "PERPLEXITY_API_KEY",
    note: "Search-oriented cloud provider.",
  },
  huggingface: {
    envVar: "HUGGINGFACE_API_KEY",
    note: "Inference router for supported HuggingFace-served models.",
  },
};
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";

const PROVIDER_TEMPLATES: ProviderTemplate[] = providerTemplates.map((template) => ({
  ...template,
  envVar: PROVIDER_TEMPLATE_META[template.providerId]?.envVar ?? "",
  note: PROVIDER_TEMPLATE_META[template.providerId]?.note ?? "OpenAI-compatible provider template.",
}));

const TOOL_APPROVAL_MODES = ["approve_all", "approve_risky", "bypass"] as const;
const BUDGET_MODES = ["saver", "balanced", "power"] as const;
const MESH_MODES = ["lan", "wan", "tailnet"] as const;
const MANUAL_MODEL_ENTRY = "__manual__";
const RETRY_MODEL_PREVIEW = "__retry__";
const USE_DEFAULT_MODEL = "__default__";

async function run(): Promise<void> {
  try {
    console.log();
    console.log(
      renderSection(
        "GoatCitadel Onboarding",
        "Guided local-first setup for gateway access, provider/model selection, runtime defaults, and optional mesh.",
      ),
    );
    console.log(
      renderBulletList(
        [
          "Press Enter to accept defaults shown in brackets.",
          "Arrow keys move through choices. Enter selects the highlighted option.",
          "Nothing is written until you confirm the final review step.",
        ],
        "accent",
      ),
    );
    console.log();

    const gatewayBaseUrl = await promptGatewayBaseUrl();
    const auth = await promptGatewayAuth();
    const initialState = await fetchOnboardingStateWithRecovery(gatewayBaseUrl, auth);

    console.log();
    console.log(
      renderBox(
        "Current checklist",
        initialState.checklist.map((item) => `${item.label}: ${item.status}${item.detail ? ` (${item.detail})` : ""}`),
        "info",
      ),
    );

    const provider = await promptProviderAndModel(initialState, gatewayBaseUrl, auth);
    const runtimeDefaults = await promptRuntimeDefaults(initialState, provider.providerBaseUrl);
    const mesh = await promptMesh(initialState);
    const completion = await promptCompletion(initialState);

    console.log();
    console.log(renderSection("Review and apply", "This is what GoatCitadel will write into runtime settings."));
    console.log(
      renderKeyValueSummary([
        { key: "Gateway", value: gatewayBaseUrl },
        { key: "Gateway auth", value: auth.mode },
        { key: "Provider", value: `${provider.providerLabel} (${provider.providerId})` },
        { key: "Base URL", value: provider.providerBaseUrl },
        { key: "Active model", value: provider.activeModel },
        { key: "Default model", value: provider.providerDefaultModel },
        { key: "Tool approvals", value: runtimeDefaults.toolApprovalMode },
        { key: "Budget mode", value: runtimeDefaults.budgetMode },
        {
          key: "Network allowlist",
          value: runtimeDefaults.networkAllowlist.length > 0 ? runtimeDefaults.networkAllowlist.join(", ") : "none",
        },
        { key: "Mesh", value: mesh.enabled ? `${mesh.mode} (${mesh.nodeId || "auto"})` : "disabled" },
        { key: "Mark complete", value: completion.markComplete ? `yes (${completion.completedBy})` : "no" },
      ]),
    );
    if (provider.providerApiKey && !provider.saveProviderApiKeyToSecureStore) {
      console.log();
      console.log(
        renderBox(
          "Provider key note",
          [
            "You entered a provider key but chose not to save it to the OS secure store.",
            "Set the suggested env var or keep the .env file path available before future restarts.",
          ],
          "warning",
        ),
      );
    }

    const apply = await confirm({
      message: "Apply onboarding now?",
      default: true,
    });
    if (!apply) {
      console.log(tuiTheme.warning("Onboarding cancelled before changes were applied."));
      return;
    }

    const bootstrap = await requestJson<OnboardingBootstrapResult>(
      gatewayBaseUrl,
      "/api/v1/onboarding/bootstrap",
      {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: initialState.settings.revision,
          toolApprovalMode: runtimeDefaults.toolApprovalMode,
          budgetMode: runtimeDefaults.budgetMode,
          networkAllowlist: runtimeDefaults.networkAllowlist,
          auth: {
            mode: auth.mode,
            allowLoopbackBypass: false,
            token: auth.mode === "token" ? auth.token : undefined,
            basicUsername: auth.mode === "basic" ? auth.username : undefined,
            basicPassword: auth.mode === "basic" ? auth.password : undefined,
          },
          llm: {
            activeProviderId: provider.providerId,
            activeModel: provider.activeModel,
            upsertProvider: {
              providerId: provider.providerId,
              label: provider.providerLabel,
              baseUrl: provider.providerBaseUrl,
              defaultModel: provider.providerDefaultModel,
              apiKeyEnv: provider.providerApiKeyEnv || undefined,
            },
          },
          mesh,
          markComplete: false,
        }),
      },
      auth,
    );

    if (provider.providerApiKey && provider.saveProviderApiKeyToSecureStore) {
      await requestJson(
        gatewayBaseUrl,
        `/api/v1/secrets/providers/${encodeURIComponent(provider.providerId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            apiKey: provider.providerApiKey,
            expectedRevision: bootstrap.state.settings.revision,
            storage: "keychain",
          }),
        },
        auth,
      );
    }

    let finalState = bootstrap.state;
    if (completion.markComplete) {
      const completed = await requestJson<{ state: OnboardingBootstrapResult["state"] }>(
        gatewayBaseUrl,
        "/api/v1/onboarding/complete",
        {
          method: "POST",
          body: JSON.stringify({ completedBy: completion.completedBy }),
        },
        auth,
      );
      finalState = completed.state;
    }

    const runtimeConfig = await requestJson<LlmRuntimeConfig>(
      gatewayBaseUrl,
      "/api/v1/llm/config",
      { method: "GET" },
      auth,
    );

    console.log();
    console.log(
      renderBox(
        "Onboarding applied",
        [
          `Applied at ${bootstrap.appliedAt}`,
          `Completed: ${finalState.completed ? "yes" : "no"}`,
          `Effective provider: ${runtimeConfig.activeProviderId}`,
          `Effective model: ${runtimeConfig.activeModel}`,
        ],
        "success",
      ),
    );
    console.log(
      renderBulletList(
        [
          "Next step: run `goat up` if the gateway is not already running.",
          "Then open Mission Control or continue with `goat doctor --deep` after the app is up.",
        ],
        "accent",
      ),
    );
  } catch (error) {
    console.error("Onboarding wizard failed.");
    console.error(error);
    process.exitCode = 1;
  }
}

async function promptGatewayBaseUrl(): Promise<string> {
  console.log();
  console.log(
    renderSection("1. Gateway access", "This first step tells the wizard which GoatCitadel gateway it should talk to."),
  );
  console.log(
    renderBulletList([
      "For a normal single-machine install, keep the loopback default.",
      "Only change this if you intentionally run the gateway on a different machine or port.",
    ]),
  );
  return (
    await input({
      message: "Gateway URL",
      default: process.env.GOATCITADEL_GATEWAY_URL ?? "http://127.0.0.1:8787",
    })
  ).trim();
}

async function promptGatewayAuth(): Promise<GatewayAuthInput> {
  const authMode = await select<GatewayAuthInput["mode"]>({
    message: "Gateway auth mode",
    default: "none",
    choices: [
      {
        name: "None - local single-user default",
        value: "none",
        description: "Use this for loopback-only local testing.",
      },
      { name: "Token - recommended when exposing beyond loopback", value: "token", description: "Bearer token auth." },
      { name: "Basic - username/password", value: "basic", description: "Simple auth for controlled environments." },
    ],
  });

  if (authMode === "token") {
    return {
      mode: "token",
      token: (
        await password({
          message: "Gateway token",
          mask: "*",
        })
      ).trim(),
    };
  }

  if (authMode === "basic") {
    return {
      mode: "basic",
      username: (await input({ message: "Gateway username" })).trim(),
      password: await password({ message: "Gateway password", mask: "*" }),
    };
  }

  return { mode: "none" };
}

async function fetchOnboardingStateWithRecovery(
  gatewayBaseUrl: string,
  auth: GatewayAuthInput,
): Promise<OnboardingState> {
  try {
    return await requestJson<OnboardingState>(gatewayBaseUrl, "/api/v1/onboarding/state", { method: "GET" }, auth);
  } catch (error) {
    if (!isLoopbackGatewayUrl(gatewayBaseUrl)) {
      throw error;
    }

    console.log();
    console.log(
      renderBox(
        "Local gateway not running yet",
        [
          "The loopback gateway did not answer the onboarding health check.",
          "GoatCitadel can start the local gateway process for you and continue once /health is ready.",
        ],
        "warning",
      ),
    );

    const startLocalGateway = await confirm({
      message: "Start the local gateway now?",
      default: true,
    });
    if (!startLocalGateway) {
      throw error;
    }

    await startLocalGatewayProcess(gatewayBaseUrl);
    return requestJson<OnboardingState>(gatewayBaseUrl, "/api/v1/onboarding/state", { method: "GET" }, auth);
  }
}

async function promptProviderAndModel(
  initialState: OnboardingState,
  gatewayBaseUrl: string,
  auth: GatewayAuthInput,
): Promise<{
  providerId: string;
  providerLabel: string;
  providerBaseUrl: string;
  providerDefaultModel: string;
  activeModel: string;
  providerApiKey: string;
  saveProviderApiKeyToSecureStore: boolean;
  providerApiKeyEnv: string;
}> {
  console.log();
  console.log(
    renderSection(
      "2. Provider and model",
      "Pick the model company first, then let GoatCitadel ask that provider which models it actually supports.",
    ),
  );

  const currentProvider = initialState.settings.llm.providers.find(
    (provider) => provider.providerId === initialState.settings.llm.activeProviderId,
  );
  const defaultTemplateId = PROVIDER_TEMPLATES.some((item) => item.providerId === currentProvider?.providerId)
    ? (currentProvider?.providerId ?? "glm")
    : "glm";

  const providerChoice = await select<string>({
    message: "Provider template",
    default: defaultTemplateId,
    choices: [
      ...PROVIDER_TEMPLATES.map((template) => ({
        name: `${template.label} (${template.providerId})`,
        value: template.providerId,
        description: template.note,
      })),
      {
        name: "Custom provider",
        value: "custom",
        description: "Use this when you have a compatible endpoint not covered by the built-in templates.",
      },
    ],
  });

  const template = PROVIDER_TEMPLATES.find((item) => item.providerId === providerChoice);
  const activeProvider = initialState.settings.llm.providers.find(
    (provider) => provider.providerId === initialState.settings.llm.activeProviderId,
  );
  let providerId =
    providerChoice === "custom"
      ? (activeProvider?.providerId ?? "custom-provider")
      : (template?.providerId ?? activeProvider?.providerId ?? "glm");
  let providerLabel =
    providerChoice === "custom"
      ? (activeProvider?.label ?? providerId)
      : (template?.label ?? activeProvider?.label ?? providerId);
  let providerBaseUrl =
    providerChoice === "custom"
      ? (activeProvider?.baseUrl ?? "http://127.0.0.1:1234/v1")
      : (template?.baseUrl ?? activeProvider?.baseUrl ?? "http://127.0.0.1:1234/v1");

  if (providerChoice === "custom") {
    console.log();
    console.log(
      renderBox(
        "Custom provider details",
        [
          "Custom providers need an internal ID, a display name, and the base URL of the compatible API endpoint.",
          "If you are just using OpenAI, GLM, Moonshot, or another built-in template, you should not need this path.",
        ],
        "info",
      ),
    );

    providerId = (
      await input({
        message: "Internal provider ID",
        default: providerId,
      })
    ).trim();

    console.log(
      renderBulletList([
        "This is the stable internal name GoatCitadel stores in config, for example `glm` or `moonshot`.",
        "Change it only if you intentionally want a custom alias for a non-built-in provider.",
      ]),
    );

    providerLabel = (
      await input({
        message: "Display name",
        default: providerLabel,
      })
    ).trim();

    providerBaseUrl = (
      await input({
        message: "API base URL",
        default: providerBaseUrl,
      })
    ).trim();
  } else {
    console.log();
    console.log(
      renderBox(
        "Built-in provider defaults",
        [
          `GoatCitadel will use the built-in ${providerLabel} configuration.`,
          `Endpoint: ${providerBaseUrl}`,
          "You can rename aliases or change endpoints later in Settings or the config files if you need advanced customization.",
        ],
        "info",
      ),
    );
  }

  const suggestedEnvVar =
    template?.envVar ||
    activeProvider?.apiKeyRef ||
    `${providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;

  console.log();
  console.log(
    renderBox(
      "Provider key guidance",
      [
        "If this provider uses an API key, you can paste it now for onboarding.",
        "If you save it, GoatCitadel keeps a key-on-file status and never sends the key back to the browser.",
        "You can also skip the secret here and rely on an env var later.",
        `Suggested env var: ${suggestedEnvVar}`,
      ],
      "info",
    ),
  );

  const providerApiKey = await password({
    message: "Provider API key (optional)",
    mask: "*",
  });
  const saveProviderApiKeyToSecureStore =
    providerApiKey.trim().length > 0
      ? await confirm({
          message: "Save provider key to the OS secure store?",
          default: true,
        })
      : false;
  let providerApiKeyEnv = suggestedEnvVar;
  if (suggestedEnvVar) {
    console.log(
      renderBulletList([
        `If you skip saving the key, GoatCitadel will look for ${suggestedEnvVar} on future restarts.`,
        "That env var name is just the lookup key. It is not the secret value itself.",
      ]),
    );
  }

  if (suggestedEnvVar) {
    const customizeEnvVar = await confirm({
      message: `Use a custom env var name instead of ${suggestedEnvVar}? (optional advanced)`,
      default: false,
    });
    if (customizeEnvVar) {
      providerApiKeyEnv =
        (
          await input({
            message: "Provider API key env var",
            default: suggestedEnvVar,
          })
        ).trim() || suggestedEnvVar;
    }
  } else {
    providerApiKeyEnv = "";
  }

  let preview = await requestJson<LlmModelPreviewResponse>(
    gatewayBaseUrl,
    "/api/v1/llm/models/preview",
    {
      method: "POST",
      body: JSON.stringify({
        providerId,
        baseUrl: providerBaseUrl,
        apiKey: providerApiKey.trim() || undefined,
        apiKeyEnv: providerApiKeyEnv || undefined,
      }),
    },
    auth,
  );

  while (true) {
    const fallbackDefaultModel =
      providerChoice === "custom"
        ? (activeProvider?.defaultModel ?? initialState.settings.llm.activeModel)
        : (template?.defaultModel ?? activeProvider?.defaultModel ?? initialState.settings.llm.activeModel);
    if (preview.warning) {
      console.log();
      console.log(
        renderBox(
          "Model discovery warning",
          [
            preview.warning,
            preview.source !== "live"
              ? "GoatCitadel fell back to the template/default model because the provider did not return a live catalog."
              : "GoatCitadel still returned live model results, but the provider sent a warning.",
          ],
          "warning",
        ),
      );
    } else {
      console.log();
      console.log(
        renderBox(
          "Model discovery",
          [
            preview.source === "live"
              ? "GoatCitadel successfully loaded a live model list from the provider API."
              : "GoatCitadel did not get a live model list, so it is offering the built-in default as a safe fallback.",
          ],
          preview.source === "live" ? "success" : "warning",
        ),
      );
    }

    const modelChoice = await select<string>({
      message: "Active model",
      default:
        preview.items.find((item) => item.id === fallbackDefaultModel)?.id ?? preview.items[0]?.id ?? USE_DEFAULT_MODEL,
      choices: [
        ...preview.items.map((item) => ({
          name: item.label ? `${item.label} (${item.id})` : item.id,
          value: item.id,
          description: preview.source === "live" ? "Live provider-reported model" : "Fallback model entry",
        })),
        {
          name: `Use provider default (${fallbackDefaultModel})`,
          value: USE_DEFAULT_MODEL,
          description: "Skip live selection and keep the template default.",
        },
        {
          name: "Retry model discovery",
          value: RETRY_MODEL_PREVIEW,
          description: "Ask the provider for models again after changing key or endpoint details.",
        },
        {
          name: "Enter model manually",
          value: MANUAL_MODEL_ENTRY,
          description: "Use this only if the provider supports the model but did not list it.",
        },
      ],
    });

    if (modelChoice === RETRY_MODEL_PREVIEW) {
      preview = await requestJson(
        gatewayBaseUrl,
        "/api/v1/llm/models/preview",
        {
          method: "POST",
          body: JSON.stringify({
            providerId,
            baseUrl: providerBaseUrl,
            apiKey: providerApiKey.trim() || undefined,
            apiKeyEnv: providerApiKeyEnv || undefined,
          }),
        },
        auth,
      );
      continue;
    }

    if (modelChoice === MANUAL_MODEL_ENTRY) {
      const manualModel = (
        await input({
          message: "Model id",
          default: fallbackDefaultModel,
        })
      ).trim();
      return {
        providerId,
        providerLabel,
        providerBaseUrl,
        providerDefaultModel: manualModel,
        activeModel: manualModel,
        providerApiKey: providerApiKey.trim(),
        saveProviderApiKeyToSecureStore,
        providerApiKeyEnv,
      };
    }

    const resolvedModel = modelChoice === USE_DEFAULT_MODEL ? fallbackDefaultModel : modelChoice;

    return {
      providerId,
      providerLabel,
      providerBaseUrl,
      providerDefaultModel: resolvedModel,
      activeModel: resolvedModel,
      providerApiKey: providerApiKey.trim(),
      saveProviderApiKeyToSecureStore,
      providerApiKeyEnv,
    };
  }
}

async function promptRuntimeDefaults(
  initialState: OnboardingState,
  providerBaseUrl: string,
): Promise<{
  toolApprovalMode: (typeof TOOL_APPROVAL_MODES)[number];
  budgetMode: (typeof BUDGET_MODES)[number];
  networkAllowlist: string[];
}> {
  console.log();
  console.log(
    renderSection(
      "3. Runtime defaults",
      "These settings control how much GoatCitadel can do by default and which outbound hosts are allowed.",
    ),
  );
  console.log(
    renderBox(
      "Network allowlist note",
      [
        "This is an outbound host allowlist. It is not your machine's desktop or LAN IP.",
        "Add cloud API hosts you want GoatCitadel to call, plus localhost when using local services.",
      ],
      "info",
    ),
  );

  const toolApprovalMode = await select<(typeof TOOL_APPROVAL_MODES)[number]>({
    message: "Tool approval mode",
    default: clampOption(initialState.settings.toolApprovalMode, TOOL_APPROVAL_MODES, "approve_risky"),
    choices: [
      {
        name: "Ask every time",
        value: "approve_all",
        description: "Require approval before every tool action.",
      },
      {
        name: "Ask for risky work",
        value: "approve_risky",
        description: "Require approval for risky or policy-gated actions.",
      },
      {
        name: "Skip normal prompts (not for Remote Hardened)",
        value: "bypass",
        description: "Skip prompts for allowed actions in local profiles. Remote Hardened rejects this mode.",
      },
    ],
  });

  const budgetMode = await select<(typeof BUDGET_MODES)[number]>({
    message: "Budget mode",
    default: clampOption(initialState.settings.budgetMode, BUDGET_MODES, "balanced"),
    choices: [
      { name: "saver", value: "saver", description: "Prefer cheaper defaults and conservative usage." },
      { name: "balanced", value: "balanced", description: "Good everyday default." },
      { name: "power", value: "power", description: "Spend more to favor stronger behavior." },
    ],
  });

  const providerHost = safeHostnameFromUrl(providerBaseUrl);
  const defaultAllowlist =
    initialState.settings.networkAllowlist.length > 0
      ? initialState.settings.networkAllowlist.join(", ")
      : ["127.0.0.1", "localhost", providerHost].filter(Boolean).join(", ");
  const networkAllowlist = parseCommaSeparated(
    (
      await input({
        message: "Network allowlist hosts (comma-separated, blank for none)",
        default: defaultAllowlist,
      })
    ).trim(),
  );

  return { toolApprovalMode, budgetMode, networkAllowlist };
}

async function promptMesh(
  initialState: OnboardingState,
): Promise<OnboardingBootstrapResult["state"]["settings"]["mesh"]> {
  console.log();
  console.log(
    renderSection(
      "4. Mesh (optional)",
      "Only enable mesh when you intentionally want this machine to participate in a multi-node GoatCitadel cluster.",
    ),
  );
  console.log(
    renderBulletList([
      "For a single-machine setup, leave mesh disabled.",
      "Static peers are other GoatCitadel nodes, not your own desktop IP unless you are explicitly peering to it.",
    ]),
  );

  const enabled = await confirm({
    message: "Enable mesh?",
    default: initialState.settings.mesh.enabled,
  });
  if (!enabled) {
    return {
      ...initialState.settings.mesh,
      enabled: false,
    };
  }

  const mode = await select<(typeof MESH_MODES)[number]>({
    message: "Mesh mode",
    default: clampOption(initialState.settings.mesh.mode, MESH_MODES, "lan"),
    choices: [
      { name: "LAN", value: "lan", description: "Use mDNS and local network discovery." },
      { name: "WAN", value: "wan", description: "Direct internet-reachable peer addresses." },
      { name: "Tailnet", value: "tailnet", description: "Use your tailnet/private overlay network." },
    ],
  });

  const nodeId = (
    await input({
      message: "Mesh node ID",
      default: initialState.settings.mesh.nodeId || `node-${process.pid}`,
    })
  ).trim();
  const mdns = await confirm({
    message: "Enable mDNS discovery?",
    default: initialState.settings.mesh.mdns,
  });
  const staticPeers = parseCommaSeparated(
    (
      await input({
        message: "Mesh static peers (comma-separated, blank to rely on discovery)",
        default: initialState.settings.mesh.staticPeers.join(", "),
      })
    ).trim(),
  );
  const requireMtls = await confirm({
    message: "Require mTLS between peers?",
    default: initialState.settings.mesh.requireMtls,
  });
  const tailnetEnabled =
    mode === "tailnet"
      ? await confirm({
          message: "Tailnet path enabled?",
          default: initialState.settings.mesh.tailnetEnabled,
        })
      : initialState.settings.mesh.tailnetEnabled;

  return {
    enabled,
    mode,
    nodeId,
    mdns,
    staticPeers,
    requireMtls,
    tailnetEnabled,
  };
}

async function promptCompletion(
  initialState: OnboardingState,
): Promise<{ markComplete: boolean; completedBy: string }> {
  console.log();
  console.log(renderSection("5. Completion", "Choose whether this run should mark onboarding complete right now."));
  const markComplete = await confirm({
    message: "Mark onboarding complete now?",
    default: true,
  });
  const completedBy =
    (
      await input({
        message: "Completed by",
        default: initialState.completedBy ?? "tui-operator",
      })
    ).trim() || "tui-operator";
  return { markComplete, completedBy };
}

async function requestJson<T>(
  baseUrl: string,
  requestPath: string,
  init: RequestInit,
  auth: GatewayAuthInput,
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");
  if ((init.method ?? "GET").toUpperCase() !== "GET") {
    headers.set("Idempotency-Key", randomUUID());
  }
  if (auth.mode === "token" && auth.token?.trim()) {
    headers.set("Authorization", `Bearer ${auth.token.trim()}`);
  }
  if (auth.mode === "basic" && auth.username && auth.password) {
    headers.set("Authorization", `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`);
  }

  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init.method ?? "GET"} ${requestPath} failed (${response.status}): ${body}`);
  }
  return (await response.json()) as T;
}

async function startLocalGatewayProcess(gatewayBaseUrl: string): Promise<void> {
  const appDir = resolveGoatCitadelAppDir();
  if (!appDir) {
    throw new Error("Cannot auto-start local gateway: GoatCitadel app root could not be resolved.");
  }

  const pnpmCommand = resolvePnpmCommand(appDir);
  const child = spawnCommand(pnpmCommand.cmd, [...pnpmCommand.prefix, "--dir", appDir, "dev:gateway"], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      GOATCITADEL_GATEWAY_URL: gatewayBaseUrl,
    },
  });
  child.unref();

  console.log(tuiTheme.info("Waiting for the local gateway to become healthy..."));
  await waitForGatewayHealth(gatewayBaseUrl, 20_000);
  console.log(tuiTheme.success("Local gateway is healthy."));
}

function resolvePnpmCommand(appDir: string): { cmd: string; prefix: string[] } {
  return resolvePnpmCommandForPlatform(appDir, process.platform);
}

function spawnCommand(cmd: string, args: string[], options: Parameters<typeof spawn>[2] = {}) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    return spawn(WINDOWS_CMD_PATH, ["/d", "/s", "/c", buildWindowsCommand([cmd, ...args])], options);
  }
  return spawn(cmd, args, options);
}

async function waitForGatewayHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "fetch failed";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for local gateway health: ${lastError}`);
}

function isLoopbackGatewayUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

void run().catch((error: unknown) => {
  console.error("Onboarding wizard terminated with an unhandled error.");
  console.error(error);
  process.exitCode = 1;
});
