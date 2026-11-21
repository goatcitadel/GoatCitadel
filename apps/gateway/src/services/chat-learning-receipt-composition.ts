import {ChatLearningReceiptService} from "./chat-learning-receipt-service.js";
import type {GatewayRouteCompositionPort} from "./gateway-route-composition-port.js";
export function createChatLearningReceiptForGateway(gateway:Pick<GatewayRouteCompositionPort,"storage"|"config"|"memoryLifecycleService"|"readFeatureFlags">){
  return new ChatLearningReceiptService({storage:gateway.storage,memory:gateway.memoryLifecycleService,readMemoryReady:async sessionId=>{
    const [prefs,flags]=await Promise.all([gateway.storage.chatSessionPrefs.get(sessionId),gateway.readFeatureFlags()]);
    return Boolean(gateway.config.assistant.memory.enabled && gateway.config.assistant.memory.qmd.enabled && gateway.config.assistant.memory.qmd.applyToChat && flags.memoryLifecycleAdminV1Enabled && prefs?.memoryMode!=="off");
  }});
}
