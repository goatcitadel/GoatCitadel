import fp from "fastify-plugin";
import type { GatewayRouteServices } from "../services/gateway-route-services.js";

declare module "fastify" {
  interface FastifyInstance {
    services: GatewayRouteServices;
  }
}

export const routeServicesPlugin = fp(async (fastify) => {
  fastify.decorate("services", fastify.gatewayRuntime.routeServices);
});
