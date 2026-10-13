import { resolveNativeMcpChatToolBinding } from "./gateway/native-mcp-chat-binding.js";
import { resolveMeshChatToolBinding } from "./gateway/mesh-chat-binding.js";

export interface RemoteWorkerNativeBindingHost {
  storage: Parameters<typeof resolveNativeMcpChatToolBinding>[0];
  restoreRequesterAdmissionSchemas?: Parameters<typeof resolveNativeMcpChatToolBinding>[3];
}
export interface RemoteWorkerMeshBindingHost {
  storage: Parameters<typeof resolveMeshChatToolBinding>[0]["storage"];
  activations: Parameters<typeof resolveMeshChatToolBinding>[0]["activations"];
  restoreMeshAdmissionSchemas?: Parameters<typeof resolveMeshChatToolBinding>[0]["restoreAdmissionSchemas"];
}

/** Workers restore bindings through Gateway-owned schema receipts before entering effects. */
export function resolveRemoteWorkerNativeBinding(
  host: RemoteWorkerNativeBindingHost,
  request: Parameters<typeof resolveNativeMcpChatToolBinding>[1],
  handle: Parameters<typeof resolveNativeMcpChatToolBinding>[2],
) {
  return resolveNativeMcpChatToolBinding(host.storage, request, handle, host.restoreRequesterAdmissionSchemas);
}
export function resolveRemoteWorkerMeshBinding(
  host: RemoteWorkerMeshBindingHost,
  request: Parameters<typeof resolveMeshChatToolBinding>[1],
  handle: Parameters<typeof resolveMeshChatToolBinding>[2],
) {
  return resolveMeshChatToolBinding(
    { storage: host.storage, activations: host.activations, restoreAdmissionSchemas: host.restoreMeshAdmissionSchemas },
    request,
    handle,
  );
}
