import React from "react";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ToolActiveGrantsPanel } from "./ToolActiveGrantsPanel";

function collectText(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map((child) => collectText(child)).join(" ");
  }
  return "";
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function expandPanel(renderer: ReactTestRenderer): void {
  act(() => {
    renderer.root.findAllByType("button")[0]?.props.onClick({
      defaultPrevented: false,
      preventDefault: vi.fn(),
    });
  });
}

function grant(overrides: Partial<ToolGrantRecord> = {}): ToolGrantRecord {
  return {
    grantId: "grant-1",
    toolPattern: "shell.exec",
    decision: "allow",
    scope: "workspace",
    scopeRef: "default",
    grantType: "ttl",
    expiresAt: "2026-04-01T12:00:00.000Z",
    createdAt: "2026-04-01T11:00:00.000Z",
    createdBy: "operator",
    ...overrides,
  };
}

describe("ToolActiveGrantsPanel", () => {
  it("renders active grants, forwards filter updates, and revokes active grants", () => {
    const setGrantFilter = vi.fn();
    const onRevoke = vi.fn(async () => undefined);
    const renderer = create(
      <ToolActiveGrantsPanel
        grantFilter="shell"
        setGrantFilter={setGrantFilter}
        visibleGrants={[grant()]}
        onRevoke={onRevoke}
      />,
    );

    expandPanel(renderer);
    expect(rendererText(renderer)).toContain("Active Grants");
    expect(rendererText(renderer)).toContain("1 visible");
    expect(rendererText(renderer)).toContain("workspace : default");
    expect(rendererText(renderer)).toContain("2026-04-01T12:00:00.000Z");

    act(() => {
      renderer.root.findByType("input").props.onChange({ target: { value: "browser" } });
    });
    expect(setGrantFilter).toHaveBeenCalledWith("browser");

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Revoke"))
        ?.props.onClick();
    });
    expect(onRevoke).toHaveBeenCalledWith("grant-1");
  });

  it("renders revoked and empty states without revoke actions", () => {
    const revokedRenderer = create(
      <ToolActiveGrantsPanel
        grantFilter=""
        setGrantFilter={vi.fn()}
        visibleGrants={[
          grant({ grantId: "grant-revoked", revokedAt: "2026-04-01T11:30:00.000Z", expiresAt: undefined }),
        ]}
        onRevoke={vi.fn()}
      />,
    );

    expandPanel(revokedRenderer);
    expect(rendererText(revokedRenderer)).toContain("revoked");
    expect(rendererText(revokedRenderer)).toContain("-");
    expect(revokedRenderer.root.findAllByType("button").some((button) => button.children.includes("Revoke"))).toBe(
      false,
    );

    const emptyRenderer = create(
      <ToolActiveGrantsPanel grantFilter="missing" setGrantFilter={vi.fn()} visibleGrants={[]} onRevoke={vi.fn()} />,
    );

    expandPanel(emptyRenderer);
    expect(rendererText(emptyRenderer)).toContain("0 visible");
    expect(rendererText(emptyRenderer)).toContain("No grants match your filter.");
  });
});
