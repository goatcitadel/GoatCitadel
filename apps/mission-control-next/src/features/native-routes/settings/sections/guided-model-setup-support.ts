import {
  describeClaudeCodeCliLoginGuidance,
  findProviderTemplate,
  isSubscriptionAuthMode,
  type ChangePlanProviderConnectionRequest,
  type ChangePlanRecord,
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
  Pick<GuidedProviderOption, "addProfile"> &
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
  if (provider.addProfile) {
    return readiness(
      "needs_setup",
      `${provider.addProfile.label ?? provider.providerId} is not added to this installation yet. Add it, then check its login.`,
    );
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
  /** A better-supported provider to offer as a one-click switch, when the list has it. */
  alternative?: { providerId: string; label: string };
}

/**
 * Credential-flow guidance for providers whose connection is not a plain API
 * key. Returns null so the caller keeps its generic copy for everything else.
 */
export function guidedConnectionHint(
  provider: (Pick<ProviderModelCatalogOption, "authMode"> & Pick<GuidedProviderOption, "addProfile">) | null,
): GuidedConnectionHint | null {
  if (provider?.addProfile) {
    return {
      connectLabel: "Add Claude Code CLI",
      note: "This installation was set up before the Claude Code CLI provider existed. Select Add Claude Code CLI to add it; GoatCitadel stores no token for it. Then run claude in a terminal, sign in with /login, and check the login here.",
    };
  }
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
      alternative: { providerId: "claude-code-cli", label: "Use Claude Code CLI instead" },
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

/** A provider option, plus the profile that adds it when an older saved config predates this built-in provider. */
export type GuidedProviderOption = ProviderModelCatalogOption & {
  readonly addProfile?: NonNullable<ChangePlanProviderConnectionRequest["profile"]>;
};

// Built-in providers that new installs get by default but an existing saved config can lack,
// each listed right after the first of its related providers so it is found where people look.
const ADDABLE_BUILTIN_PROVIDERS = [{ providerId: "claude-code-cli", after: ["claude-code", "anthropic"] }] as const;

/**
 * Adds each built-in provider the saved config is missing, next to its related providers, so
 * the guided setup can add it through a provider connection plan with its template profile.
 * Only a successful, current catalog load proves a provider is missing: while the
 * catalog is loading or failed, nothing is offered.
 */
export function withAddableBuiltinProviders(
  providers: readonly ProviderModelCatalogOption[],
  catalogLoaded: boolean,
): GuidedProviderOption[] {
  if (!catalogLoaded) return [...providers];
  const present = new Set(providers.map((provider) => provider.providerId));
  return ADDABLE_BUILTIN_PROVIDERS.filter(({ providerId }) => !present.has(providerId)).reduce<GuidedProviderOption[]>(
    (options, { providerId, after }) => {
      const template = findProviderTemplate(providerId);
      if (!template?.apiStyle) return options;
      const addition: GuidedProviderOption = {
        providerId: template.providerId,
        label: `${template.label} · not added yet`,
        baseUrl: template.baseUrl,
        defaultModel: template.defaultModel,
        apiStyle: template.apiStyle,
        authMode: template.authMode,
        models: [template.defaultModel],
        sanitizedEndpointIdentity: "",
        addProfile: {
          label: template.label,
          baseUrl: template.baseUrl,
          apiStyle: template.apiStyle,
          authMode: template.authMode,
          defaultModel: template.defaultModel,
          // Capabilities stay Gateway-owned: it pins this provider's, and a stated
          // value it overrides would fail the plan's exact saved-profile check.
        },
      };
      const anchor = after
        .map((relatedId) => options.findIndex((option) => option.providerId === relatedId))
        .find((index) => index >= 0);
      const insertAt = anchor === undefined ? 0 : anchor + 1;
      return [...options.slice(0, insertAt), addition, ...options.slice(insertAt)];
    },
    [...providers],
  );
}

export type GuidedProviderGroupId = "ready" | "subscription" | "api_key" | "cloud_account" | "local";

export interface GuidedProviderGroup {
  readonly id: GuidedProviderGroupId;
  readonly label: string;
  readonly providers: readonly GuidedProviderOption[];
}

const GUIDED_PROVIDER_GROUP_LABELS: Readonly<Record<GuidedProviderGroupId, string>> = {
  ready: "Ready to use",
  subscription: "Use a subscription",
  api_key: "Pay-per-use API key",
  cloud_account: "Pay-per-use cloud account",
  local: "Run locally",
};

// Cloud credentials that are not an API key: Google ADC or service accounts, and AWS SigV4.
const CLOUD_ACCOUNT_AUTH_MODES = new Set(["google-adc", "google-service-account", "aws-sigv4"]);

// Providers whose path is retired from the product but can linger in an older saved config.
const RETIRED_PROVIDER_IDS = new Set(["npu-local"]);

// Dropdown names that say how each provider is paid for, where the saved label leaves it ambiguous.
const GUIDED_PROVIDER_OPTION_LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI API (platform key)",
  anthropic: "Anthropic API (Console key)",
  "claude-code": "Claude Code token (may be rejected)",
};

/** The dropdown name for a provider; the saved label is unchanged everywhere else. */
export function guidedProviderOptionLabel(
  provider: Pick<GuidedProviderOption, "providerId" | "label" | "addProfile">,
): string {
  return provider.addProfile ? provider.label : (GUIDED_PROVIDER_OPTION_LABELS[provider.providerId] ?? provider.label);
}

function guidedProviderGroupId(provider: GuidedProviderOption): GuidedProviderGroupId {
  if (resolveGuidedProviderReadiness(provider).state === "ready") return "ready";
  // Sign-in or account based providers; everything not local and not cloud-account based takes an API key.
  if (isSubscriptionAuthMode(provider.authMode)) return "subscription";
  if (provider.localCostPosture === "zero_cost_local_runtime") return "local";
  if (provider.authMode && CLOUD_ACCOUNT_AUTH_MODES.has(provider.authMode)) return "cloud_account";
  return "api_key";
}

/**
 * Groups the provider choices by how they are paid for, ready ones first, keeping
 * catalog order inside each group. Retired providers are hidden unless kept visible:
 * pass both the draft selection and the saved provider, so an operator can switch
 * back to a still-saved retired provider until a replacement is confirmed.
 */
export function groupGuidedProviders(
  providers: readonly GuidedProviderOption[],
  keepVisibleIds: readonly string[],
): GuidedProviderGroup[] {
  const keep = new Set(keepVisibleIds.filter(Boolean));
  const visible = providers.filter(
    (provider) => !RETIRED_PROVIDER_IDS.has(provider.providerId) || keep.has(provider.providerId),
  );
  return (Object.keys(GUIDED_PROVIDER_GROUP_LABELS) as GuidedProviderGroupId[])
    .map((id) => ({
      id,
      label: GUIDED_PROVIDER_GROUP_LABELS[id],
      providers: visible.filter((provider) => guidedProviderGroupId(provider) === id),
    }))
    .filter((group) => group.providers.length > 0);
}

/** Readiness while the saved providers are still loading: never "not chosen" or "unavailable". */
export const GUIDED_CATALOG_LOADING_READINESS: GuidedProviderReadiness = {
  state: "checking",
  label: "Loading…",
  description: "Loading the saved providers from the Gateway.",
  evidence: null,
};

export interface PendingPlanWant {
  kind: "provider_connection" | "installation_default_model";
  model?: string;
  thinkingLevel?: string;
}

/**
 * Picks the active setup plan to resume: the one targeting the selected provider,
 * or the first one when no provider is chosen yet. Callers pass every active plan.
 * With `want`, only a plan of that kind (and, for a default-model plan, the same
 * model and thinking level) counts, so Confirm never reopens a connect plan.
 */
export function pendingPlanForSelection(
  activePlans: readonly ChangePlanRecord[],
  providerId: string,
  want?: PendingPlanWant,
): ChangePlanRecord | null {
  const matchesWant = (plan: ChangePlanRecord) => {
    if (!want) return true;
    const request = plan.request;
    if (request.kind !== want.kind) return false;
    if (request.kind !== "installation_default_model") return true;
    return (
      (want.model === undefined || request.model === want.model) &&
      (request.thinkingLevel ?? "standard") === (want.thinkingLevel ?? "standard")
    );
  };
  const candidates = activePlans.filter(matchesWant);
  if (!providerId) return candidates[0] ?? null;
  return candidates.find((plan) => "providerId" in plan.request && plan.request.providerId === providerId) ?? null;
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

export const TERMINAL_CHANGE_PLAN_STATUSES = new Set<ChangePlanRecord["status"]>([
  "completed",
  "applied",
  "manual_required",
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
]);

/** The Settings-origin provider connection and default-model plans that are still in progress. */
export const activeGuidedSetupPlans = (items: readonly ChangePlanRecord[]) =>
  items.filter(
    (plan) =>
      plan.origin.surface === "settings" &&
      ["provider_connection", "installation_default_model"].includes(plan.kind) &&
      !TERMINAL_CHANGE_PLAN_STATUSES.has(plan.status),
  );
