import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const llmRouteMethods = [
  "createChatCompletion",
  "generateImage",
  "getLlmConfigWithDetails",
  "getOpenAICodexOAuthStatus",
  "getProviderAdvice",
  "exportLlmEvalProofRuns",
  "listLlmEvalProofRuns",
  "listLlmLocalEngines",
  "listLlmModels",
  "listLlmProviders",
  "listLlmRuntimeMeasurements",
  "pollOpenAICodexOAuthDeviceFlow",
  "previewLlmModels",
  "runLlmEvalProof",
  "startOpenAICodexOAuthDeviceFlow",
  "deleteOpenAICodexOAuthCredential",
  "updateLlmConfig",
] as const;

export type LlmRouteMethod = (typeof llmRouteMethods)[number];
export type LlmRoutePort = RoutePort<LlmRouteMethod>;
export type LlmRouteService = RouteService<LlmRouteMethod>;

export function createLlmRouteService(port: LlmRoutePort): LlmRouteService {
  return createRouteService(port, llmRouteMethods);
}
