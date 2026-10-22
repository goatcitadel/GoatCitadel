import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { ToolGrantDetails } from "./ToolGrantDetails";

const preferences = vi.hoisted(() => ({
  showTechnicalDetails: false,
  activeCitadelId: "citadel-1",
  activeWorkspaceId: "workspace-active" as string | undefined,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => preferences,
}));
const workspaceNames = vi.hoisted((): Record<string, string> => ({ "workspace-a": "Research" }));
vi.mock("../../data/use-workspace-name", () => ({
  useWorkspaceNameLookup: () => (workspaceId?: string) => (workspaceId ? workspaceNames[workspaceId] : undefined),
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

const grant: ToolGrantRecord = {
  grantId: "grant-secret-id",
  toolPattern: "fs.write",
  decision: "allow",
  scope: "workspace",
  scopeRef: "workspace-a",
  grantType: "ttl",
  createdBy: "operator",
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-02T00:00:00.000Z",
  constraints: { writeRoots: ["D:\\notes"], writeRootsApprovalId: "approval-secret-id" },
};

let view: ReactTestRenderer | undefined;
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");

async function render(record: ToolGrantRecord = grant) {
  await act(async () => {
    view = create(<ToolGrantDetails grant={record} onClose={() => undefined} />);
  });
  return text(view!.root);
}

beforeEach(() => {
  preferences.showTechnicalDetails = false;
  preferences.activeWorkspaceId = "workspace-active";
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
});

describe("ToolGrantDetails", () => {
  it("reads in operator words and keeps IDs and raw times out of the visible grant", async () => {
    const shown = await render();
    expect(shown).toContain("Allow");
    // ST-14: the scope names which workspace by its name; the raw workspace ID stays hidden.
    expect(shown).toContain("Workspace: Research");
    expect(shown).toContain("Expires at a time");
    expect(shown).toContain("D:\\notes");
    for (const raw of ["grant-secret-id", "workspace-a", "approval-secret-id", grant.createdAt, grant.expiresAt!])
      expect(shown).not.toContain(raw);
    expect(view!.root.findAllByType("time").map((node) => node.props.dateTime)).toEqual([
      grant.createdAt,
      grant.expiresAt,
    ]);
    // An expiry reads as a full date and time, so it never goes stale as "Expires 2 hours ago".
    const expiry = view!.root.findAllByType("time")[1]!;
    expect(text(expiry)).not.toMatch(/\bago\b|^in\b/u);
  });

  it("names the active workspace and an unnamed workspace without their IDs", async () => {
    expect(await render({ ...grant, scopeRef: "workspace-active" })).toContain("Workspace: This workspace");
    await act(async () => view?.unmount());
    const unnamed = await render({ ...grant, scopeRef: "workspace-gone" });
    expect(unnamed).toContain("Workspace: Another workspace");
    expect(unnamed).not.toContain("workspace-gone");
  });

  it("puts the grant, scope and approval IDs in technical details", async () => {
    preferences.showTechnicalDetails = true;
    await render();
    const shown = text(view!.root.findByType("details"));
    expect(shown).toContain("grant-secret-id");
    expect(shown).toContain("workspace-a");
    expect(shown).toContain("approval-secret-id");
  });
});
