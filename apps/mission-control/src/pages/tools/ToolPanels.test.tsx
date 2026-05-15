import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ToolCatalogEntry, ToolGrantRecord } from "@goatcitadel/contracts";

vi.mock("../../components/DataToolbar", () => ({
  DataToolbar: ({
    primary,
    center,
    secondary,
  }: {
    primary?: React.ReactNode;
    center?: React.ReactNode;
    secondary?: React.ReactNode;
  }) => (
    <div data-slot="data-toolbar">
      {primary}
      {center}
      {secondary}
    </div>
  ),
}));

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    className,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    className?: string;
    children?: React.ReactNode;
  }) => (
    <section className={className} data-slot="panel">
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

vi.mock("../../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span data-slot="status-chip">{children}</span>,
}));

import { ToolAccessModesPanel } from "./ToolAccessModesPanel";
import { ToolActiveGrantsPanel } from "./ToolActiveGrantsPanel";
import { ToolCatalogPanel } from "./ToolCatalogPanel";

function textOf(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child)).join(" ");
  }
  return (node.children ?? []).map((child) => textOf(child as ReactTestRendererJSON | string | null)).join(" ");
}

function instanceText(value: unknown): string {
  if (value == null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => instanceText(child)).join(" ");
  }
  if (typeof value === "object" && "children" in value) {
    return instanceText((value as { children?: unknown }).children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  const match = renderer.root.findAllByType("button").find((node) => instanceText(node).includes(label));
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

describe("tool page panels", () => {
  it("filters active grants, exposes visible counts, and only allows revoke for active grants", () => {
    const setGrantFilter = vi.fn();
    const onRevoke = vi.fn(async () => undefined);
    const renderer = create(
      <ToolActiveGrantsPanel
        grantFilter="fs"
        setGrantFilter={setGrantFilter}
        visibleGrants={[
          {
            grantId: "grant-active",
            toolPattern: "fs.read",
            decision: "allow",
            scope: "session",
            scopeRef: "session-1",
            grantType: "persistent",
            createdBy: "operator",
            createdAt: "2026-05-15T08:00:00.000Z",
          } as ToolGrantRecord,
          {
            grantId: "grant-revoked",
            toolPattern: "browser.search",
            decision: "deny",
            scope: "workspace",
            scopeRef: "default",
            grantType: "ttl",
            createdBy: "operator",
            createdAt: "2026-05-15T08:30:00.000Z",
            expiresAt: "2026-05-15T10:00:00.000Z",
            revokedAt: "2026-05-15T09:00:00.000Z",
          } as ToolGrantRecord,
        ]}
        onRevoke={onRevoke}
      />,
    );

    expect(textOf(renderer.toJSON())).toMatch(/2\s+visible/);
    expect(textOf(renderer.toJSON())).toContain("fs.read");
    expect(textOf(renderer.toJSON())).toContain("revoked");

    act(() => {
      renderer.root.findByType("input").props.onChange({ target: { value: "browser" } });
      button(renderer, "Revoke").props.onClick();
    });

    expect(setGrantFilter).toHaveBeenCalledWith("browser");
    expect(onRevoke).toHaveBeenCalledWith("grant-active");
    expect(renderer.root.findAllByType("button")).toHaveLength(1);
    renderer.unmount();
  });

  it("renders the empty active-grant state when no grant rows match", () => {
    const renderer = create(
      <ToolActiveGrantsPanel grantFilter="none" setGrantFilter={vi.fn()} visibleGrants={[]} onRevoke={vi.fn()} />,
    );

    expect(textOf(renderer.toJSON())).toMatch(/0\s+visible/);
    expect(textOf(renderer.toJSON())).toContain("No grants match your filter.");
    renderer.unmount();
  });

  it("groups catalog entries by pack, marks nontechnical mode, and updates the catalog filter", () => {
    const setCatalogFilter = vi.fn();
    const coreTool = {
      toolName: "fs.read",
      category: "fs",
      riskLevel: "safe",
      description: "Read a file",
      requiresApproval: false,
      argSchema: {},
      examples: [],
      pack: "core",
    } as ToolCatalogEntry;
    const commsTool = {
      toolName: "slack.send",
      category: "comms",
      riskLevel: "caution",
      description: "Send a Slack message",
      requiresApproval: true,
      argSchema: {},
      examples: [],
      pack: "comms",
    } as ToolCatalogEntry;
    const renderer = create(
      <ToolCatalogPanel
        showTechnicalDetails={false}
        catalogFilter="fs"
        setCatalogFilter={setCatalogFilter}
        catalogCount={2}
        catalogByPack={{ core: [coreTool], devops: [], knowledge: [], comms: [commsTool] }}
      />,
    );

    expect(renderer.root.findByProps({ "data-slot": "panel" }).props.className).toContain("expert-only");
    expect(textOf(renderer.toJSON())).toMatch(/2\s+total/);
    expect(textOf(renderer.toJSON())).toContain("CORE");
    expect(textOf(renderer.toJSON())).toContain("fs.read");
    expect(textOf(renderer.toJSON())).toContain("yes");
    expect(textOf(renderer.toJSON())).toContain("No tools in this pack.");

    act(() => {
      renderer.root.findByType("input").props.onChange({ target: { value: "slack" } });
    });

    expect(setCatalogFilter).toHaveBeenCalledWith("slack");
    renderer.unmount();
  });

  it("applies access presets, disables profile buttons while busy, and toggles technical controls", () => {
    const onApplyToolProfile = vi.fn(async () => undefined);
    const setShowTechnicalDetails = vi.fn();
    const renderer = create(
      <ToolAccessModesPanel
        currentToolProfile="guided"
        profileSwitchBusy={null}
        presets={[
          { id: "guided", label: "Guided", helper: "Ask before risky tools." },
          { id: "trusted", label: "Trusted", helper: "Allow known tools faster." },
        ]}
        showTechnicalDetails={false}
        setShowTechnicalDetails={setShowTechnicalDetails}
        uiMode="simple"
        onApplyToolProfile={onApplyToolProfile}
      />,
    );

    expect(button(renderer, "Guided").props.className).toContain("active");
    expect(textOf(renderer.toJSON())).toContain("Beginner mode is active.");

    act(() => {
      button(renderer, "Trusted").props.onClick();
      renderer.root.findByType("input").props.onChange({ target: { checked: true } });
    });

    expect(onApplyToolProfile).toHaveBeenCalledWith("trusted");
    expect(setShowTechnicalDetails).toHaveBeenCalledWith(true);
    renderer.unmount();

    const busyRenderer = create(
      <ToolAccessModesPanel
        currentToolProfile="guided"
        profileSwitchBusy="trusted"
        presets={[{ id: "trusted", label: "Trusted", helper: "Allow known tools faster." }]}
        showTechnicalDetails
        setShowTechnicalDetails={vi.fn()}
        uiMode="advanced"
        onApplyToolProfile={vi.fn()}
      />,
    );

    expect(button(busyRenderer, "Trusted").props.disabled).toBe(true);
    expect(textOf(busyRenderer.toJSON())).toContain("Applying");
    expect(textOf(busyRenderer.toJSON())).not.toContain("Beginner mode is active.");
    busyRenderer.unmount();
  });
});
