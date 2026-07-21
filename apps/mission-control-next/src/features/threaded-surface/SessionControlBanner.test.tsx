import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { SessionControlBannerViewModel } from "@goatcitadel/threaded-surface-core";
import { SessionControlBanner } from "./SessionControlBanner";

function externalModel(overrides: Partial<SessionControlBannerViewModel> = {}): SessionControlBannerViewModel {
  return {
    externalControlActive: true,
    sendLocked: true,
    tone: "external-live",
    ownerLabel: "External controller",
    generation: 4,
    generationLabel: "Generation 4",
    leaseStateLabel: "Live lease",
    capabilitiesLabel: "Send + Read",
    clientInstanceId: "cli-instance-01",
    companionSessionId: "companion-77",
    tokenFingerprint: "0a1b2c3d",
    lastHeartbeatAt: "2026-07-14T12:00:00.000Z",
    leaseExpiresAt: "2026-07-14T12:01:00.000Z",
    reconnectExpiresAt: "2026-07-14T12:05:00.000Z",
    sendLockReason:
      "An external controller (generation 4) owns this session. Operator send is disabled until you revoke or take over.",
    pendingRequestCount: 0,
    ...overrides,
  };
}

function findButton(renderer: ReactTestRenderer, ariaLabel: string) {
  return renderer.root.find((node) => node.type === "button" && node.props["aria-label"] === ariaLabel);
}

describe("SessionControlBanner", () => {
  it("renders truthful, content-free controller state and keeps operator actions visible", () => {
    const markup = renderToStaticMarkup(
      <SessionControlBanner
        model={externalModel()}
        onRevoke={vi.fn()}
        onEmergencyTakeover={vi.fn()}
        actionPending={null}
        actionError={null}
        statusError={null}
      />,
    );
    expect(markup).toContain("External controller");
    expect(markup).toContain("Generation 4");
    expect(markup).toContain("Live lease");
    expect(markup).toContain("Send + Read");
    expect(markup).toContain("cli-instance-01");
    expect(markup).toContain("companion-77");
    expect(markup).toContain("0a1b2c3d");
    expect(markup).toContain("Operator send is disabled");
    expect(markup).toContain("Reads and approvals stay available");
    expect(markup).toContain("Revoke");
    expect(markup).toContain("Emergency takeover");
  });

  it("never renders the control secret or a full token hash", () => {
    const markup = renderToStaticMarkup(
      <SessionControlBanner
        model={externalModel()}
        onRevoke={vi.fn()}
        onEmergencyTakeover={vi.fn()}
        actionPending={null}
        actionError={null}
        statusError={null}
      />,
    );
    expect(markup.toLowerCase()).not.toContain("secret");
    expect(markup).not.toMatch(/[0-9a-f]{64}/u);
  });

  it("invokes the operator-auth actions on click", () => {
    const onRevoke = vi.fn();
    const onEmergencyTakeover = vi.fn();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <SessionControlBanner
          model={externalModel()}
          onRevoke={onRevoke}
          onEmergencyTakeover={onEmergencyTakeover}
          actionPending={null}
          actionError={null}
          statusError={null}
        />,
      );
    });
    act(() => {
      findButton(renderer!, "Revoke external session control").props.onClick();
    });
    act(() => {
      findButton(renderer!, "Emergency takeover of this session").props.onClick();
    });
    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(onEmergencyTakeover).toHaveBeenCalledTimes(1);
    renderer!.unmount();
  });

  it("disables both actions while an action is pending", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <SessionControlBanner
          model={externalModel({ tone: "external-stale", leaseStateLabel: "Stale — reconnect window open" })}
          onRevoke={vi.fn()}
          onEmergencyTakeover={vi.fn()}
          actionPending="emergency_takeover"
          actionError={null}
          statusError={null}
        />,
      );
    });
    expect(findButton(renderer!, "Revoke external session control").props.disabled).toBe(true);
    expect(findButton(renderer!, "Emergency takeover of this session").props.disabled).toBe(true);
    renderer!.unmount();
  });

  it("renders nothing when no external controller owns the session", () => {
    const markup = renderToStaticMarkup(
      <SessionControlBanner
        model={externalModel({ externalControlActive: false })}
        onRevoke={vi.fn()}
        onEmergencyTakeover={vi.fn()}
        actionPending={null}
        actionError={null}
        statusError={null}
      />,
    );
    expect(markup).toBe("");
  });
});
