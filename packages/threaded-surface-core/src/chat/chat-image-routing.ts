import { useMemo } from "react";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import type { ChatImageRoute } from "./multimodal-action-types";
import type { ChatMultimodalInput } from "./useChatMultimodalControls";

const OPENAI_IMAGE_MODEL_PREFERENCES = ["gpt-image-2", "gpt-image-1"] as const;
const GOOGLE_IMAGE_MODEL_PREFERENCES = [
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image",
] as const;
const IMAGE_MODEL_PREFERENCES: Record<"openai" | "openai-codex" | "google", readonly string[]> = {
  openai: OPENAI_IMAGE_MODEL_PREFERENCES,
  "openai-codex": OPENAI_IMAGE_MODEL_PREFERENCES,
  google: GOOGLE_IMAGE_MODEL_PREFERENCES,
};

function isImageAttachment(attachment: ChatAttachmentRecord): boolean {
  return attachment.mediaType === "image" || attachment.mimeType.startsWith("image/");
}

function normalizeOptionalString(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getImageModelPreferences(providerId: string): readonly string[] {
  return providerId === "openai" || providerId === "openai-codex"
    ? OPENAI_IMAGE_MODEL_PREFERENCES
    : providerId === "google"
      ? GOOGLE_IMAGE_MODEL_PREFERENCES
      : [];
}

function getImageModelOptions(provider: ChatModelProviderOption): string[] {
  const available = new Set<string>();
  for (const value of [provider.defaultModel, ...provider.models]) {
    const normalized = normalizeOptionalString(value);
    if (normalized && normalized.toLowerCase().includes("image")) {
      available.add(normalized);
    }
  }
  for (const model of getImageModelPreferences(provider.providerId)) {
    available.add(model);
  }
  return [...available];
}

function resolveImageModel(provider: ChatModelProviderOption, preferredModel?: string): string | null {
  const normalizedPreferred = normalizeOptionalString(preferredModel);
  const availableModels = getImageModelOptions(provider);
  if (normalizedPreferred) {
    if (availableModels.includes(normalizedPreferred)) {
      return normalizedPreferred;
    }
    if (normalizedPreferred.toLowerCase().includes("image")) {
      return normalizedPreferred;
    }
  }
  return availableModels[0] ?? null;
}

function toImageProviderOption(provider: ChatModelProviderOption | null | undefined): ChatModelProviderOption | null {
  if (!provider || provider.disabled || provider.capabilities?.imageGenerate === false) {
    return null;
  }
  const models = getImageModelOptions(provider);
  if (models.length === 0 && !IMAGE_MODEL_PREFERENCES[provider.providerId as keyof typeof IMAGE_MODEL_PREFERENCES]) {
    return null;
  }
  return {
    ...provider,
    defaultModel: models[0] ?? provider.defaultModel,
    models,
  };
}

function buildImageRoute(
  provider: ChatModelProviderOption | null | undefined,
  preferredModel?: string,
): ChatImageRoute | null {
  if (!provider || provider.disabled || provider.capabilities?.imageGenerate === false) {
    return null;
  }
  const model = resolveImageModel(provider, preferredModel);
  if (model && (provider.providerId === "openai" || provider.providerId === "openai-codex")) {
    return {
      providerId: provider.providerId,
      model,
      label: provider.providerId === "openai-codex" ? `OpenAI Codex / ${model}` : `OpenAI / ${model}`,
      supportsEdit: true,
    };
  }
  if (model && provider.providerId === "google") {
    return {
      providerId: "google",
      model,
      label: `Google / ${model}`,
      supportsEdit: false,
    };
  }
  return null;
}

export function useChatImageRouting({
  providerOptions,
  selectedProviderId,
  routePreflight,
  preferredImageProviderId,
  preferredImageModel,
  pendingAttachments,
}: Pick<
  ChatMultimodalInput,
  | "providerOptions"
  | "selectedProviderId"
  | "routePreflight"
  | "preferredImageProviderId"
  | "preferredImageModel"
  | "pendingAttachments"
>) {
  const activeProviderId =
    routePreflight?.effectiveProviderId ?? selectedProviderId ?? providerOptions[0]?.providerId ?? null;
  const activeProvider = useMemo(
    () => providerOptions.find((provider) => provider.providerId === activeProviderId) ?? null,
    [activeProviderId, providerOptions],
  );
  const imageProviderOptions = useMemo(
    () =>
      providerOptions.map((provider) => toImageProviderOption(provider)).filter(Boolean) as ChatModelProviderOption[],
    [providerOptions],
  );
  const preferredImageProvider = useMemo(
    () => imageProviderOptions.find((provider) => provider.providerId === preferredImageProviderId) ?? null,
    [imageProviderOptions, preferredImageProviderId],
  );
  const primaryImageRoute = useMemo(() => {
    const preferredRoute = buildImageRoute(preferredImageProvider, preferredImageModel);
    if (preferredRoute) {
      return preferredRoute;
    }
    const activeRoute = buildImageRoute(toImageProviderOption(activeProvider) ?? undefined);
    if (activeRoute) {
      return activeRoute;
    }
    return (
      buildImageRoute(imageProviderOptions.find((provider) => provider.providerId === "openai")) ??
      buildImageRoute(imageProviderOptions.find((provider) => provider.providerId === "google")) ??
      null
    );
  }, [activeProvider, imageProviderOptions, preferredImageModel, preferredImageProvider]);
  const googleFallbackImageRoute = useMemo(() => {
    if (primaryImageRoute?.providerId !== "openai") {
      return null;
    }
    return buildImageRoute(imageProviderOptions.find((provider) => provider.providerId === "google"));
  }, [imageProviderOptions, primaryImageRoute]);
  const latestImageAttachment = useMemo(
    () => [...pendingAttachments].reverse().find(isImageAttachment) ?? null,
    [pendingAttachments],
  );
  const imageGenerationAvailable = Boolean(primaryImageRoute);
  const imageEditAvailable = Boolean(primaryImageRoute?.supportsEdit && latestImageAttachment);
  const imageRouteLabel = primaryImageRoute
    ? googleFallbackImageRoute
      ? `${primaryImageRoute.label} with ${googleFallbackImageRoute.label} fallback`
      : primaryImageRoute.label
    : null;
  return {
    activeProviderId,
    activeProvider,
    imageProviderOptions,
    primaryImageRoute,
    googleFallbackImageRoute,
    latestImageAttachment,
    imageGenerationAvailable,
    imageEditAvailable,
    imageRouteLabel,
  };
}
