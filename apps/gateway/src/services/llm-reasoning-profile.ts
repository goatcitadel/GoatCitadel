import type {
  ChatCompletionReasoningEffort,
  ChatCompletionReasoningReceipt,
  ChatCompletionRequest,
  LlmModelMetadataEntry,
  LlmProviderCapabilities,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";

const LEGACY_REASONING_EFFORTS: ChatCompletionReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];
const EFFORT_ORDER: ChatCompletionReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface LlmReasoningProfileResolution {
  request: ChatCompletionRequest;
  receipt?: ChatCompletionReasoningReceipt;
  attribution: ModelUsageAttributionContext;
}

export function resolveLlmReasoningProfile(input: {
  request: ChatCompletionRequest;
  providerId?: string;
  providerCapabilities: LlmProviderCapabilities;
  modelMetadata?: LlmModelMetadataEntry;
  attribution?: ModelUsageAttributionContext;
}): LlmReasoningProfileResolution {
  const baseAttribution = input.attribution ?? {};
  const dispatchedRequest = input.request.reasoning?.effort;
  if (!dispatchedRequest) {
    return {
      request: input.request,
      attribution: {
        ...baseAttribution,
        reasoningDisposition: baseAttribution.reasoningDisposition ?? "provider_default",
        reasoningReasonCode: baseAttribution.reasoningReasonCode ?? "no_explicit_reasoning_request",
      },
    };
  }

  const requested = isReasoningEffort(baseAttribution.requestedReasoningLevel)
    ? baseAttribution.requestedReasoningLevel
    : dispatchedRequest;
  if (requested !== dispatchedRequest) {
    const isAuthorizedDownwardFallback =
      baseAttribution.callKind === "chat_fallback" &&
      EFFORT_ORDER.indexOf(dispatchedRequest) < EFFORT_ORDER.indexOf(requested);
    if (!isAuthorizedDownwardFallback) {
      throw new LlmReasoningProfileError({
        requested: dispatchedRequest,
        supported: [requested],
        code: "unauthorized_reasoning_drift",
        message: `Reasoning effort changed from ${requested} to ${dispatchedRequest} without a typed fallback downgrade.`,
      });
    }
  }

  const capability = resolveCapability(input.modelMetadata, input.providerCapabilities);
  const supported = new Set<ChatCompletionReasoningEffort>(["none", ...capability.supportedEfforts]);
  let actual = dispatchedRequest;
  let disposition: ChatCompletionReasoningReceipt["disposition"] =
    requested === dispatchedRequest ? "honored" : "downgraded";
  let reasonCode =
    requested === dispatchedRequest ? "requested_reasoning_supported" : "reasoning_changed_before_provider_dispatch";

  if (!supported.has(dispatchedRequest)) {
    const canOmitUnsupportedLegacyReasoning =
      capability.source === "legacy_compatibility" && supported.size === 1 && supported.has("none");
    if (baseAttribution.callKind !== "chat_fallback" && !canOmitUnsupportedLegacyReasoning) {
      throw new LlmReasoningProfileError({
        requested: dispatchedRequest,
        supported: [...supported],
        code: "unsupported_reasoning_effort",
        message: `Reasoning effort ${dispatchedRequest} is not supported by the selected provider/model.`,
      });
    }
    if (canOmitUnsupportedLegacyReasoning) {
      actual = "none";
      disposition = "downgraded";
      reasonCode = "legacy_provider_reasoning_omitted";
    } else {
      const downgrade = nearestLowerSupportedEffort(dispatchedRequest, supported);
      if (!downgrade) {
        throw new LlmReasoningProfileError({
          requested: dispatchedRequest,
          supported: [...supported],
          code: "unsupported_reasoning_fallback",
          message: `Reasoning effort ${dispatchedRequest} cannot be safely downgraded for the fallback provider/model.`,
        });
      }
      actual = downgrade;
      disposition = "downgraded";
      reasonCode = "fallback_model_effort_downgrade";
    }
  }

  const providerEffort = capability.providerEffortMap?.[actual] ?? actual;
  assertProviderWireEffort(input.providerId, providerEffort, actual, capability.providerEffortMap, capability.source);
  const receipt: ChatCompletionReasoningReceipt = {
    requested,
    actual,
    providerEffort,
    disposition,
    reasonCode,
    capabilitySource: capability.source,
  };
  return {
    request: {
      ...input.request,
      reasoning: { effort: providerEffort },
    },
    receipt,
    attribution: {
      ...baseAttribution,
      requestedReasoningLevel: requested,
      dispatchedReasoningEffort: providerEffort,
      reasoningDisposition: disposition,
      reasoningReasonCode: reasonCode,
    },
  };
}

function resolveCapability(
  modelMetadata: LlmModelMetadataEntry | undefined,
  providerCapabilities: LlmProviderCapabilities,
): {
  supportedEfforts: ChatCompletionReasoningEffort[];
  providerEffortMap?: Partial<Record<ChatCompletionReasoningEffort, ChatCompletionReasoningEffort>>;
  source: ChatCompletionReasoningReceipt["capabilitySource"];
} {
  if (modelMetadata?.reasoning) {
    return {
      supportedEfforts: modelMetadata.reasoning.supportedEfforts,
      providerEffortMap: modelMetadata.reasoning.providerEffortMap,
      source: "model_metadata",
    };
  }
  if (providerCapabilities.reasoningEfforts?.length) {
    return {
      supportedEfforts: providerCapabilities.reasoningEfforts,
      source: "provider_config",
    };
  }
  return {
    supportedEfforts: providerCapabilities.reasoning ? LEGACY_REASONING_EFFORTS : ["none"],
    source: "legacy_compatibility",
  };
}

function nearestLowerSupportedEffort(
  requested: ChatCompletionReasoningEffort,
  supported: ReadonlySet<ChatCompletionReasoningEffort>,
): ChatCompletionReasoningEffort | undefined {
  const requestedIndex = EFFORT_ORDER.indexOf(requested);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = EFFORT_ORDER[index];
    if (candidate && supported.has(candidate)) return candidate;
  }
  return undefined;
}

function isReasoningEffort(value: unknown): value is ChatCompletionReasoningEffort {
  return typeof value === "string" && EFFORT_ORDER.includes(value as ChatCompletionReasoningEffort);
}

function assertProviderWireEffort(
  providerId: string | undefined,
  providerEffort: ChatCompletionReasoningEffort,
  actual: ChatCompletionReasoningEffort,
  effortMap: Partial<Record<ChatCompletionReasoningEffort, ChatCompletionReasoningEffort>> | undefined,
  capabilitySource: ChatCompletionReasoningReceipt["capabilitySource"],
): void {
  const normalizedProviderId = providerId?.trim().toLowerCase();
  if (!normalizedProviderId || providerEffort === "none") return;
  const supportedWireEfforts =
    normalizedProviderId === "vertex"
      ? new Set<ChatCompletionReasoningEffort>(["low", "medium", "high"])
      : normalizedProviderId === "fireworks"
        ? new Set<ChatCompletionReasoningEffort>(["low", "medium", "high", "xhigh", "max"])
        : undefined;
  if (
    normalizedProviderId === "vertex" &&
    !new Set<ChatCompletionReasoningEffort>(["low", "medium", "high"]).has(actual)
  ) {
    throw new LlmReasoningProfileError({
      requested: actual,
      supported: ["none", "low", "medium", "high"],
      code: "unsupported_reasoning_wire_effort",
      message: "Vertex reasoning supports only low, medium, or high; metadata cannot manufacture another level.",
    });
  }
  if (normalizedProviderId === "fireworks" && providerEffort === "xhigh" && capabilitySource !== "model_metadata") {
    throw new LlmReasoningProfileError({
      requested: actual,
      supported: ["none", "low", "medium", "high", "max"],
      code: "unsupported_reasoning_wire_effort",
      message: "Fireworks xhigh reasoning requires explicit model-scoped metadata.",
    });
  }
  if (
    normalizedProviderId === "fireworks" &&
    actual === "ultra" &&
    (providerEffort !== "max" || effortMap?.ultra !== "max")
  ) {
    throw new LlmReasoningProfileError({
      requested: actual,
      supported: ["none", "low", "medium", "high", "xhigh", "max"],
      code: "unsupported_reasoning_wire_effort",
      message: "Fireworks ultra reasoning requires exact model metadata mapping it to max.",
    });
  }
  if (!supportedWireEfforts || supportedWireEfforts.has(providerEffort)) return;
  const mappingRequired = normalizedProviderId === "fireworks" && actual === "ultra" && !effortMap?.ultra;
  throw new LlmReasoningProfileError({
    requested: actual,
    supported: [...supportedWireEfforts],
    code: "unsupported_reasoning_wire_effort",
    message: mappingRequired
      ? "Fireworks ultra reasoning requires explicit model metadata mapping it to a supported wire effort."
      : `Reasoning effort ${providerEffort} is not accepted by the ${normalizedProviderId} wire API.`,
  });
}

export class LlmReasoningProfileError extends Error {
  public readonly code:
    | "unsupported_reasoning_effort"
    | "unsupported_reasoning_fallback"
    | "unauthorized_reasoning_drift"
    | "unsupported_reasoning_wire_effort";
  public readonly requested: ChatCompletionReasoningEffort;
  public readonly supported: ChatCompletionReasoningEffort[];

  public constructor(input: {
    code: LlmReasoningProfileError["code"];
    message: string;
    requested: ChatCompletionReasoningEffort;
    supported: ChatCompletionReasoningEffort[];
  }) {
    super(input.message);
    this.name = "LlmReasoningProfileError";
    this.code = input.code;
    this.requested = input.requested;
    this.supported = input.supported;
  }
}
