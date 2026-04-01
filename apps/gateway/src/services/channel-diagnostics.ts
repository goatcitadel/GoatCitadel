import type { ChannelRuntimePosture } from "@goatcitadel/contracts";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";

export interface ChannelFeatureMetadata {
  supportedDeliveryActions: string[];
  supportedAttachmentSources: string[];
  supportNotes: string[];
  setupDiagnostics: string[];
  setupReady: boolean;
  runtimePosture: ChannelRuntimePosture;
}

export function describeChannelFeatureMetadata(
  channelKey: string,
  config: Record<string, unknown>,
): ChannelFeatureMetadata {
  const capabilities = describeChannelCapabilities(channelKey, config);
  return {
    supportedDeliveryActions: [...capabilities.supportedDeliveryActions],
    supportedAttachmentSources: [...capabilities.supportedAttachmentSources],
    supportNotes: [...capabilities.supportNotes],
    setupDiagnostics: [...capabilities.setupDiagnostics],
    setupReady: capabilities.setupReady,
    runtimePosture: capabilities.runtimePosture,
  };
}

export { describeChannelCapabilities } from "@goatcitadel/gateway-core";
