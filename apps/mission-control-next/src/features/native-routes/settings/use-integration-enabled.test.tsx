// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { useIntegrationEnabled } from "./use-integration-enabled";
import {
  __resetIntegrationConnectionMutationsForTests,
  commitIntegrationConnectionUpdate,
} from "./integration-connection-mutation";

const api = vi.hoisted(() => ({ fetchIntegrationConnection: vi.fn(), updateIntegrationConnection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
const connection = (patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  connectionId: "connection-one",
  revision: "a".repeat(64),
  catalogId: "productivity.github",
  kind: "productivity",
  key: "github",
  label: "Saved GitHub",
  enabled: false,
  status: "connected",
  workspaceId: "bound-workspace",
  config: { owner: "sample", token: "[REDACTED]" },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let current: IntegrationConnection;
let workspaceId: string;
let available: boolean;
let control: ReturnType<typeof useIntegrationEnabled>;
const reload = vi.fn<() => Promise<unknown>>();
function Harness() {
  control = useIntegrationEnabled({ workspaceId, available, reload });
  return <p>{control.notice}</p>;
}
async function render() {
  await act(async () => root.render(<Harness />));
}
async function review() {
  await act(async () => control.requestReview(current));
}
async function remount() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetIntegrationConnectionMutationsForTests();
  current = connection();
  workspaceId = "selected-workspace";
  available = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  reload.mockResolvedValue(undefined);
  api.fetchIntegrationConnection.mockImplementation(async () => current);
  api.updateIntegrationConnection.mockImplementation(async (_id: string, input: { enabled: boolean }) => {
    current = { ...current, enabled: input.enabled, revision: "b".repeat(64) };
    return current;
  });
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetIntegrationConnectionMutationsForTests();
});

describe("reviewed integration enabled control", () => {
  it("reads before review and confirmation, sends only enabled and exact revision, and preserves the binding", async () => {
    await review();
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    expect(control.review?.connection.workspaceId).toBe("bound-workspace");
    await act(async () => control.confirm());
    expect(api.fetchIntegrationConnection).toHaveBeenCalledTimes(2);
    expect(api.updateIntegrationConnection).toHaveBeenCalledExactlyOnceWith("connection-one", {
      expectedRevision: "a".repeat(64),
      enabled: true,
    });
    expect(control.notice).toContain("external connectivity has not been tested");
    expect(current.config).toEqual(connection().config);
    expect(current.status).toBe("connected");
  });
  it("keeps the lock notice for the locked connection after its review is closed", async () => {
    api.fetchIntegrationConnection.mockImplementation(async () => current);
    api.updateIntegrationConnection.mockRejectedValue(new Error("lost acknowledgement"));
    await review();
    await act(async () => control.confirm());
    expect(control.notice).toMatch(/outcome is unconfirmed/);
    act(() => control.cancel());
    expect(control.review).toBeNull();
    expect(control.notice).toMatch(/outcome is unconfirmed/);
  });
  it("cancels a review without an owner mutation", async () => {
    await review();
    await act(async () => control.cancel());
    await act(async () => control.confirm());
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    expect(control.review).toBeNull();
  });
  it.each(["channel", "external_connector"] as const)("does not offer %s activation", async (kind) => {
    current = connection({ kind });
    await review();
    expect(api.fetchIntegrationConnection).not.toHaveBeenCalled();
    expect(control.review).toBeNull();
  });
  it("says so when the directory starts refreshing during confirmation, changes nothing and keeps the review", async () => {
    await review();
    const read = deferred<IntegrationConnection>();
    api.fetchIntegrationConnection.mockReturnValueOnce(read.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm();
    });
    available = false;
    await render();
    await act(async () => {
      read.resolve(current);
      await pending;
    });
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    expect(control.notice).toMatch(/refreshing\. Nothing was changed/);
    expect(control.review).not.toBeNull();
  });
  it("says the list is refreshing, not that the connection changed, when a refresh starts during review", async () => {
    const read = deferred<IntegrationConnection>();
    api.fetchIntegrationConnection.mockReturnValueOnce(read.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.requestReview(current);
    });
    available = false;
    await render();
    await act(async () => {
      read.resolve(current);
      await pending;
    });
    expect(control.review).toBeNull();
    expect(control.notice).toMatch(/refreshing\. Nothing was changed/);
    expect(control.notice).not.toMatch(/connection changed/);
    expect(reload).not.toHaveBeenCalled();
  });
  it("rejects changed revision or binding after confirmation review", async () => {
    await review();
    current = connection({ revision: "c".repeat(64), workspaceId: "another-workspace" });
    await act(async () => control.confirm());
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    expect(control.notice).toContain("changed after review");
    expect(control.review).toBeNull();
  });
  it("ignores a late initial read after a workspace switch and back", async () => {
    const read = deferred<IntegrationConnection>();
    api.fetchIntegrationConnection.mockReturnValueOnce(read.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.requestReview(current);
    });
    workspaceId = "other";
    await render();
    workspaceId = "selected-workspace";
    await render();
    await act(async () => {
      read.resolve(current);
      await pending;
    });
    expect(control.review).toBeNull();
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
  });
  it("withholds a late confirmation read after cancellation, navigation, or unmount", async () => {
    await review();
    const read = deferred<IntegrationConnection>();
    api.fetchIntegrationConnection.mockReturnValueOnce(read.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm();
    });
    await act(async () => control.cancel());
    await act(async () => {
      read.resolve(current);
      await pending;
    });
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    await review();
    const next = deferred<IntegrationConnection>();
    api.fetchIntegrationConnection.mockReturnValueOnce(next.promise);
    await act(async () => {
      pending = control.confirm();
    });
    await remount();
    await act(async () => {
      next.resolve(current);
      await pending;
    });
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
  });
  it("holds an unknown update across remount and blocks the classic mutation entry", async () => {
    await review();
    const sent = deferred<IntegrationConnection>();
    api.updateIntegrationConnection.mockReturnValueOnce(sent.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm();
    });
    const reviewed = connection();
    expect(
      (
        await commitIntegrationConnectionUpdate({
          reviewed,
          input: { expectedRevision: reviewed.revision, label: "Classic edit" },
          isCurrent: () => true,
        })
      ).status,
    ).toBe("locked");
    await remount();
    await act(async () => {
      sent.reject(new Error("response lost"));
      await pending;
    });
    await review();
    expect(control.attempt.phase).toBe("uncertain");
    await act(async () => control.confirm());
    expect(
      (
        await commitIntegrationConnectionUpdate({
          reviewed,
          input: { expectedRevision: reviewed.revision, enabled: true },
          isCurrent: () => true,
        })
      ).status,
    ).toBe("locked");
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
  });
  it.each([
    { connectionId: "foreign" },
    { workspaceId: "other" },
    { catalogId: "other" },
    { enabled: false },
    { revision: "a".repeat(64) },
    { config: { token: "different" } },
    { status: "paused" as const },
  ])("locks wrong mutation receipts %j", async (patch) => {
    await review();
    api.updateIntegrationConnection.mockResolvedValueOnce(
      connection({ revision: "b".repeat(64), enabled: true, ...patch }),
    );
    await act(async () => control.confirm());
    expect(control.attempt.phase).toBe("uncertain");
    await act(async () => control.confirm());
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
  });
  it("handles an exact uncommitted conflict but retains the lock if commit evidence is present", async () => {
    const conflict = {
      status: 409,
      method: "PATCH", path: "/api/v1/integrations/connections/connection-one",
      body: { code: "WRITE_CONFLICT", details: { reason: "INTEGRATION_CONNECTION_REVISION_CONFLICT" } },
    };
    await review();
    api.updateIntegrationConnection.mockRejectedValueOnce(conflict);
    await act(async () => control.confirm());
    expect(control.review).toBeNull();
    await review();
    expect(control.attempt.locked).toBe(false);
    api.updateIntegrationConnection.mockRejectedValueOnce({
      ...conflict,
      body: { ...conflict.body, mutationCommitted: true },
    });
    await act(async () => control.confirm());
    expect(control.attempt.phase).toBe("uncertain");
  });
  it("accepts reordered equivalent public configuration but locks a conflict for another request", async () => {
    await review();
    api.updateIntegrationConnection.mockResolvedValueOnce(connection({ enabled: true, revision: "b".repeat(64), config: { token: "[REDACTED]", owner: "sample" } }));
    await act(async () => control.confirm()); expect(control.notice).toContain("Saved state is confirmed");
    await review();
    api.updateIntegrationConnection.mockRejectedValueOnce({ status: 409, method: "PATCH", path: "/api/v1/integrations/connections/other", body: { code: "WRITE_CONFLICT", details: { reason: "INTEGRATION_CONNECTION_REVISION_CONFLICT" } } });
    await act(async () => control.confirm()); expect(control.attempt.phase).toBe("uncertain");
  });
  it("keeps a confirmed acknowledgement separate from a failed directory refresh", async () => {
    await review();
    reload.mockRejectedValueOnce(new Error("directory unavailable"));
    await act(async () => control.confirm());
    expect(control.notice).toContain("Saved state is confirmed");
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
  });
  it("retains a successful late acknowledgement without changing the new workspace view", async () => {
    await review();
    const sent = deferred<IntegrationConnection>();
    api.updateIntegrationConnection.mockReturnValueOnce(sent.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.confirm();
    });
    workspaceId = "other";
    await render();
    await act(async () => {
      sent.resolve(connection({ enabled: true, revision: "b".repeat(64) }));
      await pending;
    });
    expect(control.notice).toBeNull();
    expect(control.review).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
