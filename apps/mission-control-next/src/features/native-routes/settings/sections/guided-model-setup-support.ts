import {
  describeClaudeCodeCliLoginGuidance,
  type ChatCompletionReasoningEffort,
  type ChatThinkingLevel,
} from "@goatcitadel/contracts";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";

export const GUIDED_THINKING_LEVELS: ReadonlyArray<{ value: ChatThinkingLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
  { value: "deep", label: "Deep" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

const THINKING_LEVEL_FOR_EFFORT: Readonly<Record<ChatCompletionReasoningEffort, ChatThinkingLevel>> = {
  none: "off",
  low: "minimal",
  medium: "standard",
  high: "extended",
  xhigh: "deep",
  max: "max",
  ultra: "ultra",
};

/**
 * Mirrors the Gateway's Model Change Plan effort gate so the wizard never
 * offers (or silently submits) an effort the selected provider rejects with
 * a 422. The Gateway stays authoritative for model-specific effort metadata.
 */
export function supportedGuidedThinkingLevels(
  capabilities: ProviderModelCatalogOption["capabilities"] | undefined,
): ChatThinkingLevel[] {
  if (capabilities?.reasoning === false) return ["off"];
  const efforts = capabilities?.reasoningEfforts;
  if (!efforts?.length) return GUIDED_THINKING_LEVELS.map((option) => option.value);
  const supported = new Set<ChatThinkingLevel>(["off", ...efforts.map((effort) => THINKING_LEVEL_FOR_EFFORT[effort])]);
  return GUIDED_THINKING_LEVELS.map((option) => option.value).filter((level) => supported.has(level));
}

export function clampGuidedThinkingLevel(
  requested: ChatThinkingLevel,
  supported: readonly ChatThinkingLevel[],
): ChatThinkingLevel {
  if (supported.includes(requested)) return requested;
  const order = GUIDED_THINKING_LEVELS.map((option) => option.value);
  const requestedRank = order.indexOf(requested);
  // Prefer the strongest supported effort that does not exceed the request.
  const fallback = [...supported]
    .filter((level) => order.indexOf(level) <= requestedRank)
    .sort((left, right) => order.indexOf(right) - order.indexOf(left))[0];
  return fallback ?? supported[0] ?? "off";
}

type GuidedModelSelection = { providerId: string; model: string; thinkingLevel: ChatThinkingLevel };

/**
 * The draft input a saved default acknowledges. The wizard submits the clamped effort, so the raw draft captured when
 * the plan was submitted is that submission when its effort clamps to the saved one. Input edited after submission is
 * compared against this snapshot, so it stays unsaved.
 */
export function submittedGuidedSelection(
  submittedDraft: GuidedModelSelection | null,
  saved: GuidedModelSelection,
  supported: readonly ChatThinkingLevel[],
): GuidedModelSelection {
  return submittedDraft &&
    submittedDraft.providerId === saved.providerId &&
    submittedDraft.model === saved.model &&
    clampGuidedThinkingLevel(submittedDraft.thinkingLevel, supported) === saved.thinkingLevel
    ? submittedDraft
    : saved;
}

type GuidedReadinessProvider = Pick<ProviderModelCatalogOption, "providerId" | "label" | "baseUrl"> &
  Partial<
    Pick<
      ProviderModelCatalogOption,
      | "authMode"
      | "authReadiness"
      | "hasApiKey"
      | "localCostPosture"
      | "modelProbeState"
      | "modelProbeSource"
      | "modelProbeWarning"
      | "modelRefreshStatus"
    >
  >;

export interface GuidedProviderReadiness {
  state: "ready" | "checking" | "not_verified" | "needs_setup";
  /** Short status for the card summary. */
  label: string;
  description: string;
  /** Which existing Gateway evidence proved readiness; null until something did. */
  evidence: "credential" | "local_endpoint" | "local_login" | null;
}

const READINESS_LABELS: Readonly<Record<GuidedProviderReadiness["state"], string>> = {
  ready: "Ready",
  checking: "Checking…",
  not_verified: "Not verified",
  needs_setup: "Needs setup",
};

function readiness(
  state: GuidedProviderReadiness["state"],
  description: string,
  evidence: GuidedProviderReadiness["evidence"] = null,
): GuidedProviderReadiness {
  return { state, label: READINESS_LABELS[state], description, evidence };
}

/**
 * Projects existing Gateway evidence into first-run readiness. A local runtime
 * is ready only after its endpoint answered a live model probe, and a cloud
 * provider only when its credential owner reports it configured; a runtime
 * type or a suggested model is never evidence on its own.
 */
export function resolveGuidedProviderReadiness(provider: GuidedReadinessProvider | null): GuidedProviderReadiness {
  if (!provider) {
    return {
      ...readiness("needs_setup", "Choose a cloud provider, or a local runtime that is already running."),
      label: "Not chosen",
    };
  }
  const authStatus = provider.authReadiness?.status;
  if (provider.authMode === "claude-code-cli-login") {
    return resolveLocalLoginReadiness(provider);
  }
  if (authStatus === "missing" || authStatus === "invalid") {
    return readiness("needs_setup", `${provider.label} needs a credential. Connect it with the secure setup flow.`);
  }
  if (provider.localCostPosture === "zero_cost_local_runtime") {
    return resolveLocalEndpointReadiness(provider);
  }
  if (authStatus === "configured" || authStatus === "ready") {
    return readiness("ready", `${provider.label} has a saved credential.`, "credential");
  }
  if (authStatus === "unknown" || authStatus === "unavailable") {
    return readiness("not_verified", `${provider.label}'s credential could not be checked yet.`);
  }
  if (provider.hasApiKey === true) {
    return readiness("ready", `${provider.label} has a saved credential.`, "credential");
  }
  if (provider.hasApiKey === false) {
    return readiness("needs_setup", `${provider.label} needs a credential. Connect it with the secure setup flow.`);
  }
  return readiness("not_verified", `${provider.label}'s credential status is not available yet.`);
}

// The local Claude Code CLI has no credential to collect: readiness is its own login probe.
function resolveLocalLoginReadiness(provider: GuidedReadinessProvider): GuidedProviderReadiness {
  const readinessState = provider.authReadiness;
  if (readinessState?.status === "ready" || readinessState?.status === "configured") {
    // A ready login never borrows failure text from an unrecognized reason code.
    return readiness("ready", describeClaudeCodeCliLoginGuidance("claude_cli_logged_in"), "local_login");
  }
  const guidance = describeClaudeCodeCliLoginGuidance(readinessState?.reasonCode);
  if (readinessState?.status === "missing" || readinessState?.status === "invalid") {
    return readiness("needs_setup", guidance);
  }
  return readiness("not_verified", guidance);
}

function resolveLocalEndpointReadiness(provider: GuidedReadinessProvider): GuidedProviderReadiness {
  const endpoint = provider.baseUrl;
  if (provider.modelRefreshStatus === "stale") {
    return readiness(
      "not_verified",
      `The last check of ${provider.label} at ${endpoint} is stale. Check the connection again.`,
    );
  }
  if (provider.modelProbeState === "ready" && provider.modelProbeSource === "live") {
    return readiness("ready", `${provider.label} answered at ${endpoint}.`, "local_endpoint");
  }
  if (!provider.modelProbeState || provider.modelProbeState === "not_checked") {
    return readiness("checking", `Checking ${provider.label} at ${endpoint}…`);
  }
  if (provider.modelProbeState === "empty") {
    return readiness(
      "not_verified",
      `${provider.label} answered at ${endpoint} but reported no models. Load a model, then check the connection again.`,
    );
  }
  const warning = provider.modelProbeWarning?.trim();
  return readiness(
    "not_verified",
    `${provider.label} has not answered at ${endpoint}${warning ? ` (${warning})` : ""}. Start it, then check the connection again.`,
  );
}

/**
 * First-run default: the saved provider, otherwise the first provider with
 * ready evidence. Never preselects an unverified runtime for a new user.
 */
export function pickDefaultGuidedProvider<T extends GuidedReadinessProvider>(
  providers: readonly T[],
  activeProviderId: string,
): T | null {
  return (
    providers.find((provider) => provider.providerId === activeProviderId) ??
    providers.find((provider) => resolveGuidedProviderReadiness(provider).state === "ready") ??
    null
  );
}

export interface GuidedConnectionHint {
  /** Primary button text before the provider is ready. */
  connectLabel: string;
  note: string;
}

/**
 * Credential-flow guidance for providers whose connection is not a plain API
 * key. Returns null so the caller keeps its generic copy for everything else.
 */
export function guidedConnectionHint(
  provider: Pick<ProviderModelCatalogOption, "authMode"> | null,
): GuidedConnectionHint | null {
  if (provider?.authMode === "codex-oauth") {
    return {
      connectLabel: "Connect ChatGPT",
      note: "Use your ChatGPT account: select Connect ChatGPT, review the plan, then approve the sign-in in OpenAI.",
    };
  }
  if (provider?.authMode === "claude-code-oauth") {
    return {
      connectLabel: "Connect Claude Code",
      note: "Run claude setup-token in a terminal, select Connect Claude Code, then paste the token it prints. Anthropic limits subscription tokens to Claude Code and may reject them here; choose Claude Code CLI (local login) to use your subscription, or an Anthropic API key.",
    };
  }
  if (provider?.authMode === "claude-code-cli-login") {
    return {
      connectLabel: "Check Claude Code login",
      note: "Runs Claude Code on this machine under your own claude login, so GoatCitadel stores no token. Install Claude Code, run claude and sign in with /login, then select Check Claude Code login.",
    };
  }
  return null;
}

export interface LocalRuntimeSetupGuide {
  title: string;
  steps: readonly string[];
  command?: string;
}

type GuideContext = { baseUrl: string; model?: string };

function localHostAndPort(baseUrl: string): { host: string; port: string } | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname)) return null;
    return { host: url.hostname, port: url.port || "8080" };
  } catch {
    return { host: "127.0.0.1", port: "8080" };
  }
}

const LOCAL_RUNTIME_GUIDES: Readonly<Record<string, (context: GuideContext) => LocalRuntimeSetupGuide>> = {
  llamacpp: ({ baseUrl, model }) => ({
    title: "Start llama.cpp before connecting",
    steps: [
      "Download a GGUF model, or let GoatCitadel manage llama-server from Settings → Runtime.",
      `Run llama-server so it answers at ${baseUrl} (the /v1 OpenAI-compatible API).`,
      "Pass --alias so the model name you pick here matches what the server reports from /v1/models.",
      "Select Check connection. GoatCitadel checks the server and lists the models it serves.",
    ],
    command: (() => {
      const endpoint = localHostAndPort(baseUrl);
      const alias = model?.trim() || "my-local-model";
      if (!endpoint || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(alias)) return undefined;
      return `llama-server -m path/to/model.gguf --alias ${alias} --host ${endpoint.host} --port ${endpoint.port} --jinja`;
    })(),
  }),
  localai: ({ baseUrl }) => ({
    title: "Start LocalAI before connecting",
    steps: [
      `Run LocalAI so it answers at ${baseUrl}. LocalAI and llama.cpp both default to port 8080 — run only one there, or move one and edit its base URL in Providers.`,
      "Install at least one model (LocalAI gallery or a models/ folder); the model name is the one LocalAI lists at /v1/models.",
      "If you started LocalAI with an API key, set LOCALAI_API_KEY, or enter it with Verify provider connection under Advanced model settings.",
      "Select Check connection — the Gateway probes the endpoint and lists the installed models.",
    ],
    command: "docker run -p 8080:8080 --name local-ai -ti localai/localai:latest",
  }),
};

export function localRuntimeSetupGuide(
  provider: Pick<ProviderModelCatalogOption, "providerId" | "baseUrl"> | null,
  model?: string,
): LocalRuntimeSetupGuide | null {
  if (!provider) return null;
  const build = LOCAL_RUNTIME_GUIDES[provider.providerId.trim().toLowerCase()];
  return build ? build({ baseUrl: provider.baseUrl, model }) : null;
}
