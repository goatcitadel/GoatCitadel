// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { resetCommandNewChatForTests, useCommandNewChat } from "./use-command-new-chat";

const api = vi.hoisted(() => ({ verify: vi.fn(), create: vi.fn(), read: vi.fn() }));
vi.mock("./command-palette-search", () => ({ assertPaletteWorkspace: api.verify }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  createChatSession: api.create,
  fetchChatSessionStatus: api.read,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => "http://synthetic.invalid" }));
const scope = { workspaceId: "workspace-a", citadelId: "citadel-a" };
const created: ChatSessionRecord = {
  sessionId: "created-session",
  revision: 1,
  sessionKey: "mission:created-session",
  workspaceId: scope.workspaceId,
  scope: "mission",
  mode: "chat",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "local",
  updatedAt: "2026-09-30T00:00:00Z",
  lastActivityAt: "2026-09-30T00:00:00Z",
  tokenTotal: 0,
  costUsdTotal: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
let root: Root, element: HTMLDivElement, owner: ReturnType<typeof useCommandNewChat>;
const navigate = vi.fn();
function Probe({
  workspaceId = scope.workspaceId,
  citadelId = scope.citadelId,
  open = true,
}: {
  workspaceId?: string;
  citadelId?: string;
  open?: boolean;
}) {
  owner = useCommandNewChat({ workspaceId, citadelId }, open, navigate);
  return <p>{owner.attempt?.message}</p>;
}
beforeEach(() => {
  vi.clearAllMocks();
  navigate.mockReset();
  resetCommandNewChatForTests();
  api.verify.mockResolvedValue(undefined);
  api.create.mockResolvedValue(created);
  api.read.mockResolvedValue({ sessionId: created.sessionId, workspaceId: scope.workspaceId });
  element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  act(() => {
    root.render(<Probe />);
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  element.remove();
});

describe("explicit palette New chat", () => {
  it("admits one request, verifies exact canonical identity, then navigates without sending", async () => {
    const pending = deferred<ChatSessionRecord>();
    api.create.mockReturnValue(pending.promise);
    let first!: Promise<void>, duplicate!: Promise<void>;
    await act(async () => {
      first = owner.create();
      duplicate = owner.create();
      await Promise.resolve();
    });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith(
      { ...scope, mode: "chat", includeInHistory: true },
      { originSurface: "chat" },
    );
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(created);
      await first;
      await duplicate;
    });
    expect(api.read).toHaveBeenCalledWith(created.sessionId, expect.any(AbortSignal));
    expect(navigate).toHaveBeenCalledWith(created.sessionId);
    expect(owner.attempt?.state).toBe("confirmed");
  });

  it("cancels a deferred preflight after scope ABA or palette close, before any POST", async () => {
    const pending = deferred<void>();
    api.verify.mockReturnValue(pending.promise);
    let request!: Promise<void>;
    act(() => {
      request = owner.create();
    });
    act(() => {
      root.render(<Probe workspaceId="workspace-b" />);
    });
    act(() => {
      root.render(<Probe />);
    });
    await act(async () => {
      pending.resolve();
      await request;
    });
    expect(api.create).not.toHaveBeenCalled();
    expect(owner.blocked).toBe(false);
  });

  it("retains a lost acknowledgement lock across unmount and does not retry creation", async () => {
    api.create.mockRejectedValue(new Error("Response lost"));
    await act(async () => {
      await owner.create();
    });
    act(() => {
      root.unmount();
    });
    root = createRoot(element);
    act(() => {
      root.render(<Probe />);
    });
    await act(async () => {
      await owner.create();
    });
    expect(owner.attempt?.state).toBe("unknown");
    expect(owner.blocked).toBe(true);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("acknowledges the origin after a late confirmed save without navigating a newer scope", async () => {
    const pending = deferred<ChatSessionRecord>();
    api.create.mockReturnValue(pending.promise);
    let request!: Promise<void>;
    await act(async () => {
      request = owner.create();
      await Promise.resolve();
    });
    act(() => {
      root.render(<Probe workspaceId="workspace-b" />);
    });
    await act(async () => {
      pending.resolve(created);
      await request;
    });
    expect(navigate).not.toHaveBeenCalled();
    act(() => {
      root.render(<Probe />);
    });
    expect(owner.attempt?.state).toBe("confirmed");
    expect(owner.attempt?.sessionId).toBe(created.sessionId);
  });

  it("withholds mismatched receipts and canonical readbacks as unknown outcomes", async () => {
    api.read.mockResolvedValue({ sessionId: created.sessionId, workspaceId: "foreign" });
    await act(async () => {
      await owner.create();
    });
    expect(owner.attempt?.state).toBe("unknown");
    expect(navigate).not.toHaveBeenCalled();
    resetCommandNewChatForTests();
    api.create.mockResolvedValue({ ...created, workspaceId: "foreign" });
    api.read.mockClear();
    await act(async () => {
      await owner.create();
    });
    expect(api.read).not.toHaveBeenCalled();
    expect(owner.attempt?.state).toBe("unknown");
  });

  it("rejects an old rendered action before any read or write in a new scope", async () => {
    const retained = owner.create;
    act(() => {
      root.render(<Probe workspaceId="workspace-b" />);
    });
    await act(async () => {
      await retained();
    });
    expect(api.verify).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("retains the unknown lock for a workspace moved to another Citadel after dispatch", async () => {
    api.verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Workspace moved"));
    await act(async () => {
      await owner.create();
    });
    expect(owner.attempt?.state).toBe("unknown");
    expect(owner.attempt?.sessionId).toBe(created.sessionId);
    expect(navigate).not.toHaveBeenCalled();
    act(() => {
      root.render(<Probe citadelId="citadel-b" />);
    });
    await act(async () => {
      await owner.create();
    });
    expect(owner.blocked).toBe(true);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("keeps independently verified creation confirmed when navigation throws", async () => {
    navigate.mockImplementation(() => {
      throw new Error("Presentation failed");
    });
    await act(async () => {
      await owner.create();
    });
    expect(api.verify).toHaveBeenCalledTimes(2);
    expect(owner.attempt?.state).toBe("confirmed");
    expect(owner.attempt?.message).toContain("Opening it failed");
    expect(owner.attempt?.sessionId).toBe(created.sessionId);
  });
});
