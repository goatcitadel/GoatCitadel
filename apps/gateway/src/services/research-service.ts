import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelUsageAttributionContext,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchSummaryRecord,
  ToolPolicyActorContext,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

interface ResearchServiceDeps {
  storage: Storage;
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
  createChatCompletion: (
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ) => Promise<ChatCompletionResponse>;
  resolveToolPolicyContext?: (input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: ToolPolicyActorContext["surface"];
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }) => Promise<ToolPolicyActorContext>;
}

export class ResearchService {
  public constructor(private readonly deps: ResearchServiceDeps) {}

  public async run(input: {
    sessionId: string;
    query: string;
    mode: "quick" | "deep";
    providerId?: string;
    model?: string;
    workspaceId?: string;
    policyRunId?: string;
    policyTaskId?: string;
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    surface?: ToolPolicyActorContext["surface"];
  }): Promise<ResearchSummaryRecord> {
    const runId = randomUUID();
    const policyRunId = input.policyRunId ?? runId;
    const policyTaskId = input.policyTaskId ?? runId;
    const policyContext = await this.deps.resolveToolPolicyContext?.({
      operatorId: input.operatorId ?? input.authActorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: policyTaskId,
      runId: policyRunId,
      surface: input.surface ?? "chat",
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
    });
    await this.deps.storage.researchRuns.create({
      runId,
      sessionId: input.sessionId,
      query: input.query,
      mode: input.mode,
      status: "running",
    });

    try {
      const searchResult = await this.deps.invokeTool({
        toolName: "browser.search",
        args: {
          query: input.query,
          engine: "duckduckgo",
          limit: input.mode === "deep" ? 10 : 5,
        },
        agentId: "research",
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        taskId: policyTaskId,
        runId: policyRunId,
        permissionProfileId: policyContext?.permissionProfileId ?? input.permissionProfileId,
        localOperatorOverrideId: policyContext?.localOperatorOverrideId ?? input.localOperatorOverrideId,
        surface: policyContext?.surface ?? input.surface ?? "chat",
        policyContext,
        consentContext: {
          operatorId: input.operatorId ?? input.authActorId,
          source: "agent",
          reason: `research:${input.mode}`,
        },
      });
      if (searchResult.outcome !== "executed") {
        throw new Error(searchResult.policyReason);
      }

      const rawResults = Array.isArray(searchResult.result?.results)
        ? (searchResult.result?.results as Array<Record<string, unknown>>)
        : [];
      const sources: ResearchSourceRecord[] = rawResults
        .slice(0, input.mode === "deep" ? 8 : 4)
        .map((result, index) => ({
          sourceId: randomUUID(),
          runId,
          title: typeof result.title === "string" ? result.title : undefined,
          url: typeof result.url === "string" ? result.url : "",
          snippet: typeof result.snippet === "string" ? result.snippet : undefined,
          rank: index,
          createdAt: new Date().toISOString(),
        }))
        .filter((item) => item.url.length > 0);

      const persistedSources = await this.deps.storage.researchSources.replaceForRun(runId, sources);
      const sessionMeta = await this.deps.storage.chatSessionMeta.get(input.sessionId);
      const summary = await this.summarize(
        {
          ...input,
          runId,
          trustedWorkspaceId: policyContext?.workspaceId ?? sessionMeta?.workspaceId,
          trustedTaskId: policyContext?.taskId,
          trustedRunId: policyContext?.runId,
        },
        persistedSources,
      );
      const finishedAt = new Date().toISOString();
      await this.deps.storage.researchRuns.patch(runId, {
        status: "completed",
        summary,
        finishedAt,
      });

      return {
        runId,
        query: input.query,
        summary,
        sources: persistedSources,
      };
    } catch (error) {
      await this.deps.storage.researchRuns.patch(runId, {
        status: "failed",
        error: (error as Error).message,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  public async getRun(
    sessionId: string,
    runId: string,
  ): Promise<{
    run: ResearchRunRecord;
    sources: ResearchSourceRecord[];
  }> {
    const run = await this.deps.storage.researchRuns.get(runId);
    if (run.sessionId !== sessionId) {
      throw new Error(`Research run ${runId} does not belong to session ${sessionId}`);
    }
    return {
      run,
      sources: await this.deps.storage.researchSources.listByRun(runId),
    };
  }

  private async summarize(
    input: {
      query: string;
      mode: "quick" | "deep";
      sessionId: string;
      runId: string;
      providerId?: string;
      model?: string;
      trustedWorkspaceId?: string;
      trustedTaskId?: string;
      trustedRunId?: string;
    },
    sources: ResearchSourceRecord[],
  ): Promise<string> {
    if (sources.length === 0) {
      return "No external sources were available for this query.";
    }

    const sourceLines = sources
      .map((source, index) => {
        const title = source.title ?? source.url;
        const snippet = source.snippet ? `\nSnippet: ${source.snippet}` : "";
        return `${index + 1}. ${title}\nURL: ${source.url}${snippet}`;
      })
      .join("\n\n");

    const response = await this.deps.createChatCompletion(
      {
        providerId: input.providerId,
        model: input.model,
        messages: [
          {
            role: "system",
            content:
              "You are a concise research analyst. Summarize the findings in plain English and cite by source number.",
          },
          {
            role: "user",
            content: `Research query: ${input.query}\nMode: ${input.mode}\n\nSources:\n${sourceLines}`,
          },
        ],
        memory: {
          enabled: false,
          mode: "off",
        },
        stream: false,
      },
      createUtilityModelUsageAttribution({
        operationId: `research:${encodeURIComponent(input.runId)}:summary`,
        utilityKind: "research_summary",
        requestedProviderId: input.providerId,
        requestedModelId: input.model,
        lineage: {
          workspaceId: input.trustedWorkspaceId,
          sessionId: input.sessionId,
          durableRunId: input.trustedRunId,
          taskId: input.trustedTaskId,
          agentId: "research",
          parentOperationId: `research:${encodeURIComponent(input.runId)}`,
        },
      }),
    );

    const content = extractAssistantText(response);
    return content || "Research completed, but no summary text was generated.";
  }
}

function extractAssistantText(response: ChatCompletionResponse): string {
  const message = response.choices?.[0]?.message as Record<string, unknown> | undefined;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const part = item as Record<string, unknown>;
        return typeof part.text === "string" ? part.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}
