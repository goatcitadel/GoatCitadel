import { expect, vi } from "vitest";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  createChatSideChat,
  getChatSideChat,
  listChatSessions,
  type ChatSessionDependencies,
} from "../services/chat-session-service.js";

export function createSideChatTestDeps(asyncStorage: AsyncStorage): ChatSessionDependencies {
  const deps: ChatSessionDependencies = {
    storage: asyncStorage,
    operatorSummaryCache: {
      invalidate: vi.fn(),
    },
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
    ensureChatSessionRuntimeGrants: vi.fn(),
    requireChatSession: vi.fn(),
    getSession: (sessionId: string) => asyncStorage.sessions.getBySessionId(sessionId),
    publishRealtime: vi.fn(),
    clearChatTurnWriteLease: vi.fn(),
    removeChatSessionStoredFile: vi.fn(),
    copyChatSessionStoredFile: vi.fn(),
    getChatSessionModelDefaults: () => ({
      providerId: undefined,
      model: undefined,
      thinkingLevel: "standard" as const,
    }),
    ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
    hydrateChatPrefsWithAutonomy: async (_sessionId, prefs) => prefs,
    patchSessionAutonomyPrefs: vi.fn(),
  };
  deps.requireChatSession = vi.fn(async (sessionId: string) => {
    const workspaceId = (await asyncStorage.chatSessionMeta.get(sessionId))?.workspaceId ?? "default";
    const session = (
      await listChatSessions(deps, {
        workspaceId,
        scope: "all",
        view: "all",
        includeHidden: true,
        limit: 1000,
      })
    ).find((record) => record.sessionId === sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  });
  return deps;
}

export async function expectSideChatConvergence(
  first: ChatSessionDependencies,
  second: ChatSessionDependencies,
  parentSessionId: string,
): Promise<void> {
  const results = await Promise.all([
    createChatSideChat(first, parentSessionId, { sourceTurnId: "first-turn" }),
    createChatSideChat(second, parentSessionId, { sourceTurnId: "second-turn" }),
  ]);
  const canonical = await getChatSideChat(second, parentSessionId);
  const childSessionId = canonical.childSession?.sessionId;
  expect(childSessionId).toBeTruthy();
  expect(results.map(({ childSession }) => childSession.sessionId)).toEqual([childSessionId, childSessionId]);
  expect(results[0].item).toEqual(results[1].item);
  expect(canonical.item).toEqual(results[0].item);
  expect(await createChatSideChat(first, parentSessionId, { sourceTurnId: "reopen" })).toEqual(canonical);
  expect((await listChatSessions(first, { includeHidden: true })).map(({ sessionId }) => sessionId).sort()).toEqual(
    [parentSessionId, childSessionId].sort(),
  );
  const publishers = new Set([first.publishRealtime, second.publishRealtime]);
  const events = [...publishers].flatMap((publish) => vi.mocked(publish).mock.calls);
  expect(events.filter(([, , event]) => event.type === "chat_side_chat_created")).toHaveLength(1);
}
