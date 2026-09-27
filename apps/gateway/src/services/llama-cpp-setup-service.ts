import path from "node:path";
import {
  type ChatSendMessageRequest,
  type ChatSendMessageResponse,
  type ChatSessionCreateInput,
  type LlamaCppSetupChatTestResult,
  type LlamaCppSetupProjection,
  type LlmModelPreviewResponse,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";
import type { LlamaCppSetupSelectionService } from "./llama-cpp-setup-selection-service.js";
import type { EvolutionControlPlaneService } from "./evolution-control-plane-service.js";

interface Dependencies {
  getSettings: () => Promise<RuntimeSettings>;
  runtime: LlamaCppRuntimeService;
  selections: LlamaCppSetupSelectionService;
  plans: EvolutionControlPlaneService;
  previewModels: (baseUrl: string) => Promise<LlmModelPreviewResponse>;
  createChatSession: (input: ChatSessionCreateInput) => Promise<{ sessionId: string }>;
  sendChatMessage: (
    sessionId: string,
    input: ChatSendMessageRequest,
    options: { abortSignal?: AbortSignal },
  ) => Promise<ChatSendMessageResponse>;
}

/** Operator-facing setup truth composed from canonical Gateway owners. */
export class LlamaCppSetupService {
  public constructor(private readonly deps: Dependencies) {}

  public async get(workspaceId: string): Promise<LlamaCppSetupProjection> {
    const settings = await this.deps.getSettings();
    const [runtime, binary, models, catalog, plans] = await Promise.all([
      this.deps.runtime.refresh(),
      this.deps.runtime.detectLocalInstall(),
      this.deps.runtime.listModels().catch(() => []),
      this.deps.previewModels(settings.llamaCpp.baseUrl).catch(() => undefined),
      this.deps.plans.list({ surface: "settings", workspaceId, actorId: "llamacpp-setup" }, { limit: 30 }),
    ]);
    const latest = plans.find(
      (plan) =>
        plan.request.kind === "runtime_configuration" &&
        (plan.request.change.operation === "llama_cpp_setup" ||
          plan.request.change.operation === "llama_cpp_configuration"),
    );
    const recentPlan = latest
      ? {
          planId: latest.planId,
          revision: latest.revision,
          status: latest.status,
          ...(latest.requiredAction?.kind === "approval" && latest.requiredAction.approvalId
            ? { approvalId: latest.requiredAction.approvalId }
            : {}),
          ...(latest.result?.summary ? { summary: latest.result.summary } : {}),
        }
      : undefined;
    const pending =
      latest &&
      !["completed", "manual_required", "failed", "cancelled", "rolled_back", "rollback_failed"].includes(
        latest.status,
      );
    return {
      settingsRevision: settings.revision,
      managementMode: settings.llamaCpp.managementMode,
      baseUrl: settings.llamaCpp.baseUrl,
      runtime: { ...runtime, command: undefined, modelPath: undefined, launchCommandPreview: undefined },
      ownership: runtime.leaseDiagnostics?.ownership ?? "none",
      binary: {
        found: binary.found,
        ...(binary.command ? { label: path.basename(binary.command) } : {}),
        ...(binary.version ? { version: binary.version } : {}),
      },
      models: models.map((model) => ({
        modelId: model.modelId,
        label: model.filePath ? path.basename(model.filePath) : model.modelId,
        source: model.source === "filesystem" ? ("filesystem" as const) : ("runtime" as const),
      })),
      catalog:
        catalog?.source === "live" && catalog.catalogStatus !== "stale"
          ? {
              status: catalog.items.length > 0 ? "fresh" : "empty",
              modelIds: catalog.items.map((item) => item.id),
              ...(catalog.warning ? { warning: catalog.warning } : {}),
            }
          : catalog
            ? { status: "stale", modelIds: [], warning: catalog.warning ?? "Live model discovery failed." }
            : { status: "unavailable", modelIds: [], warning: "The server did not return a live model catalog." },
      chatRoute: {
        providerId: settings.llm.activeProviderId ?? "",
        model: settings.llm.activeModel ?? "",
        thinkingLevel: settings.llm.defaultThinkingLevel ?? "off",
      },
      ...(recentPlan ? { recentPlan } : {}),
      ...(pending && recentPlan ? { pendingPlan: recentPlan } : {}),
    };
  }

  public stageManagedSelection(input: { workspaceId: string; modelId: string; commandPath?: string }) {
    return this.deps.selections.stage(input);
  }

  public async chatTest(workspaceId: string): Promise<LlamaCppSetupChatTestResult> {
    const started = performance.now();
    const settings = await this.deps.getSettings();
    const route = { providerId: settings.llm.activeProviderId, model: settings.llm.activeModel };
    if (route.providerId !== "llamacpp" || !route.model) {
      return {
        success: false,
        providerId: route.providerId ?? "",
        model: route.model ?? "",
        settingsRevision: settings.revision,
        elapsedMs: Math.round(performance.now() - started),
        error: "Select a verified llama.cpp model for Chat before sending a test message.",
      };
    }
    const session = await this.deps.createChatSession({
      workspaceId,
      origin: "system",
      includeInHistory: false,
      title: "llama.cpp setup diagnostic",
    });
    try {
      const sent = await this.deps.sendChatMessage(
        session.sessionId,
        {
          content: "Reply with one short sentence confirming you can respond to a chat message.",
          mode: "chat",
          useMemory: false,
          memoryMode: "off",
          webMode: "off",
          thinkingLevel: "off",
          subagentPolicy: "off",
          prefsOverride: {
            toolAutonomy: "manual",
            orchestrationEnabled: false,
            memoryMode: "off",
            webMode: "off",
            subagentPolicy: "off",
            thinkingLevel: "off",
          },
        },
        { abortSignal: AbortSignal.timeout(60_000) },
      );
      const providerId = sent.routing?.effectiveProviderId ?? "";
      const model = sent.routing?.effectiveModel ?? sent.model ?? "";
      const excerpt = sent.assistantMessage?.content?.trim().slice(0, 1_000);
      const revision = (await this.deps.getSettings()).revision;
      const success =
        Boolean(excerpt) &&
        providerId === route.providerId &&
        model === route.model &&
        revision === settings.revision &&
        sent.trace?.status === "completed";
      return {
        success,
        providerId,
        model,
        settingsRevision: settings.revision,
        elapsedMs: Math.round(performance.now() - started),
        ...(excerpt ? { responseExcerpt: excerpt } : {}),
        ...(sent.turnId ? { traceRef: sent.turnId } : {}),
        ...(!success
          ? {
              error:
                revision !== settings.revision
                  ? "Settings changed during the test. Run it again."
                  : !excerpt
                    ? "The model did not complete a Chat response. Check server logs and retry."
                    : "Chat used a different provider or model. Check routing and retry.",
            }
          : {}),
      };
    } catch (error) {
      return {
        success: false,
        ...route,
        settingsRevision: settings.revision,
        elapsedMs: Math.round(performance.now() - started),
        traceRef: session.sessionId,
        error: error instanceof Error ? error.message : "The Chat test failed. Check the server and retry.",
      };
    }
  }
}
