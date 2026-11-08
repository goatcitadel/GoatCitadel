import type { ChatGeneratedArtifactSourceSurface, ChatMode } from "@goatcitadel/contracts";

export interface ChatRequestSurfaceOptions {
  originSurface?: ChatMode;
}

export function originSurfaceHeader(options?: ChatRequestSurfaceOptions): HeadersInit | undefined {
  return options?.originSurface
    ? { "x-goatcitadel-origin-surface": normalizeChatSurface(options.originSurface) }
    : undefined;
}

export function originSurfaceInit(options?: ChatRequestSurfaceOptions): Pick<RequestInit, "headers"> {
  const headers = originSurfaceHeader(options);
  return headers ? { headers } : {};
}

export function normalizeChatSurface(_surface?: ChatMode | ChatGeneratedArtifactSourceSurface | null): "chat" {
  return "chat";
}
