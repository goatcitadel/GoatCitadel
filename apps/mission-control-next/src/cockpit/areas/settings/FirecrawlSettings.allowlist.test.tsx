// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ApprovalStatus } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: () => false,
}));
const check = vi.hoisted(() => ({ checkFirecrawlConnection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/web-search-settings", () => check);
// The dialog itself is covered in SettingsApprovalDialog.test.tsx; here it only reports a decision.
vi.mock("./SettingsApprovalDialog", () => ({
  SettingsApprovalDialog: ({ onResolved }: { onResolved: (status: ApprovalStatus) => void }) => (
    <>
      <button type="button" onClick={() => onResolved("approved")}>
        Decide approved
      </button>
      <button type="button" onClick={() => onResolved("rejected")}>
        Decide rejected
      </button>
    </>
  ),
}));

import { FirecrawlSettings } from "./FirecrawlSettings";

const settingsWith = (allowlist: string[], revision: number) => ({
  revision,
  networkAllowlist: allowlist,
  web: {
    firecrawl: {
      enabled: true,
      baseUrl: "http://192.168.0.199:3002",
      apiKeyEnv: "FIRECRAWL_API_KEY",
      timeoutMs: 20_000,
      defaultReadBackend: "firecrawl",
      fallbackToNative: true,
      baseUrlAllowlisted: allowlist.includes("192.168.0.199:3002"),
    },
  },
});

function Harness() {
  const settings = useQuery({ queryKey: ["settings", "firecrawl-test"], queryFn: () => api.fetchSettings() });
  return <FirecrawlSettings settings={settings as never} />;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

async function addHostAwaitingApproval() {
  api.fetchSettings.mockResolvedValue(settingsWith(["localhost"], 3));
  api.patchSettings.mockResolvedValue({
    ...settingsWith(["localhost"], 3),
    changePlanReceipt: {
      planId: "plan-allowlist",
      status: "awaiting_approval",
      revision: 3,
      requiredAction: { kind: "approval", approvalId: "approval-allowlist" },
    },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <Harness />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(button("Add 192.168.0.199:3002 to the outbound allowlist")).toBeDefined());
  await act(async () => button("Add 192.168.0.199:3002 to the outbound allowlist")!.click());
  await vi.waitFor(() => expect(button("Decide rejected")).toBeDefined());
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("does not offer a second allowlist request while the first waits for its decision", async () => {
  await addHostAwaitingApproval();
  expect(button("Add 192.168.0.199:3002 to the outbound allowlist")!.disabled).toBe(true);
  expect(api.patchSettings).toHaveBeenCalledTimes(1);
});

it("says a denied allowlist change added nothing, without reading the plan", async () => {
  await addHostAwaitingApproval();
  await act(async () => button("Decide rejected")!.click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Denied. 192.168.0.199:3002 was not added to the outbound allowlist."),
  );
  expect(container.textContent).not.toContain("is now in the outbound allowlist");
  expect(api.fetchChangePlan).not.toHaveBeenCalled();
});

it("reports the host as added only after the plan completes", async () => {
  await addHostAwaitingApproval();
  api.fetchChangePlan.mockResolvedValue({ planId: "plan-allowlist", status: "completed" });
  api.fetchSettings.mockResolvedValue(settingsWith(["localhost", "192.168.0.199:3002"], 4));
  await act(async () => button("Decide approved")!.click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "192.168.0.199:3002 is now in the outbound allowlist. Save Firecrawl to finish.",
    ),
  );
  expect(api.fetchChangePlan).toHaveBeenCalledWith("plan-allowlist", { workspaceId: "default" });
});

it("reports an approved change that failed to apply as not added", async () => {
  await addHostAwaitingApproval();
  api.fetchChangePlan.mockResolvedValue({
    planId: "plan-allowlist",
    status: "failed",
    result: { summary: "The owner write failed." },
  });
  await act(async () => button("Decide approved")!.click());
  await vi.waitFor(() => expect(container.textContent).toContain("192.168.0.199:3002 was not added."));
  expect(container.textContent).toContain("The owner write failed.");
  expect(container.textContent).not.toContain("is now in the outbound allowlist");
});

const renderPage = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <Harness />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );

it("stops showing a blocked test result once the settings change, until a new test says otherwise", async () => {
  // The settings read says allowed, but the test finds the host blocked and it is not listed yet.
  const first = settingsWith(["localhost"], 3);
  first.web.firecrawl.baseUrlAllowlisted = true;
  api.fetchSettings.mockResolvedValue(first);
  check.checkFirecrawlConnection.mockResolvedValue({
    status: "blocked",
    baseUrl: "http://192.168.0.199:3002",
    checkedAt: "2026-11-15T00:00:00Z",
    keySource: "none",
    message: "Not allowlisted.",
  });
  await renderPage();
  await vi.waitFor(() => expect(button("Test connection")).toBeDefined());
  await act(async () => button("Test connection")!.click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("192.168.0.199:3002 is not in the outbound allowlist, so tools can't"),
  );
  // The host was added elsewhere: the settings revision moves and the Gateway now says allowed.
  api.fetchSettings.mockResolvedValue(settingsWith(["192.168.0.199:3002"], 4));
  await act(async () => client.invalidateQueries());
  await vi.waitFor(() => expect(container.textContent).not.toContain("is not in the outbound allowlist, so tools"));
  expect(container.textContent).not.toContain("Not allowlisted.");
});

it("offers no add button for a listed address the Gateway still refuses as private or reserved", async () => {
  const refused = settingsWith(["127.0.0.1:9"], 3);
  refused.web.firecrawl.baseUrl = "http://127.0.0.1:9";
  refused.web.firecrawl.baseUrlAllowlisted = false;
  api.fetchSettings.mockResolvedValue(refused);
  await renderPage();
  await vi.waitFor(() => expect(container.textContent).toContain("127.0.0.1:9 can't be used for Firecrawl."));
  expect(container.textContent).toContain("private or reserved address");
  expect(
    [...container.querySelectorAll("button")].some((element) =>
      /Add .* to the outbound allowlist/u.test(element.textContent ?? ""),
    ),
  ).toBe(false);
});
