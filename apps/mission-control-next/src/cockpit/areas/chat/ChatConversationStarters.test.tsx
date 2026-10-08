// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatConversationStarters } from "./ChatConversationStarters";
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});
function mount(overrides = {}) {
  container = document.createElement("div");
  document.body.append(container);
  const textarea = document.createElement("textarea");
  textarea.id = "cockpit-chat-draft";
  container.append(textarea);
  const host = document.createElement("div");
  container.append(host);
  root = createRoot(host);
  const props = { draft: "", historicalReadOnly: false, sending: false, onDraftChange: vi.fn(), ...overrides };
  act(() => root.render(<ChatConversationStarters props={props} />));
  return props;
}
describe("conversation starters", () => {
  it("fills a draft and focuses its composer without sending", () => {
    const props = mount();
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Plan a change"))!;
    act(() => button.click());
    expect(props.onDraftChange).toHaveBeenCalledWith(
      "Help me plan a change. Ask what I want to achieve and what context I can share.",
    );
    expect(document.activeElement?.id).toBe("cockpit-chat-draft");
    expect(container.querySelector('a[href="/library/knowledge?shell=cockpit"]')).not.toBeNull();
  });
  it.each([{ draft: "keep this" }, { historicalReadOnly: true }, { sending: true }])(
    "never overwrites or starts work in a restricted state %o",
    (overrides) => {
      const props = mount(overrides);
      expect(container.querySelector("button")).toBeNull();
      expect(props.onDraftChange).not.toHaveBeenCalled();
    },
  );
});
