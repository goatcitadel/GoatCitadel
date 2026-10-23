// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAuthorityItem } from "@goatcitadel/contracts";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { RuntimeAuthorityMap } from "./RuntimeAuthorityMap";

const projection = vi.hoisted(() => ({
  value: { data: null as unknown, loading: false, error: null as string | null, reload: vi.fn(async () => undefined) },
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useRuntimeAuthorityProjection", () => ({
  useRuntimeAuthorityProjection: vi.fn(() => projection.value),
}));
const preferences = vi.hoisted(() => ({ showTechnicalDetails: true }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));

const item = (overrides: Partial<RuntimeAuthorityItem> = {}): RuntimeAuthorityItem =>
  ({
    id: "run-ledger",
    domain: "runs",
    label: "Durable run ledger",
    authorityClass: "canonical_record",
    owner: "Gateway durable runs",
    source: "durable_runs table",
    observedAt: "2026-10-08T10:00:00.000Z",
    freshness: "current",
    posture: "ok",
    state: "3 active runs",
    basis: "Read from the canonical run store.",
    scope: { kind: "workspace", workspaceId: "default" },
    canonicalRef: { kind: "durable_run", runId: "run-7", label: "Open run detail" },
    ...overrides,
  }) as RuntimeAuthorityItem;

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <CockpitNavigationProvider>
        <RuntimeAuthorityMap workspaceId="default" />
      </CockpitNavigationProvider>,
    ),
  );

beforeEach(() => {
  preferences.showTechnicalDetails = true;
  projection.value = { data: null, loading: false, error: null, reload: vi.fn(async () => undefined) };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit runtime authority map", () => {
  it("shows each record's class, freshness, posture, owner, source, scope and basis", async () => {
    projection.value.data = {
      items: [
        item(),
        item({
          id: "signals",
          label: "Realtime signals",
          authorityClass: "retained_signal",
          freshness: "stale",
          posture: "attention",
          scope: { kind: "citadel" } as RuntimeAuthorityItem["scope"],
          observedAt: undefined,
          canonicalRef: undefined,
          caveat: "Signals are not the complete history.",
        }),
      ],
    };
    await render();
    const list = container.querySelector('[aria-label="Runtime authority records"]')!;
    const records = list.querySelectorAll(":scope > li");
    expect(records).toHaveLength(2);
    expect(records[0]!.textContent).toContain("Durable run ledger");
    expect(records[0]!.textContent).toContain("Runs · Saved record");
    // Classification is neutral text; only freshness and posture read as status.
    expect([...records[0]!.querySelectorAll("[data-tone]")].map((badge) => badge.textContent)).toEqual([
      "Current",
      "OK",
    ]);
    expect(records[0]!.textContent).toContain("Current");
    expect(records[0]!.textContent).toContain("OK");
    expect(records[0]!.textContent).toContain("Managed by: Gateway durable runs");
    expect(records[0]!.textContent).toContain("Source: durable_runs table");
    expect(records[0]!.textContent).toContain("Scope: Current workspace");
    expect(records[1]!.textContent).toContain("Recorded signal");
    expect(records[1]!.textContent).toContain("Stale");
    expect(records[1]!.textContent).toContain("Needs attention");
    expect(records[1]!.textContent).toContain("Scope: Citadel runtime");
    expect(records[1]!.textContent).toContain("Observed: Not available");
    expect(records[1]!.textContent).toContain("Signals are not the complete history.");
    expect(container.textContent).toContain("2 records · 1 needs attention");
  });

  it("links canonical records to their native owners", async () => {
    projection.value.data = {
      items: [
        item(),
        item({
          id: "a",
          label: "Approvals",
          canonicalRef: { kind: "approval", approvalId: "ap 1", label: "Open approval detail" },
        }),
        item({ id: "r", label: "Release", canonicalRef: { kind: "release_evidence", label: "Open release evidence" } }),
      ] as RuntimeAuthorityItem[],
    };
    await render();
    const href = (label: string) =>
      [...container.querySelectorAll("a")].find((link) => link.textContent === label)?.getAttribute("href");
    // Link text is the cockpit's own, by reference kind; the server's label is not shown.
    expect(href("Open run")).toContain("/work/runs/run-7");
    expect(href("Open approval")).toMatch(/\/inbox\?approvalId=ap(\+|%20)1/);
    expect(href("Open release details")).toContain("/system/diagnostics");
    expect(container.textContent).not.toContain("Open release evidence");
  });

  it("states an empty projection without inventing records", async () => {
    projection.value.data = { items: [] };
    await render();
    expect(container.textContent).toContain("No authority records came back. Nothing is shown in their place.");
  });

  it("words a coded state and keeps the server prose in technical details (SY-N06)", async () => {
    projection.value.data = {
      items: [
        item({
          owner: "Approvals",
          state: "3 canonical approval record(s) are available for client materialization.",
          stateMessage: { code: "approval_records_available", count: 3 },
          caveat: "Client caches remain non-canonical.",
        }),
      ],
    };
    await render();
    const record = container.querySelector('[aria-label="Runtime authority records"] > li')!;
    expect(record.textContent).toContain("3 approval records are in this workspace's recent window.");
    preferences.showTechnicalDetails = false;
    await render();
    expect(container.textContent).toContain("3 approval records are in this workspace's recent window.");
    expect(container.textContent).not.toContain("record(s)");
    expect(container.textContent).not.toContain("non-canonical");
    expect(container.textContent).not.toContain("Classification basis");
    expect(container.textContent).not.toContain("Gateway");
  });

  it("heads and words every coded record, with owner, source and the server label in technical details", async () => {
    projection.value.data = {
      items: [
        item({
          id: "runs-empty",
          label: "No canonical run record",
          owner: "DurableRunRepository",
          source: "durable run rows",
          state: "No valid durable run record is available in this workspace window.",
          stateMessage: { code: "runs_empty" },
          canonicalRef: undefined,
        }),
        item({
          id: "config-generation",
          domain: "reconciliation",
          label: "Canonical config generation",
          authorityClass: "derived_projection",
          state: "Revision 8 is the active canonical generation.",
          stateMessage: { code: "config_generation", counts: { revision: 8 } },
          canonicalRef: undefined,
        }),
      ] as RuntimeAuthorityItem[],
    };
    preferences.showTechnicalDetails = false;
    await render();
    const text = container.textContent ?? "";
    expect([...container.querySelectorAll("li h3")].map((h) => h.textContent)).toEqual([
      "Runs",
      "Configuration version",
    ]);
    expect(text).toContain("No runs are recorded in this workspace's recent window.");
    expect(text).toContain("Version 8 of the configuration is active.");
    expect(text).toContain("Reconciliation · Computed");
    for (const word of [
      "canonical",
      "durable",
      "Revision",
      "DurableRunRepository",
      "Managed by",
      "Source:",
      "Snapshot",
    ])
      expect(text).not.toContain(word);
    preferences.showTechnicalDetails = true;
    await render();
    expect(container.textContent).toContain("No canonical run record");
    expect(container.textContent).toContain("Managed by: DurableRunRepository");
    expect(container.textContent).toContain("Source: durable run rows");
  });

  it("shows an unavailable projection and reloads on request", async () => {
    projection.value.error = "The scoped runtime authority envelope is unavailable.";
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Runtime authority unavailable: The scoped runtime authority envelope is unavailable.",
    );
    const reload = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload authority",
    )!;
    await act(async () => reload.click());
    expect(projection.value.reload).toHaveBeenCalledOnce();
  });

  it("shows a manual reload in progress until it settles", async () => {
    projection.value.error = "The scoped runtime authority envelope is unavailable.";
    let settle!: () => void;
    projection.value.reload = vi.fn(() => new Promise<undefined>((resolve) => (settle = () => resolve(undefined))));
    await render();
    const button = () =>
      [...container.querySelectorAll("button")].find((item) => /authority$/.test(item.textContent ?? ""))!;
    await act(async () => button().click());
    expect(button().textContent).toBe("Reloading authority");
    expect(button().disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Reloading runtime authority");
    await act(async () => settle());
    expect(button().textContent).toBe("Reload authority");
    expect(button().disabled).toBe(false);
  });

  it("uses section headings below the page title", async () => {
    projection.value.data = { items: [item()] };
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("Runtime authority map");
    expect(container.querySelector("li h3")?.textContent).toBe("Durable run ledger");
  });

  it("leads each record with its heading and keeps domain and class as trailing metadata (SY-N05)", async () => {
    projection.value.data = { items: [item()] };
    await render();
    const record = container.querySelector('[aria-label="Runtime authority records"] > li')!;
    const heading = record.querySelector("h3")!;
    const meta = [...record.querySelectorAll("li")].find((entry) => entry.textContent === "Runs · Saved record");
    expect(meta).toBeDefined();
    expect(heading.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing above the heading: it is the record's first text.
    expect(record.textContent?.startsWith("Durable run ledger")).toBe(true);
  });

  it("renders rows as hairline-separated items, not bordered cards", async () => {
    projection.value.data = { items: [item(), item({ id: "signals", label: "Realtime signals" })] };
    await render();
    const list = container.querySelector('[aria-label="Runtime authority records"]')!;
    expect(list.className).toContain("divide-y divide-line-subtle");
    expect(list.className).not.toContain("grid-cols-2");
    for (const row of list.querySelectorAll(":scope > li")) {
      expect(row.className).not.toMatch(/\brounded-(?:md|lg|xl)\b/);
      expect(row.className.split(/\s+/)).not.toContain("border");
    }
  });

  it("announces loading before the first projection arrives", async () => {
    projection.value.loading = true;
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading runtime authority");
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Reloading authority")!
        .disabled,
    ).toBe(true);
  });
});
