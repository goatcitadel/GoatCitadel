import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    actions,
    children,
  }: {
    title?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <div>{actions}</div>
      {children}
    </section>
  ),
}));

import { ChatDockSuggestionsSection } from "./ChatDockSuggestionsSection";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function instanceText(node: ReactTestInstance | string | number): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return node.children.map((child) => instanceText(child as ReactTestInstance | string | number)).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType("button").find((candidate) => instanceText(candidate).includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function buildProps(overrides: Partial<Parameters<typeof ChatDockSuggestionsSection>[0]> = {}) {
  return {
    isChatSurface: true,
    isCoworkSurface: false,
    sending: false,
    selectedSessionId: "session-1",
    proactiveRuns: [],
    proactiveSuggestionCount: 0,
    capabilitySuggestions: [],
    specialistSuggestions: [],
    specialistCandidates: [],
    delegationSuggestion: null,
    onCapabilitySuggestionAction: vi.fn(),
    onCreateSpecialistDraft: vi.fn(async () => undefined),
    onActivateCatalogSpecialist: vi.fn(async () => undefined),
    onSpecialistCandidatePatch: vi.fn(async () => undefined),
    onAcceptDelegation: vi.fn(async () => undefined),
    ...overrides,
  } as Parameters<typeof ChatDockSuggestionsSection>[0];
}

describe("ChatDockSuggestionsSection", () => {
  it("routes capability, specialist, catalog, and delegation actions while hiding no-action runs", async () => {
    const onCapabilitySuggestionAction = vi.fn();
    const onCreateSpecialistDraft = vi.fn(async () => undefined);
    const onActivateCatalogSpecialist = vi.fn(async () => undefined);
    const onAcceptDelegation = vi.fn(async () => undefined);
    const renderer = create(
      <ChatDockSuggestionsSection
        {...buildProps({
          isChatSurface: false,
          isCoworkSurface: true,
          proactiveSuggestionCount: 2,
          proactiveRuns: [
            {
              runId: "run-hidden",
              status: "no_action",
              startedAt: "2026-05-14T10:00:00.000Z",
              reasoningSummary: "Should stay hidden",
            } as never,
            {
              runId: "run-visible",
              status: "suggested",
              startedAt: "2026-05-14T10:01:00.000Z",
              reasoningSummary: "Review the next checkpoint.",
            } as never,
          ],
          capabilitySuggestions: [
            {
              kind: "missing_skill",
              title: "Install browser skill",
              summary: "Browser access is useful.",
              reason: "The prompt asks for live inspection.",
              recommendedAction: "install_skill_enable",
              riskLevel: "medium",
            } as never,
          ],
          specialistSuggestions: [
            {
              title: "Research specialist",
              role: "Researcher",
              summary: "Handles external sourcing.",
            } as never,
            {
              candidateId: "catalog-qa",
              title: "QA specialist",
              role: "QA",
              summary: "Reusable test lead.",
              reason: "Catalog match.",
              source: "catalog",
            } as never,
          ],
          delegationSuggestion: {
            reason: "Split research and verification.",
            roles: ["Researcher", "QA"],
          } as never,
          onCapabilitySuggestionAction,
          onCreateSpecialistDraft,
          onActivateCatalogSpecialist,
          onAcceptDelegation,
        })}
      />,
    );

    const text = collectText(renderer.toJSON());
    expect(text).toContain("Suggested next moves");
    expect(text).toContain("Review the next checkpoint.");
    expect(text).not.toContain("Should stay hidden");

    await act(async () => {
      findButton(renderer.root, "Approve and install").props.onClick();
      await findButton(renderer.root, "Draft dormant specialist").props.onClick();
      await findButton(renderer.root, "Activate for session").props.onClick();
      await findButton(renderer.root, "Accept plan").props.onClick();
    });

    expect(onCapabilitySuggestionAction).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Install browser skill" }),
    );
    expect(onCreateSpecialistDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "Research specialist" }));
    expect(onActivateCatalogSpecialist).toHaveBeenCalledWith(expect.objectContaining({ candidateId: "catalog-qa" }));
    expect(onAcceptDelegation).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("a").props.href).toContain("catalogEntryId=catalog-qa");
  });

  it("patches saved specialists through approve, activate, disable, and retire actions", async () => {
    const onSpecialistCandidatePatch = vi.fn(async () => undefined);
    const renderer = create(
      <ChatDockSuggestionsSection
        {...buildProps({
          specialistCandidates: [
            {
              candidateId: "draft-1",
              title: "Draft Specialist",
              role: "Coder",
              summary: "Draft helper.",
              status: "drafted",
              routingMode: "manual_only",
              confidence: 0.64,
            } as never,
            {
              candidateId: "retired-1",
              title: "Retired Specialist",
              role: "Ops",
              summary: "Hidden helper.",
              status: "retired",
              routingMode: "disabled",
              confidence: 0.1,
            } as never,
          ],
          onSpecialistCandidatePatch,
        })}
      />,
    );

    expect(collectText(renderer.toJSON())).toContain("Draft Specialist");
    expect(collectText(renderer.toJSON())).not.toContain("Retired Specialist");

    await act(async () => {
      await findButton(renderer.root, "Approve").props.onClick();
      await findButton(renderer.root, "Activate auto-match").props.onClick();
      await findButton(renderer.root, "Disable").props.onClick();
      await findButton(renderer.root, "Retire").props.onClick();
    });

    expect(onSpecialistCandidatePatch).toHaveBeenCalledWith(
      "draft-1",
      { status: "approved" },
      "Approved Draft Specialist.",
    );
    expect(onSpecialistCandidatePatch).toHaveBeenCalledWith(
      "draft-1",
      { status: "active", routingMode: "strong_match_only" },
      "Activated Draft Specialist for strong-match routing.",
    );
    expect(onSpecialistCandidatePatch).toHaveBeenCalledWith(
      "draft-1",
      { status: "disabled", routingMode: "manual_only" },
      "Disabled Draft Specialist.",
    );
    expect(onSpecialistCandidatePatch).toHaveBeenCalledWith(
      "draft-1",
      { status: "retired", routingMode: "disabled" },
      "Retired Draft Specialist.",
    );
  });
});
