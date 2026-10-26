// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAMP_USER_MESSAGE_CHARS, ChatClampedUserMessage } from "./ChatClampedUserMessage";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Clamped user message", () => {
  it("leaves a short message alone", () => {
    act(() =>
      root.render(
        <ChatClampedUserMessage text="hello">
          <p>hello</p>
        </ChatClampedUserMessage>,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("hello");
  });

  it("clips a very long message, keeps its text in the page, and toggles", () => {
    const text = "x".repeat(CLAMP_USER_MESSAGE_CHARS + 1);
    act(() =>
      root.render(
        <ChatClampedUserMessage text={text}>
          <p>{text}</p>
        </ChatClampedUserMessage>,
      ),
    );
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Show full message");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".max-h-64")).not.toBeNull();
    expect(container.textContent).toContain(text);
    act(() => button.click());
    expect(button.textContent).toBe("Show less");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".max-h-64")).toBeNull();
  });
});
