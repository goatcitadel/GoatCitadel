import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CapabilityScopeView,
  CapabilityScopeReviewedUpdateInput,
  CapabilityScopeSelectionReceipt,
} from "@goatcitadel/contracts";
import { useCapabilityScope } from "./use-capability-scope";
import { __resetCapabilityScopeAttemptsForTests } from "./capability-scope-state";
import { __resetSessionDraftsForTests } from "../library/session-drafts";

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), reset: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchCitadelCapabilities: api.read,
  fetchWorkspaceCapabilities: api.read,
  updateReviewedCapabilities: api.save,
  resetReviewedCapabilities: api.reset,
  isApiRequestError: (value: { kind?: string }) => value?.kind === "http",
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
let owner: CapabilityScopeView,
  renderer: ReactTestRenderer | undefined,
  control!: ReturnType<typeof useCapabilityScope>;
const initial = (id = "workspace"): CapabilityScopeView => ({
  scopeKind: "workspace",
  scopeId: id,
  resourceType: "skill",
  mode: "inherit",
  items: ["Alpha", "Beta"].map((label) => ({
    resourceRef: label.toLowerCase(),
    label,
    enabled: true,
    available: true,
    inherited: true,
  })),
  effectiveRefs: ["alpha", "beta"],
  selectionReview: {
    version: "capability_scope_selection.v1",
    scopeKind: "workspace",
    scopeId: id,
    resourceType: "skill",
    revision: "a".repeat(64),
    citadelId: "parent",
    scopeLifecycleStatus: "active",
    citadelLifecycleStatus: "active",
    assignments: [],
    parentAssignments: [],
  },
});
function Harness({ id = "workspace" }: { id?: string }) {
  control = useCapabilityScope({ scopeKind: "workspace", scopeId: id, resourceType: "skill" });
  return null;
}
async function mount(id = "workspace") {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Harness id={id} />
      </StrictMode>,
    );
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function saved(input: CapabilityScopeReviewedUpdateInput): CapabilityScopeSelectionReceipt {
  const selectionReview = { ...owner.selectionReview!, revision: "b".repeat(64), assignments: input.assignments };
  owner = {
    ...owner,
    mode: input.assignments.length ? "curated" : "inherit",
    selectionReview,
    items: owner.items.map((item) => ({
      ...item,
      inherited: !input.assignments.length,
      enabled: input.assignments.length
        ? input.assignments.some((row) => row.resourceRef === item.resourceRef && row.enabled)
        : true,
    })),
  };
  return { version: "capability_scope_receipt.v1", previousRevision: input.expectedRevision, selectionReview };
}
async function review() {
  await act(async () => control.toggle("alpha"));
  await act(async () => control.requestReview());
  expect(control.review).not.toBeNull();
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetCapabilityScopeAttemptsForTests();
  __resetSessionDraftsForTests();
  owner = initial();
  api.read.mockImplementation(async (id: string) => (id === "workspace" ? owner : initial(id)));
  api.save.mockImplementation(async (_kind: string, _id: string, input: CapabilityScopeReviewedUpdateInput) =>
    saved(input),
  );
  api.reset.mockImplementation(async (_kind: string, _id: string, resourceType: "skill", expectedRevision: string) =>
    saved({ resourceType, expectedRevision, assignments: [] }),
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
it("confirms a StrictMode exact selection with separate preflight and readback and no implicit action", async () => {
  await mount();
  expect(api.save).not.toHaveBeenCalled();
  await review();
  expect(api.save).not.toHaveBeenCalled();
  const reads = api.read.mock.calls.length;
  await act(async () => {
    await control.confirm();
  });
  expect(api.save).toHaveBeenCalledExactlyOnceWith("workspace", "workspace", {
    resourceType: "skill",
    expectedRevision: "a".repeat(64),
    assignments: [
      { resourceRef: "alpha", enabled: false },
      { resourceRef: "beta", enabled: true },
    ],
  });
  expect(api.read.mock.calls.length - reads).toBe(2);
  expect(control.draft.isDirty).toBe(false);
  expect(control.notice).toContain("saved and confirmed");
});
it("preserves unavailable selected references and resets only after an explicit inheritance review", async () => {
  owner = {
    ...initial(),
    mode: "curated",
    selectionReview: { ...initial().selectionReview!, assignments: [{ resourceRef: "alpha", enabled: true }] },
    items: initial().items.map((item) => ({ ...item, available: false, enabled: false, inherited: false })),
  };
  await mount();
  expect(control.draft.value.alpha).toBe(true);
  await act(async () => control.requestReview(true));
  expect(api.reset).not.toHaveBeenCalled();
  await act(async () => {
    await control.confirm();
  });
  expect(api.reset).toHaveBeenCalledExactlyOnceWith("workspace", "workspace", "skill", "a".repeat(64));
  expect(control.view?.mode).toBe("inherit");
});
it.each(["old-gateway", "foreign-review", "archived-parent", "oversized"])(
  "withholds editing for %s",
  async (reason) => {
    if (reason === "old-gateway") owner.selectionReview = undefined;
    if (reason === "foreign-review") owner.selectionReview!.scopeId = "foreign";
    if (reason === "archived-parent") owner.selectionReview!.citadelLifecycleStatus = "archived";
    if (reason === "oversized")
      owner.items = Array.from({ length: 1001 }, (_, i) => ({
        resourceRef: String(i),
        label: String(i),
        available: true,
        enabled: true,
        inherited: true,
      }));
    await mount();
    expect(control.ready).toBeFalsy();
    await act(async () => {
      control.requestReview();
      await control.confirm();
    });
    expect(api.save).not.toHaveBeenCalled();
  },
);
it.each(["unmount", "away-back", "edit", "ABA", "cancel", "refresh"])(
  "cancels preflight on %s with zero writes",
  async (change) => {
    await mount();
    await review();
    const read = deferred<CapabilityScopeView>();
    api.read.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.confirm();
    });
    if (change === "unmount") {
      await act(async () => renderer!.unmount());
      renderer = undefined;
    }
    if (change === "away-back") {
      await act(async () =>
        renderer!.update(
          <StrictMode>
            <Harness id="foreign" />
          </StrictMode>,
        ),
      );
      await act(async () =>
        renderer!.update(
          <StrictMode>
            <Harness />
          </StrictMode>,
        ),
      );
    }
    if (change === "edit" || change === "ABA") {
      await act(async () => control.toggle("beta"));
      if (change === "ABA") await act(async () => control.toggle("beta"));
    }
    if (change === "cancel") await act(async () => control.cancelReview());
    if (change === "refresh") await act(async () => control.reload());
    await act(async () => {
      read.resolve(initial());
      await pending;
    });
    expect(api.save).not.toHaveBeenCalled();
  },
);
it.each(["parent", "availability", "revision"])("requires another review after a %s drift", async (drift) => {
  await mount();
  await review();
  if (drift === "parent") owner = { ...owner, selectionReview: { ...owner.selectionReview!, citadelId: "other" } };
  if (drift === "availability") owner = { ...owner, items: owner.items.map((item) => ({ ...item, available: false })) };
  if (drift === "revision")
    owner = { ...owner, selectionReview: { ...owner.selectionReview!, revision: "c".repeat(64) } };
  await act(async () => {
    await control.confirm();
  });
  expect(api.save).not.toHaveBeenCalled();
  expect(control.notice).toContain("changed");
  expect(control.review).toBeNull();
});
it("admits only one concurrent dispatch and acknowledges an originating draft after unmount", async () => {
  await mount();
  await review();
  const response = deferred<CapabilityScopeSelectionReceipt>();
  api.save.mockReturnValueOnce(response.promise);
  let first!: Promise<boolean>, second!: Promise<boolean>;
  await act(async () => {
    first = control.confirm();
    second = control.confirm();
  });
  expect(api.save).toHaveBeenCalledOnce();
  const input = api.save.mock.calls[0]![2] as CapabilityScopeReviewedUpdateInput;
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => {
    response.resolve(saved(input));
    await Promise.all([first, second]);
  });
  await mount();
  expect(control.draft.isDirty).toBe(false);
  expect(control.locked).toBe(false);
  expect(api.save).toHaveBeenCalledOnce();
});
it("acknowledges a dispatched snapshot without clearing newer input", async () => {
  await mount();
  await review();
  const response = deferred<CapabilityScopeSelectionReceipt>();
  api.save.mockReturnValueOnce(response.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = control.confirm();
  });
  const input = api.save.mock.calls[0]![2] as CapabilityScopeReviewedUpdateInput;
  await act(async () => control.toggle("beta"));
  await act(async () => {
    response.resolve(saved(input));
    await pending;
  });
  expect(control.draft.isDirty).toBe(true);
  expect(control.draft.value.beta).toBe(false);
  expect(control.notice).toBeNull();
});
it.each(["lost", "foreign-receipt", "readback", "committed-error"])(
  "retains %s uncertainty across remount and refresh",
  async (kind) => {
    await mount();
    await review();
    if (kind === "lost") api.save.mockRejectedValueOnce(new Error("Lost response"));
    if (kind === "foreign-receipt")
      api.save.mockImplementationOnce(async (_kind, _id, input) => {
        const receipt = saved(input);
        return { ...receipt, selectionReview: { ...receipt.selectionReview, scopeId: "other" } };
      });
    if (kind === "readback")
      api.save.mockImplementationOnce(async (_kind, _id, input) => {
        const receipt = saved(input);
        owner = { ...owner, selectionReview: { ...owner.selectionReview!, revision: "c".repeat(64) } };
        return receipt;
      });
    if (kind === "committed-error")
      api.save.mockRejectedValueOnce({
        kind: "http",
        method: "PATCH",
        path: "/api/v1/workspaces/workspace/capabilities/reviewed",
        status: 409,
        body: {
          code: "WRITE_CONFLICT",
          mutationCommitted: true,
          details: { reason: "CAPABILITY_SCOPE_REVISION_CONFLICT" },
        },
      });
    await act(async () => {
      await control.confirm();
    });
    expect(control.attempt.phase).toBe("uncertain");
    await act(async () => renderer!.unmount());
    await mount();
    await act(async () => control.reload());
    expect(control.locked).toBe(true);
    await act(async () => {
      control.requestReview();
      await control.confirm();
    });
    expect(api.save).toHaveBeenCalledOnce();
  },
);
it("releases only a source-bound known precommit conflict and requires a fresh explicit attempt", async () => {
  await mount();
  await review();
  api.save.mockRejectedValueOnce({
    kind: "http",
    method: "PATCH",
    path: "/api/v1/workspaces/workspace/capabilities/reviewed",
    status: 409,
    body: { code: "WRITE_CONFLICT", details: { reason: "CAPABILITY_SCOPE_REVISION_CONFLICT" } },
  });
  await act(async () => {
    await control.confirm();
  });
  expect(control.locked).toBe(false);
  expect(control.review).toBeNull();
  expect(api.save).toHaveBeenCalledOnce();
});
