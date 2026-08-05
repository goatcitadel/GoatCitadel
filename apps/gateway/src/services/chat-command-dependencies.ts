import * as chatCommandService from "./chat-command-service.js";
import { undoChatTurns, type ChatTurnUndoDependencies } from "./chat-turn-undo-service.js";

type ChatCommandAsyncAdapterKey = "getSettings" | "listMemoryItems" | "normalizeWorkspaceId";

type ChatCommandDependencySource = Omit<
  chatCommandService.ChatCommandDependencies,
  "undoChatTurns" | ChatCommandAsyncAdapterKey
> &
  ChatTurnUndoDependencies;

export type ChatCommandAsyncAdapters = Pick<chatCommandService.ChatCommandDependencies, ChatCommandAsyncAdapterKey>;

export function createChatCommandDependencies(
  source: ChatCommandDependencySource,
  asyncAdapters: ChatCommandAsyncAdapters,
): chatCommandService.ChatCommandDependencies {
  const undoDeps = source;
  const commandDeps = Object.create(source) as chatCommandService.ChatCommandDependencies;
  commandDeps.undoChatTurns = (sessionId, count, options) => undoChatTurns(undoDeps, sessionId, count, options);
  commandDeps.getSettings = () => asyncAdapters.getSettings();
  commandDeps.listMemoryItems = (input) => asyncAdapters.listMemoryItems(input);
  commandDeps.normalizeWorkspaceId = (workspaceId) => asyncAdapters.normalizeWorkspaceId(workspaceId);
  const boundFunctions = new Map<unknown, unknown>();
  return new Proxy(commandDeps, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      const cached = boundFunctions.get(value);
      if (cached) {
        return cached;
      }

      const bound = value.bind(source);
      boundFunctions.set(value, bound);
      return bound;
    },
  });
}
