import { sha256 } from "./agent-comparison.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { goatComparisonConfig } from "./agent-comparison-goat-profile.mjs";
import { nativeComparisonPermissions } from "./agent-comparison-permissions.mjs";

export const NATIVE_COMPARISON_VERSION = "goatcitadel.agent-comparison.native.v1";
export const NATIVE_COMPARISON_PINS = Object.freeze({
  goatcitadel: "41d0f2e52910c60c39fa0b788042638eddf302e5",
  openclaw: "309ae03db2d45312d877e766f8f60731ad5971b7",
  hermes: "bf53ff00a7360826ec2c9e2949533160068a8fc8",
});
export const NATIVE_PROFILE_SLOTS = Object.freeze({
  baseUrl: "__GOAT_COMPARISON_BASE_URL__",
  apiKey: "__GOAT_COMPARISON_PROXY_KEY__",
  workspace: "__GOAT_COMPARISON_WORKSPACE__",
  workspaceParent: "__GOAT_COMPARISON_WORKSPACE_PARENT__",
  unavailableGatewayPort: "__GOAT_COMPARISON_UNAVAILABLE_GATEWAY_PORT__",
  approvalGatewayPort: "__GOAT_COMPARISON_APPROVAL_GATEWAY_PORT__",
  approvalGatewayToken: "__GOAT_COMPARISON_APPROVAL_GATEWAY_TOKEN__",
});

// These are source-pinned launch profiles, not claims that the products enforce
// identical host isolation. The operator reviews the native policy and records
// interventions; the independent task verifier still decides the task outcome.
export function buildNativeComparisonProfile(
  product,
  profile,
  outputField = "max_completion_tokens",
  { approvalGateway = false, interactiveCli = false, skillWorkflow = false } = {},
) {
  if (
    typeof skillWorkflow !== "boolean" ||
    (skillWorkflow &&
      (product === "hermes"
        ? !interactiveCli || approvalGateway
        : !["goatcitadel", "openclaw"].includes(product) || !approvalGateway))
  )
    throw new Error("The native skill workflow requires a supervised approval Gateway or Hermes terminal profile.");
  if (skillWorkflow && ["openclaw", "hermes"].includes(product) && profile.tools?.includes("terminal"))
    throw new Error(
      "This native skill workflow supports files and skills; terminal approvals need a separate native journey.",
    );
  if (typeof interactiveCli !== "boolean" || (interactiveCli && (product !== "hermes" || approvalGateway)))
    throw new Error("The interactive CLI profile is available only for pinned Hermes without an approval Gateway.");
  if (typeof approvalGateway !== "boolean" || (approvalGateway && !["openclaw", "goatcitadel"].includes(product)))
    throw new Error("The supervised approval Gateway requires a pinned OpenClaw or GoatCitadel profile.");
  if (!Object.hasOwn(NATIVE_COMPARISON_PINS, product))
    throw new Error("This native adapter supports only the reviewed GoatCitadel, OpenClaw, and Hermes revisions.");
  if (profile?.revision !== NATIVE_COMPARISON_PINS[product])
    throw new Error("The native CLI/config adapter has not been reviewed for this source revision.");
  if (!["max_tokens", "max_completion_tokens"].includes(outputField))
    throw new Error("The native profile needs the campaign's pinned output field.");
  if (
    !Array.isArray(profile.tools) ||
    !profile.tools.length ||
    profile.tools.some(
      (tool) => !(skillWorkflow ? ["files", "terminal", "skills"] : ["files", "terminal"]).includes(tool),
    ) ||
    (skillWorkflow && (!profile.tools.includes("files") || !profile.tools.includes("skills")))
  )
    throw new Error(
      "The headless profile supports files and terminal only; skills and scheduling require the supervised native workflow.",
    );
  if (profile.grants?.length !== 1 || profile.grants[0] !== "test-workspace")
    throw new Error("Review an explicit test-workspace grant; this adapter cannot translate additional grants.");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(profile.model ?? "") ||
    !["none", "minimal", "low", "medium", "high", "xhigh"].includes(profile.reasoning) ||
    ![profile.contextTokens, profile.outputTokens, profile.maxTaskMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    profile.outputTokens > profile.contextTokens
  )
    throw new Error("The native profile requires a bounded text model, reasoning level, and token/time limits.");
  // The pinned Hermes runtime rejects smaller windows during agent startup.
  // Reject at preparation rather than silently changing the comparison budget.
  if (product === "hermes" && profile.contextTokens < 64_000)
    throw new Error(
      "The pinned Hermes runtime requires at least 64,000 context tokens; review a common model/context profile before launch.",
    );
  const files = profile.tools.includes("files");
  const terminal = profile.tools.includes("terminal");
  const slots = NATIVE_PROFILE_SLOTS;
  let config;
  let filename;
  let nativeTools;
  let reviewNotes;
  if (product === "goatcitadel") {
    if (profile.outputTokens >= profile.contextTokens)
      throw new Error("GoatCitadel needs input space below the context cap.");
    ({ config, nativeTools } = goatComparisonConfig(profile, slots));
    filename = "config/goatcitadel.json";
    reviewNotes = [
      "The authenticated loopback Gateway owns project/session creation, route preflight, durable Chat, tools, and approvals.",
      "Only a fresh runtime is seeded. OS keychain reads, inherited credentials, and personal skills/config are disabled or omitted.",
      "Shell commands retain approval requirements. A waiting or denied action is evidence, not an automatic approval.",
      ...(skillWorkflow
        ? [
            "The operator separately reviews the generated draft, immutable artifacts, activation confirmation and native approval. Held-out reuse input is released only after native activation evidence, and a new session must load that exact skill version.",
          ]
        : []),
      ...(approvalGateway
        ? [
            "An inherited interactive terminal owns explicit approval decisions. The driver checks the exact Chat/durable linkage and waits for canonical settlement after approval.",
          ]
        : []),
    ];
  } else if (product === "openclaw") {
    const modelRef = `comparison/${profile.model}`;
    nativeTools = [
      ...(files ? ["read", "write", "edit"] : []),
      ...(terminal ? ["exec", "process"] : []),
      ...(skillWorkflow ? ["skill_workshop"] : []),
    ];
    filename = "openclaw.json";
    config = {
      models: {
        mode: "replace",
        providers: {
          comparison: {
            baseUrl: slots.baseUrl,
            apiKey: slots.apiKey,
            api: "openai-completions",
            auth: "api-key",
            models: [
              {
                id: profile.model,
                name: profile.model,
                reasoning: profile.reasoning !== "none",
                input: ["text"],
                contextWindow: profile.contextTokens,
                maxTokens: profile.outputTokens,
                compat: { maxTokensField: outputField },
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          workspace: slots.workspace,
          skipBootstrap: true,
          // An empty skills.allowBundled means unrestricted in this revision.
          // The agent-level filter preserves an explicit empty selection.
          skills: skillWorkflow ? ["release-note"] : [],
          model: { primary: modelRef, fallbacks: [] },
          models: { [modelRef]: { params: { maxTokens: profile.outputTokens } } },
          thinkingDefault: profile.reasoning === "none" ? "off" : profile.reasoning,
        },
      },
      tools: {
        allow: nativeTools,
        fs: { workspaceOnly: true },
        // agent exec merges a full-mode default beneath this config. Legacy
        // ask/security alone leave that mode active; use its canonical override.
        exec: { mode: "ask", safeBins: [] },
      },
      // This headless adapter owns no OpenClaw approval Gateway. Route attempted
      // approval connections only to its own rejecting loopback listener, never
      // to an operator's possibly running default-port Gateway.
      gateway: { mode: "local", port: slots.unavailableGatewayPort, auth: { mode: "token", token: slots.apiKey } },
      plugins: { enabled: false },
      skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
    };
    reviewNotes = [
      "Canonical exec mode ask overrides agent exec's full-mode default. Legacy ask/security fields alone leave that default active.",
      "Commands missing the fresh allowlist require approval; safe binary exemptions are empty. The headless command has no approval channel, so blocked execution requires a separately supervised native journey.",
      "Approval connections target only the owned comparison listener, which rejects Gateway traffic; an existing personal Gateway is never selected.",
      "Native cost metadata is zero because the shared proxy owns pinned-rate cost accounting. Do not report the CLI estimate as provider cost.",
      "A fresh home, state, and explicit config prevent inherited profile selection; this is not an OS sandbox.",
      "The agent skill filter is explicitly empty. Workshop autonomy is off and lifecycle approval remains pending; an empty bundled-skill allowlist would permit bundled skills in this revision.",
    ];
    if (approvalGateway) {
      reviewNotes[0] =
        "Gateway-backed agent execution keeps native exec mode ask and an empty safe-bin exemption list.";
      config.models.catalogRefresh = { enabled: false };
      config.gateway = {
        mode: "local",
        bind: "loopback",
        port: slots.approvalGatewayPort,
        auth: { mode: "token", token: slots.approvalGatewayToken },
        controlUi: { enabled: false },
        reload: { mode: "off" },
      };
      config.cron = { enabled: false };
      config.discovery = { mdns: { mode: "off" } };
      config.update = { checkOnStart: false };
      reviewNotes.splice(
        1,
        2,
        "A separate foreground Gateway owns native pending approvals. It uses fresh state, an independently generated token and an ephemeral loopback port; no existing Gateway is selected.",
        skillWorkflow
          ? "The foreground child owns typed artifact and native apply reviews. The parent does not attach a competing terminal reader; no execution approval is resolved automatically."
          : "The terminal operator inspects requests and explicitly chooses allow-once or deny. The comparison console forwards each decision through the native approvals CLI; it never grants automatically or adds allowlist entries.",
        "A fresh native CLI event client holds operator.admin scope, required for cross-requester approval visibility. It retains events and never resolves a request.",
      );
      if (skillWorkflow) {
        reviewNotes.push(
          "The foreground workflow uses the native agent and Workshop APIs. The operator reviews exact projected installation bytes and explicitly confirms native apply; a fresh session must read the complete installed version. Support-file bundles and terminal tools are not supported by this workflow adapter.",
        );
        reviewNotes.push(
          "Workshop lifecycle operations require review. This does not govern arbitrary edits to skill files through other filesystem owners or provide an OS isolation boundary.",
        );
        reviewNotes[reviewNotes.findIndex((note) => note.startsWith("The agent skill filter"))] =
          "The agent skill filter permits only release-note; no such skill is seeded. Workshop autonomy is off and lifecycle approval remains pending.";
      }
    }
  } else {
    nativeTools = [...(files ? ["file"] : []), ...(terminal ? ["terminal"] : []), ...(skillWorkflow ? ["skills"] : [])];
    filename = "config.yaml"; // JSON is a YAML subset; no extra serializer dependency.
    const route = {
      provider: "comparison",
      model: profile.model,
      base_url: slots.baseUrl,
      api_key: slots.apiKey,
      reasoning_effort: profile.reasoning,
      extra_body: { [outputField]: profile.outputTokens },
    };
    config = {
      model: { provider: "comparison", default: profile.model },
      providers: {
        comparison: {
          name: "comparison",
          api: slots.baseUrl,
          api_key: slots.apiKey,
          transport: "chat_completions",
          default_model: profile.model,
          discover_models: false,
          models: { [profile.model]: { context_length: profile.contextTokens } },
          extra_body: { [outputField]: profile.outputTokens },
        },
      },
      fallback_providers: [],
      toolsets: nativeTools,
      agent: { reasoning_effort: profile.reasoning, reasoning_overrides: {}, max_turns: 100 },
      delegation: { provider: "comparison", model: profile.model, fallback_providers: [] },
      auxiliary: Object.fromEntries(
        ["compression", "approval", "skills_hub", "mcp", "vision"].map((name) => [name, route]),
      ),
      approvals: { mode: "manual", single_query_mode: "deny", unattended_mode: "deny", cron_mode: "deny" },
      command_allowlist: [],
      hooks: {},
      mcp_servers: {},
      ...(skillWorkflow
        ? {
            skills: {
              write_approval: true,
              ledger: true,
              external_dirs: [],
              create_dir: "",
              project_discovery: false,
              trusted_project_dirs: [],
              template_vars: false,
              inline_shell: false,
            },
            curator: { enabled: false },
            memory: { memory_enabled: false, user_profile_enabled: false },
          }
        : {}),
    };
    reviewNotes = [
      "Single-query dangerous commands are denied; ordinary commands run without approval. No --oneshot/--yolo flag is used.",
      "The file and terminal toolsets are not a filesystem jail. Use a dedicated test account/host for untrusted work.",
      "Main, auxiliary, and delegated routes use the proxy; alternate provider credentials are omitted from the child environment.",
    ];
    if (interactiveCli)
      reviewNotes[0] =
        "The real Hermes terminal owns native approval prompts. Explicit one-time decisions preserve risk-based approval; exit the CLI after the task. Terminal stdout is visible but not captured or byte-limited; bounded native transcripts and stderr are retained.";
    if (skillWorkflow)
      reviewNotes.push(
        "The native opt-out command and public startup sync seed only Hermes's essential operating manual; optional bundles and external/project skill discovery are disabled. The baseline manual is retained in the native inventory.",
        "Skill writes stage through skills.write_approval. The operator reviews exact pending bytes, then uses the real CLI /skills diff and /skills approve commands. Native approval binds a pending ID only; the adapter checks installed bytes and ledger evidence before reuse. Comparison hash references are not native versions or CAS guarantees.",
        "Source, capture and reuse use the native one-query CLI and retained SQLite history. Capture resumes the source session; reuse starts a new session and must call skill_view for the full reviewed bytes. The operator-only review session may not add model turns. Native approval does not govern arbitrary file writes or isolate the host.",
      );
  }
  const plan = {
    schemaVersion: NATIVE_COMPARISON_VERSION,
    product,
    ...(approvalGateway ? { approvalGateway: true } : {}),
    ...(interactiveCli ? { interactiveCli: true } : {}),
    revision: profile.revision,
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
    filename,
    config,
    nativeTools,
    permissionPolicy: nativeComparisonPermissions(product, profile.tools),
    reviewNotes,
    outputField,
    ...(skillWorkflow ? { skillWorkflow: true } : {}),
    supportedTasks: skillWorkflow
      ? ["workflow_capture_reuse"]
      : ["cited_research", "code_repair", "document_generation"],
    taskOutcome: "unverified",
    transportCoverage: "native_configuration_review_required",
  };
  return { ...plan, planSha256: sha256(plan) };
}

export function bindNativeComparisonConfig(plan, connection, workspace, approvalGateway) {
  if (connection?.effectiveConfigSha256 !== plan.effectiveConfigSha256 || connection.revision !== plan.revision)
    throw new Error("The native profile does not match the supervised execution binding.");
  const url = new URL(connection.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1"
  )
    throw new Error("A native profile may bind only the supervised loopback provider.");
  if (typeof connection.apiKey !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(connection.apiKey))
    throw new Error("The short-lived supervised provider token is invalid.");
  if (
    plan.approvalGateway && plan.product === "openclaw"
      ? !approvalGateway ||
        !Number.isInteger(approvalGateway.port) ||
        approvalGateway.port < 1024 ||
        approvalGateway.port > 65535 ||
        approvalGateway.port === Number(url.port) ||
        typeof approvalGateway.token !== "string" ||
        !/^[a-f0-9]{64}$/u.test(approvalGateway.token) ||
        approvalGateway.token === connection.apiKey
      : approvalGateway !== undefined
  )
    throw new Error("The supervised approval Gateway needs a distinct private loopback binding.");
  const values = new Map([
    [NATIVE_PROFILE_SLOTS.baseUrl, connection.baseUrl],
    [NATIVE_PROFILE_SLOTS.apiKey, connection.apiKey],
    [NATIVE_PROFILE_SLOTS.workspace, workspace],
    [NATIVE_PROFILE_SLOTS.workspaceParent, path.dirname(workspace)],
    [NATIVE_PROFILE_SLOTS.unavailableGatewayPort, Number(url.port)],
    [NATIVE_PROFILE_SLOTS.approvalGatewayPort, approvalGateway?.port],
    [NATIVE_PROFILE_SLOTS.approvalGatewayToken, approvalGateway?.token],
  ]);
  const visit = (value) => {
    if (typeof value === "string") return values.get(value) ?? value;
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return visit(plan.config);
}

export function nativeComparisonArguments(
  product,
  {
    checkoutRoot,
    configFile,
    stateDirectory,
    promptFile,
    workspace,
    profile,
    evidenceDirectory,
    approvalGateway = false,
    interactiveCli = false,
    skillWorkflow = false,
    configurationSha256,
    executablePath,
  },
) {
  if (product === "hermes" && skillWorkflow)
    return [
      fileURLToPath(new URL("./agent-comparison-hermes-workflow-child.mjs", import.meta.url)),
      checkoutRoot,
      executablePath,
      configFile,
      configurationSha256,
      workspace,
      evidenceDirectory,
    ];
  if (product === "goatcitadel")
    return [
      fileURLToPath(new URL("./agent-comparison-goat-child.mjs", import.meta.url)),
      checkoutRoot,
      stateDirectory,
      promptFile,
      workspace,
      `${evidenceDirectory}/goatcitadel`,
      ...(skillWorkflow ? ["--supervised-skill-workflow"] : approvalGateway ? ["--supervised-approvals"] : []),
    ];
  if (product === "openclaw" && skillWorkflow)
    return [
      fileURLToPath(new URL("./agent-comparison-openclaw-workflow-child.mjs", import.meta.url)),
      checkoutRoot,
      configFile,
      configurationSha256,
      workspace,
      evidenceDirectory,
    ];
  if (product === "openclaw" && approvalGateway)
    return [
      `${checkoutRoot}/openclaw.mjs`,
      "agent",
      "--agent",
      "main",
      "--session-key",
      "agent:main:comparison",
      "--message-file",
      promptFile,
      "--model",
      `comparison/${profile.model}`,
      "--thinking",
      profile.reasoning === "none" ? "off" : profile.reasoning,
      "--timeout",
      String(Math.ceil(profile.maxTaskMs / 1000)),
      "--json",
    ];
  if (product === "openclaw")
    return [
      `${checkoutRoot}/openclaw.mjs`,
      "agent",
      "exec",
      "--message-file",
      promptFile,
      "--cwd",
      workspace,
      "--state-dir",
      stateDirectory,
      "--config",
      configFile,
      "--model",
      `comparison/${profile.model}`,
      "--thinking",
      profile.reasoning === "none" ? "off" : profile.reasoning,
      "--timeout",
      String(Math.ceil(profile.maxTaskMs / 1000)),
      "--json",
    ];
  if (product === "hermes")
    return [
      "-m",
      "hermes_cli.main",
      "chat",
      "--query-file",
      promptFile,
      ...(interactiveCli ? [] : ["--quiet"]),
      "--provider",
      "comparison",
      "--model",
      profile.model,
      "--reasoning",
      profile.reasoning,
      "--toolsets",
      profile.tools.map((tool) => (tool === "files" ? "file" : tool)).join(","),
      "--max-turns",
      "100",
      "--run-budget",
      String(profile.maxTaskMs / 1000),
    ];
  throw new Error("Unsupported native CLI adapter.");
}
