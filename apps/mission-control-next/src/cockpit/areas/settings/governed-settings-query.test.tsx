// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { BudgetModeControl } from "./BudgetModeControl";
import { ChatThinkingStreamControl } from "./ChatThinkingStreamControl";
import { ClaudeCliToolBridgeControl } from "./ClaudeCliToolBridgeControl";
import { ClaudeCliWarmContinuationControl } from "./ClaudeCliWarmContinuationControl";
import { useGovernedSettingsQuery } from "./governed-settings-query";
import { resetSettingsAttempt } from "./settings-attempt.test-support";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchChangePlans: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: () => new Promise(() => undefined),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  fetchChangePlans: api.fetchChangePlans,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) =>
  (await import("./settings-attempt.test-support")).withTrackedSettingsSave(
    await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>(),
  ),
);
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) =>
  (await import("./settings-attempt.test-support")).withSettingsAttemptRead(
    await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/mutation-attempts")>(),
  ),
);

type Server = { revision: number; budgetMode: string; features: Record<string, boolean> };
let server: Server;
const roots: ReturnType<typeof createRoot>[] = [];
const clients: QueryClient[] = [];

function settingsAt(revision: number, overrides: Partial<Server> = {}): Server {
  return {
    revision,
    budgetMode: "balanced",
    features: {
      chatThinkingStreamV1Enabled: false,
      claudeCliToolBridgeEnabled: false,
      claudeCliWarmContinuationEnabled: false,
    },
    ...overrides,
  };
}
async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  roots.push(root);
  clients.push(client);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>{ui}</CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  return { container, client };
}
const FourControls = () => (
  <>
    <BudgetModeControl />
    <ChatThinkingStreamControl />
    <ClaudeCliToolBridgeControl />
    <ClaudeCliWarmContinuationControl />
  </>
);

beforeEach(() => {
  resetSettingsAttempt();
  server = settingsAt(2);
  api.fetchSettings.mockImplementation(async () => structuredClone(server));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const client of clients.splice(0)) client.clear();
  document.body.replaceChildren();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("one shared settings read for the governed controls (U-GL-050)", () => {
  it("four governed controls make one settings read on mount, then one per minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { container } = await mount(<FourControls />);
    await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
    expect(api.fetchSettings).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.fetchSettings).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.fetchSettings).toHaveBeenCalledTimes(3);
  });

  it("every control shows each failed read as its own failed state, never a stale value", async () => {
    api.fetchSettings.mockRejectedValue(new Error("Gateway unreachable"));
    const { container } = await mount(<FourControls />);
    await vi.waitFor(() => expect(container.querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(4));
    expect(container.textContent).not.toContain("Current:");
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
  });

  it("a save in one control reaches the others at once and keeps their unsaved drafts", async () => {
    api.patchSettings.mockImplementation(async (input: { features?: Record<string, boolean> }) => {
      server = settingsAt(server.revision + 1, { features: { ...server.features, ...input.features } });
      return structuredClone(server);
    });
    const { container } = await mount(<FourControls />);
    await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "saver";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Unsaved preference draft");
    const switches = () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches()[0]?.getAttribute("aria-checked")).toBe("false");
    await act(async () => switches()[0]!.click());
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      /^Save/.test(button.textContent ?? ""),
    );
    const thinkingSave = save.find((button) => !button.disabled && button.textContent !== "Save preference")!;
    const readsBefore = api.fetchSettings.mock.calls.length;
    await act(async () => {
      thinkingSave.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(switches()[0]?.getAttribute("aria-checked")).toBe("true"));
    // The save's own read before writing and the read after it are separate calls from the shared poll.
    expect(api.fetchSettings.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(container.textContent).toContain("Unsaved preference draft");
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("saver");
  });

  it("a background refetch of the shared read leaves Save enabled in all four, and a save still reads fresh first", async () => {
    api.patchSettings.mockImplementation(async (input: { features?: Record<string, boolean> }) => {
      server = settingsAt(server.revision + 1, { features: { ...server.features, ...input.features } });
      return structuredClone(server);
    });
    server = settingsAt(2, { features: { ...server.features, claudeCliToolBridgeEnabled: true } });
    const { container, client } = await mount(<FourControls />);
    await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
    const switches = () => [
      ...container.querySelectorAll<HTMLButtonElement>('[role="switch"], input[type="checkbox"]'),
    ];
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "saver";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const toggle of switches()) await act(async () => toggle.click());
    const saves = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) => /^Save/.test(b.textContent ?? ""));
    expect(saves()).toHaveLength(4);
    // The minute poll (or another control's re-read) is in flight.
    let release: (value: Server) => void = () => undefined;
    api.fetchSettings.mockImplementationOnce(() => new Promise<Server>((resolve) => (release = resolve)));
    await act(async () => void client.refetchQueries({ queryKey: ["system", "settings-governed"] }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(client.isFetching({ queryKey: ["system", "settings-governed"] })).toBe(1);
    expect(saves().map((b) => b.disabled)).toEqual([false, false, false, false]);
    // A save goes through its own fresh read, not the shared one that is still running.
    const before = api.fetchSettings.mock.calls.length;
    await act(async () => {
      saves()[1]!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledTimes(1));
    expect(api.fetchSettings.mock.calls.length).toBeGreaterThan(before);
    await act(async () => release(structuredClone(server)));
  });

  it("one control's post-save re-read does not disable another control's Save", async () => {
    api.patchSettings.mockImplementation(async (input: { features?: Record<string, boolean> }) => {
      server = settingsAt(server.revision + 1, { features: { ...server.features, ...input.features } });
      return structuredClone(server);
    });
    server = settingsAt(2, { features: { ...server.features, claudeCliToolBridgeEnabled: true } });
    const { container } = await mount(<FourControls />);
    await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
    const switches = () => [
      ...container.querySelectorAll<HTMLButtonElement>('[role="switch"], input[type="checkbox"]'),
    ];
    await act(async () => switches()[0]!.click());
    await act(async () => switches()[1]!.click());
    const saves = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) => /^Save/.test(b.textContent ?? ""));
    // Hold the re-read that follows the first save.
    api.fetchSettings.mockImplementationOnce(async () => structuredClone(server));
    let release: (value: Server) => void = () => undefined;
    const held = new Promise<Server>((resolve) => (release = resolve));
    api.fetchSettings.mockImplementationOnce(() => held);
    await act(async () => {
      saves()
        .find((b) => !b.disabled && b.textContent === "Save setting")!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledTimes(1));
    const others = saves().filter((b) => b.textContent === "Save setting");
    expect(others.some((b) => !b.disabled)).toBe(true);
    await act(async () => release(structuredClone(server)));
  });

  it("a read made to confirm a save is never joined to an older in-flight shared read", async () => {
    let resolveStale: (value: Server) => void = () => undefined;
    const stale = {
      promise: new Promise<Server>((resolve) => (resolveStale = resolve)),
      resolve: (value: Server) => resolveStale(value),
    };
    let latestRead: Server = settingsAt(2);
    let probe: ReturnType<typeof useGovernedSettingsQuery> | undefined;
    function Probe() {
      probe = useGovernedSettingsQuery();
      return <p>{probe.data ? `revision ${probe.data.revision}` : "no data"}</p>;
    }
    const { container } = await mount(<Probe />);
    await vi.waitFor(() => expect(container.textContent).toContain("revision 2"));
    api.fetchSettings.mockImplementationOnce(() => stale.promise);
    api.fetchSettings.mockImplementation(async () => structuredClone(latestRead));
    await act(async () => void probe!.refetch());
    expect(api.fetchSettings).toHaveBeenCalledTimes(2);
    latestRead = settingsAt(3);
    await act(async () => void probe!.refetch());
    expect(api.fetchSettings).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(container.textContent).toContain("revision 3"));
    await act(async () => stale.resolve(settingsAt(2)));
    expect(container.textContent).toContain("revision 3");
  });
});
