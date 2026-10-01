// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { gatewayAuthSettingsFixture } from "../../../features/native-routes/settings/gateway-auth.test-support";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { __resetApprovalModeUncertaintyForTests } from "./approval-mode-state";
import { useApprovalModeControl } from "./use-approval-mode-control";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  base: "owner",
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api, isApiRequestError: () => false }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root, client: QueryClient, owner: RuntimeSettingsResponse;
let control: ReturnType<typeof useApprovalModeControl>;
function Probe({ scope, safeOnly }: { scope: string; safeOnly: boolean }) {
  control = useApprovalModeControl({ scope, safeOnly });
  return null;
}
async function render(scope = "one", safeOnly = false) {
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Probe scope={scope} safeOnly={safeOnly} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(control.settings.isFetching).toBe(false));
}
async function prepare(safeOnly = false) {
  await render("one", safeOnly);
  await act(async () => control.draft.setValue("approve_risky"));
}
beforeEach(() => {
  vi.resetAllMocks();
  api.base = "owner";
  owner = gatewayAuthSettingsFixture();
  api.fetchSettings.mockImplementation(async () => structuredClone(owner));
  api.patchSettings.mockImplementation(
    async (input: { toolApprovalMode: RuntimeSettingsResponse["toolApprovalMode"] }) => {
      owner = { ...owner, revision: owner.revision + 1, toolApprovalMode: input.toolApprovalMode };
      return structuredClone(owner);
    },
  );
  root = createRoot(document.createElement("div"));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  __resetApprovalModeUncertaintyForTests();
});

describe("approval save review lifetime", () => {
  it("retains normal save behavior under StrictMode", async () => {
    await prepare();
    await act(async () => control.requestSave());
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 41,
      toolApprovalMode: "approve_risky",
    });
    expect(control.draft.isDirty).toBe(false);
  });

  it("does not dispatch after unmount during the fresh owner read", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => root.render(null));
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
    await render();
    expect(control.canSave).toBe(true);
  });

  it("does not dispatch after leaving and returning to the reviewed scope", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await render("two");
    await render("one");
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(control.draft.isDirty).toBe(true);
  });

  it("invalidates a pending preflight even when a changed draft is restored", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => control.draft.setValue("approve_all"));
    await act(async () => control.draft.setValue("approve_risky"));
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("invalidates a preflight when another owner refresh changes the settings revision", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => client.setQueryData(["system", "settings-approval-mode"], { ...owner, revision: 42 }));
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("does not dispatch to a different installation after the preflight", async () => {
    await prepare();
    const read = deferred<RuntimeSettingsResponse>();
    api.fetchSettings.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    api.base = "other-owner";
    await act(async () => {
      read.resolve(owner);
      await pending;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it("acknowledges a dispatched origin draft after unmount without reporting a late view success", async () => {
    await prepare();
    const write = deferred<RuntimeSettingsResponse>();
    api.patchSettings.mockReturnValueOnce(write.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    owner = { ...owner, revision: 42, toolApprovalMode: "approve_risky" };
    await act(async () => {
      write.resolve(owner);
      expect(await pending).toBe(false);
    });
    await render();
    expect(control.draft.isDirty).toBe(false);
    expect(control.notice).toBeNull();
  });

  it("retains unknown dispatched outcome across unmount and scope remount", async () => {
    await prepare();
    const write = deferred<RuntimeSettingsResponse>();
    api.patchSettings.mockReturnValueOnce(write.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = control.requestSave();
    });
    await act(async () => root.render(null));
    await act(async () => {
      write.resolve({ ...owner, revision: 42 });
      await pending;
    });
    await render("two");
    expect(control.uncertain).toContain("uncertain");
    expect(control.canSave).toBe(false);
    await act(async () => control.requestSave());
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });

  it("withholds bypass even for a forced first-run draft", async () => {
    await prepare(true);
    await act(async () => control.draft.setValue("bypass"));
    expect(control.canSave).toBe(false);
    await act(async () => control.requestSave());
    expect(api.patchSettings).not.toHaveBeenCalled();
  });
});
