import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach } from "vitest";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { DraftLeaveDialog } from "../../library/DraftLeaveDialog";
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

const renderers: ReactTestRenderer[] = [];
beforeEach(() => __resetSessionDraftsForTests());
afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});
function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
function button(root: ReactTestInstance, label: string) {
  const found = root.findAllByType("button").find((node) => textOf(node).startsWith(label));
  if (!found) throw new Error("Missing button " + label);
  return found;
}
async function click(node: ReactTestInstance) {
  await act(async () => {
    await node.props.onClick();
  });
}
describe("NotificationRoutingPanel", () => {
  it("retains a destination draft across dismissal, refresh, and editor changes", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<NotificationRoutingPanel workspaceId="workspace-retention" channels={[]} />);
      renderers.push(renderer);
    });
    await click(button(renderer.root, "New destination"));
    await act(async () =>
      renderer.root.findAllByType("input")[0]!.props.onChange({ target: { value: "Retained destination" } }),
    );
    await click(button(renderer.root, "Back to list"));
    await act(async () => renderer.root.findByType(DraftLeaveDialog).props.onContinue());
    expect(textOf(button(renderer.root, "New destination"))).toContain("Unsaved");
    await click(button(renderer.root, "Refresh"));
    await click(button(renderer.root, "New rule"));
    expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("");
    await click(button(renderer.root, "Back to list"));
    await click(button(renderer.root, "New destination"));
    expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("Retained destination");
    await click(button(renderer.root, "Back to list"));
    await act(async () => renderer.root.findByType(DraftLeaveDialog).props.onDiscard());
    await click(button(renderer.root, "New destination"));
    expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("");
  });
  it("renders accessible target/rule forms and operator-owned destination guidance", () => {
    const markup = renderToStaticMarkup(<NotificationRoutingPanel workspaceId="workspace-1" channels={[]} />);
    expect(markup).toContain("Notification routing");
    expect(markup).toContain("models can reference rules, never raw endpoints or credentials");
    expect(markup).toContain('aria-labelledby="notification-target-heading"');
    expect(markup).toContain('aria-labelledby="notification-rule-heading"');
    expect(markup).toContain("New destination");
    expect(markup).not.toContain("Only when away");
    expect(markup).toContain("New rule");
  });
});
