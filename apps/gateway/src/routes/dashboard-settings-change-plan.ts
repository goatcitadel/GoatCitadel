import {
  CHANGE_PLAN_RUNTIME_FEATURE_FLAGS,
  ValidationError,
  checkPublicWebAddress,
  type ChangePlanRequest,
} from "@goatcitadel/contracts";

type RuntimeChange = Extract<ChangePlanRequest, { kind: "runtime_configuration" }>["change"];
type RuntimeChangeFor<Operation extends RuntimeChange["operation"]> = Extract<RuntimeChange, { operation: Operation }>;
type ProviderProfile = NonNullable<Extract<ChangePlanRequest, { kind: "provider_connection" }>["profile"]>;

/**
 * Validated by `updateSettingsSchema` before this compatibility projection is
 * reached. Keeping the shape local prevents Settings routes from becoming a
 * second mutation authority.
 */
export interface SettingsChangePlanInput {
  readonly expectedRevision: number;
  readonly toolApprovalMode?: RuntimeChangeFor<"tool_approval_mode">["mode"];
  readonly budgetMode?: RuntimeChangeFor<"budget_mode">["mode"];
  readonly deploymentProfile?: RuntimeChangeFor<"deployment_profile">["profile"];
  readonly readAccessMode?: RuntimeChangeFor<"read_access_policy">["mode"];
  readonly outsideRootWriteMode?: RuntimeChangeFor<"outside_root_write_policy">["mode"];
  readonly networkAllowlist?: readonly string[];
  /** `null` clears the address. */
  readonly publicWebAddress?: string | null;
  readonly operatorWriteRootChange?: Omit<RuntimeChangeFor<"operator_write_root">, "operation">;
  readonly globalToolAccessChange?: Omit<RuntimeChangeFor<"tool_global_access">, "operation">;
  readonly toolGroupChange?: Omit<RuntimeChangeFor<"tool_group_access">, "operation">;
  readonly llm?: {
    readonly activeProviderId?: string;
    readonly activeModel?: string;
    readonly defaultThinkingLevel?: Extract<ChangePlanRequest, { kind: "installation_default_model" }>["thinkingLevel"];
    readonly utilityProviderId?: string;
    readonly utilityModel?: string;
    readonly upsertProvider?: {
      readonly providerId: string;
      readonly label?: string;
      readonly baseUrl?: string;
      readonly apiStyle?: ProviderProfile["apiStyle"];
      readonly authMode?: ProviderProfile["authMode"];
      readonly defaultModel?: string;
      readonly apiKey?: string;
      readonly apiKeyEnv?: string;
      readonly googleCloud?: ProviderProfile["googleCloud"];
      readonly request?: unknown;
      readonly headers?: unknown;
      readonly capabilities?: ProviderProfile["capabilities"];
    };
  };
  readonly memory?: RuntimeChangeFor<"memory_configuration">["config"];
  readonly web?: {
    readonly firecrawl?: RuntimeChangeFor<"web_firecrawl_configuration">["config"];
    readonly search?: RuntimeChangeFor<"web_search_configuration">["config"];
  };
  readonly mesh?: RuntimeChangeFor<"mesh_configuration">["config"];
  readonly npu?: RuntimeChangeFor<"npu_configuration">["config"];
  readonly llamaCpp?: RuntimeChangeFor<"llama_cpp_configuration">["config"] & {
    readonly command?: string;
    readonly extraArgs?: readonly string[];
    readonly modelsRootPath?: string;
    readonly modelPath?: string;
  };
  readonly features?: Readonly<Record<string, boolean | undefined>>;
}

type RuntimeFeatureFlag = RuntimeChangeFor<"feature_flag">["flag"];

/**
 * One-release Settings compatibility projection. These exact, typed mutations
 * use the same adapters as Chat and treat the explicit Save click as the plan's
 * confirmation. More complex/secret/path-bearing owners retain their dedicated
 * routes until their Control Plane adapters are registered.
 *
 * Throws a `ValidationError` (a 400 that carries its own sentence) for a public web address that fails its check,
 * so no plan is made for one.
 */
export function settingsChangePlanRequest(input: SettingsChangePlanInput): ChangePlanRequest | null {
  const mutationKeys = Object.keys(input).filter((key) => key !== "expectedRevision");
  if (mutationKeys.length !== 1) return null;
  switch (mutationKeys[0]) {
    case "toolApprovalMode":
      return input.toolApprovalMode
        ? { kind: "runtime_configuration", change: { operation: "tool_approval_mode", mode: input.toolApprovalMode } }
        : null;
    case "budgetMode":
      return input.budgetMode
        ? { kind: "runtime_configuration", change: { operation: "budget_mode", mode: input.budgetMode } }
        : null;
    case "deploymentProfile":
      return input.deploymentProfile
        ? {
            kind: "runtime_configuration",
            change: { operation: "deployment_profile", profile: input.deploymentProfile },
          }
        : null;
    case "readAccessMode":
      return input.readAccessMode
        ? { kind: "runtime_configuration", change: { operation: "read_access_policy", mode: input.readAccessMode } }
        : null;
    case "outsideRootWriteMode":
      return input.outsideRootWriteMode
        ? {
            kind: "runtime_configuration",
            change: { operation: "outside_root_write_policy", mode: input.outsideRootWriteMode },
          }
        : null;
    case "networkAllowlist":
      return input.networkAllowlist
        ? { kind: "runtime_configuration", change: { operation: "network_allowlist", entries: input.networkAllowlist } }
        : null;
    case "publicWebAddress": {
      const typed = input.publicWebAddress;
      if (typed === undefined) return null;
      if (typed === null) {
        return {
          kind: "runtime_configuration",
          change: { operation: "public_web_address_configuration", config: { publicWebAddress: null } },
        };
      }
      // A problem is the operator's to fix, so it is a 400 with its own sentence and no plan is made. The plan carries
      // the tidied address, which is what the operator reviews and approves.
      const checked = checkPublicWebAddress(typed);
      if (!checked.ok) throw new ValidationError({ message: checked.problem });
      return {
        kind: "runtime_configuration",
        change: { operation: "public_web_address_configuration", config: { publicWebAddress: checked.address } },
      };
    }
    case "operatorWriteRootChange":
      return input.operatorWriteRootChange
        ? {
            kind: "runtime_configuration",
            change: { operation: "operator_write_root", ...input.operatorWriteRootChange },
          }
        : null;
    case "globalToolAccessChange":
      return input.globalToolAccessChange
        ? {
            kind: "runtime_configuration",
            change: { operation: "tool_global_access", ...input.globalToolAccessChange },
          }
        : null;
    case "toolGroupChange":
      return input.toolGroupChange
        ? {
            kind: "runtime_configuration",
            change: { operation: "tool_group_access", ...input.toolGroupChange },
          }
        : null;
    case "llm": {
      const llm = input.llm;
      if (!llm) return null;
      const keys = Object.keys(llm);
      if (keys.every((key) => key === "activeProviderId" || key === "activeModel" || key === "defaultThinkingLevel")) {
        if (!llm.activeProviderId || !llm.activeModel) return null;
        return {
          kind: "installation_default_model",
          providerId: llm.activeProviderId,
          model: llm.activeModel,
          ...(llm.defaultThinkingLevel ? { thinkingLevel: llm.defaultThinkingLevel } : {}),
        };
      }
      if (keys.every((key) => key === "utilityProviderId" || key === "utilityModel")) {
        if (!llm.utilityProviderId || !llm.utilityModel) return null;
        return {
          kind: "runtime_configuration",
          change: { operation: "utility_model", providerId: llm.utilityProviderId, model: llm.utilityModel },
        };
      }
      if (keys.length === 1 && llm.upsertProvider) {
        const provider = llm.upsertProvider;
        if (provider.apiKey || provider.request || provider.headers) return null;
        return {
          kind: "provider_connection",
          providerId: provider.providerId,
          profile: {
            ...(provider.label !== undefined ? { label: provider.label } : {}),
            ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
            ...(provider.apiStyle !== undefined ? { apiStyle: provider.apiStyle } : {}),
            ...(provider.authMode !== undefined ? { authMode: provider.authMode } : {}),
            ...(provider.defaultModel !== undefined ? { defaultModel: provider.defaultModel } : {}),
            ...(provider.apiKeyEnv !== undefined ? { apiKeyEnv: provider.apiKeyEnv } : {}),
            ...(provider.googleCloud !== undefined ? { googleCloud: provider.googleCloud } : {}),
            ...(provider.capabilities !== undefined ? { capabilities: provider.capabilities } : {}),
          },
        };
      }
      return null;
    }
    case "memory":
      return input.memory && Object.keys(input.memory).length > 0
        ? { kind: "runtime_configuration", change: { operation: "memory_configuration", config: input.memory } }
        : null;
    case "web": {
      // One governed owner per save: Firecrawl and the native engine order are separate plans.
      const firecrawl = input.web?.firecrawl;
      const search = input.web?.search;
      if (firecrawl && search) return null;
      if (search?.engineOrder) {
        return {
          kind: "runtime_configuration",
          change: { operation: "web_search_configuration", config: { engineOrder: search.engineOrder } },
        };
      }
      return firecrawl && Object.keys(firecrawl).length > 0
        ? { kind: "runtime_configuration", change: { operation: "web_firecrawl_configuration", config: firecrawl } }
        : null;
    }
    case "mesh":
      return input.mesh && Object.keys(input.mesh).length > 0
        ? { kind: "runtime_configuration", change: { operation: "mesh_configuration", config: input.mesh } }
        : null;
    case "npu":
      return input.npu && Object.keys(input.npu).length > 0
        ? { kind: "runtime_configuration", change: { operation: "npu_configuration", config: input.npu } }
        : null;
    case "llamaCpp": {
      const llama = input.llamaCpp;
      if (!llama || Object.keys(llama).length === 0) return null;
      if (
        llama.command !== undefined ||
        llama.extraArgs !== undefined ||
        llama.modelsRootPath !== undefined ||
        llama.modelPath !== undefined
      ) {
        return null;
      }
      return { kind: "runtime_configuration", change: { operation: "llama_cpp_configuration", config: llama } };
    }
    case "features": {
      const entries = Object.entries(input.features ?? {}).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      );
      if (entries.length !== 1) return null;
      const [flag, enabled] = entries[0]!;
      if (!(CHANGE_PLAN_RUNTIME_FEATURE_FLAGS as readonly string[]).includes(flag)) return null;
      return {
        kind: "runtime_configuration",
        change: {
          operation: "feature_flag",
          flag: flag as RuntimeFeatureFlag,
          enabled,
        },
      };
    }
    default:
      return null;
  }
}
