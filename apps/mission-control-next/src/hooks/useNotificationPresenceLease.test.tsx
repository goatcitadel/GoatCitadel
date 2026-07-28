// @vitest-environment happy-dom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationPresenceLease } from "./useNotificationPresenceLease";

const mocks = vi.hoisted(() => ({ upsert: vi.fn(async (input) => input) }));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  upsertNotificationPresence: mocks.upsert,
}));

function Harness({ workspaceId, sessionId }: { workspaceId: string; sessionId?: string }) {
  useNotificationPresenceLease(workspaceId, sessionId);
  return null;
}

describe("useNotificationPresenceLease", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    mocks.upsert.mockClear();
    window.sessionStorage.clear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.restoreAllMocks();
  });

  it("publishes focused/visible leases and explicitly releases presence on cleanup", async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { workspaceId: "workspace-1", sessionId: "session-1" }));
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        focused: true,
        visible: true,
        ttlMs: 90_000,
      }),
    );
    act(() => renderer?.unmount());
    await Promise.resolve();
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", focused: false, visible: false }),
    );
    renderer = undefined;
  });
});
