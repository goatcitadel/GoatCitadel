// @vitest-environment happy-dom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { NativeDisclosureCard, NativePageFrame, NativeSectionIndex } from "./NativeRoutePageLayout";

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: vi.fn(),
}));

describe("NativePageFrame error state (STATE-01)", () => {
  it("renders an ErrorState carrying the message, with a working retry", () => {
    const onRetry = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <NativePageFrame
          kicker="Ops"
          title="Activity"
          description="Operational activity"
          loading={false}
          error="Gateway offline"
          onRetry={onRetry}
        >
          <div />
        </NativePageFrame>,
      );
    });
    expect(renderer.root.findByProps({ className: "mc-next-error-state" })).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain("Gateway offline");
    act(() => renderer.root.findByProps({ className: "gc-button" }).props.onClick());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry control when no onRetry handler is supplied", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <NativePageFrame kicker="Ops" title="Activity" description="Operational activity" loading={false} error="Boom">
          <div />
        </NativePageFrame>,
      );
    });
    expect(renderer.root.findByProps({ className: "mc-next-error-state" })).toBeTruthy();
    expect(renderer.root.findAllByProps({ className: "gc-button" })).toHaveLength(0);
  });

  it("does NOT render children while an error is shown (Finding 10)", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <NativePageFrame kicker="Library" title="Citadel" description="Overview" loading={false} error="Fetch failed">
          <div data-testid="stale-children">No Charter found.</div>
        </NativePageFrame>,
      );
    });
    expect(renderer.root.findByProps({ className: "mc-next-error-state" })).toBeTruthy();
    // The (null/stale-data) children must NOT render underneath the error banner, or an
    // operator can't tell a real fetch failure from genuinely-empty data.
    expect(renderer.root.findAllByProps({ "data-testid": "stale-children" })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("No Charter found.");
  });

  it("keeps machine errors in technical details and renders a secondary access action", () => {
    const onConfigure = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <NativePageFrame
          kicker="Ops"
          title="Saved Boards"
          description="Operator boards"
          loading={false}
          error="API error 403: authenticated operator required"
          errorSecondaryAction={
            <button type="button" onClick={onConfigure}>
              Configure access
            </button>
          }
        >
          <div />
        </NativePageFrame>,
      );
    });

    const primaryCopy = renderer.root.findByProps({ className: "mc-next-error-state-copy" });
    expect(primaryCopy.findByProps({ className: "mc-next-error-state-title" }).children.join("")).toContain(
      "Operator authentication required",
    );
    expect(primaryCopy.findByProps({ className: "mc-next-error-state-description" }).children.join("")).not.toContain(
      "API error 403",
    );
    expect(renderer.root.findByType("details").props.children).toBeTruthy();
    const configureButton = renderer.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Configure access");
    act(() => configureButton?.props.onClick());
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });
});

describe("Native long-page navigation", () => {
  it("keeps section links and disclosure summaries in the keyboard tab order", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <>
          <NativeSectionIndex
            items={[
              { id: "runtime-posture", label: "Runtime posture" },
              { id: "diagnostics", label: "Diagnostics" },
            ]}
          />
          <NativeDisclosureCard
            id="diagnostics"
            title="Diagnostics"
            subtitle="Technical evidence and recovery detail."
            defaultOpen={false}
          >
            <p>Technical evidence</p>
          </NativeDisclosureCard>
        </>,
      );
    });

    const links = renderer.root.findAllByType("a");
    expect(links.map((link) => link.props.href)).toEqual(["#runtime-posture", "#diagnostics"]);
    expect(links.every((link) => link.props.tabIndex !== -1)).toBe(true);
    const summary = renderer.root.findByType("summary");
    expect(summary.props.id).toBe("diagnostics");
    expect(summary.props.tabIndex).not.toBe(-1);
  });
});
