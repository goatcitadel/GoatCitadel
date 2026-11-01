/* eslint-disable max-lines */
import {
  CHANGE_PLAN_RUNTIME_FEATURE_FLAGS,
  CURATED_FS_MUTATION_TOOLS,
  GLOBAL_TOOL_ACCESS_POSTURES,
  OPERATOR_WRITE_ROOT_LABEL_MAX,
  OPERATOR_WRITE_ROOT_PATH_MAX,
  OPERATOR_WRITE_ROOT_PRESETS,
} from "@goatcitadel/contracts";
import type { ToolCatalogEntry, ToolCategory, ToolPack, ToolRiskLevel } from "@goatcitadel/contracts";

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  description: string;
  argSchema?: Record<string, unknown>;
  examples?: Array<{ title: string; args: Record<string, unknown> }>;
  pack: ToolPack;
  recommendedContexts?: string[];
  preferredForIntents?: string[];
  usageHints?: string[];
  readOnly?: boolean;
  deterministic?: boolean;
  codeModeAllowed?: boolean;
}

/**
 * R3-8 model-callable spawn tool. Single source of truth for the name — the
 * registry definition, the executor dispatch, and the gateway's exposure gate
 * and runtime all key on this constant.
 */
export const SUBAGENT_FANOUT_TOOL_NAME = "agent.fanout";

/** Chat-callable request for a Gateway-owned secure runtime configuration flow. */
export const RUNTIME_CONFIGURE_TOOL_NAME = "runtime.configure";

/** Model-callable, plan-creation-only entry to the Evolution Control Plane. */
export const CHANGE_REQUEST_TOOL_NAME = "change.request";

/**
 * Model-callable request to run a short Code Mode script in the current Chat turn. It always needs an explicit
 * operator approval: no grant, relief, bypass mode or profile skips it.
 */
export const CODE_MODE_REQUEST_TOOL_NAME = "code_mode.request";

/** tests.run, lint.run and build.run only ever run a package script; they accept no command. */
const RESTRICTED_PACKAGE_SCRIPT_ARG_SCHEMA = {
  type: "object",
  properties: {
    manager: { type: "string", enum: ["pnpm", "npm"], description: "Package manager. Defaults to pnpm." },
    filter: {
      type: "string",
      pattern: "^[a-zA-Z0-9@/_\\-.]+$",
      description: "pnpm workspace filter, such as a package name.",
    },
    cwd: { type: "string", description: "Project folder inside the workspace. Defaults to the workspace." },
  },
  additionalProperties: false,
} as const;

/** Where memory.write and memory.upsert save a note when the caller names no namespace (#566). */
export const DEFAULT_MEMORY_NAMESPACE = "general";

/** memory.write and memory.upsert: only the content is required; the executor fills the namespace and title. */
const MEMORY_WRITE_ARG_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "The text to remember, in full." },
    title: { type: "string", description: "Short title. Defaults to the content's first line." },
    namespace: {
      type: "string",
      description: `Optional grouping, such as "preferences" or a project name. Defaults to "${DEFAULT_MEMORY_NAMESPACE}".`,
    },
    tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
    metadata: { type: "object", description: "Optional extra fields stored with the note." },
  },
  required: ["content"],
} as const;

export const RUNTIME_CONFIGURATION_TARGET_IDS = ["search.brave", "search.parallel"] as const;

export type RuntimeConfigurationTargetId = (typeof RUNTIME_CONFIGURATION_TARGET_IDS)[number];

/** Delegated-worker completion/scope-request envelope. The gateway owns fulfillment. */
export const SUBMIT_WORK_RESULT_TOOL_NAME = "submit_work_result";

/** Hard cap on subtasks per `agent.fanout` call (and thus on child concurrency). */
export const SUBAGENT_FANOUT_MAX_SUBTASKS = 3;

const ARTIFACT_DESIGN_ARG_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["auto", "polished", "minimal", "plain"] },
    preset: {
      type: "string",
      enum: ["auto", "clean-professional", "education", "wellness", "pitch", "technical-report", "cyberpunk-ops"],
    },
    visualLevel: { type: "string", enum: ["minimal", "polished", "rich"] },
    assetPolicy: { type: "string", enum: ["auto", "generated-first", "web-first", "built-in-only", "none"] },
    audience: { type: "string" },
    skillId: {
      type: "string",
      enum: ["impeccable"],
      description: "Use GoatCitadel Design Quality V1 for non-plain artifact output.",
    },
    brand: {
      type: "object",
      properties: {
        name: { type: "string" },
        colors: { type: "array", items: { type: "string" } },
        fonts: { type: "array", items: { type: "string" } },
        logoPath: { type: "string" },
      },
    },
  },
} as const;

const ARTIFACT_DESTINATION_ARG_SCHEMA = {
  oneOf: [
    { type: "string", enum: ["local", "google", "google-drive", "google-docs", "google-slides"] },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["local", "google", "google-drive", "google-docs", "google-slides"] },
        folderId: { type: "string" },
        title: { type: "string" },
        convert: { type: "boolean" },
      },
    },
  ],
} as const;

const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: "capabilities.search",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    deterministic: true,
    codeModeAllowed: false,
    description:
      "Find currently callable tools or skills by task. Results are discovery only; tool execution still requires current policy and approvals.",
    pack: "core",
    recommendedContexts: ["chat"],
    argSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "skills.read",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    deterministic: true,
    codeModeAllowed: false,
    description:
      "Read an exact, verified instruction file from a currently callable trusted skill. Defaults to SKILL.md; reading grants no tool permissions and executes no scripts.",
    pack: "core",
    recommendedContexts: ["chat"],
    argSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", minLength: 1, maxLength: 256 },
        relativePath: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["skillId"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_artifact.read",
    category: "research",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    description:
      "Read a bounded page of saved tool output by artifact ID from the current chat session. Internal artifact paths are not workspace files; use this tool instead of fs.read.",
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["research", "web_lookup", "artifact_output"],
    argSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", format: "uuid" },
        offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 12000 },
      },
      required: ["artifactId"],
      additionalProperties: false,
    },
  },
  {
    name: CHANGE_REQUEST_TOOL_NAME,
    category: "ops",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Request an inspectable Change Plan for an allowlisted configuration, connection, capability, repair, or update intent. This never confirms or applies the change.",
    argSchema: {
      type: "object",
      properties: {
        intent: {
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { const: "session_model" },
                providerId: { type: "string", minLength: 1, maxLength: 256 },
                model: { type: "string", minLength: 1, maxLength: 256 },
                thinkingLevel: {
                  type: "string",
                  enum: ["off", "minimal", "standard", "extended", "deep", "max", "ultra"],
                },
              },
              required: ["kind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "installation_default_model" },
                providerId: { type: "string", minLength: 1, maxLength: 256 },
                model: { type: "string", minLength: 1, maxLength: 256 },
                thinkingLevel: {
                  type: "string",
                  enum: ["off", "minimal", "standard", "extended", "deep", "max", "ultra"],
                },
              },
              required: ["kind", "providerId", "model"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "provider_connection" },
                providerId: { type: "string", minLength: 1, maxLength: 256 },
                credentialAction: {
                  type: "string",
                  enum: ["replace_api_key", "replace_oauth", "remove_api_key", "remove_oauth"],
                },
                profile: {
                  type: "object",
                  properties: {
                    label: { type: "string", minLength: 1, maxLength: 256 },
                    baseUrl: { type: "string", format: "uri", maxLength: 2048 },
                    apiStyle: {
                      type: "string",
                      enum: [
                        "openai-chat-completions",
                        "openai-responses",
                        "openai-codex-responses",
                        "anthropic-messages",
                        "bedrock-messages",
                        "claude-code-cli",
                      ],
                    },
                    authMode: {
                      type: "string",
                      enum: [
                        "api-key",
                        "codex-oauth",
                        "claude-code-oauth",
                        "claude-code-cli-login",
                        "google-service-account",
                        "google-adc",
                        "aws-sigv4",
                        "aws-bedrock-api-key",
                      ],
                    },
                    defaultModel: { type: "string", minLength: 1, maxLength: 256 },
                  },
                  additionalProperties: false,
                },
              },
              required: ["kind", "providerId"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "runtime_configuration" },
                change: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        operation: { const: "tool_approval_mode" },
                        mode: { type: "string", enum: ["approve_all", "approve_risky", "bypass"] },
                      },
                      required: ["operation", "mode"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "budget_mode" },
                        mode: { type: "string", enum: ["saver", "balanced", "power"] },
                      },
                      required: ["operation", "mode"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "deployment_profile" },
                        profile: { type: "string", enum: ["local_dev", "trusted_local", "remote_hardened"] },
                      },
                      required: ["operation", "profile"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "read_access_policy" },
                        mode: { type: "string", enum: ["roots_only", "approval_required", "full_disk"] },
                      },
                      required: ["operation", "mode"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "outside_root_write_policy" },
                        mode: { type: "string", enum: ["deny", "approval_required"] },
                      },
                      required: ["operation", "mode"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "network_allowlist" },
                        entries: {
                          type: "array",
                          maxItems: 256,
                          items: { type: "string", minLength: 1, maxLength: 512 },
                        },
                      },
                      required: ["operation", "entries"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      description:
                        "Add or remove a folder outside the workspace that filesystem tools may write to. Give exactly one of an absolute path or the os_temp preset. The operator reviews and confirms; delete access stays off unless allowDelete is true.",
                      properties: {
                        operation: { const: "operator_write_root" },
                        action: { type: "string", enum: ["add", "remove"] },
                        path: { type: "string", minLength: 1, maxLength: OPERATOR_WRITE_ROOT_PATH_MAX },
                        preset: { type: "string", enum: [...OPERATOR_WRITE_ROOT_PRESETS] },
                        allowDelete: { type: "boolean" },
                        label: { type: "string", minLength: 1, maxLength: OPERATOR_WRITE_ROOT_LABEL_MAX },
                      },
                      required: ["operation", "action"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      description:
                        "Set the global posture of one filesystem mutation tool. Deny-wins policy and approvals still apply.",
                      properties: {
                        operation: { const: "tool_global_access" },
                        toolName: { type: "string", enum: [...CURATED_FS_MUTATION_TOOLS] },
                        posture: { type: "string", enum: [...GLOBAL_TOOL_ACCESS_POSTURES] },
                      },
                      required: ["operation", "toolName", "posture"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "utility_model" },
                        providerId: { type: "string", minLength: 1, maxLength: 256 },
                        model: { type: "string", minLength: 1, maxLength: 256 },
                      },
                      required: ["operation", "providerId", "model"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "gateway_auth_configuration" },
                        mode: { type: "string", enum: ["none", "token", "basic"] },
                        allowLoopbackBypass: { type: "boolean" },
                        basicUsername: { type: "string", minLength: 1, maxLength: 256 },
                        replaceCredential: { type: "boolean" },
                      },
                      required: ["operation", "mode", "allowLoopbackBypass"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "memory_configuration" },
                        config: {
                          type: "object",
                          minProperties: 1,
                          properties: {
                            enabled: { type: "boolean" },
                            qmdEnabled: { type: "boolean" },
                            qmdApplyToChat: { type: "boolean" },
                            qmdApplyToOrchestration: { type: "boolean" },
                            qmdMaxContextTokens: { type: "integer", minimum: 1, maximum: 2_000_000 },
                            qmdMinPromptChars: { type: "integer", minimum: 0, maximum: 2_000_000 },
                            qmdCacheTtlSeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
                            qmdDistillerProviderId: { type: "string", minLength: 1, maxLength: 256 },
                            qmdDistillerModel: { type: "string", minLength: 1, maxLength: 256 },
                          },
                          additionalProperties: false,
                        },
                      },
                      required: ["operation", "config"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "web_firecrawl_configuration" },
                        config: {
                          type: "object",
                          minProperties: 1,
                          properties: {
                            enabled: { type: "boolean" },
                            baseUrl: { type: "string", format: "uri", maxLength: 2_048 },
                            timeoutMs: { type: "integer", minimum: 100, maximum: 300_000 },
                            defaultReadBackend: { type: "string", enum: ["native", "firecrawl"] },
                            fallbackToNative: { type: "boolean" },
                          },
                          additionalProperties: false,
                        },
                      },
                      required: ["operation", "config"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "web_search_configuration" },
                        config: {
                          type: "object",
                          properties: {
                            engineOrder: {
                              type: "array",
                              minItems: 1,
                              maxItems: 3,
                              uniqueItems: true,
                              items: { type: "string", enum: ["duckduckgo", "bing", "google"] },
                              description: "Native search engines in order; the first is the default.",
                            },
                          },
                          required: ["engineOrder"],
                          additionalProperties: false,
                        },
                      },
                      required: ["operation", "config"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "mesh_configuration" },
                        config: {
                          type: "object",
                          minProperties: 1,
                          properties: {
                            enabled: { type: "boolean" },
                            mode: { type: "string", enum: ["lan", "wan", "tailnet"] },
                            nodeId: { type: "string", minLength: 1, maxLength: 256 },
                            mdns: { type: "boolean" },
                            staticPeers: {
                              type: "array",
                              maxItems: 64,
                              items: { type: "string", minLength: 1, maxLength: 2_048 },
                            },
                            requireMtls: { type: "boolean" },
                            tailnetEnabled: { type: "boolean" },
                          },
                          additionalProperties: false,
                        },
                      },
                      required: ["operation", "config"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "npu_configuration" },
                        config: {
                          type: "object",
                          minProperties: 1,
                          properties: {
                            enabled: { type: "boolean" },
                            autoStart: { type: "boolean" },
                            sidecarUrl: { type: "string", format: "uri", maxLength: 2_048 },
                          },
                          additionalProperties: false,
                        },
                      },
                      required: ["operation", "config"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "llama_cpp_configuration" },
                        config: {
                          type: "object",
                          minProperties: 1,
                          properties: {
                            enabled: { type: "boolean" },
                            autoStart: { type: "boolean" },
                            baseUrl: { type: "string", format: "uri", maxLength: 2_048 },
                            alias: { type: "string", minLength: 1, maxLength: 256 },
                            ctxSize: { type: ["integer", "null"], minimum: 1, maximum: 2_000_000 },
                            threads: { type: ["integer", "null"], minimum: 1, maximum: 2_000_000 },
                            gpuLayers: { type: ["integer", "null"], minimum: 0, maximum: 2_000_000 },
                            parallel: { type: ["integer", "null"], minimum: 1, maximum: 2_000_000 },
                            batchSize: { type: ["integer", "null"], minimum: 1, maximum: 2_000_000 },
                            ubatchSize: { type: ["integer", "null"], minimum: 1, maximum: 2_000_000 },
                            flashAttention: { type: ["boolean", "null"] },
                          },
                          additionalProperties: false,
                        },
                      },
                      required: ["operation", "config"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operation: { const: "feature_flag" },
                        flag: {
                          type: "string",
                          enum: CHANGE_PLAN_RUNTIME_FEATURE_FLAGS,
                        },
                        enabled: { type: "boolean" },
                      },
                      required: ["operation", "flag", "enabled"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              required: ["kind", "change"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "channel_connection" },
                channelKind: { type: "string", minLength: 1, maxLength: 256 },
                draftId: { type: "string", minLength: 1, maxLength: 256 },
              },
              required: ["kind", "channelKind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "runtime_remediation" },
                remediationId: { type: "string", minLength: 1, maxLength: 256 },
              },
              required: ["kind", "remediationId"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "capability_candidate" },
                proposalId: { type: "string", minLength: 1, maxLength: 256 },
                action: { type: "string", enum: ["activate", "revoke", "rollback"] },
                versionId: { type: "string", minLength: 1, maxLength: 256 },
              },
              required: ["kind", "proposalId"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "improvement_candidate" },
                candidateId: { type: "string", minLength: 1, maxLength: 256 },
              },
              required: ["kind", "candidateId"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { const: "managed_source_registration" } },
              required: ["kind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "product_source_update" },
                sourceInstallId: { type: "string", minLength: 1, maxLength: 256 },
                changeSummary: { type: "string", minLength: 1, maxLength: 2_000 },
                codeModeRunId: { type: "string", minLength: 1, maxLength: 256 },
              },
              required: ["kind", "sourceInstallId", "changeSummary", "codeModeRunId"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["intent"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    preferredForIntents: [
      "change_configuration",
      "connect_provider",
      "connect_channel",
      "improve_capability",
      "update_product",
    ],
    usageHints: [
      "Use this only to create a Change Plan; tell the operator that Chat will show the exact confirmation action.",
      "Never include credentials, OAuth values, filesystem paths, patches, commands, arbitrary setting keys, or delegated-agent requests.",
    ],
  },
  {
    name: CODE_MODE_REQUEST_TOOL_NAME,
    category: "ops",
    riskLevel: "caution",
    requiresApproval: true,
    description:
      "Ask the operator to run a short script on this computer in a restricted sandbox, then continue with its result. The operator approves every run. The docs.* helpers (capabilities.docs.read_bytes, extract_text, decompress) exist only inside the script; never call them as tools.",
    argSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: 'A plain verb phrase shown to the operator, such as "read the text of saturday-plan.pdf".',
        },
        source: {
          type: "string",
          minLength: 1,
          maxLength: 20_000,
          description:
            "The script body. It reads `input`, may await helpers, and returns the answer. Long documents come back in pages: call again with `offset: nextOffset` while nextOffset is set.",
        },
        language: { type: "string", enum: ["javascript", "typescript"] },
        input: { type: "object", description: "File paths and values the script uses." },
        reads: {
          type: "array",
          maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 1_024 },
          description:
            "Every file path, folder path (for fs.list) and attachment ID the script reads. The operator sees this list, and each helper call must name one of these; with none the script reads no files.",
        },
      },
      required: ["goal", "source"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    codeModeAllowed: false,
    usageHints: [
      "Use only when no available tool can do a step, such as reading a binary file. Put paths and values in `input`, list every file, folder or attachment the script reads in `reads`, return the answer, and keep the script short.",
      "Inside the script call helpers as `await capabilities.docs.extract_text({ path: input.path })`. Each call names its target: fs.read, file.read_range, fs.stat, docs.extract_text or docs.read_bytes on a path listed in `reads` (the docs.* helpers also take a listed attachmentId), and fs.list on a folder listed in `reads`; docs.decompress works on bytes the script already has.",
    ],
  },
  {
    name: "session.status",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    description: "Return basic status for the active session.",
    pack: "core",
  },
  {
    name: "user_input.request",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Ask an optional clarification while independent work continues. Use required-input flows for blockers; never request secrets or approval through this tool.",
    argSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 100 },
        question: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["title", "question"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    usageHints: [
      "Only ask when you can continue useful independent work. Replies arrive at a subsequent model boundary while this turn is active; do not assume a reply or treat one as approval.",
    ],
  },
  {
    name: RUNTIME_CONFIGURE_TOOL_NAME,
    category: "ops",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Request a secure operator-owned configuration flow for an official search provider. Credentials are never accepted as tool arguments.",
    argSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", enum: [...RUNTIME_CONFIGURATION_TARGET_IDS] },
      },
      required: ["targetId"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    preferredForIntents: ["configure_search", "repair_search", "configure_runtime"],
    usageHints: [
      "Use this when official Brave or Parallel search needs configuration or credential repair.",
      "Never ask the operator to paste credentials into Chat; this tool opens a separate secure runtime flow.",
    ],
  },
  {
    name: "notify.request",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: true,
    description:
      "Request operator attention through the canonical notification stream. External delivery is selected only by operator-authored rules; raw destinations are never accepted.",
    argSchema: {
      type: "object",
      properties: {
        eventType: {
          type: "string",
          enum: [
            "turn.completed",
            "turn.failed",
            "turn.blocked",
            "approval.requested",
            "user_input.requested",
            "durable.attention_required",
            "timer.due",
            "scheduled_turn.completed",
            "scheduled_turn.failed",
          ],
        },
        title: { type: "string", minLength: 1, maxLength: 120 },
        message: { type: "string", minLength: 1, maxLength: 4000 },
      },
      required: ["eventType", "title", "message"],
      additionalProperties: false,
    },
    pack: "comms",
    recommendedContexts: ["chat"],
    preferredForIntents: ["request_attention", "notify_operator"],
    usageHints: [
      "Do not provide webhook URLs, credentials, or target ids; Settings rules own destinations.",
      "The tool is governed because an approved rule may cause an external side effect.",
    ],
  },
  {
    name: "document.propose_patch",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Create a reviewable full-replacement proposal for an editable personal note or generated Markdown/text artifact. This never applies the edit.",
    argSchema: {
      type: "object",
      properties: {
        targetKind: { type: "string", enum: ["personal_note", "generated_artifact"] },
        targetId: { type: "string", minLength: 1, maxLength: 256 },
        baseRevision: { type: "integer", minimum: 1 },
        baseContentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        proposedContent: { type: "string", maxLength: 262144 },
      },
      required: ["targetKind", "targetId", "proposedContent"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    preferredForIntents: ["edit_note", "edit_artifact", "propose_document_patch"],
    usageHints: [
      "Use the active document's exact target id and base revision or content hash.",
      "The operator must review and apply the proposal; this tool cannot mutate the target document.",
      "Workspace, session, turn, and assistant provenance are bound by the Gateway and cannot be supplied in arguments.",
    ],
  },
  {
    name: "context.list",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    deterministic: true,
    description:
      "List content-free metadata and admission dispositions for the immutable context snapshot attached to this turn.",
    argSchema: { type: "object", properties: {}, additionalProperties: false },
    pack: "core",
    recommendedContexts: ["chat"],
    preferredForIntents: ["attached_context", "source_inspection"],
    usageHints: ["Available only when the active turn has admitted attached-context text."],
  },
  {
    name: "context.grep",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    deterministic: true,
    description:
      "Find literal text with exact line receipts inside the immutable context snapshot attached to this turn.",
    argSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 512 },
        caseSensitive: { type: "boolean" },
        entryIndex: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    preferredForIntents: ["attached_context", "source_inspection"],
    usageHints: ["Use context.list first when the relevant entry is unknown."],
  },
  {
    name: "context.query",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    deterministic: true,
    description:
      "Retrieve relevant lines from the immutable context snapshot attached to this turn without consulting global knowledge.",
    argSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512 },
        entryIndex: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    preferredForIntents: ["attached_context", "source_inspection"],
    usageHints: ["Results are ephemeral and scoped to this turn's frozen snapshot."],
  },
  {
    name: "context.read_range",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    deterministic: true,
    description:
      "Read a bounded 1-based line range from one admitted entry in the immutable context snapshot attached to this turn.",
    argSchema: {
      type: "object",
      properties: {
        entryIndex: { type: "integer", minimum: 0 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["entryIndex", "startLine", "endLine"],
      additionalProperties: false,
    },
    pack: "core",
    recommendedContexts: ["chat"],
    preferredForIntents: ["attached_context", "source_inspection"],
    usageHints: ["Use exact entry indexes and line ranges returned by context.list, context.grep, or context.query."],
  },
  {
    name: "session.search",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Full-text search over past messages in this conversation's history (tier-2 recall). Use to pull older context that is no longer in the active window.",
    argSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 512 },
        scope: { type: "string", enum: ["session", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        contextRadius: { type: "integer", minimum: 0, maximum: 10 },
      },
      required: ["query"],
    },
    examples: [
      {
        title: "Recall what was decided earlier about deployment",
        args: { query: "deployment decision", limit: 5 },
      },
    ],
    pack: "core",
    readOnly: true,
    deterministic: true,
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["recall_history", "memory_lookup"],
    usageHints: [
      "Use when the user references something from earlier in the conversation that you can no longer see.",
      "Defaults to this session; scope:'all' remains confined to the active workspace.",
    ],
  },
  {
    name: SUBMIT_WORK_RESULT_TOOL_NAME,
    category: "session",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Submit a typed delegated-work result, including an approval-gated request for additional filesystem scope when the current scope is insufficient.",
    argSchema: {
      type: "object",
      properties: {
        disposition: { type: "string", enum: ["completed", "blocked", "scope_expansion"] },
        summary: { type: "string", maxLength: 8_000 },
        changedFiles: { type: "array", maxItems: 1_000, items: { type: "string" } },
        evidenceRefs: {
          type: "array",
          maxItems: 1_000,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
            pattern: "^[^\\u0000-\\u001f\\u007f]+$",
          },
        },
        scopeExpansion: {
          type: "object",
          properties: {
            requestedPaths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
            reason: { type: "string", maxLength: 2_000 },
          },
          required: ["requestedPaths", "reason"],
        },
      },
      required: ["disposition", "summary", "changedFiles", "evidenceRefs"],
    },
    pack: "core",
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["code", "project_bound"],
    preferredForIntents: ["delegation", "implementation"],
    usageHints: [
      "Use once when delegated filesystem/code work completes or is blocked.",
      "A scope_expansion request records requested paths but never grants access; wait for operator approval.",
    ],
  },
  {
    name: "session.history",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Reopen bounded transcript context around an exact workspace-authorized message and sequence returned by session.search.",
    argSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        messageId: { type: "string" },
        sequence: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 101 },
      },
      required: ["messageId", "sequence"],
    },
    examples: [
      {
        title: "Reopen context around a search hit",
        args: { sessionId: "session-id-from-search", messageId: "message-id-from-search", sequence: 42, limit: 21 },
      },
    ],
    pack: "core",
    readOnly: true,
    deterministic: true,
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["recall_history", "memory_lookup"],
    usageHints: [
      "Use the exact sessionId, messageId, and sequence returned by session.search.",
      "An unavailable anchor means it was deleted or compacted; do not silently substitute the latest transcript.",
    ],
  },
  {
    name: "memory.read",
    category: "memory",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    description: "Read memory context from local memory sources.",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string" },
        title: { type: "string" },
        key: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_lookup", "project_context"],
    usageHints: [
      "Use when you need to retrieve existing memory context or recent saved notes.",
      "Provide query, title, or key when you want a focused lookup.",
    ],
  },
  {
    name: "time.now",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    description: "Return current local time and UTC time on this host.",
    pack: "core",
  },
  {
    // R3-8 fan-out primitive, part B. Deliberately NOT readOnly: it spawns
    // delegated LLM child turns, so the parallel read-only batch pre-executor
    // must never treat it as side-effect free. Exposure is additionally gated
    // per turn (Chat-normalized mode + subagentPolicy === "auto_when_useful" +
    // kill switch `subagentFanoutV1Disabled`) in the chat orchestrator's tool
    // schema.
    name: SUBAGENT_FANOUT_TOOL_NAME,
    category: "session",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Spawn up to 3 delegated subagents that each work one independent subtask concurrently and return their buffered results as one aggregated payload.",
    argSchema: {
      type: "object",
      properties: {
        subtasks: {
          type: "array",
          minItems: 1,
          maxItems: SUBAGENT_FANOUT_MAX_SUBTASKS,
          items: {
            type: "object",
            properties: {
              objective: {
                type: "string",
                description: "Self-contained objective for one subagent. It cannot see this conversation.",
              },
              label: { type: "string", description: "Short display label for the subtask." },
              expectedOutput: { type: "string", description: "What the subtask should hand back." },
              resultSchema: {
                type: "object",
                description:
                  "Optional bounded JSON Schema for the final child JSON result. Supported types: object, array, string, number, integer, boolean, null. Objects require properties and additionalProperties:false; arrays require maxItems<=128 and items; strings require maxLength<=8192. No refs, patterns or schema combinators.",
              },
            },
            required: ["objective"],
          },
        },
      },
      required: ["subtasks"],
    },
    examples: [
      {
        title: "Fan out three independent research subtasks",
        args: {
          subtasks: [
            {
              objective: "Research vendor A's pricing tiers; report the cheapest plan that includes SSO.",
              label: "Vendor A",
            },
            {
              objective: "Research vendor B's pricing tiers; report the cheapest plan that includes SSO.",
              label: "Vendor B",
            },
            {
              objective: "Research vendor C's pricing tiers; report the cheapest plan that includes SSO.",
              label: "Vendor C",
            },
          ],
        },
      },
    ],
    pack: "core",
    recommendedContexts: ["cowork", "code"],
    preferredForIntents: ["parallel_subtasks", "delegation"],
    usageHints: [
      "Use only for genuinely independent subtasks; sequential or interdependent work belongs in your own turn.",
      "Each subagent starts fresh: give every objective the full context it needs, then synthesize the aggregated results yourself.",
      "Subagents cannot spawn further subagents. The tool is only callable when the session's subagent policy is auto_when_useful; ask_when_useful remains an operator-confirmed suggestion path.",
    ],
  },
  {
    name: "fs.read",
    category: "fs",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Read a file inside allowed read roots.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    examples: [
      {
        title: "Read a project file",
        args: { path: "./apps/gateway/src/services/gateway-service.ts" },
      },
    ],
    pack: "core",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["chat", "cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "read_file"],
    usageHints: [
      "Use for a single whole-file read when you already know the path.",
      "Prefer file.read_range when you only need a focused section.",
    ],
  },
  {
    name: "file.read_range",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Read a specific line range from a file inside allowed read roots.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path", "startLine", "endLine"],
    },
    examples: [
      {
        title: "Read a focused TypeScript range",
        args: {
          path: "./apps/gateway/src/services/chat-turn-agent-runner.ts",
          startLine: 880,
          endLine: 980,
        },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "inspect_code", "targeted_read"],
    usageHints: ["Prefer this over fs.read when you only need a local slice of a file."],
  },
  {
    name: "file.find",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search file contents under an allowed path for a text pattern.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path", "pattern"],
    },
    examples: [
      {
        title: "Find a symbol in one package",
        args: { path: "./apps/gateway/src", pattern: "failureGuidance", limit: 20 },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "search_text", "inspect_code"],
    usageHints: ["Use for recursive text search when you know the directory root."],
  },
  {
    name: "code.search",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search code and config files under an allowed path for a code/text query.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path", "query"],
    },
    examples: [
      {
        title: "Search gateway code for a helper",
        args: { path: "./apps/gateway/src", query: "buildToolFailureFallbackMessage", limit: 20 },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "inspect_code", "search_code"],
    usageHints: ["Prefer this over file.find for code-oriented symbol or helper lookup."],
  },
  {
    name: "code.search_files",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search file and directory names under an allowed path.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path", "query"],
    },
    examples: [
      {
        title: "Find test files for a service",
        args: { path: "./apps/gateway/src", query: "chat-turn-agent-runner", limit: 20 },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "search_files", "inspect_code"],
    usageHints: ["Use when you need candidate file paths before reading contents."],
  },
  {
    name: "fs.write",
    category: "fs",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Write a file inside write jail roots.",
    pack: "core",
  },
  {
    name: "fs.patch",
    category: "fs",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Replace one exact text occurrence in a file inside write jail roots when its SHA-256 still matches.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        expectedSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
      },
      required: ["path", "expectedSha256", "oldText", "newText"],
      additionalProperties: false,
    },
    pack: "core",
  },
  {
    name: "fs.list",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "List files and directories under an allowed path.",
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
  },
  {
    name: "fs.stat",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Read file or directory metadata.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
  },
  {
    name: "fs.copy",
    category: "fs",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Copy file from source to destination inside write jail.",
    pack: "devops",
  },
  {
    name: "fs.move",
    category: "fs",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Move or rename a file inside write jail.",
    pack: "devops",
  },
  {
    name: "fs.delete",
    category: "fs",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Delete a file or directory in write jail.",
    pack: "devops",
  },
  {
    name: "http.get",
    category: "http",
    riskLevel: "caution",
    requiresApproval: false,
    description: "HTTP GET request to allowlisted hosts.",
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["live_data", "fetch_url", "api_lookup"],
    usageHints: ["Prefer for direct URL/API fetches when full browser automation is unnecessary."],
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
      },
      required: ["url"],
    },
    examples: [
      {
        title: "Fetch an allowlisted JSON endpoint",
        args: { url: "https://example.com/api/status" },
      },
    ],
  },
  {
    name: "http.post",
    category: "http",
    riskLevel: "danger",
    requiresApproval: true,
    description: "HTTP POST request to allowlisted hosts.",
    pack: "core",
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        body: { type: "object" },
      },
      required: ["url"],
    },
    examples: [
      {
        title: "POST JSON to an allowlisted endpoint",
        args: { url: "https://example.com/api/search", body: { query: "latest status" } },
      },
    ],
  },
  {
    name: "shell.exec",
    category: "shell",
    riskLevel: "danger",
    requiresApproval: true,
    description:
      "Run one program with its arguments, with policy gating. No shell is started: pipes, ;, &&, redirection, variables and multi-line scripts are rejected.",
    argSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'One program and its arguments, for example "node --version". For a script, invoke a shell explicitly: pwsh -NoProfile -Command "<script>" or sh -c "<script>".',
        },
        cwd: { type: "string" },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 900000,
          description:
            "Foreground time limit; defaults to 20000 ms. Use an explicit bounded limit for coding agents or long verification runs.",
        },
      },
      required: ["command"],
    },
    examples: [
      {
        title: "Run a targeted test command",
        args: { command: "pnpm --filter @goatcitadel/gateway test -- src/routes/chat.routes.test.ts" },
      },
    ],
    pack: "core",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["run_command", "verify_change", "project_task"],
    usageHints: [
      "Use for foreground commands where captured stdout/stderr matters. For OpenCode use the opencode skill, run --format json, and an explicit timeoutMs.",
    ],
  },
  {
    name: "shell.exec_background",
    category: "shell",
    riskLevel: "danger",
    requiresApproval: true,
    description:
      "Start one program in the background and return its process details. No shell is started: pipes, ;, &&, redirection, variables and multi-line scripts are rejected.",
    argSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'One program and its arguments, for example "pnpm dev". For a script, invoke a shell explicitly: pwsh -NoProfile -Command "<script>" or sh -c "<script>".',
        },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
    examples: [
      {
        title: "Start the local dev server in the background",
        args: { command: "pnpm dev", cwd: "./apps/mission-control-next" },
      },
    ],
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["background_process", "long_running_command", "project_task"],
    usageHints: [
      "Use for long-running dev servers or watchers that should not block the turn. For a one-off command whose result you need, such as a file conversion, use shell.exec so you see its exit code and output.",
    ],
  },
  {
    name: "git.status",
    category: "git",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Get repository status summary.",
    pack: "devops",
  },
  {
    name: "git.diff",
    category: "git",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Get repository diff summary.",
    pack: "devops",
  },
  {
    name: "git.add",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Stage files by path.",
    pack: "devops",
  },
  {
    name: "git.commit",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Create git commit from staged changes.",
    pack: "devops",
  },
  {
    name: "git.branch.create",
    category: "git",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Create a new git branch.",
    pack: "devops",
  },
  {
    name: "git.branch.switch",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Switch git branch.",
    pack: "devops",
  },
  {
    name: "git.worktree.create",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Create git worktree at target path.",
    pack: "devops",
  },
  {
    name: "git.worktree.remove",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Remove git worktree at target path.",
    pack: "devops",
  },
  {
    name: "tests.run",
    category: "ops",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Run the project's `test` package script (`pnpm run test` or `npm run test`) in the workspace or `cwd`. Takes no command: it cannot run a file or arbitrary script, and fails when the project has no `test` script.",
    argSchema: RESTRICTED_PACKAGE_SCRIPT_ARG_SCHEMA,
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["verify_change", "run_tests"],
    usageHints: ["Prefer this over shell.exec when you specifically want a test run."],
  },
  {
    name: "lint.run",
    category: "ops",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Run the project's `lint` package script (`pnpm run lint` or `npm run lint`) in the workspace or `cwd`. Takes no command: it cannot run a file or arbitrary script, and fails when the project has no `lint` script.",
    argSchema: RESTRICTED_PACKAGE_SCRIPT_ARG_SCHEMA,
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["verify_change", "lint"],
    usageHints: ["Prefer this over shell.exec for lint-only validation."],
  },
  {
    name: "build.run",
    category: "ops",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Run the project's `build` package script (`pnpm run build` or `npm run build`) in the workspace or `cwd`. Takes no command: it cannot run a file or arbitrary script, and fails when the project has no `build` script.",
    argSchema: RESTRICTED_PACKAGE_SCRIPT_ARG_SCHEMA,
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["verify_change", "build"],
    usageHints: ["Prefer this over shell.exec for build verification."],
  },
  {
    name: "browser.search",
    category: "research",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Search the web through governed browser or official US/global-English provider execution.",
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["live_data", "web_lookup", "research"],
    usageHints: [
      "Use to discover candidate sources before navigating to a page.",
      "Set backend=official to search with Brave or Parallel (needs a configured key); otherwise native search or Firecrawl is used.",
    ],
    argSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
        backend: { type: "string", enum: ["native", "firecrawl", "official"] },
        mode: { type: "string", enum: ["quick", "research"] },
        providers: { type: "array", items: { type: "string", enum: ["brave", "parallel"] }, maxItems: 2 },
        freshness: { type: "string", enum: ["any", "day", "week", "month"] },
      },
      required: ["query"],
    },
    examples: [
      {
        title: "Search for authoritative sources before extracting",
        args: { query: "OpenAI background mode docs", maxResults: 5, backend: "firecrawl" },
      },
      {
        title: "Search official providers for current primary sources",
        args: { query: "OpenTelemetry specification updates", maxResults: 5, backend: "official", mode: "quick" },
      },
    ],
  },
  {
    name: "browser.navigate",
    category: "research",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Navigate to page and extract page text.",
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["web_lookup", "fetch_url", "research"],
    usageHints: ["Use when you already have a specific page URL to inspect."],
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        maxChars: { type: "integer", minimum: 200, maximum: 20000 },
        backend: { type: "string", enum: ["native", "firecrawl"] },
      },
      required: ["url"],
    },
    examples: [
      {
        title: "Read a known documentation page",
        args: { url: "https://example.com/docs/guide", maxChars: 12000, backend: "firecrawl" },
      },
    ],
  },
  {
    name: "browser.extract",
    category: "research",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Extract text from selected CSS selector.",
    pack: "core",
    recommendedContexts: ["cowork", "code"],
    preferredForIntents: ["web_extract", "research"],
    usageHints: ["Use for targeted extraction when a generic page read is too noisy."],
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        selector: { type: "string" },
        maxChars: { type: "integer", minimum: 200, maximum: 50000 },
        backend: { type: "string", enum: ["native", "firecrawl"] },
      },
      required: ["url", "selector"],
    },
    examples: [
      {
        title: "Extract a specific results panel",
        args: { url: "https://example.com/results", selector: "main article", maxChars: 8000, backend: "firecrawl" },
      },
    ],
  },
  {
    name: "local_business.research",
    category: "research",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Build a structured, source-backed local business contact research plan, evidence summary, verification status, and blockers.",
    pack: "core",
    readOnly: true,
    deterministic: true,
    recommendedContexts: ["cowork"],
    preferredForIntents: ["local_business_research", "contact_research", "research"],
    usageHints: [
      "Use for local-business contact discovery tasks that need candidate, source, email, contact-name, and blocker state.",
      "Treat public official/contact/about/profile sources as evidence and blocked listings as secondary leads only.",
    ],
    argSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        location: { type: "string" },
        radiusMiles: { type: "number", minimum: 1, maximum: 250 },
        categories: { type: "array", items: { type: "string" } },
        requiredContactFields: { type: "array", items: { type: "string", enum: ["email", "contact_name"] } },
        citations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
            },
            required: ["url"],
          },
        },
      },
      required: ["objective"],
    },
    examples: [
      {
        title: "Research local tabletop game stores",
        args: {
          objective:
            "Locate boardgame/tabletop game stores within 10 miles of 91303 and find public email/contact-name evidence.",
          location: "91303",
          radiusMiles: 10,
          categories: ["board game and tabletop game store"],
          requiredContactFields: ["email", "contact_name"],
        },
      },
    ],
  },
  {
    name: "browser.screenshot",
    category: "research",
    riskLevel: "danger",
    requiresApproval: false,
    description: "Capture screenshot into jailed output path.",
    pack: "core",
  },
  {
    name: "browser.interact",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description:
      "Perform approved click, type, press, wait_for_selector, or wait steps. Use browser.extract or browser.navigate for read-only page text; snapshot is not a supported step.",
    pack: "core",
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["click", "type", "press", "wait_for_selector", "wait"] },
              selector: { type: "string", description: "Required for click, type, and wait_for_selector." },
              text: { type: "string", description: "Required non-empty text for type." },
              key: { type: "string", description: "Key for press; defaults to Enter." },
              timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
            },
            required: ["action"],
          },
        },
        finalSelector: { type: "string" },
        maxChars: { type: "integer", minimum: 200, maximum: 30000 },
        outputPath: { type: "string", description: "Optional screenshot path inside the write jail." },
        fullPage: { type: "boolean" },
      },
      required: ["url", "steps"],
    },
  },
  {
    name: "browser.cookies.get",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Read browser cookies from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.cookies.set",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Write browser cookies into the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.cookies.clear",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Clear browser cookies from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.storage.get",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Read localStorage/sessionStorage from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.storage.set",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Write localStorage/sessionStorage into the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.storage.clear",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Clear localStorage/sessionStorage from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.context.configure",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description:
      "Configure locale, timezone, headers, credentials, and geolocation for the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "mcp.invoke",
    category: "ops",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Invoke a managed MCP tool through policy-gated execution.",
    argSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["serverId", "toolName"],
    },
    pack: "core",
  },
  {
    name: "schedule.manage",
    category: "ops",
    riskLevel: "danger",
    requiresApproval: true,
    description:
      "Create, list, or cancel the agent's own scheduled work (an agent_turn cron job that wakes the agent on a recurring schedule). Creating or cancelling a schedule requires approval.",
    argSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["create", "list", "cancel"] },
        jobId: { type: "string", description: "Target job id for the cancel op (or the explicit id for create)." },
        name: { type: "string", description: "Human-readable name for a created schedule." },
        schedule: {
          type: "string",
          description: "Cron-style schedule, e.g. '0 9 * * 1' (every Monday 09:00). Must not be finer than 15 minutes.",
        },
        prompt: {
          type: "string",
          description: "The instruction the scheduled turn wakes the agent with.",
        },
        deliveryChannel: {
          type: "object",
          properties: {
            channelKey: { type: "string" },
            target: { type: "string" },
          },
        },
        endAt: { type: "string", description: "Optional ISO date/time after which the schedule stops firing." },
      },
      required: ["op"],
    },
    examples: [
      {
        title: "List the agent's own scheduled jobs",
        args: { op: "list" },
      },
      {
        title: "Schedule a recurring morning briefing",
        args: {
          op: "create",
          name: "Morning briefing",
          schedule: "0 9 * * 1-5",
          prompt: "Summarize overnight updates and surface anything that needs my attention.",
        },
      },
      {
        title: "Cancel a scheduled job",
        args: { op: "cancel", jobId: "morning-briefing" },
      },
    ],
    pack: "core",
    recommendedContexts: ["chat", "cowork"],
    preferredForIntents: ["schedule_work", "recurring_task", "remind_me", "self_schedule"],
    usageHints: [
      "Use to set up, review, or cancel the agent's own recurring scheduled turns.",
      "Creating or cancelling a schedule is a governed action and requires operator approval.",
    ],
  },
  {
    name: "citations.build",
    category: "research",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Build citation bundle from gathered sources.",
    argSchema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              citationId: { type: "string", minLength: 1 },
              title: { type: "string" },
              url: { type: "string", minLength: 1 },
              snippet: { type: "string" },
              description: { type: "string" },
              sourceType: { type: "string", minLength: 1 },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
      },
      required: ["sources"],
      additionalProperties: false,
    },
    pack: "core",
  },
  {
    name: "memory.write",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Write structured memory note into knowledge index.",
    pack: "knowledge",
    argSchema: MEMORY_WRITE_ARG_SCHEMA,
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_persist"],
    usageHints: ["Use only when the user explicitly asks to save or remember something."],
  },
  {
    name: "memory.upsert",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Upsert structured memory note by deterministic key.",
    pack: "knowledge",
    argSchema: MEMORY_WRITE_ARG_SCHEMA,
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_persist"],
  },
  {
    name: "memory.search",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search indexed memory and return ranked snippets.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_lookup", "project_context"],
    usageHints: ["Use before re-asking the same project or user-context question."],
  },
  {
    name: "docs.ingest",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Ingest file/url/text documents into normalized knowledge chunks with TTL-aware caching.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        sourceType: { type: "string", enum: ["file", "url", "text"] },
        source: { type: "string" },
        namespace: { type: "string" },
        title: { type: "string" },
        backend: { type: "string", enum: ["native", "firecrawl"] },
        cacheTtlSeconds: { type: "integer", minimum: 0 },
        forceRefresh: { type: "boolean" },
      },
      required: ["sourceType", "source", "namespace"],
    },
  },
  {
    name: "docs.read_bytes",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Read a file or chat attachment as base64 bytes for Code Mode runs, up to 64 KiB per call. Page with offset and length; nextOffset is set while bytes remain. Provide exactly one of path or attachmentId.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        attachmentId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1, maximum: 65_536 },
      },
      additionalProperties: false,
    },
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: [],
  },
  {
    name: "docs.extract_text",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Extract plain text from a PDF, DOCX or text file or chat attachment for Code Mode runs, up to 60000 characters (and 96 KiB) per call. Page with offset (characters); nextOffset is set while text remains. Provide exactly one of path or attachmentId.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        attachmentId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 60_000 },
      },
      additionalProperties: false,
    },
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: [],
  },
  {
    name: "docs.decompress",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Decompress base64 gzip, deflate, raw-deflate or brotli data for Code Mode runs, with a hard output cap of 64 KiB.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        base64: { type: "string", minLength: 1 },
        format: { type: "string", enum: ["gzip", "deflate", "raw-deflate", "brotli"] },
        maxOutputBytes: { type: "integer", minimum: 1, maximum: 65_536 },
      },
      required: ["base64", "format"],
      additionalProperties: false,
    },
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: [],
  },
  {
    name: "docs.search",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search normalized ingested context and return attributed chunks.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "embeddings.index",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Generate/update embeddings for knowledge chunks.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        documentId: { type: "string" },
        force: { type: "boolean" },
        embeddingProfile: {
          type: "object",
          properties: {
            provider: { type: "string" },
            modelId: { type: "string" },
            dimensions: { type: "integer", minimum: 1 },
            profileId: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "embeddings.query",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search chunks by vector similarity with lexical fallback.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        embeddingProfile: {
          type: "object",
          properties: {
            provider: { type: "string" },
            modelId: { type: "string" },
            dimensions: { type: "integer", minimum: 1 },
            profileId: { type: "string" },
          },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "artifacts.create",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Create artifact file from template into workspace.",
    pack: "knowledge",
  },
  {
    name: "documents.create",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Create a real document artifact in a jailed workspace path.",
    argSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Output path for the document. Supported extensions include .md, .txt, .html, .json, .csv, .docx, and .pdf.",
        },
        format: {
          type: "string",
          enum: ["markdown", "md", "txt", "html", "json", "csv", "docx", "pdf"],
        },
        title: { type: "string" },
        body: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
            },
          },
        },
        rows: { type: "array" },
        html: {
          type: "string",
          description:
            "Optional complete HTML document (<!doctype html> … </html>) written verbatim for format html, at most 512 KiB. Honored only with a governed design receipt (impeccable or design-intelligence); otherwise the renderer template is used.",
        },
        design: ARTIFACT_DESIGN_ARG_SCHEMA,
        destination: ARTIFACT_DESTINATION_ARG_SCHEMA,
      },
      required: ["path", "title"],
    },
    examples: [
      {
        title: "Create a Word document",
        args: {
          path: "./workspace/artifacts/free-time-report.docx",
          format: "docx",
          title: "Free Time Report",
          sections: [
            {
              heading: "Recommended Activities",
              bullets: ["Read", "Walk", "Cook something new"],
            },
          ],
        },
      },
    ],
    pack: "knowledge",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["document_generation", "artifact_output", "report", "pdf", "docx", "markdown"],
    usageHints: [
      "Use when the user asks for a real document file such as DOCX, PDF, HTML, Markdown, text, JSON, or CSV.",
      "Do not satisfy a requested document artifact with text-only prose when this tool is available.",
      "Use design.mode minimal or plain for raw data, logs, JSON, CSV, code, or explicitly plain outputs.",
      "For non-plain DOCX, PDF, HTML, reports, briefs, and handouts, set design.skillId to impeccable so Design Quality V1 is reflected in the artifact design report.",
      "Keep renderer provenance in the design report rather than visible document body copy unless the user explicitly asks for an evidence appendix.",
      "For format html under a design receipt, you may author the whole page yourself in the html argument; the design report records markup: model-authored and the artifact can be rendered to PNG evidence from Chat.",
      "A non-plain PDF renders as a portrait report in the design colors (design.preset, or design.brand.colors with the first color as the accent): a colored cover band, the summary in a callout box, accented section headings, marked bullets, and rows (an array of objects with the same keys) as a table after the sections. Put tabular data in rows, not in section text; keep each bullet to a sentence or two (over 1200 characters is cut), and if the result has warnings, text was cut: split it and write again. It embeds no photos or custom fonts; for slide-style visuals with provider images, use presentations.create with format pdf.",
      "Describe the result from designReport.layouts, which lists only what the renderer drew, and from designReport.validation; do not claim a design skill was applied when design-skill-applied is a warning.",
    ],
  },
  {
    name: "presentations.create",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Create a real slide deck in a jailed workspace path: a PowerPoint .pptx (default) or a deck-style PDF with one landscape page per slide.",
    argSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Output path for the deck file (.pptx, or .pdf when format is pdf). Use a safe workspace or artifacts path when none is provided.",
        },
        format: {
          type: "string",
          enum: ["pptx", "pdf"],
          description:
            "Deck file format. Use pdf when the user wants the slides saved or exported as a PDF; defaults to pptx (or pdf for a .pdf path).",
        },
        title: { type: "string" },
        subtitle: { type: "string" },
        slides: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: {
                type: "array",
                maxItems: 24,
                items: {
                  oneOf: [
                    { type: "string", maxLength: 240 },
                    {
                      type: "object",
                      properties: {
                        text: { type: "string", maxLength: 240 },
                        claimKind: { type: "string", enum: ["fact", "analysis", "recommendation"] },
                        sourceIds: { type: "array", items: { type: "string" }, uniqueItems: true },
                      },
                      required: ["text"],
                    },
                  ],
                },
              },
              archetype: {
                type: "string",
                enum: ["auto", "narrative", "comparison", "matrix", "chart", "section", "sources", "closing"],
              },
              table: {
                type: "object",
                properties: {
                  headers: {
                    type: "array",
                    minItems: 1,
                    items: {
                      oneOf: [
                        { type: "string" },
                        {
                          type: "object",
                          properties: {
                            text: { type: "string" },
                            sourceIds: { type: "array", items: { type: "string" }, uniqueItems: true },
                          },
                          required: ["text"],
                        },
                      ],
                    },
                  },
                  rows: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "array",
                      minItems: 1,
                      items: {
                        oneOf: [
                          { type: "string" },
                          {
                            type: "object",
                            properties: {
                              text: { type: "string" },
                              sourceIds: { type: "array", items: { type: "string" }, uniqueItems: true },
                            },
                            required: ["text"],
                          },
                        ],
                      },
                    },
                  },
                },
                required: ["headers", "rows"],
              },
              chart: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["bar", "column", "line"] },
                  categories: { type: "array", minItems: 1, items: { type: "string" } },
                  series: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        values: { type: "array", minItems: 1, items: { type: "number" } },
                        sourceIds: { type: "array", items: { type: "string" }, uniqueItems: true },
                      },
                      required: ["name", "values"],
                    },
                  },
                  sourceIds: { type: "array", items: { type: "string" }, uniqueItems: true },
                },
                required: ["type", "categories", "series"],
              },
              visualBrief: {
                type: "string",
                description: "Optional subject-specific direction for a generated visual on this slide.",
              },
            },
            required: ["title"],
          },
        },
        research: {
          type: "object",
          properties: {
            asOfDate: { type: "string" },
            geography: { type: "string" },
            physicalDigitalBoundary: { type: "string" },
            inclusionCriteria: { type: "array", minItems: 1, items: { type: "string" } },
            exclusions: { type: "array", minItems: 1, items: { type: "string" } },
            methodology: { type: "array", minItems: 1, items: { type: "string" } },
            limitations: { type: "array", minItems: 1, items: { type: "string" } },
            competitors: { type: "array", minItems: 1, items: { type: "string" } },
            comparisonCriteria: { type: "array", minItems: 1, items: { type: "string" } },
          },
          required: [
            "asOfDate",
            "geography",
            "physicalDigitalBoundary",
            "inclusionCriteria",
            "exclusions",
            "methodology",
            "limitations",
            "competitors",
            "comparisonCriteria",
          ],
        },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              url: { type: "string", pattern: "^https://", maxLength: 480 },
              publisher: { type: "string" },
              publishedAt: { type: "string" },
              retrievedAt: { type: "string" },
              role: {
                type: "string",
                enum: ["official", "independent", "retailer", "marketplace", "financial", "event", "other"],
              },
              domain: { type: "string" },
              snippet: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              toolRunId: { type: "string" },
              toolName: { type: "string" },
              query: { type: "string" },
            },
            required: ["title", "url", "publisher", "role"],
          },
        },
        theme: { type: "string" },
        design: ARTIFACT_DESIGN_ARG_SCHEMA,
        visualAsset: {
          type: "object",
          description:
            "Optional generated supporting image for the deck. Prefer gateway-generated image assets with source/model provenance.",
          properties: {
            bytesBase64: { type: "string" },
            b64Json: { type: "string" },
            dataBase64: { type: "string" },
            mimeType: { type: "string" },
            altText: { type: "string" },
            source: { type: "string" },
            sourceModel: { type: "string" },
            revisedPrompt: { type: "string" },
          },
        },
        destination: ARTIFACT_DESTINATION_ARG_SCHEMA,
      },
      required: ["path", "title", "slides"],
    },
    examples: [
      {
        title: "Create a PowerPoint deck",
        args: {
          path: "./workspace/artifacts/free-time-activities.pptx",
          title: "Top Things To Do In Free Time",
          slides: [
            {
              title: "Go Outside",
              bullets: ["Pick a nearby park or trail.", "Keep the plan lightweight and repeatable."],
            },
          ],
        },
      },
      {
        title: "Create a slide deck saved as a PDF",
        args: {
          path: "./workspace/artifacts/weekend-plans.pdf",
          format: "pdf",
          title: "Weekend Plans",
          slides: [
            {
              title: "Saturday Evening",
              bullets: ["Catch the outdoor movie at the park.", "Grab dinner nearby before the 7 PM showing."],
            },
          ],
        },
      },
    ],
    pack: "knowledge",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["presentation", "slide_deck", "powerpoint", "artifact_output", "document_generation"],
    usageHints: [
      "Use when the user asks for PowerPoint, PPTX, slides, a slide deck, or a presentation file.",
      'When the user wants the deck saved or exported as a PDF ("deck style, saved as a PDF"), use this tool with format "pdf" and a .pdf path instead of documents.create, so the PDF keeps the slide design. PDF decks use standard Latin fonts; use pptx for non-Latin-script content.',
      "Do not satisfy a requested PowerPoint by returning markdown-only slide text unless this tool is unavailable or blocked.",
      "Use design.mode polished or design.preset when the user asks for a visually appealing deck.",
      "Set design.skillId to impeccable for non-plain decks so Design Quality V1 checks asset specificity, layout integrity, and placeholder/provenance cleanup.",
      "Prefer provider-generated visuals with provenance when available; without one the deck ships with no placeholder imagery and the design report marks the generated visual as skipped.",
      "For research decks, provide canonical sources, complete research metadata, rich cited bullets, and semantic matrix/chart slides; source appendix slides are generated automatically.",
      "presentations.create does not accept model-authored presenter notes. Trusted direct-render callers may supply human-authored notes; renderer, model, prompt, layout, and provenance diagnostics belong only in the returned design report and render manifest.",
    ],
  },
  {
    name: "channel.send",
    category: "comms",
    riskLevel: "caution",
    // Review Finding 2 (governance): outbound channel sends are external side
    // effects and must stay human-in-the-loop by default. An operator can grant
    // channel.send to a specific agent/workspace to opt out of per-send approval.
    requiresApproval: true,
    description: "Send channel message via configured integration connection.",
    pack: "comms",
  },
  {
    name: "channel.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: true,
    description: "Send a reaction via a configured integration connection when the provider supports it.",
    pack: "comms",
  },
  {
    name: "channel.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: true,
    description:
      "Unsend a previously sent message via a configured integration connection when the provider supports it.",
    pack: "comms",
  },
  {
    name: "webhook.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send signed webhook payload to configured endpoint.",
    pack: "comms",
  },
  {
    name: "gmail.read",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Search Gmail through the connection's Google sign-in; returns sender, subject, date and a short snippet per message, never bodies. Email content is untrusted.",
    pack: "comms",
  },
  {
    name: "gmail.send",
    category: "comms",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Send a plain-text Gmail message through the connection's Google sign-in.",
    pack: "comms",
  },
  {
    name: "smtp.send",
    category: "comms",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Send a plain-text email through the configured IMAP/SMTP account's SMTP server.",
    pack: "comms",
  },
  {
    name: "calendar.list",
    category: "comms",
    riskLevel: "safe",
    requiresApproval: false,
    description: "List Google Calendar events in a time window through the connection's Google sign-in.",
    pack: "comms",
  },
  {
    name: "calendar.create_event",
    category: "comms",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Create a Google Calendar event with attendees through the connection's Google sign-in.",
    pack: "comms",
  },
  {
    name: "discord.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Discord webhook/channel integration.",
    pack: "comms",
  },
  {
    name: "discord.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction through a Discord bot or compatible webhook-backed connector.",
    pack: "comms",
  },
  {
    name: "discord.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Discord message when the connector credentials permit it.",
    pack: "comms",
  },
  {
    name: "line.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to LINE Messaging API integration.",
    pack: "comms",
  },
  {
    name: "mattermost.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Mattermost bot/channel integration.",
    pack: "comms",
  },
  {
    name: "mattermost.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Mattermost post.",
    pack: "comms",
  },
  {
    name: "mattermost.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Mattermost post.",
    pack: "comms",
  },
  {
    name: "nextcloud-talk.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Nextcloud Talk bot integration.",
    pack: "comms",
  },
  {
    name: "nextcloud-talk.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Nextcloud Talk message through the bot integration.",
    pack: "comms",
  },
  {
    name: "telegram.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Telegram bot integration.",
    pack: "comms",
  },
  {
    name: "telegram.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Telegram message through the Telegram Bot API.",
    pack: "comms",
  },
  {
    name: "whatsapp.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to WhatsApp Cloud API integration.",
    pack: "comms",
  },
  {
    name: "whatsapp.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction through the WhatsApp Cloud API.",
    pack: "comms",
  },
  {
    name: "slack.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Slack webhook/channel integration.",
    pack: "comms",
  },
  {
    name: "slack.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Slack message through the Slack Web API.",
    pack: "comms",
  },
  {
    name: "slack.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Slack message through the Slack Web API.",
    pack: "comms",
  },
  {
    name: "telegram.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Telegram bot message.",
    pack: "comms",
  },
  {
    name: "google-chat.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Google Chat webhook integration.",
    pack: "comms",
  },
  {
    name: "teams.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Microsoft Teams webhook integration.",
    pack: "comms",
  },
  {
    name: "zalo.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Zalo OA bot integration.",
    pack: "comms",
  },
];

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  public constructor(initial: ToolDefinition[] = BUILTIN_TOOLS) {
    for (const tool of initial) {
      this.byName.set(tool.name, tool);
    }
  }

  public get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  public list(): ToolDefinition[] {
    return [...this.byName.values()];
  }

  public toCatalog(): ToolCatalogEntry[] {
    return this.list().map((tool) => ({
      toolName: tool.name,
      category: tool.category,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      description: tool.description,
      argSchema: tool.argSchema ?? {},
      examples: tool.examples ?? [],
      pack: tool.pack,
      recommendedContexts: tool.recommendedContexts,
      preferredForIntents: tool.preferredForIntents,
      usageHints: tool.usageHints,
      readOnly: tool.readOnly,
      deterministic: tool.deterministic,
      codeModeAllowed: tool.codeModeAllowed,
    }));
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(BUILTIN_TOOLS);
}

let readOnlyBuiltinToolNames: ReadonlySet<string> | undefined;

/**
 * Builtin tools that are safe to execute concurrently within one model turn:
 * declared read-only, never approval-gated at the definition level, and
 * risk-classified safe. Callers still run full per-call policy evaluation —
 * this set only decides whether calls may OVERLAP, never whether they run.
 */
export function listReadOnlyBuiltinToolNames(): ReadonlySet<string> {
  if (!readOnlyBuiltinToolNames) {
    readOnlyBuiltinToolNames = new Set(
      BUILTIN_TOOLS.filter(
        (tool) => tool.readOnly === true && tool.requiresApproval === false && tool.riskLevel === "safe",
      ).map((tool) => tool.name),
    );
  }
  return readOnlyBuiltinToolNames;
}
