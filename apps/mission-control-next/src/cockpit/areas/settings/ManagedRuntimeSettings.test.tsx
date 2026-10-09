// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { __resetManagedRuntimeUncertaintyForTests } from "../../../features/native-routes/settings/managed-runtime-state";
import { ManagedRuntimeSettings } from "./ManagedRuntimeSettings";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
// Each owner write reports the attempt it dispatched, as the real capture would for its Gateway route.
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => {
    const path = attempts.paths.shift();
    if (path) onAttempt({ attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", method: "PATCH", path });
    return dispatch();
  },
}));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
let confirmation: ComponentProps<typeof ConfirmModal>;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    confirmation = props;
    return null;
  },
}));
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let owner: {
  revision: number;
  llamaCpp: {
    enabled: boolean;
    autoStart: boolean;
    managementMode: "managed" | "external";
    baseUrl: string;
    alias: string;
    command: string;
    modelPath: string;
    status: { processState: string };
  };
};
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ManagedRuntimeSettings />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Loading runtime configuration"));
}
async function changeAlias(value: string) {
  await act(async () => {
    const input = container.querySelectorAll("input")[1]!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network forbidden in runtime component test.");
    }),
  );
  owner = {
    revision: 41,
    llamaCpp: {
      enabled: false,
      autoStart: false,
      managementMode: "managed",
      baseUrl: "http://127.0.0.1:8080/v1",
      alias: "saved-model",
      command: "llama-server",
      modelPath: "/models/saved.gguf",
      status: { processState: "stopped" },
    },
  };
  api.fetchSettings.mockImplementation(async () => ({ ...owner }));
  api.patchSettings.mockImplementation(async (input) => {
    owner = { ...owner, revision: 42, llamaCpp: { ...owner.llamaCpp, ...input.llamaCpp } };
    return owner;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  __resetManagedRuntimeUncertaintyForTests();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
describe("native managed runtime configuration", () => {
  it("announces the initial owner read and withholds controls until it settles", async () => {
    let resolveRead!: (value: typeof owner) => void;
    const pending = new Promise<typeof owner>((resolve) => {
      resolveRead = resolve;
    });
    api.fetchSettings.mockReturnValueOnce(pending);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ManagedRuntimeSettings />
        </QueryClientProvider>,
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading runtime configuration…");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(button("Refresh runtime settings").disabled).toBe(true);
    expect(button("Review runtime changes")).toBeUndefined();
    expect(api.patchSettings).not.toHaveBeenCalled();
    await act(async () => {
      resolveRead(structuredClone(owner));
      await pending;
    });
    await vi.waitFor(() => expect(container.querySelectorAll("input")).toHaveLength(4));
    expect(container.textContent).not.toContain("Loading runtime configuration");
    expect(container.textContent).toContain("settings revision 41");
    expect(api.patchSettings).not.toHaveBeenCalled();
  });
  it("announces an in-flight refetch without exposing stale controls or losing retained input", async () => {
    await render();
    await changeAlias("retained-runtime-draft");
    let resolveRead!: (value: typeof owner) => void;
    const pending = new Promise<typeof owner>((resolve) => {
      resolveRead = resolve;
    });
    api.fetchSettings.mockReturnValueOnce(pending);
    await act(async () => button("Refresh runtime settings").click());
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading runtime configuration…"),
    );
    // The previous data still exists; this is a background fetch, not the initial loading state.
    expect(client.getQueryState(["system", "managed-runtime-settings"])?.status).toBe("success");
    expect(client.getQueryState(["system", "managed-runtime-settings"])?.fetchStatus).toBe("fetching");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(button("Refresh runtime settings").disabled).toBe(true);
    expect(button("Review runtime changes")).toBeUndefined();
    expect(confirmation.open).toBe(false);
    expect(api.patchSettings).not.toHaveBeenCalled();
    await act(async () => {
      resolveRead(structuredClone(owner));
      await pending;
    });
    await vi.waitFor(() => expect(container.querySelectorAll("input")).toHaveLength(4));
    expect(container.textContent).not.toContain("Loading runtime configuration");
    expect(container.textContent).toContain("settings revision 41");
    expect(container.querySelectorAll("input")[1]?.value).toBe("retained-runtime-draft");
    expect(button("Review runtime changes").disabled).toBe(false);
    expect(api.patchSettings).not.toHaveBeenCalled();
  });
  it("shows the llama.cpp lifecycle beside the saved configuration", async () => {
    await render();
    expect(container.querySelector('[aria-label="llama.cpp lifecycle"]')).not.toBeNull();
    expect(button("Refresh runtime status")).toBeDefined();
  });

  it("shows exact configuration and host-wide consequence before a cancelable save", async () => {
    await render();
    await changeAlias("reviewed-model");
    await act(async () => button("Review runtime changes").click());
    expect(confirmation.open).toBe(true);
    expect(confirmation.message).toContain("http://127.0.0.1:8080/v1");
    expect(confirmation.message).toContain("saved-model → reviewed-model");
    expect(confirmation.message).toContain("every workspace");
    expect(api.patchSettings).not.toHaveBeenCalled();
    act(() => confirmation.onCancel());
    expect(api.patchSettings).not.toHaveBeenCalled();
    await act(async () => button("Review runtime changes").click());
    await act(async () => confirmation.onConfirm());
    await vi.waitFor(() => expect(container.textContent).toContain("saved and confirmed"));
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Process: Stopped");
    expect(container.textContent).toContain("Read-only evidence");
    expect(container.querySelectorAll("input")).toHaveLength(4);
  });
  it("checks a lost runtime save's outcome and releases the lock after readback", async () => {
    attempts.paths.length = 0;
    attempts.paths.push("/api/v1/settings");
    api.patchSettings.mockRejectedValue(new Error("lost response"));
    await render();
    await changeAlias("reviewed-model");
    await act(async () => button("Review runtime changes").click());
    await act(async () => confirmation.onConfirm());
    await vi.waitFor(() => expect(container.textContent).toContain("Save outcome is uncertain"));
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    await act(async () => button("Check outcome").click());
    await vi.waitFor(() => expect(container.textContent).toContain("recorded this runtime change as processed"));
    expect(container.textContent).not.toContain("Save outcome is uncertain");
    expect(button("Check outcome")).toBeUndefined();
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });
  it("keeps external launch configuration with its owner", async () => {
    owner.llamaCpp.managementMode = "external";
    await render();
    expect(container.textContent).toContain("observes this external server");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(
      container.querySelector('a[href="/settings/onboarding?view=llamacpp&shell=classic&shellScope=visit"]'),
    ).not.toBeNull();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });
  it("explains a disabled stale review inside the dialog and allows cancellation without a mutation", async () => {
    await render();
    await changeAlias("reviewed-model");
    await act(async () => button("Review runtime changes").click());
    owner = { ...owner, revision: 42, llamaCpp: { ...owner.llamaCpp, alias: "remote-model" } };
    await act(async () => {
      await client.refetchQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(confirmation.open).toBe(true);
    expect(confirmation.confirmDisabled).toBe(true);
    expect(confirmation.message).toContain("This review is no longer current.");
    expect(confirmation.message).toContain("close this dialog, then refresh and review your retained draft");
    act(() => confirmation.onCancel());
    expect(confirmation.open).toBe(false);
    expect(api.patchSettings).not.toHaveBeenCalled();
  });
  it("withholds stale editable settings after an owner read fails", async () => {
    await render();
    api.fetchSettings.mockRejectedValue(new Error("owner unavailable"));
    await act(async () => {
      await client.refetchQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
