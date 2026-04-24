import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const secretsRouteMethods = ["deleteProviderSecret", "getProviderSecretStatus", "saveProviderSecret"] as const;

export type SecretsRouteMethod = (typeof secretsRouteMethods)[number];
export type SecretsRoutePort = RoutePort<SecretsRouteMethod>;
export type SecretsRouteService = RouteService<SecretsRouteMethod>;

export function createSecretsRouteService(port: SecretsRoutePort): SecretsRouteService {
  return createRouteService(port, secretsRouteMethods);
}
