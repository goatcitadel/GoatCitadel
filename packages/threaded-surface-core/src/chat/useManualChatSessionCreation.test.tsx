// @vitest-environment happy-dom
import React, { StrictMode, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { ChatSessionsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { beginChatSessionCreation, chatSessionCreationKey, readChatSessionCreation, resetChatSessionCreationForTests } from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { useManualChatSessionCreation } from "./useManualChatSessionCreation";

const api = vi.hoisted(() => ({ create: vi.fn(), status: vi.fn(), installation: "http://gateway.invalid" }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ createChatSession: api.create, fetchChatSessionStatus: api.status }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.installation }));
const session: ChatSessionRecord = {
  sessionId: "new-chat", revision: 1, sessionKey: "mission:operator:new", workspaceId: "workspace-a", scope: "mission",
  mode: "chat", includeInHistory: true, pinned: false, lifecycleStatus: "active", projectId: "project-a", channel: "mission",
  account: "operator", updatedAt: "2026-10-01T00:00:00Z", lastActivityAt: "2026-10-01T00:00:00Z", tokenTotal: 0, costUsdTotal: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let control: ReturnType<typeof useManualChatSessionCreation>;
let snapshot: { selected: string | null; sessions: ChatSessionsResponse | null; error: string | null; history: "active" | "archived" };
let renderer: ReactTestRenderer | undefined;
const onCreated = vi.fn();
function Harness({ viewIdentity = "citadel-a", workspaceId = "workspace-a", projectId = "project-a", selection = "prior" }: {
  viewIdentity?: string; workspaceId?: string; projectId?: string; selection?: string;
}) {
  const [selected, setSelected] = useState<string | null>(selection);
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<"active" | "archived">("archived");
  control = useManualChatSessionCreation({ workspaceId, viewIdentity, selectedProjectId: projectId, selectedSessionId: selection,
    historyView: history, setSessions, setHistoryView: setHistory, setSelectedSessionId: setSelected, setError, onSessionCreated: onCreated });
  snapshot = { selected, sessions, error, history };
  return null;
}
const key = () => chatSessionCreationKey(api.installation, "workspace-a");
beforeEach(() => {
  vi.clearAllMocks(); resetChatSessionCreationForTests(); api.installation = "http://gateway.invalid";
  window.history.replaceState(null, "", "/chat?shell=cockpit");
  api.create.mockResolvedValue(session); api.status.mockResolvedValue({ sessionId: session.sessionId, workspaceId: session.workspaceId });
});
afterEach(async () => { if (renderer) await act(async () => { renderer!.unmount(); }); renderer = undefined; });
async function mount() { await act(async () => { renderer = create(<StrictMode><Harness /></StrictMode>); }); }

describe("manual conversation creation owner", () => {
  it("inserts the verified canonical session once and delegates hydration to ordinary selection", async () => {
    await mount(); const read = deferred<{ sessionId: string; workspaceId: string }>(); api.status.mockReturnValueOnce(read.promise);
    let pending!: Promise<void>;
    await act(async () => { pending = control.create("chat"); });
    expect(snapshot.sessions).toBeNull(); expect(snapshot.selected).toBe("prior");
    await act(async () => { await control.create("chat"); }); expect(api.create).toHaveBeenCalledTimes(1);
    await act(async () => { read.resolve({ sessionId: session.sessionId, workspaceId: "workspace-a" }); await pending; });
    expect(snapshot).toMatchObject({ selected: session.sessionId, history: "active", sessions: { items: [session] } });
    expect(api.create).toHaveBeenCalledWith({ workspaceId: "workspace-a", projectId: "project-a", mode: "chat" }, { originSurface: "chat" });
    expect(api.status).toHaveBeenCalledWith(session.sessionId, expect.any(AbortSignal));
    expect(onCreated).toHaveBeenCalledOnce(); expect(readChatSessionCreation(key())?.state).toBe("confirmed");
  });

  it.each(["workspace", "citadel", "project", "selection", "navigation", "installation", "unmount"])("refuses old %s callbacks before creating", async (kind) => {
    await mount(); const old = control.create;
    if (kind === "citadel") { await act(async () => { renderer!.update(<StrictMode><Harness viewIdentity="citadel-b" /></StrictMode>); }); await act(async () => { renderer!.update(<StrictMode><Harness /></StrictMode>); }); }
    if (kind === "workspace") { await act(async () => { renderer!.update(<StrictMode><Harness workspaceId="workspace-b" /></StrictMode>); }); await act(async () => { renderer!.update(<StrictMode><Harness /></StrictMode>); }); }
    if (kind === "project") { await act(async () => { renderer!.update(<StrictMode><Harness projectId="project-b" /></StrictMode>); }); await act(async () => { renderer!.update(<StrictMode><Harness /></StrictMode>); }); }
    if (kind === "selection") { await act(async () => { renderer!.update(<StrictMode><Harness selection="other" /></StrictMode>); }); await act(async () => { renderer!.update(<StrictMode><Harness /></StrictMode>); }); }
    if (kind === "navigation") { window.history.pushState(null, "", "/work"); window.dispatchEvent(new Event("goatcitadel:cockpit-location")); window.history.replaceState(null, "", "/chat?shell=cockpit"); window.dispatchEvent(new Event("goatcitadel:cockpit-location")); }
    if (kind === "installation") api.installation = "http://other.invalid";
    if (kind === "unmount") await act(async () => { renderer!.unmount(); renderer = undefined; });
    await act(async () => { await old("chat"); }); expect(api.create).not.toHaveBeenCalled();
  });

  it.each(["workspace", "citadel", "navigation", "unmount"])("records a dispatched result after %s without selecting it", async (kind) => {
    await mount(); const receipt = deferred<ChatSessionRecord>(); api.create.mockReturnValueOnce(receipt.promise); let pending!: Promise<void>;
    await act(async () => { pending = control.create("chat"); });
    if (kind === "citadel") { await act(async () => { renderer!.update(<StrictMode><Harness viewIdentity="citadel-b" /></StrictMode>); }); await act(async () => { renderer!.update(<StrictMode><Harness /></StrictMode>); }); }
    if (kind === "workspace") { await act(async () => { renderer!.update(<StrictMode><Harness workspaceId="workspace-b" /></StrictMode>); }); await act(async () => { renderer!.update(<StrictMode><Harness /></StrictMode>); }); }
    if (kind === "navigation") { window.dispatchEvent(new Event("popstate")); }
    if (kind === "unmount") await act(async () => { renderer!.unmount(); renderer = undefined; });
    await act(async () => { receipt.resolve(session); await pending; });
    expect(readChatSessionCreation(key())?.state).toBe("confirmed"); expect(onCreated).not.toHaveBeenCalled(); expect(snapshot.selected).toBe("prior");
  });

  it.each(["response-loss", "foreign-receipt", "foreign-status"])("retains %s across remount and other entry admission", async (failure) => {
    await mount();
    if (failure === "response-loss") api.create.mockRejectedValueOnce(new Error("connection lost"));
    if (failure === "foreign-receipt") api.create.mockResolvedValueOnce({ ...session, workspaceId: "foreign" });
    if (failure === "foreign-status") api.status.mockResolvedValueOnce({ sessionId: "foreign", workspaceId: "workspace-a" });
    await act(async () => { await control.create("chat"); });
    await act(async () => { renderer!.unmount(); renderer = undefined; }); await mount();
    await act(async () => { await control.create("chat"); });
    expect(api.create).toHaveBeenCalledTimes(1); expect(snapshot.error).toContain("unconfirmed");
    await act(async () => { renderer!.update(<StrictMode><Harness viewIdentity="citadel-b" /></StrictMode>); });
    await act(async () => { await control.create("chat"); });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(beginChatSessionCreation(key(), { state: "checking", mode: "chat", message: "Palette" })).toBe(false);
  });

  it("preserves confirmed owner truth when opening the conversation throws", async () => {
    await mount(); onCreated.mockImplementationOnce(() => { throw new Error("view failure"); });
    await act(async () => { await control.create("chat"); });
    expect(readChatSessionCreation(key())?.state).toBe("confirmed"); expect(snapshot.error).toContain("created and verified");
  });
});
