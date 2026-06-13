// @vitest-environment happy-dom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { NativePageFrame } from "./NativeRoutePageLayout";

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
});
