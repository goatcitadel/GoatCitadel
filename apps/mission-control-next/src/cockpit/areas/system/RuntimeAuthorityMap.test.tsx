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

const item = (overrides: Partial<RuntimeAuthorityItem> = {}): RuntimeAuthorityItem =>
  ({
    id: "run-ledger",
    domain: "durable_execution",
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
    expect(records[0]!.textContent).toContain("Canonical record");
    expect(records[0]!.textContent).toContain("Current");
    expect(records[0]!.textContent).toContain("OK");
    expect(records[0]!.textContent).toContain("Owner: Gateway durable runs");
    expect(records[0]!.textContent).toContain("Source: durable_runs table");
    expect(records[0]!.textContent).toContain("Scope: Current workspace");
    expect(records[1]!.textContent).toContain("Retained signal");
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
    expect(href("Open run detail")).toContain("/work/runs/run-7");
    expect(href("Open approval detail")).toMatch(/\/inbox\?approvalId=ap(\+|%20)1/);
    expect(href("Open release evidence")).toContain("/system/diagnostics");
  });

  it("states an empty projection without inventing records", async () => {
    projection.value.data = { items: [] };
    await render();
    expect(container.textContent).toContain(
      "The Gateway returned no authority records. Nothing is inferred in their place.",
    );
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
