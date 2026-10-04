// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AreaErrorBoundary } from "./AreaErrorBoundary";

let root: Root;
let container: HTMLDivElement;
const failure = { error: null as Error | null };

function Fragile() {
  if (failure.error) throw failure.error;
  return <p>Area content</p>;
}

beforeEach(() => {
  failure.error = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);

async function render(resetKey = "inbox", onGoToChat?: () => void) {
  await act(async () =>
    root.render(
      <AreaErrorBoundary label="Inbox" resetKey={resetKey} onGoToChat={onGoToChat}>
        <Fragile />
      </AreaErrorBoundary>,
    ),
  );
}

describe("AreaErrorBoundary", () => {
  it("contains a render failure, offers Chat, and recovers on Try again", async () => {
    failure.error = new Error("synthetic render failure");
    const onGoToChat = vi.fn();
    await render("inbox", onGoToChat);
    const alert = container.querySelector('[role="alert"]')?.textContent;
    expect(alert).toContain("Inbox couldn't be shown");
    // A view can fail right after a send or an approval went through, so the fallback must not deny it.
    expect(alert).toContain("check whether it went through before trying again");
    expect(alert).not.toContain("didn't send or change anything");
    await act(async () => button("Go to Chat")?.click());
    expect(onGoToChat).toHaveBeenCalledOnce();
    failure.error = null;
    await act(async () => button("Try again")?.click());
    expect(container.textContent).toContain("Area content");
  });

  it("offers only a reload after a chunk fails to download", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    failure.error = new TypeError("Failed to fetch dynamically imported module: /assets/InboxArea.js");
    await render();
    expect(button("Try again")).toBeUndefined();
    await act(async () => button("Reload app")?.click());
    expect(reload).toHaveBeenCalledOnce();
  });

  it("clears the error when its reset key changes", async () => {
    failure.error = new Error("synthetic render failure");
    await render("inbox");
    failure.error = null;
    await render("work");
    expect(container.textContent).toContain("Area content");
  });

  it.each([null, undefined])("contains a thrown %s and recovers on Try again or a new reset key", async (thrown) => {
    const failing = { active: true };
    function ThrowsFalsy() {
      // Anything can be thrown; a falsy value must still count as a failure.
      if (failing.active) throw thrown;
      return <p>Area content</p>;
    }
    const renderAt = (resetKey: string) =>
      act(async () =>
        root.render(
          <AreaErrorBoundary label="Inbox" resetKey={resetKey}>
            <ThrowsFalsy />
          </AreaErrorBoundary>,
        ),
      );
    await renderAt("inbox");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Inbox couldn't be shown");
    failing.active = false;
    await act(async () => button("Try again")?.click());
    expect(container.textContent).toContain("Area content");
    failing.active = true;
    await renderAt("inbox");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    failing.active = false;
    await renderAt("work");
    expect(container.textContent).toContain("Area content");
  });
});
