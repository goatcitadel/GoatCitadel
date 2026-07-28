import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NotificationRoutingPanel } from "./NotificationRoutingPanel";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  createNotificationRule: vi.fn(),
  createNotificationTarget: vi.fn(),
  fetchIntegrationConnections: vi.fn(async () => ({ items: [] })),
  fetchNotificationDeliveries: vi.fn(async () => ({ items: [] })),
  fetchNotificationRules: vi.fn(async () => ({ items: [] })),
  fetchNotificationTargets: vi.fn(async () => ({ items: [] })),
  sendTestNotification: vi.fn(),
  updateNotificationRule: vi.fn(),
  updateNotificationTarget: vi.fn(),
}));

describe("NotificationRoutingPanel", () => {
  it("renders accessible target/rule forms and operator-owned destination guidance", () => {
    const markup = renderToStaticMarkup(<NotificationRoutingPanel workspaceId="workspace-1" channels={[]} />);
    expect(markup).toContain("Notification routing");
    expect(markup).toContain("models can reference rules, never raw endpoints or credentials");
    expect(markup).toContain('aria-labelledby="notification-target-heading"');
    expect(markup).toContain('aria-labelledby="notification-rule-heading"');
    expect(markup).toContain("Only when away");
    expect(markup).toContain("turn.failed");
  });
});
