import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const knowledgeRouteMethods = [
  "knowledgeDocsIngest",
  "knowledgeEmbeddingsIndex",
  "knowledgeEmbeddingsQuery",
  "knowledgeMemorySearch",
  "knowledgeMemoryWrite",
] as const;

export type KnowledgeRouteMethod = (typeof knowledgeRouteMethods)[number];
export type KnowledgeRoutePort = RoutePort<KnowledgeRouteMethod>;
export type KnowledgeRouteService = RouteService<KnowledgeRouteMethod>;

export function createKnowledgeRouteService(port: KnowledgeRoutePort): KnowledgeRouteService {
  return createRouteService(port, knowledgeRouteMethods);
}
