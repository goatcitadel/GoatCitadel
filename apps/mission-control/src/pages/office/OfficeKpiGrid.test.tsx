import React from "react";
import { create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { OfficeKpiGrid } from "./OfficeKpiGrid";

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

function normalizedText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  return collectText(node)
    .replace(/\s+/g, " ")
    .replace(/\s+\/min/g, "/min")
    .trim();
}

describe("OfficeKpiGrid", () => {
  it("renders live and syncing KPI summaries", () => {
    const renderer = create(
      <OfficeKpiGrid
        activeAgents={3}
        hotAgents={2}
        readyAgents={5}
        eventFlow={1.25}
        pendingApprovalsCount={4}
        streamHealthy
      />,
    );

    expect(normalizedText(renderer.toJSON())).toContain("Goats in motion 3");
    expect(normalizedText(renderer.toJSON())).toContain("Event pace 1.3/min");
    expect(normalizedText(renderer.toJSON())).toContain("4 approvals pending");
    expect(normalizedText(renderer.toJSON())).toContain("stream live");

    renderer.update(
      <OfficeKpiGrid
        activeAgents={0}
        hotAgents={0}
        readyAgents={1}
        eventFlow={0}
        pendingApprovalsCount={0}
        streamHealthy={false}
      />,
    );

    expect(normalizedText(renderer.toJSON())).toContain("Ready reserves 1");
    expect(normalizedText(renderer.toJSON())).toContain("stream syncing");
    renderer.unmount();
  });
});
