import { createGatewayRouteServices, type GatewayRouteServices } from "./gateway-route-services.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import { composeChatRouteDependencies } from "./gateway-route-composition-chat.js";
import { composeIntegrationChannelRouteDependencies } from "./gateway-route-composition-integrations.js";
import { composeRuntimeAdminRouteDependencies } from "./gateway-route-composition-runtime.js";
import { composeMemoryKnowledgeRouteDependencies } from "./gateway-route-composition-memory.js";
import { composeToolsMcpRouteDependencies } from "./gateway-route-composition-tools.js";
import { composeSystemRouteDependencies } from "./gateway-route-composition-system.js";

export {
  createGatewayRouteCompositionPort,
  type GatewayRouteCompositionHost,
  type GatewayRouteCompositionPort,
  type GatewayRouteCompositionPrivateDependencies,
} from "./gateway-route-composition-port.js";
export {
  createChatThreadKnowledgeDependenciesForGateway,
  createSettingsAuthRuntimeDependenciesForGateway,
  createSettingsRuntimeDependenciesForGateway,
} from "./gateway-route-composition-shared.js";
export {
  createCommsHostForGateway,
  createIntegrationChannelServiceForGateway,
  createIntegrationDiagnosticsServiceForGateway,
} from "./gateway-route-composition-integrations.js";

export function composeGatewayRouteServices(gateway: GatewayRouteCompositionPort): GatewayRouteServices {
  return createGatewayRouteServices({
    ...composeChatRouteDependencies(gateway),
    ...composeIntegrationChannelRouteDependencies(gateway),
    ...composeRuntimeAdminRouteDependencies(gateway),
    ...composeMemoryKnowledgeRouteDependencies(gateway),
    ...composeToolsMcpRouteDependencies(gateway),
    ...composeSystemRouteDependencies(gateway),
  });
}
