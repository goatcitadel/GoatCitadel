// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JourneyTimelineItem, JourneyTimelinePage } from "@goatcitadel/contracts";
import { fetchJourneyTimeline } from "@goatcitadel/mission-control-shared/api/journey";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryJourney } from "./LibraryJourney";

vi.mock("@goatcitadel/mission-control-shared/api/journey", () => ({ fetchJourneyTimeline: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "one", activeCitadelId: "personal", showTechnicalDetails: false }),
}));

function item(id: string, overrides: Partial<JourneyTimelineItem> = {}): JourneyTimelineItem {
  return {
    eventId: id,
    eventFingerprint: "a".repeat(64),
    category: "memory",
    scopeKind: "workspace",
    workspaceId: "one",
    eventType: "memory_lifecycle",
    subjectKind: "memory_item",
    subjectId: "m-1",
    action: "memory_written",
    actorId: "operator",
    actorType: "operator",
    evidenceRefs: [{ owner: "approval", refId: "approval-7" } as JourneyTimelineItem["evidenceRefs"][number]],
    evidence: {
      health: "complete",
      sourceLinked: true,
      approvalLinked: true,
      requiresSource: true,
      requiresApproval: true,
      requirementsDeclared: true,
      trustContribution: "evidence_only",
      blockerCodes: [],
    },
    provenance: { origin: "chat-turn" },
    summary: { title: "Saved preference" },
    occurredAt: "2026-10-07T10:00:00.000Z",
    recordedAt: `2026-10-07T10:00:0${id.slice(-1)}.000Z`,
    ...overrides,
  };
}
function page(items: JourneyTimelineItem[], nextCursor?: string): JourneyTimelinePage {
  return {
    schemaVersion: "goatcitadel.journey-timeline-page.v1",
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "one",
    includeGlobal: false,
    items,
    ...(nextCursor ? { nextCursor } : {}),
    generatedAt: "2026-10-07T11:00:00.000Z",
  };
}
let root: Root, container: HTMLDivElement, client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
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

async function open(path: string) {
  await act(async () => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <LibraryJourney workspaceId="one" />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
}
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const lastQuery = () => vi.mocked(fetchJourneyTimeline).mock.calls.at(-1)![0];

it("reads the URL filters as an exact scoped query and states the read-only boundary", async () => {
  vi.mocked(fetchJourneyTimeline).mockResolvedValue(page([item("e-1")]));
  await open("/library/journey?category=memory&evidence=blocked&sessionId=s-9&includeGlobal=true");
  await vi.waitFor(() => expect(container.textContent).toContain("Memory written"));
  expect(lastQuery()).toMatchObject({
    workspaceId: "one",
    includeGlobal: true,
    sessionId: "s-9",
    poisoningStatuses: ["blocked"],
    eventTypes: ["memory_lifecycle", "memory_item_lifecycle", "structured_memory_lifecycle"],
  });
  expect(container.textContent).toContain("never activates skills or promotes memory");
});

it("updates the URL and query when a filter changes", async () => {
  vi.mocked(fetchJourneyTimeline).mockResolvedValue(page([item("e-1")]));
  await open("/library/journey");
  await vi.waitFor(() => expect(container.textContent).toContain("Memory written"));
  const select = [...container.querySelectorAll("select")][0]!;
  await act(async () => {
    select.value = "approvals";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get("category")).toBe("approvals"));
  await vi.waitFor(() => expect(lastQuery().eventTypes).toEqual(["approval_lifecycle", "approval_effect_lifecycle"]));
});

it("loads older events with the cursor and keeps each event once", async () => {
  vi.mocked(fetchJourneyTimeline)
    .mockResolvedValueOnce(page([item("e-2"), item("e-1")], "cursor-1"))
    .mockResolvedValueOnce(page([item("e-1"), item("e-0")]));
  await open("/library/journey");
  await vi.waitFor(() => expect(button("Load older events")).toBeDefined());
  await act(async () => button("Load older events")!.click());
  await vi.waitFor(() => expect(container.querySelectorAll("[data-journey-event]").length).toBe(3));
  expect(lastQuery().cursor).toBe("cursor-1");
  expect(button("Load older events")).toBeUndefined();
});

it("inspects a selected event's evidence, references and provenance without raw payloads by default", async () => {
  vi.mocked(fetchJourneyTimeline).mockResolvedValue(
    page([
      item("e-1", {
        evidence: {
          ...item("e-1").evidence,
          health: "missing_approval",
          approvalLinked: false,
          trustContribution: "blocked",
        },
      }),
    ]),
  );
  await open("/library/journey?eventId=e-1");
  const inspector = await vi.waitFor(() => {
    const region = container.querySelector<HTMLElement>("[aria-label='Journey event detail']");
    expect(region).not.toBeNull();
    return region!;
  });
  for (const text of ["missing approval", "blocked", "approval-7", "chat-turn", "Saved preference"])
    expect(inspector.textContent).toContain(text);
  expect(inspector.textContent).not.toContain('"eventFingerprint"');
});

it("keeps the session field in step with the URL on Back and normalizes the applied value", async () => {
  vi.mocked(fetchJourneyTimeline).mockResolvedValue(page([item("e-1")]));
  await open("/library/journey?sessionId=s-1");
  const input = () => container.querySelectorAll("input")[0] as HTMLInputElement;
  await vi.waitFor(() => expect(input().value).toBe("s-1"));
  await act(async () => {
    window.history.pushState(null, "", "/library/journey?sessionId=s-2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await vi.waitFor(() => expect(input().value).toBe("s-2"));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "  ｓ-3 ");
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Apply session")!.click());
  await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("s-3"));
});

it("states which producers Journey does not yet cover", async () => {
  vi.mocked(fetchJourneyTimeline).mockResolvedValue(page([item("e-1")]));
  await open("/library/journey");
  await vi.waitFor(() => expect(container.textContent).toContain("Memory written"));
  expect(container.textContent).toContain("not yet complete");
  expect(container.textContent).toContain("not release-bearing parity evidence");
});

it("says when a linked event is not in the loaded results", async () => {
  vi.mocked(fetchJourneyTimeline).mockResolvedValue(page([item("e-1")], "cursor-1"));
  await open("/library/journey?eventId=e-missing");
  await vi.waitFor(() => expect(container.textContent).toContain("This event is not in the loaded results"));
});

it("reports an unavailable timeline without claiming there are no events", async () => {
  vi.mocked(fetchJourneyTimeline).mockRejectedValue(
    Object.assign(new Error("Journey timeline service is unavailable."), { status: 503 }),
  );
  await open("/library/journey");
  await vi.waitFor(() => expect(container.textContent).toContain("Journey timeline service is unavailable."));
  expect(container.textContent).not.toContain("No Journey events match");
});
