import type { LlmProviderSummary, LlmRuntimeConfig } from "@goatcitadel/contracts";
import { isRouteLocalProvider } from "./chat-route-local-ward.js";

export interface UtilityModelOverride {
  providerId: string;
  model: string;
}

/**
 * Resolves the cheap utility-model override for background LLM calls
 * (improvement scans, judges, classifiers, prompt packs).
 *
 * Returns `undefined` — meaning "keep today's model selection exactly" —
 * unless every precondition holds: the `utilityModelRoutingV1Enabled` flag is
 * on, a utility provider is configured, that provider is known, and it has a
 * usable API key. A missing utility model falls back to the provider's
 * default model rather than failing.
 */
export function resolveUtilityModelOverride(input: {
  flagEnabled: boolean;
  utilityProviderId?: string;
  utilityModel?: string;
  provider?: Pick<LlmProviderSummary, "providerId" | "hasApiKey" | "defaultModel">;
}): UtilityModelOverride | undefined {
  if (!input.flagEnabled) {
    return undefined;
  }
  const providerId = input.utilityProviderId?.trim();
  if (!providerId) {
    return undefined;
  }
  const provider = input.provider;
  if (!provider || provider.providerId !== providerId || !provider.hasApiKey) {
    return undefined;
  }
  const model = input.utilityModel?.trim() || provider.defaultModel?.trim();
  if (!model) {
    return undefined;
  }
  return { providerId, model };
}

export interface JudgeModelDefaults {
  providerId?: string;
  model?: string;
}

// Keyed fallbacks for operator-started Prompt Lab judging, tried in order when
// the active provider is not ready. Each uses its own configured default model;
// the literal is only a last resort. Background jobs never use this list.
const JUDGE_FALLBACK_PROVIDERS: ReadonlyArray<{ providerId: string; fallbackModel?: string }> = [
  { providerId: "openai-codex" },
  { providerId: "openai", fallbackModel: "gpt-5.4" },
  { providerId: "glm", fallbackModel: "glm-5" },
  { providerId: "moonshot" },
];

type ModelRoutingRuntime = Pick<LlmRuntimeConfig, "activeProviderId" | "activeModel"> & {
  providers: ReadonlyArray<
    Pick<LlmProviderSummary, "providerId" | "baseUrl" | "hasApiKey" | "defaultModel"> &
      Partial<Pick<LlmProviderSummary, "apiStyle" | "resolvedApiStyle">>
  >;
};

/**
 * Background jobs never run on the Claude Code CLI: each call starts its own CLI process, and live a plain
 * turn ran the follow-up classifier (plus background review every fifth turn) as extra processes on the
 * operator's subscription (#493). An explicit utility-model override still wins.
 */
function isActiveProviderPerCallCli(runtime: ModelRoutingRuntime): boolean {
  const active = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
  return (active?.resolvedApiStyle ?? active?.apiStyle) === "claude-code-cli";
}

/**
 * The operator's active provider and model when that provider is ready, else
 * `undefined`. A keyless provider on a loopback endpoint (Ollama, LM Studio,
 * llama.cpp) counts as ready.
 */
function resolveReadyActiveProvider(runtime: ModelRoutingRuntime): UtilityModelOverride | undefined {
  const active = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
  const activeModel = runtime.activeModel || active?.defaultModel;
  if (active && (active.hasApiKey || isRouteLocalProvider(active)) && activeModel) {
    return { providerId: active.providerId, model: activeModel };
  }
  return undefined;
}

/**
 * Picks the model for background jobs (post-turn commitment classification,
 * background review, proactive planning) when no utility override applies:
 * the active provider when it is ready, otherwise `undefined`, meaning skip
 * the job. Background jobs never fall back to another provider, so post-turn
 * transcripts only reach the provider the operator chose for Chat (or an
 * explicit utility-model override).
 */
export function resolveBackgroundJobModelDefaults(runtime: ModelRoutingRuntime): UtilityModelOverride | undefined {
  return resolveReadyActiveProvider(runtime);
}

export interface BackgroundJobModelResolverDeps {
  getUtilityModelOverride(): Promise<UtilityModelOverride | undefined>;
  /**
   * Runs any probe-backed readiness check so "not checked yet" is not read as "not ready". It never runs
   * for the Claude Code CLI, which background jobs skip before probing. The implementation records bounded evidence for a check that throws; the job is skipped either way.
   */
  ensureActiveProviderReadiness(): Promise<void>;
  getRuntimeConfig(): ModelRoutingRuntime;
}

/**
 * Resolves the background-job model: an explicit utility-model override wins;
 * otherwise jobs are skipped on the Claude Code CLI, then the active provider's
 * readiness is checked and `resolveBackgroundJobModelDefaults` decides.
 * `undefined` means skip the job.
 */
export async function resolveBackgroundJobModel(
  deps: BackgroundJobModelResolverDeps,
): Promise<UtilityModelOverride | undefined> {
  const override = await deps.getUtilityModelOverride();
  if (override) {
    return override;
  }
  // Read twice on purpose: the provider's style before the probe, its readiness only after it.
  const readRuntime = () => deps.getRuntimeConfig();
  // Decided before the readiness probe, which on the CLI would itself start a process.
  if (isActiveProviderPerCallCli(readRuntime())) {
    return undefined;
  }
  try {
    await deps.ensureActiveProviderReadiness();
  } catch {
    // Fail closed: the provider summary could still project an earlier "ready"
    // result, so a check that just failed must not be overridden by it.
    return undefined;
  }
  // Checked again: the active provider can change to the CLI while the probe runs.
  const runtime = readRuntime();
  if (isActiveProviderPerCallCli(runtime)) {
    return undefined;
  }
  return resolveBackgroundJobModelDefaults(runtime);
}

/**
 * Picks the judge model for operator-started Prompt Lab scoring when no
 * utility override applies. The active provider wins whenever it is ready;
 * otherwise a signed-in fallback provider is used so a run the operator
 * started still gets scored. Background jobs use
 * `resolveBackgroundJobModel` instead, which never falls back.
 */
export function resolveJudgeModelDefaults(runtime: ModelRoutingRuntime): JudgeModelDefaults {
  const ready = resolveReadyActiveProvider(runtime);
  if (ready) {
    return ready;
  }
  const active = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
  const activeModel = runtime.activeModel || active?.defaultModel;
  for (const candidate of JUDGE_FALLBACK_PROVIDERS) {
    const provider = runtime.providers.find((item) => item.providerId === candidate.providerId && item.hasApiKey);
    const model = provider?.defaultModel || candidate.fallbackModel;
    if (provider && model) {
      return { providerId: provider.providerId, model };
    }
  }
  return { providerId: active?.providerId ?? runtime.activeProviderId, model: activeModel };
}
