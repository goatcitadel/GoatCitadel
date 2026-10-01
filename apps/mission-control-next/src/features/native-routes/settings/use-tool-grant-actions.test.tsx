// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { __resetToolGrantActionsForTests, useToolGrantActions } from "./use-tool-grant-actions";
import { normalizeToolGrantDraft } from "./tool-grant-binding";

const api = vi.hoisted(() => ({
  createToolGrant: vi.fn(),
  fetchToolGrants: vi.fn(),
  revokeToolGrant: vi.fn(),
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const draft = () => ({
  toolPattern: " session.status ",
  decision: "allow",
  scope: "workspace",
  scopeRef: " workspace-a ",
  grantType: "persistent",
  expiresAt: "unused",
});
const record = (): ToolGrantRecord => ({
  grantId: "grant-a",
  toolPattern: "session.status",
  decision: "allow",
  scope: "workspace",
  scopeRef: "workspace-a",
  grantType: "persistent",
  createdAt: "2026-09-30T15:00:00.000Z",
  createdBy: "operator-a",
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let view: ReactTestRenderer | undefined, hook: ReturnType<typeof useToolGrantActions>, records: ToolGrantRecord[];
let key: string, pendingReview: Promise<boolean> | undefined;
const reload = vi.fn();
function Harness() {
  hook = useToolGrantActions(key, reload);
  return null;
}
async function render() {
  await act(async () => {
    if (view)
      view.update(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    else
      view = create(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
  });
}
async function review() {
  await act(async () => {
    pendingReview = hook.requestCreate(draft());
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetToolGrantActionsForTests();
  key = "workspace-a:new";
  pendingReview = undefined;
  records = [];
  api.fetchToolGrants.mockImplementation(async () => ({ items: structuredClone(records) }));
  api.createToolGrant.mockImplementation(async () => {
    const saved = record();
    records.push(saved);
    return structuredClone(saved);
  });
  api.revokeToolGrant.mockImplementation(async (grantId: string) => {
    records = records.map((item) =>
      item.grantId === grantId ? { ...item, revokedAt: "2026-09-30T15:01:00.000Z", revokedBy: "operator-a" } : item,
    );
    return { revoked: true, grantId, revokedBy: "operator-a" };
  });
  reload.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => {
    view?.unmount();
  });
  view = undefined;
});

describe("tool grant reviewed owner lifecycle", () => {
  it("reviews normalized exact scope and cancels without a write", async () => {
    await render();
    await review();
    expect(hook.review?.kind).toBe("create");
    if (hook.review?.kind === "create")
      expect(hook.review.input).toEqual({
        toolPattern: "session.status",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-a",
        grantType: "persistent",
      });
    await act(async () => hook.cancel());
    expect(await pendingReview).toBe(false);
    expect(api.createToolGrant).not.toHaveBeenCalled();
  });
  it("binds the receipt and independent owner ID before acknowledging the draft", async () => {
    await render();
    await review();
    await act(async () => { await hook.confirm(); });
    expect(await pendingReview).toBe(true);
    expect(api.createToolGrant).toHaveBeenCalledExactlyOnceWith(normalizeToolGrantDraft(draft()));
    expect(api.fetchToolGrants).toHaveBeenCalledTimes(2);
    expect(hook.notice?.tone).toBe("success");
    expect(hook.attemptFor("create")).toBeUndefined();
  });
  it("does not duplicate simultaneous confirmations or allow another create from another workspace", async () => {
    const response = deferred<ToolGrantRecord>();
    api.createToolGrant.mockReturnValue(response.promise);
    await render();
    await review();
    let confirmation!: Promise<boolean>;
    await act(async () => {
      confirmation = hook.confirm();
    });
    await act(async () => { await hook.confirm(); });
    expect(api.createToolGrant).toHaveBeenCalledTimes(1);
    key = "workspace-b:new";
    await render();
    expect(await pendingReview).toBe(false);
    expect(await hook.requestCreate(draft())).toBe(false);
    records = [record()];
    await act(async () => {
      response.resolve(record());
      await confirmation;
    });
    expect(hook.review).toBeNull();
    expect(hook.notice).toBeNull();
  });
  it("retains an unknown create across unmount and different workspace selection", async () => {
    api.createToolGrant.mockRejectedValue(new Error("response lost"));
    await render();
    await review();
    await act(async () => { await hook.confirm(); });
    expect(await pendingReview).toBe(false);
    expect(hook.attemptFor("create")?.phase).toBe("uncertain");
    await act(async () => view?.unmount());
    view = undefined;
    key = "workspace-b:new";
    await render();
    expect(await hook.requestCreate(draft())).toBe(false);
    expect(api.createToolGrant).toHaveBeenCalledTimes(1);
  });
  it("locks mismatched receipt and duplicate independent owner rows", async () => {
    await render();
    await review();
    api.createToolGrant.mockResolvedValue({ ...record(), scopeRef: "foreign" });
    await act(async () => { await hook.confirm(); });
    expect(hook.attemptFor("create")?.phase).toBe("uncertain");
    __resetToolGrantActionsForTests();
    await review();
    api.createToolGrant.mockImplementation(async () => {
      records = [record(), record()];
      return record();
    });
    await act(async () => { await hook.confirm(); });
    expect(hook.attemptFor("create")?.phase).toBe("uncertain");
  });
  it("unlocks a route-owned precommit validation error but retains committed-marker uncertainty", async () => {
    await render();
    await review();
    api.createToolGrant.mockRejectedValue({ status: 400, body: { error: "validation failed" } });
    await act(async () => { await hook.confirm(); });
    expect(hook.attemptFor("create")).toBeUndefined();
    await review();
    api.createToolGrant.mockRejectedValue({ status: 400, body: { details: { mutationCommitted: true } } });
    await act(async () => { await hook.confirm(); });
    expect(hook.attemptFor("create")?.phase).toBe("uncertain");
  });
  it("does not dispatch if its owner changes during preflight", async () => {
    const read = deferred<{ items: ToolGrantRecord[] }>();
    api.fetchToolGrants.mockReturnValue(read.promise);
    await render();
    await review();
    let confirmation!: Promise<boolean>;
    await act(async () => {
      confirmation = hook.confirm();
    });
    key = "workspace-b:new";
    await render();
    await act(async () => {
      read.resolve({ items: [] });
      await confirmation;
    });
    expect(api.createToolGrant).not.toHaveBeenCalled();
    expect(hook.attemptFor("create")).toBeUndefined();
  });
  it("checks the exact immutable revoke binding before dispatch", async () => {
    records = [{ ...record(), scopeRef: "changed" }];
    await render();
    await act(async () => hook.requestRevoke(record()));
    await act(async () => { await hook.confirm(); });
    expect(api.revokeToolGrant).not.toHaveBeenCalled();
    expect(hook.notice?.tone).toBe("error");
  });
  it("confirms revocation against current owner metadata and blocks stale repeat", async () => {
    records = [record()];
    await render();
    await act(async () => hook.requestRevoke(record()));
    await act(async () => { await hook.confirm(); });
    expect(api.revokeToolGrant).toHaveBeenCalledExactlyOnceWith("grant-a");
    expect(hook.attemptFor("revoke:grant-a")?.phase).toBe("confirmed");
    await act(async () => hook.requestRevoke(record()));
    expect(hook.review).toBeNull();
  });
  it("does not turn a confirmed write and failed display refresh into an unknown retry", async () => {
    reload.mockRejectedValue(new Error("display offline"));
    await render();
    await review();
    await act(async () => { await hook.confirm(); });
    expect(await pendingReview).toBe(true);
    expect(hook.notice?.message).toContain("write was confirmed");
    expect(hook.attemptFor("create")).toBeUndefined();
  });
  it("keeps a newer review when an earlier confirmed write's display refresh fails late", async () => {
    const refresh = deferred<void>(); reload.mockReturnValue(refresh.promise);
    await render(); await review(); let confirmation!: Promise<boolean>;
    await act(async () => { confirmation = hook.confirm(); });
    expect(await pendingReview).toBe(true);
    await review(); expect(hook.notice).toBeNull();
    await act(async () => { refresh.reject(new Error("late display failure")); await confirmation; });
    expect(hook.notice).toBeNull(); expect(hook.review?.kind).toBe("create");
    await act(async () => hook.cancel());
  });
  it("requires a scoped ID and valid future TTL and rejects deny-one-use", () => {
    for (const changed of [
      { ...draft(), scopeRef: " " },
      { ...draft(), grantType: "ttl", expiresAt: "bad" },
      { ...draft(), grantType: "ttl", expiresAt: "2020-01-01T00:00:00Z" },
      { ...draft(), decision: "deny", grantType: "one_time" },
    ])
      expect(() => normalizeToolGrantDraft(changed)).toThrow();
    expect(normalizeToolGrantDraft({ ...draft(), scope: "global", scopeRef: "ignored" })).not.toHaveProperty(
      "scopeRef",
    );
  });
});
