// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemoryContextPack } from "@goatcitadel/contracts";
import { fetchMemoryQmdStats } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchJourneyTimeline } from "@goatcitadel/mission-control-shared/api/journey";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryKnowledgeEvidence } from "./LibraryKnowledgeEvidence";

vi.mock("@goatcitadel/mission-control-shared/api/memory", () => ({ fetchMemoryQmdStats: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/journey", () => ({ fetchJourneyTimeline: vi.fn() }));

const transcript = JSON.stringify({
  message: {
    role: "user",
    content: "Draft the release notes for 1.0",
    parts: [{ type: "text", text: "Draft the release notes for 1.0" }],
  },
});

const pack = {
  contextId: "ctx-1",
  scope: "session",
  queryHash: "q",
  sourcesHash: "s",
  contextText: "Retained context",
  citations: [
    {
      candidateId: "c-1",
      sourceType: "transcript",
      sourceRef: "turn-1",
      snippet: transcript,
      score: 0.8123,
      provenance: { relationScope: "session", freshness: "current", selectionReason: "Matched the request" },
    },
    { candidateId: "c-2", sourceType: "memory_item", sourceRef: "m-1", snippet: "Plain memory excerpt", score: 0.5 },
    { candidateId: "c-3", sourceType: "transcript", sourceRef: "turn-2", snippet: '{"message":{"role":"assistant"}}', score: 0.25 },
  ],
  quality: {},
  originalTokenEstimate: 120,
  distilledTokenEstimate: 40,
  createdAt: "2026-10-10T08:00:00.000Z",
  expiresAt: "2026-10-11T08:00:00.000Z",
} as unknown as MemoryContextPack;

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchMemoryQmdStats).mockResolvedValue({ recent: [pack] } as never);
  vi.mocked(fetchJourneyTimeline).mockResolvedValue({ items: [] } as never);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

it("renders transcript citations as role and message text and keeps the raw JSON behind technical details", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryKnowledgeEvidence workspaceId="one" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Draft the release notes for 1.0"));
  const cards = [...container.querySelectorAll<HTMLElement>("section[aria-label='Knowledge evidence'] > ul > li > ul > li")];
  expect(cards).toHaveLength(3);
  const [transcriptCard, memoryCard, emptyCard] = cards as [HTMLElement, HTMLElement, HTMLElement];

  const excerpt = transcriptCard.querySelector("p");
  expect(excerpt?.textContent).toBe("User: Draft the release notes for 1.0");
  expect(excerpt?.textContent).not.toContain('"role"');
  expect(transcriptCard.textContent).toContain("Score 0.812");
  const details = [...transcriptCard.querySelectorAll("details")].find(
    (node) => node.querySelector("summary")?.textContent === "Technical details",
  );
  expect(details?.textContent).toContain('"role": "user"');
  expect(details?.open).toBe(false);

  expect(memoryCard.querySelector("p")?.textContent).toBe("Plain memory excerpt");
  expect([...memoryCard.querySelectorAll("summary")].map((node) => node.textContent)).not.toContain("Technical details");

  expect(emptyCard.querySelector("p")?.textContent).toBe("Assistant: No message text recorded");
});
