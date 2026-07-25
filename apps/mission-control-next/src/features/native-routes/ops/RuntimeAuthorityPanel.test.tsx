import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAuthorityProjectionResponse } from "@goatcitadel/contracts";
import { RuntimeAuthorityPanel } from "./RuntimeAuthorityPanel";

const hookState = vi.hoisted(() => ({
  data: null as RuntimeAuthorityProjectionResponse | null,
  loading: false,
  error: null as string | null,
  reload: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useRuntimeAuthorityProjection", () => ({
  useRuntimeAuthorityProjection: () => hookState,
}));

afterEach(() => {
  hookState.data = null;
  hookState.loading = false;
  hookState.error = null;
  hookState.reload.mockReset();
});

describe("RuntimeAuthorityPanel", () => {
  it("renders explicit authority, freshness, owner, caveat, and accessible legend labels without raw ids", () => {
    hookState.data = projection();
    const markup = renderToStaticMarkup(
      <RuntimeAuthorityPanel workspaceId="workspace-a" theme="ops" navigate={vi.fn()} />,
    );

    expect(markup).toContain("Runtime authority map");
    expect(markup).toContain("Canonical record");
    expect(markup).toContain("Contradictory");
    expect(markup).toContain("DurableRunRepository");
    expect(markup).toContain("the repository wins");
    expect(markup).toContain('aria-label="Authority class legend"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain("Classification basis");
    expect(markup).not.toContain("opaque-worker-secret");
    expect(markup).not.toContain("run-sensitive-id");
  });

  it("maps typed canonical references to the existing run, approval, release, and reconciliation routes", () => {
    hookState.data = projection();
    const navigate = vi.fn();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<RuntimeAuthorityPanel workspaceId="workspace-a" theme="ops" navigate={navigate} />);
    });

    for (const [label, expected] of [
      [
        "Open run detail",
        { area: "ops", section: "sessions", view: "run-detail", runId: "run-sensitive-id", theme: "ops" },
      ],
      [
        "Open approval detail",
        { area: "ops", section: "approvals", approvalId: "approval-sensitive-id", theme: "ops" },
      ],
      ["Open release evidence", { area: "ops", section: "diagnostics", theme: "ops" }],
      ["Open reconciliation ledger", { area: "settings", section: "integrations", theme: "ops" }],
    ] as const) {
      const button = renderer!.root
        .findAllByType("button")
        .find((candidate) => flattenText(candidate.props.children) === label);
      expect(button, label).toBeDefined();
      act(() => button?.props.onClick());
      expect(navigate).toHaveBeenLastCalledWith(expected);
    }

    renderer!.unmount();
  });

  it("keeps the authority card grid responsive for narrow and mobile layouts", () => {
    const cssPath = fileURLToPath(new URL("./runtime-authority.css", import.meta.url));
    const css = fs.readFileSync(cssPath, "utf8");
    expect(css).toMatch(/@media \(max-width: 860px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*flex-direction: column/);
    expect(css).toMatch(/overflow-wrap: anywhere/);
  });

  it("uses canonical shell tokens for readable authority cards in both themes", () => {
    const cssPath = fileURLToPath(new URL("./runtime-authority.css", import.meta.url));
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toMatch(
      /\.mc-next-runtime-authority-item\s*{[^}]*color: var\(--foreground\);[^}]*background: color-mix\(in oklab, var\(--mc-surface-2\) 92%, transparent\);/s,
    );
    expect(css).toMatch(/\.mc-next-runtime-authority-item h3\s*{[^}]*color: var\(--foreground\);/s);
    expect(css).toMatch(/\.mc-next-runtime-authority-state\s*{[^}]*color: var\(--foreground\);/s);
    expect(css).toMatch(/\.mc-next-runtime-authority-meta dd\s*{[^}]*color: var\(--foreground\);/s);
    expect(css).not.toMatch(
      /var\(--mc-(?:panel|foreground|muted-foreground|accent|border|success|warning|danger|muted)(?:,|\))/,
    );
  });
});

function projection(): RuntimeAuthorityProjectionResponse {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-13T20:00:00.000Z",
    workspaceId: "workspace-a",
    items: [
      {
        id: "run-card",
        domain: "runs",
        label: "Chat turn run",
        authorityClass: "canonical_record",
        owner: "DurableRunRepository",
        source: "durable_runs",
        observedAt: "2026-07-13T19:59:00.000Z",
        freshness: "current",
        posture: "ok",
        state: "Terminal outcome: completed.",
        basis: "The durable row owns terminal outcome.",
        caveat: "A retained signal cannot overwrite it.",
        scope: { kind: "workspace", workspaceId: "workspace-a" },
        canonicalRef: { kind: "durable_run", label: "Open run detail", runId: "run-sensitive-id" },
      },
      {
        id: "retained-card",
        domain: "runs",
        label: "Retained run signal",
        authorityClass: "retained_signal",
        owner: "RealtimeEventRepository",
        source: "retained operator stream",
        observedAt: "2026-07-13T19:58:00.000Z",
        freshness: "contradictory",
        posture: "critical",
        state: "Retained signal: durable run failed.",
        basis: "The event is retained for awareness.",
        caveat: "The retained signal conflicts; the repository wins.",
        scope: { kind: "workspace", workspaceId: "workspace-a" },
      },
      {
        id: "approval-card",
        domain: "approvals",
        label: "Tool approval",
        authorityClass: "canonical_record",
        owner: "ApprovalRepository + ApprovalEffectRepository",
        source: "approval rows",
        freshness: "current",
        posture: "attention",
        state: "Decision approved; effect settlement is pending.",
        basis: "Decision and effects have separate canonical rows.",
        scope: { kind: "workspace", workspaceId: "workspace-a" },
        canonicalRef: {
          kind: "approval",
          label: "Open approval detail",
          approvalId: "approval-sensitive-id",
        },
      },
      {
        id: "release-card",
        domain: "backups",
        label: "Release evidence certificate",
        authorityClass: "canonical_record",
        owner: "ReviewReadinessService",
        source: "release certificate",
        freshness: "current",
        posture: "ok",
        state: "Release evidence verifies.",
        basis: "The bound certificate is durable evidence.",
        scope: { kind: "citadel" },
        canonicalRef: { kind: "release_evidence", label: "Open release evidence" },
      },
      {
        id: "reconciliation-card",
        domain: "reconciliation",
        label: "External side effect reconciliation",
        authorityClass: "canonical_record",
        owner: "ExternalSideEffectRunRepository",
        source: "side-effect ledger",
        freshness: "current",
        posture: "critical",
        state: "Manual reconciliation is required.",
        basis: "Unknown provider outcome is durable.",
        scope: { kind: "workspace", workspaceId: "workspace-a" },
        canonicalRef: { kind: "external_side_effects", label: "Open reconciliation ledger" },
      },
    ],
  };
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("");
  return "";
}
