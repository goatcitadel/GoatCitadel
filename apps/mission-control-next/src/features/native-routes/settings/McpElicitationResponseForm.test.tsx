// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { McpElicitationResponseForm } from "./McpElicitationResponseForm";
import { elicitationFixture, respondedFixture } from "./mcp-elicitation.test-support";
import { __resetMcpResponsesForTests } from "./mcp-elicitation-response";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
const api = vi.hoisted(() => ({ fetchMcpElicitations: vi.fn(), respondMcpElicitation: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let request = elicitationFixture(),
  current = elicitationFixture(),
  container: HTMLDivElement,
  root: Root;
const settled = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpResponsesForTests();
  __resetSessionDraftsForTests();
  request = elicitationFixture();
  current = structuredClone(request);
  api.fetchMcpElicitations.mockImplementation(async () => ({ items: [structuredClone(current)] }));
  api.respondMcpElicitation.mockImplementation(async (_id, input) => {
    current = respondedFixture(current, input.action, input.content);
    return structuredClone(current);
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <McpElicitationResponseForm
          request={request}
          workspaceId="workspace"
          onRecorded={settled}
          fieldClass=""
          button={(label, click, disabled) => (
            <button type="button" onClick={click} disabled={disabled}>
              {label}
            </button>
          )}
        />
      </StrictMode>,
    ),
  );
}
const button = (name: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === name)!;
async function click(name: string) {
  await act(async () => button(name).click());
}
async function value(name: string, text: string) {
  const label = [...container.querySelectorAll("label")].find((item) => item.textContent === name)!;
  const node = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[id="${label.htmlFor}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, text);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
it("renders typed fields, review/cancel performs no write, and confirmed acceptance uses the original owner", async () => {
  await render();
  expect(api.fetchMcpElicitations).not.toHaveBeenCalled();
  await value("Display name (required)", "Visible");
  await value("count", "2");
  await value("enabled", "false");
  await click("Review accept response");
  expect(container.querySelector('[aria-label="Review MCP response"]')?.textContent).toContain("Visible");
  await click("Cancel response review");
  expect(api.respondMcpElicitation).not.toHaveBeenCalled();
  await click("Review accept response");
  await click("Confirm response");
  expect(api.respondMcpElicitation).toHaveBeenCalledExactlyOnceWith(request.elicitationId, {
    action: "accept",
    content: { name: "Visible", count: 2, enabled: false },
    owner: request.owner,
  });
  expect(settled).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("does not confirm remote delivery or durable execution");
  expect(button("Review accept response").disabled).toBe(true);
});
it.each(["decline", "cancel"] as const)(
  "withholds unsupported acceptance but permits reviewed %s without content",
  async (action) => {
    request.requestedSchema.value = { type: "object", properties: { nested: { type: "object" } } };
    request.protocol.requestedSchema = request.requestedSchema.value;
    current = structuredClone(request);
    await render();
    expect(button("Review accept response").disabled).toBe(true);
    expect(container.textContent).toContain("schema is unsupported");
    await click(`Review ${action} response`);
    expect(container.textContent).toContain("No response content will be sent.");
    await click("Confirm response");
    expect(api.respondMcpElicitation).toHaveBeenCalledExactlyOnceWith(request.elicitationId, {
      action,
      content: undefined,
      owner: request.owner,
    });
  },
);
it("invalidates an open review when the actual request changes and does not submit", async () => {
  await render();
  await click("Review decline response");
  request = { ...request, prompt: { ...request.prompt, text: "Changed prompt" } };
  await render();
  expect(button("Confirm response").disabled).toBe(true);
  await click("Confirm response");
  expect(api.respondMcpElicitation).not.toHaveBeenCalled();
});
