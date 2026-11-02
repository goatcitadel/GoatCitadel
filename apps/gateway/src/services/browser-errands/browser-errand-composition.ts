import path from "node:path";
import type {
  ChatAttachmentRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelUsageAttributionContext,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import { launchErrandBrowser } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../../config.js";
import type { ChatAttachmentUploadInput } from "../chat-attachment-service.js";
import { createUtilityModelUsageAttribution } from "../utility-model-usage-attribution.js";
import { BrowserErrandService } from "./browser-errand-service.js";
import type { ErrandApprovalRuntime } from "./errand-approval-gate.js";

export const BROWSER_ERRAND_UTILITY_KIND = "browser_errand";

export interface GatewayBrowserErrandInputs {
  config: GatewayRuntimeConfig;
  storage: AsyncStorage;
  approvals: ErrandApprovalRuntime;
  isEnabled(): Promise<boolean>;
  chatCompletions(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  uploadAttachment(input: ChatAttachmentUploadInput): Promise<ChatAttachmentRecord>;
  subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void;
}

/** Where the errand browser keeps its own logins, apart from the operator's everyday Chrome. */
export function browserErrandProfileDir(config: Pick<GatewayRuntimeConfig, "rootDir" | "assistant">): string {
  return path.join(path.resolve(config.rootDir, config.assistant.dataDir), "browser-errands", "profile");
}

/** Builds the Gateway's errand service from live Gateway pieces; GatewayService only wires the result. */
export function createGatewayBrowserErrandService(inputs: GatewayBrowserErrandInputs): BrowserErrandService {
  const { config } = inputs;
  return new BrowserErrandService({
    isEnabled: () => inputs.isEnabled(),
    deploymentProfile: () => config.assistant.deploymentProfile,
    sessionChannel: async (sessionId) => (await inputs.storage.sessions.getBySessionId(sessionId)).channel,
    launchBrowser: (signal) =>
      launchErrandBrowser({
        profileDir: browserErrandProfileDir(config),
        channel: "chrome",
        // Errands browse the public web like Chat's full-web mode; private and LAN addresses stay blocked.
        networkAllowlist: [...config.toolPolicy.sandbox.networkAllowlist, "*"],
        signal,
      }),
    callModel: (request, lineage) =>
      inputs.chatCompletions(
        request,
        createUtilityModelUsageAttribution({
          operationId: lineage.errandId,
          utilityKind: BROWSER_ERRAND_UTILITY_KIND,
          ...(request.providerId ? { requestedProviderId: request.providerId } : {}),
          ...(request.model ? { requestedModelId: request.model } : {}),
          lineage: {
            sessionId: lineage.sessionId,
            turnId: lineage.turnId,
            ...(lineage.workspaceId ? { workspaceId: lineage.workspaceId } : {}),
          },
        }),
      ),
    gate: {
      approvals: inputs.approvals,
      storage: inputs.storage,
      realtime: { subscribeRealtime: (listener) => inputs.subscribeRealtime(listener) },
      attachments: {
        // The record's sha256 is computed from exactly these bytes as they are stored.
        upload: async (input) => {
          const record = await inputs.uploadAttachment(input);
          return { attachmentId: record.attachmentId, sha256: record.sha256 };
        },
      },
    },
  });
}
