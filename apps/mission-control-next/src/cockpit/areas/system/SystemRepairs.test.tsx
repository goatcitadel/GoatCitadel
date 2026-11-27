// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeRepairSweepSnapshot } from "@goatcitadel/contracts";
import { fetchRuntimeRepairs } from "@goatcitadel/mission-control-shared/api/runtime-repairs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { SystemRepairs } from "./SystemRepairs";

vi.mock("@goatcitadel/mission-control-shared/api/runtime-repairs", () => ({ fetchRuntimeRepairs: vi.fn() }));
const preferences = { activeWorkspaceId: "one", activeCitadelId: "personal", showTechnicalDetails: false };
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));

const checked = "2026-11-27T12:00:00.000Z";
const detectors: RuntimeRepairSweepSnapshot["detectors"] = [
  { detectorId: "approval.resolved-wait-not-woken", lastRunAt: checked, truncated: false },
  { detectorId: "durable.dead-letter", lastRunAt: checked, truncated: true },
];
const withFindings: RuntimeRepairSweepSnapshot = {
  mode: "detect_only",
  ready: true,
  lastTickAt: checked,
  detectors,
  open: [
    {
      findingId: "f-1",
      detectorId: "approval.resolved-wait-not-woken",
      detectorVersion: 1,
      fingerprint: "fp-1",
      subject: { runId: "run-1", approvalId: "approval-1" },
      summary: "An approval was answered, but the run waiting on it never continued.",
      proposedTier: "automatic",
      facts: { minutesSinceResolved: 12 },
      state: "observed",
      firstSeenAt: "2026-11-27T11:50:00.000Z",
      lastSeenAt: checked,
      seenCount: 3,
    },
    {
      findingId: "f-2",
      detectorId: "approval.no-inbox",
      detectorVersion: 1,
      fingerprint: "fp-2",
      subject: { approvalId: "approval-2" },
      summary: "An approval is waiting for you, but it belongs to no workspace or chat, so no Inbox shows it.",
      proposedTier: "report",
      facts: { approvalKind: "tool.invoke", minutesPending: 40 },
      state: "observed",
      firstSeenAt: "2026-11-27T11:20:00.000Z",
      lastSeenAt: checked,
      seenCount: 1,
    },
  ],
  recentlyCleared: [],
};

let root: Root, container: HTMLDivElement, client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  preferences.showTechnicalDetails = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

async function open() {
  await act(async () => {
    window.history.replaceState(null, "", "/system/repairs");
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <SystemRepairs />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
}
const links = () =>
  [...container.querySelectorAll<HTMLAnchorElement>("a")].map((a) => [a.textContent?.trim(), a.getAttribute("href")]);
const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());

it("lists open findings in plain words, links each to the thing it names, and offers nothing that changes them", async () => {
  vi.mocked(fetchRuntimeRepairs).mockResolvedValue(withFindings);
  await open();
  await vi.waitFor(() => expect(container.textContent).toContain("2 things look stuck as of the last check."));
  expect(container.querySelector("h1")?.textContent).toBe("Repairs");
  expect(container.textContent).toContain("This first version only watches: it hasn't changed anything.");
  expect(container.textContent).toContain("Can be fixed automatically later");
  expect(container.textContent).toContain("Needs you");
  expect(container.textContent).toContain("Answered 12 min ago · seen 3 times");
  expect(links()).toEqual(
    expect.arrayContaining([
      ["Open run", "/work/runs/run-1?shell=cockpit"],
      ["Review approval", "/inbox?approvalId=approval-2&shell=cockpit"],
    ]),
  );
  expect(buttons()).toEqual(["Refresh repairs"]);
  expect(container.textContent).not.toContain("approval.no-inbox");
  expect(container.textContent).toContain("Only the newest ones were checked");
});

it("shows raw ids only in technical details when the operator turned them on", async () => {
  preferences.showTechnicalDetails = true;
  vi.mocked(fetchRuntimeRepairs).mockResolvedValue(withFindings);
  await open();
  await vi.waitFor(() => expect(container.textContent).toContain("Technical details"));
  expect(container.querySelector("details")?.textContent).toContain("approval.resolved-wait-not-woken");
});

it("says the first check hasn't run, rather than that nothing is stuck", async () => {
  vi.mocked(fetchRuntimeRepairs).mockResolvedValue({ ...withFindings, ready: false, lastTickAt: undefined, open: [] });
  await open();
  await vi.waitFor(() => expect(container.textContent).toContain("The first check hasn't run yet"));
  expect(container.textContent).not.toContain("Nothing looks stuck");
});

it("says nothing looks stuck once every check ran, and still lists the checks", async () => {
  vi.mocked(fetchRuntimeRepairs).mockResolvedValue({ ...withFindings, open: [] });
  await open();
  await vi.waitFor(() => expect(container.textContent).toContain("Nothing looks stuck"));
  expect(container.textContent).toContain("Answered approvals whose run didn't continue");
  expect(container.textContent).not.toContain("Open run");
});

it("names a check that couldn't run instead of calling the page clear", async () => {
  vi.mocked(fetchRuntimeRepairs).mockResolvedValue({
    ...withFindings,
    open: [],
    detectors: [{ detectorId: "approval.expiry-lagging", lastRunAt: checked, truncated: false, lastError: "boom" }],
  });
  await open();
  await vi.waitFor(() => expect(container.textContent).toContain("1 check couldn't run."));
  expect(container.textContent).toContain("Couldn't check this time");
  expect(container.textContent).not.toContain("Nothing looks stuck");
  expect(container.textContent).not.toContain("boom");
});

it("shows a failed load as an error with a way to try again", async () => {
  vi.mocked(fetchRuntimeRepairs).mockRejectedValue(new Error("Gateway unreachable"));
  await open();
  await vi.waitFor(() => expect(container.textContent).toContain("Repairs unavailable"));
  expect(buttons()).toContain("Try again");
});
