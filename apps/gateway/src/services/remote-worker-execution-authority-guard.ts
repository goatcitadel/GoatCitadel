import type { AsyncStorage } from "@goatcitadel/storage";
import {
  resolveRemoteWorkerChatAuthority,
  type RemoteWorkerChatAuthorityDependencies,
  type RemoteWorkerChatExecution,
} from "./remote-worker-chat-authority.js";
/** Re-read protected assignment authority after resolving the live Chat admission. */
export async function revalidateRemoteWorkerExecutionAuthority(
  dependencies: RemoteWorkerChatAuthorityDependencies & {
    storage: RemoteWorkerChatAuthorityDependencies["storage"] & Pick<AsyncStorage, "remoteWorkerAssignments">;
  },
  command: Parameters<AsyncStorage["remoteWorkerAssignments"]["resolveActiveChatExecution"]>[0] & {
    protectedAuthority: Parameters<AsyncStorage["remoteWorkerAssignments"]["resolveActiveChatExecution"]>[1];
  },
  execution: RemoteWorkerChatExecution,
  changedMessage: string,
) {
  return resolveRemoteWorkerChatAuthority(dependencies, execution, async () => {
    const current = await dependencies.storage.remoteWorkerAssignments.resolveActiveChatExecution(
      command,
      command.protectedAuthority,
    );
    if (current.workload.workloadSha256 !== execution.workload.workloadSha256) throw new Error(changedMessage);
  });
}
