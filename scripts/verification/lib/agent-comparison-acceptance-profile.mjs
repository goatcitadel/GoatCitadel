import { sha256 } from "./agent-comparison.mjs";
import {
  buildNativeComparisonProfile,
  NATIVE_COMPARISON_PINS,
  NATIVE_PROFILE_SLOTS,
} from "./agent-comparison-native-profile.mjs";
import { goatComparisonConfig } from "./agent-comparison-goat-profile.mjs";
import { nativeComparisonPermissions } from "./agent-comparison-permissions.mjs";
import { FEATURE_ACCEPTANCE_TASKS } from "./agent-comparison-acceptance-fixtures.mjs";

export const FEATURE_ACCEPTANCE_PINS = Object.freeze({
  ...NATIVE_COMPARISON_PINS,
  goatcitadel: "997e682752d939b415ee71523794197a37d4d4d3",
});

/** These limits describe the exact additional fixture, not the product's entire
 * scheduling, fallback or delegation feature. No model call can turn an absent
 * native receipt/authority into a successful comparison. */
export function readFeatureAcceptanceAvailability(product, taskId, profile) {
  if (!Object.hasOwn(FEATURE_ACCEPTANCE_PINS, product) || !FEATURE_ACCEPTANCE_TASKS.some((task) => task.id === taskId))
    throw new Error("Select a reviewed product and feature acceptance task.");
  if (profile && profile.revision !== FEATURE_ACCEPTANCE_PINS[product])
    throw new Error("The feature acceptance source pin has not been reviewed.");
  if (product === "hermes" && profile && profile.contextTokens < 64_000)
    return {
      status: "unsupported",
      code: "minimum_context_window",
      reason:
        "This pinned Hermes runtime requires 64,000 context tokens; the common campaign cap cannot be enlarged during a cell.",
      sourceFiles: ["agent/agent_init.py"],
    };
  if (taskId === "scheduled_agent_work" && product === "openclaw")
    return {
      status: "unsupported",
      code: "pending_approval_cancelled_on_restart",
      reason:
        "The exact scenario requires the same pending per-send approval after restart. This revision cancels orphaned prior-epoch operator approvals at startup. Native scheduling and delivery recovery remain available.",
      sourceFiles: ["src/gateway/server-aux-handlers.ts", "src/gateway/operator-approval-store.ts"],
    };
  if (taskId === "scheduled_agent_work" && product === "hermes")
    return {
      status: "unsupported",
      code: "unattended_cron_has_no_pending_approval",
      reason:
        "Cron approval policy immediately approves or denies unattended work; it does not expose the pending human per-send approval required across this fixture's restart. Native tool-using schedules remain available.",
      sourceFiles: ["tools/approval.py", "cron/executions.py", "cron/delivery_queue.py"],
    };
  if (taskId === "delegation" && product === "hermes")
    return {
      status: "unsupported",
      code: "unfinished_children_recover_as_unknown",
      reason:
        "Restart retains completed asynchronous child results and marks abandoned unfinished children unknown; delivery of retained completion is a new turn, not automatic continuation of both original children required here.",
      sourceFiles: ["tools/async_delegation.py", "tools/delegate_tool.py"],
    };
  if (taskId === "delegation" && product === "openclaw")
    return {
      status: "unsupported",
      code: "per_child_request_budget_unavailable",
      reason:
        "The reviewed native subagent configuration bounds depth, active children, concurrency and time, but exposes no enforceable per-child request/token quota matching this fixture. The shared comparison journal is an aggregate cap, not child attribution. Native restart recovery is supported separately.",
      sourceFiles: [
        "src/config/types.agent-defaults.ts",
        "src/agents/subagents/spawn/subagent-spawn.ts",
        "src/agents/subagents/registry/subagent-recovery-state.ts",
      ],
    };
  return {
    status: "supported",
    code: "native_journey",
    reason: "Run the reviewed native journey and independently verify its receipts.",
    sourceFiles: [],
  };
}

/** Additive suite-only profiles. The five original native profiles are untouched.
 * All model routes use the same metered connection; search uses the product's
 * key-free native provider. These policies are not an OS egress sandbox. */
export function buildFeatureAcceptanceProfile(product, profile, taskId, outputField = "max_completion_tokens") {
  readFeatureAcceptanceAvailability(product, taskId, profile);
  if (
    profile.outputTokens !== 4096 ||
    profile.contextTokens > 64_000 ||
    profile.maxTaskMs !== 600_000 ||
    !Number.isSafeInteger(profile.contextTokens) ||
    profile.contextTokens <= profile.outputTokens ||
    profile.grants?.length !== 1 ||
    profile.grants[0] !== "test-workspace"
  )
    throw new Error("Feature acceptance must retain the reviewed pilot context, output, time and workspace bounds.");
  const allowed = new Set(["files", "web", "scheduling", "delegation", "fallback"]);
  if (!profile.tools?.includes("files") || profile.tools.some((tool) => !allowed.has(tool)))
    throw new Error(
      "Feature profiles require files and explicitly declared feature tools; terminal and ambient integrations are not enabled.",
    );
  const required = {
    web_research: "web",
    scheduled_agent_work: "scheduling",
    delegation: "delegation",
    provider_recovery: "fallback",
  }[taskId];
  if (!profile.tools.includes(required))
    throw new Error("The native feature was not declared in the campaign tool profile.");
  let plan;
  if (product === "goatcitadel") {
    const native = goatComparisonConfig(profile, NATIVE_PROFILE_SLOTS);
    plan = {
      product,
      revision: profile.revision,
      filename: "config/goatcitadel.json",
      ...native,
      permissionPolicy: nativeComparisonPermissions(product, profile.tools),
      outputField,
    };
    if (taskId === "delegation")
      Object.assign(plan.config.assistant.features, {
        autonomyV1Disabled: false,
        chatDelegationControlsV1Enabled: true,
        chatAutomaticFanoutV1Enabled: true,
        durableChatFanoutV1Enabled: true,
      });
    if (taskId === "web_research") {
      plan.nativeTools.push(
        "browser.search",
        "browser.extract",
        "browser.navigate",
        "browser.current",
        "browser.close",
      );
      plan.config.toolPolicy.sandbox.networkAllowlist = [
        "127.0.0.1",
        "duckduckgo.com",
        "html.duckduckgo.com",
        "www.postgresql.org",
        "sqlite.org",
        "www.sqlite.org",
      ];
    }
    if (taskId === "delegation") plan.nativeTools.push("agent.fanout");
    if (taskId === "scheduled_agent_work") {
      plan.config.assistant.features.scheduledChatTurnsV1Enabled = true;
      plan.nativeTools.push("channel.send");
      plan.permissionPolicy.schedule = "per_send_approval";
    }
    if (taskId === "provider_recovery") {
      Object.assign(plan.config.assistant.features, {
        chatProviderFallbackV1Enabled: true,
        chatStaticMcpV1Enabled: true,
      });
      plan.config.llm.providers.push({
        ...plan.config.llm.providers[0],
        providerId: "comparison-fallback",
        label: "Reviewed comparison fallback",
      });
      plan.nativeTools.push("mcp.*");
    }
    plan.config.toolPolicy.tools.allow = [...plan.nativeTools];
  } else {
    plan = buildNativeComparisonProfile(product, { ...profile, tools: ["files"] }, outputField, {
      approvalGateway: product === "openclaw",
    });
    plan = structuredClone(plan);
    if (taskId === "web_research" && product === "openclaw") {
      plan.nativeTools.push("web_search", "web_fetch");
      plan.config.tools.allow = [...plan.nativeTools];
      plan.config.tools.web = {
        search: { provider: "duckduckgo", enabled: true },
        fetch: { enabled: true, maxChars: 20000 },
      };
      plan.config.plugins = { enabled: true, allow: ["duckduckgo"], entries: { duckduckgo: { enabled: true } } };
    } else if (taskId === "web_research") {
      plan.nativeTools.push("web");
      plan.config.toolsets = [...plan.nativeTools];
      plan.config.web = {
        backend: "parallel",
        search_backend: "parallel",
        extract_backend: "parallel",
        provider_tier: { parallel: "free", exa: "paid", firecrawl: "paid", keenable: "paid" },
      };
      plan.config.plugins = { enabled: ["web/parallel"] };
      plan.config.memory = { memory_enabled: false, user_profile_enabled: false };
    }
  }
  delete plan.planSha256;
  Object.assign(plan, {
    suite: "feature_acceptance_v1",
    supportedTasks: [taskId],
    effectiveConfigSha256: sha256({
      provider: profile.provider,
      model: profile.model,
      tools: [...profile.tools].sort(),
      grants: [...profile.grants].sort(),
      reasoning: profile.reasoning,
      contextTokens: profile.contextTokens,
      outputTokens: profile.outputTokens,
      maxTaskMs: profile.maxTaskMs,
    }),
    reviewNotes: [
      ...(plan.reviewNotes ?? []),
      "This extra suite is distinct from the original five tasks. No native receipt is inferred from a model answer; unavailable predicates remain incomplete.",
      "Search and filesystem permissions differ by product. The environment filter does not provide an OS sandbox.",
    ],
  });
  return { ...plan, planSha256: sha256(plan) };
}
