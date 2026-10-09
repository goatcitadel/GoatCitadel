// @vitest-environment happy-dom
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { OutboundQueueItem } from "../useChatSurfaceOrchestration";
import { resetChatSessionCreationForTests } from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { createQueueStorageKey } from "../useChatLocalPersistence";
import {
  api,
  CREATED,
  FIRST_ROUTE,
  QUEUED_ROUTE,
  LATER_ROUTE,
  deferred,
  Harness,
  latest,
} from "./first-send-queue.test-support";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  resetChatSessionCreationForTests();
  api.fetchChatSessionStatus.mockResolvedValue({ sessionId: CREATED.sessionId, workspaceId: CREATED.workspaceId });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network is forbidden in the queue composition regression.");
    }),
  );
  window.localStorage.clear();
  api.fetchChatPendingApprovals.mockResolvedValue({ items: [] });
  api.fetchChatSessionGoal.mockResolvedValue({ goal: null });
  api.loadSidebar.mockResolvedValue(undefined);
  api.loadSessionCoreState.mockResolvedValue(undefined);
  api.preflight.mockResolvedValue(null);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  window.localStorage.clear();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("first-session send and queue restoration composition", () => {
  it.each([
    { label: "ordinary navigation", creation: null, workspaceId: CREATED.workspaceId! },
    {
      label: "a foreign creation marker",
      creation: { workspaceId: "foreign", sessionId: "existing" },
      workspaceId: CREATED.workspaceId!,
    },
    {
      label: "workspace navigation",
      creation: { workspaceId: CREATED.workspaceId!, sessionId: "existing" },
      workspaceId: "foreign",
    },
  ])("does not transfer the new-conversation queue during $label", async ({ creation, workspaceId }) => {
    const queued: OutboundQueueItem = {
      id: "queue-new-scope",
      action: "send",
      content: "Keep in its original scope",
      attachments: [],
      paused: true,
      createdAt: "2026-09-30T12:00:00.000Z",
      requestPrefs: {
        mode: "chat",
        providerId: "provider-new",
        model: "model-new",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        speedMode: "standard",
        subagentPolicy: "ask_when_useful",
        fullWebAccess: false,
      },
    };
    window.localStorage.setItem(createQueueStorageKey(CREATED.workspaceId!, null), JSON.stringify([queued]));
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(latest.queue.map((item) => item.id)).toEqual([queued.id]);
    await act(async () => {
      latest.markCreation(creation);
      latest.navigate("existing", workspaceId);
    });
    expect(latest.queue).toEqual([]);
    expect(latest.getCreation()).toBeNull();
    expect(api.createChatSession).not.toHaveBeenCalled();
    expect(api.sendAgentChatMessage).not.toHaveBeenCalled();
  });

  it("does not publish or send a late session creation after the operator changed workspace", async () => {
    const creation = deferred<ChatSessionRecord>();
    api.createChatSession.mockReturnValue(creation.promise);
    await act(async () => {
      renderer = create(<Harness />);
    });
    act(() => latest.setDraft("First workspace message"));
    let sending!: Promise<void>;
    await act(async () => {
      sending = latest.send();
    });
    act(() => latest.setDraft("Queued first workspace message"));
    await act(async () => latest.send());
    await act(async () => latest.navigate("other-conversation", "other-workspace"));
    await act(async () => {
      creation.resolve(CREATED);
      await sending;
    });
    expect(latest.sessionId).toBe("other-conversation");
    expect(latest.getCreation()).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(createQueueStorageKey(CREATED.workspaceId!, null)) ?? "[]")).toEqual([
      expect.objectContaining({ content: "Queued first workspace message" }),
    ]);
    expect(latest.queue).toEqual([]);
    expect(latest.draft).toBe("");
    expect(api.sendAgentChatMessage).not.toHaveBeenCalled();
  });

  it.each([
    { timing: "before assignment", sendOnAssignment: false },
    { timing: "between assignment and hydration", sendOnAssignment: true },
  ])("keeps the follow-up exactly once when queued $timing", async ({ sendOnAssignment }) => {
    const creation = deferred<ChatSessionRecord>();
    const firstResponse = deferred<{ userMessage: { messageId: string } }>();
    const secondResponse = deferred<{ userMessage: { messageId: string } }>();
    api.createChatSession.mockReturnValue(creation.promise);
    api.sendAgentChatMessage
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
      .mockResolvedValue({ userMessage: { messageId: "user-restored" } });
    const stored: OutboundQueueItem = {
      id: "queue-stored",
      action: "send",
      sessionId: CREATED.sessionId,
      content: "Previously collected",
      attachments: [],
      paused: true,
      createdAt: "2026-09-30T12:00:00.000Z",
      requestPrefs: {
        mode: "chat",
        providerId: "provider-stored",
        model: "model-stored",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        speedMode: "standard",
        subagentPolicy: "ask_when_useful",
        fullWebAccess: false,
      },
    };
    window.localStorage.setItem(
      createQueueStorageKey(CREATED.workspaceId!, CREATED.sessionId),
      JSON.stringify([stored]),
    );
    await act(async () => {
      renderer = create(<Harness sendOnAssignment={sendOnAssignment} />);
    });
    act(() => latest.setDraft("First message"));
    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = latest.send();
    });
    expect(api.createChatSession).toHaveBeenCalledTimes(1);
    expect(latest.sending).toBe(true);
    expect(api.sendAgentChatMessage).not.toHaveBeenCalled();
    act(() => {
      latest.setDraft("Second message");
      latest.setRoute(QUEUED_ROUTE);
    });
    if (!sendOnAssignment) {
      await act(async () => latest.send());
      expect(latest.queue.map((item) => item.content)).toEqual(["Second message"]);
      expect(latest.queue[0]?.sessionId).toBeUndefined();
    }
    await act(async () => {
      creation.resolve(CREATED);
    });
    expect(latest.sessionId).toBe(CREATED.sessionId);
    expect(latest.getCreation()).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(createQueueStorageKey(CREATED.workspaceId!, null)) ?? "[]")).toEqual(
      [],
    );
    expect(api.createChatSession).toHaveBeenCalledTimes(1);
    expect(api.sendAgentChatMessage).toHaveBeenCalledTimes(1);
    expect(latest.queue.map((item) => item.content)).toEqual(["Previously collected", "Second message"]);
    expect(latest.queue.map((item) => item.sessionId)).toEqual([CREATED.sessionId, CREATED.sessionId]);
    act(() => latest.setRoute(LATER_ROUTE));
    await act(async () => {
      firstResponse.resolve({ userMessage: { messageId: "user-first" } });
      await firstSend;
    });
    expect(api.sendAgentChatMessage).toHaveBeenCalledTimes(2);
    expect(
      api.sendAgentChatMessage.mock.calls.map(([sessionId, input]) => ({
        sessionId,
        content: input.content,
        providerId: input.providerId,
        model: input.model,
        fullWebAccess: Boolean(input.fullWebAccess),
      })),
    ).toEqual([
      { sessionId: CREATED.sessionId, content: "First message", ...FIRST_ROUTE },
      { sessionId: CREATED.sessionId, content: "Second message", ...QUEUED_ROUTE },
    ]);
    expect(latest.queue.map((item) => item.id)).toEqual([stored.id]);
    await act(async () => {
      secondResponse.resolve({ userMessage: { messageId: "user-second" } });
    });
    expect(latest.sending).toBe(false);
    expect(latest.error).toBeNull();
    act(() => latest.resumeQueue());
    await act(async () => undefined);
    expect(api.createChatSession).toHaveBeenCalledTimes(1);
    expect(api.sendAgentChatMessage).toHaveBeenCalledTimes(3);
    expect(api.sendAgentChatMessage.mock.calls[2]).toEqual([
      CREATED.sessionId,
      expect.objectContaining({ content: stored.content, providerId: "provider-stored", model: "model-stored" }),
      { originSurface: "chat" },
    ]);
    expect(latest.queue).toEqual([]);
    expect(latest.sending).toBe(false);
    expect(api.preflight.mock.calls.map(([input]) => input.requestPrefs?.model)).toEqual([
      "model-first",
      "model-queued",
      "model-stored",
    ]);
  });
});

it("collects, removes, recollects and preserves the original caller queue across pagehide before one explicit resume", async () => {
  setGatewayCallerScope("queue-actor-a");
  api.sendAgentChatMessage.mockResolvedValue({ userMessage: { messageId: "resumed-once" } });
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => latest.navigate(CREATED.sessionId));
  await act(async () => latest.setDraft("/queue collect Remove this"));
  await act(async () => latest.sendIntent());
  expect(latest.queue.map((item) => item.content)).toEqual(["Remove this"]);
  await act(async () => latest.removeQueue(latest.queue[0]!.id));
  expect(latest.queue).toEqual([]);
  await act(async () => latest.setDraft("/queue collect Retain this"));
  await act(async () => latest.sendIntent());
  expect(latest.queue.map((item) => item.content)).toEqual(["Retain this"]);
  expect(latest.draft).toBe(""); expect(api.sendAgentChatMessage).not.toHaveBeenCalled();
  const originalKey = createQueueStorageKey(CREATED.workspaceId!, CREATED.sessionId);
  // Reload/page navigation does not run React cleanup. Flush the captured key,
  // even if identity changes immediately before the browser lifecycle event.
  setGatewayCallerScope("queue-actor-b");
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(JSON.parse(window.localStorage.getItem(originalKey) ?? "[]").map((item: OutboundQueueItem) => item.content)).toEqual(["Retain this"]);
  expect(window.localStorage.getItem(createQueueStorageKey(CREATED.workspaceId!, CREATED.sessionId))).toBeNull();
  await act(async () => renderer!.unmount()); renderer = undefined;
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => latest.navigate(CREATED.sessionId));
  expect(latest.queue).toEqual([]);
  await act(async () => renderer!.unmount()); renderer = undefined;
  setGatewayCallerScope("queue-actor-a");
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => latest.navigate(CREATED.sessionId));
  expect(latest.queue).toHaveLength(1); expect(latest.queue[0]!.paused).toBe(true);
  expect(api.sendAgentChatMessage).not.toHaveBeenCalled();
  await act(async () => latest.resumeQueue());
  expect(api.sendAgentChatMessage).toHaveBeenCalledTimes(1);
  expect(api.sendAgentChatMessage.mock.calls[0]?.[1].content).toBe("Retain this");
  expect(latest.queue).toEqual([]);
  await act(async () => renderer!.unmount()); renderer = undefined;
  setGatewayCallerScope("");
});


it.each([false, true])("retains new parent input across delayed side opening (handoff %s)", async (handoff) => {
  const opening = deferred<void>();
  api.openBtwSideChat.mockReturnValue(opening.promise);
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => latest.setDraft("/btw Side question"));
  const originalIntent = latest.sendIntent;
  let pending!: Promise<void>;
  await act(async () => { pending = latest.sendIntent(); });
  expect(latest.draft).toBe("");
  expect(api.openBtwSideChat).toHaveBeenCalledExactlyOnceWith("Side question");
  if (handoff) await act(async () => latest.navigate("other-parent", "other-workspace"));
  await act(async () => latest.setDraft("New parent input"));
  await act(async () => { opening.resolve(); await pending; });
  expect(latest.draft).toBe("New parent input");
  expect(api.sendAgentChatMessage).not.toHaveBeenCalled();
  if (handoff) {
    await act(async () => originalIntent());
    expect(api.openBtwSideChat).toHaveBeenCalledTimes(1);
    expect(latest.draft).toBe("New parent input");
  }
});
