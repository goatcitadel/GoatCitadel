import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryKnowledgeSection } from "./LibraryKnowledgeSection";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  fetchEngineeringLearnings: vi.fn(),
  fetchMemoryFiles: vi.fn(),
  fetchMemoryQmdStats: vi.fn(),
  fetchSettings: vi.fn(),
  requestEngineeringLearningAction: vi.fn(),
}));

const journeyMocks = vi.hoisted(() => ({
  fetchJourneyTimeline: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => apiMocks);
vi.mock("@goatcitadel/mission-control-shared/api/journey", () => journeyMocks);
vi.mock("./LibraryExternalSourcesSection", () => ({
  LibraryExternalSourcesSection: () => "External sources panel",
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FULL_SHA = "9f2c4d6e8a0b1c3d5e7f9a1b2c4d6e8f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d";
const TIMESTAMP = "2026-07-20T10:00:00.000Z";

function journeyEvent(action: string, eventIdSuffix = "") {
  return {
    eventId: `event-${action}${eventIdSuffix}`,
    eventFingerprint: `fingerprint-${action}`,
    category: "provenance",
    scopeKind: "workspace",
    workspaceId: "workspace-1",
    eventType: "knowledge_snapshot_lifecycle",
    subjectKind: "external_source_knowledge_snapshot",
    subjectId: action === "approval_requested" ? "approval-1" : "link-1",
    action,
    actorId: "operator-1",
    actorType: "operator",
    approvalId: "approval-1",
    sourceKind: "external_source",
    sourceId: "source-1",
    trustDisposition: action === "approval_requested" ? "evidence_only" : "approved_snapshot",
    poisoningStatus: "clean",
    evidenceRefs: [],
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
    provenance: {},
    summary: {
      approvalId: "approval-1",
      sourceId: "source-1",
      importId: "import-1",
      itemId: "item-1",
      attachmentId: "attachment-1",
      normalizedArtifactSha256: FULL_SHA,
      ...(action === "approval_requested"
        ? {}
        : { linkId: "link-1", knowledgeDocumentId: "knowledge-doc-1", chunkCount: 3 }),
    },
    occurredAt: TIMESTAMP,
    recordedAt: TIMESTAMP,
  };
}

function journeyPage(items: unknown[]) {
  return {
    schemaVersion: "goatcitadel.journey-timeline-page.v1",
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "workspace-1",
    includeGlobal: false,
    items,
    generatedAt: TIMESTAMP,
  };
}

const baseProps = {
  activeWorkspaceId: "workspace-1",
  activeWorkspaceName: "Workspace One",
} as unknown as NativeRoutePagesProps;

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : collectText(child)))
    .join(" ");
}

function metricValue(renderer: ReactTestRenderer, label: string): string {
  const metric = renderer.root
    .findAll((node) => node.props?.className === "mc-next-settings-metric")
    .find((node) => collectText(node).includes(label));
  if (!metric) {
    throw new Error(`Metric not found: ${label}`);
  }
  return collectText(metric.findByType("strong"));
}

async function renderSection(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(<LibraryKnowledgeSection {...baseProps} />);
  });
  return renderer!;
}

function markupOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  apiMocks.downloadFile.mockReset().mockResolvedValue({ content: "# Notes", contentType: "text/markdown" });
  apiMocks.fetchEngineeringLearnings.mockReset().mockResolvedValue({ items: [] });
  apiMocks.fetchMemoryFiles.mockReset().mockResolvedValue({
    items: [{ relativePath: "memory/workspace.md", size: 512, modifiedAt: TIMESTAMP }],
  });
  apiMocks.fetchMemoryQmdStats.mockReset().mockResolvedValue(null);
  apiMocks.fetchSettings.mockReset().mockResolvedValue({ features: { engineeringLearningsV1Enabled: false } });
  apiMocks.requestEngineeringLearningAction.mockReset();
  journeyMocks.fetchJourneyTimeline.mockReset().mockResolvedValue(journeyPage([]));
});

describe("LibraryKnowledgeSection", () => {
  it("projects recovered external snapshots from the Journey lifecycle evidence", async () => {
    journeyMocks.fetchJourneyTimeline.mockResolvedValue(
      journeyPage([
        journeyEvent("snapshot_created"),
        journeyEvent("snapshot_created", "-2"),
        journeyEvent("attached"),
        journeyEvent("approval_requested"),
      ]),
    );
    const renderer = await renderSection();
    const markup = markupOf(renderer);

    expect(journeyMocks.fetchJourneyTimeline).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventTypes: ["knowledge_snapshot_lifecycle"],
      limit: 8,
    });
    expect(markup).toContain("Recovered external snapshots");
    expect(markup).toContain("Snapshot created");
    expect(markup).toContain("Attached to thread");
    expect(markup).toContain("Approval requested");
    expect(markup).toContain("knowledge-doc-1");
    expect(markup).toContain("3 chunks");
    expect(markup).toContain(`${FULL_SHA.slice(0, 12)}…`);
    expect(markup).not.toContain(FULL_SHA);
    expect(metricValue(renderer, "Snapshots created")).toBe("2");
    expect(metricValue(renderer, "Thread attachments")).toBe("1");
    expect(metricValue(renderer, "Approval requests")).toBe("1");
    expect(markup).not.toContain("Pending approvals");
    expect(markup).not.toContain("awaiting approval");
    expect(markup).toContain("Knowledge-copy request recorded");
    expect(markup).not.toContain("Awaiting operator approval");
    renderer.unmount();
  });

  it("never tags memory file paths as recovered snapshots", async () => {
    apiMocks.fetchMemoryFiles.mockResolvedValue({
      items: [{ relativePath: "memory/external-source-snapshots-notes.md", size: 512, modifiedAt: TIMESTAMP }],
    });
    const renderer = await renderSection();
    const markup = markupOf(renderer);

    expect(markup).toContain("memory/external-source-snapshots-notes.md");
    expect(markup).not.toContain(" · Recovered external snapshot");
    expect(markup).not.toContain("Approved external-source copy");
    expect(markup).toContain("No recovered external snapshots yet");
    renderer.unmount();
  });

  it("keeps the knowledge browser alive when the Journey evidence feed is unavailable", async () => {
    journeyMocks.fetchJourneyTimeline.mockRejectedValue(new Error("journey feed offline"));
    const renderer = await renderSection();
    const markup = markupOf(renderer);

    expect(markup).toContain("memory/workspace.md");
    expect(markup).toContain("No recovered external snapshots yet");
    expect(markup).toContain("journey feed offline");
    renderer.unmount();
  });
});
