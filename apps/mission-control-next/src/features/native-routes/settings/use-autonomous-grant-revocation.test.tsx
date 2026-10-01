import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  useAutonomousGrantRevocation,
  __resetAutonomousGrantRevocationsForTests,
} from "./use-autonomous-grant-revocation";
import {
  autonomousGrantFixture as grant,
  revokedAutonomousGrantFixture as revoked,
} from "./autonomous-grant.test-support";

const api = vi.hoisted(() => ({
  getGatewayApiBaseUrl: vi.fn(() => "http://fixture-gateway"),
  fetchAutonomousActivationGrants: vi.fn(),
  revokeAutonomousActivationGrant: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let owner: ReturnType<typeof useAutonomousGrantRevocation>, view: ReactTestRenderer | undefined;
let rows = [grant];
const reload = vi.fn(async () => undefined);
function Harness({ scope }: { scope: string }) {
  owner = useAutonomousGrantRevocation({ scope, reload });
  return null;
}
async function render(scope = "workspace-a") {
  await act(async () => {
    if (view) view.update(<Harness scope={scope} />);
    else view = create(<Harness scope={scope} />);
  });
}
async function review() {
  await act(async () => {
    await owner.request(grant);
  });
}
async function confirm() {
  await act(async () => {
    await owner.confirm();
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetAutonomousGrantRevocationsForTests();
  rows = [grant];
  api.getGatewayApiBaseUrl.mockReturnValue("http://fixture-gateway");
  api.fetchAutonomousActivationGrants.mockImplementation(async () => ({ items: rows }));
  api.revokeAutonomousActivationGrant.mockImplementation(async () => {
    rows = [revoked];
    return revoked;
  });
  reload.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(async () => {
  if (view) await act(async () => view?.unmount());
  view = undefined;
  vi.unstubAllGlobals();
});

it("requires a cancelable exact review and independent canonical revoked readback", async () => {
  await render();
  await review();
  expect(owner.review).toEqual(grant);
  await act(async () => owner.cancel());
  expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
  await review();
  await confirm();
  expect(api.revokeAutonomousActivationGrant).toHaveBeenCalledExactlyOnceWith(grant.grantId, {
    revokedBy: "operator",
    reason: "Revoked from Settings.",
  });
  expect(api.fetchAutonomousActivationGrants).toHaveBeenCalledTimes(4);
  const freshSignals = api.fetchAutonomousActivationGrants.mock.calls.map((call) => call[1]);
  expect(freshSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(new Set(freshSignals).size).toBe(4);
  expect(owner.attemptFor(grant.grantId)?.phase).toBe("recorded");
  expect(owner.busy(grant.grantId)).toBe(false);
  expect(reload).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects a current grant that differs from the reviewed record before any write", async () => {
  await render();
  await review();
  rows = [{ ...grant, usedActivations: 2 }];
  await confirm();
  expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
  expect(owner.message).toContain("changed after review");
  expect(owner.busy(grant.grantId)).toBe(false);
});
it.each(["foreign", "unrevoked", "readback", "lost-after-commit"])(
  "retains unknown admission after %s outcome",
  async (variant) => {
    await render();
    await review();
    if (variant === "foreign")
      api.revokeAutonomousActivationGrant.mockResolvedValue({ ...revoked, workspaceId: "foreign" });
    if (variant === "unrevoked") api.revokeAutonomousActivationGrant.mockResolvedValue(grant);
    if (variant === "readback") api.revokeAutonomousActivationGrant.mockResolvedValue(revoked);
    if (variant === "lost-after-commit")
      api.revokeAutonomousActivationGrant.mockImplementation(async () => {
        rows = [revoked];
        throw new Error("postcommit publication failed");
      });
    await confirm();
    expect(owner.attemptFor(grant.grantId)?.phase).toBe("uncertain");
    await act(async () => view?.unmount());
    view = undefined;
    await render("workspace-b");
    expect(owner.busy(grant.grantId)).toBe(true);
    await review();
    await confirm();
    expect(api.revokeAutonomousActivationGrant).toHaveBeenCalledOnce();
  },
);
it("admits one dispatch across two mounted shell owners", async () => {
  await render();
  await review();
  let second!: ReturnType<typeof useAutonomousGrantRevocation>;
  function Other() {
    second = useAutonomousGrantRevocation({ scope: "workspace-a", reload });
    return null;
  }
  let other!: ReactTestRenderer;
  await act(async () => {
    other = create(<Other />);
  });
  await act(async () => {
    await second.request(grant);
  });
  await act(async () => {
    await Promise.all([owner.confirm(), second.confirm()]);
  });
  expect(api.revokeAutonomousActivationGrant).toHaveBeenCalledOnce();
  expect(second.attemptFor(grant.grantId)?.phase).toBe("recorded");
  await act(async () => other.unmount());
});
it.each(["scope-roundtrip", "unmount", "installation"])("cancels a preflight after %s", async (transition) => {
  await render();
  await review();
  const pending = deferred<{ items: typeof rows }>();
  api.fetchAutonomousActivationGrants.mockReturnValueOnce(pending.promise);
  let action!: Promise<void>;
  await act(async () => {
    action = owner.confirm();
  });
  if (transition === "scope-roundtrip") {
    await render("workspace-b");
    await render("workspace-a");
  }
  if (transition === "unmount") {
    await act(async () => view?.unmount());
    view = undefined;
  }
  if (transition === "installation") api.getGatewayApiBaseUrl.mockReturnValue("http://other-gateway");
  await act(async () => {
    pending.resolve({ items: rows });
    await action;
  });
  expect(api.revokeAutonomousActivationGrant).not.toHaveBeenCalled();
});
it("does not reclassify a verified revocation when the view refresh fails", async () => {
  reload.mockRejectedValue(new Error("display refresh failed"));
  await render();
  await review();
  await confirm();
  expect(owner.attemptFor(grant.grantId)?.phase).toBe("recorded");
  expect(owner.busy(grant.grantId)).toBe(false);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
