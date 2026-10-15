// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { NativeMessageRenderer, isPlainMessage } from "./NativeMessageRenderer";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
it.each([
  "Hello, world.",
  "First paragraph.\n\nSecond paragraph.",
  "Unicode: café — 42 percent.",
  "Inline hyphen and (parentheses).",
  "One line\nA soft line break",
  "",
  "\n\nPlain answer.\n\n",
])("preserves the accepted plain message markup and copy shell: %s", (content) => {
  expect(isPlainMessage(content)).toBe(true);
  for (const role of ["user", "assistant"] as const) {
    expect(renderToStaticMarkup(<NativeMessageRenderer role={role} content={content} />)).toBe(
      renderToStaticMarkup(<AssistantMessageRenderer role={role} content={content} />),
    );
  }
});
it.each([
  "\0",
  "before\0after",
  "before\0",
  "**strong**",
  "[link](https://example.com)",
  "www.example.com",
  "name@example.com",
  "&amp;",
  "\\u0061",
  "    code",
  "text  \nnext",
  "1. item",
  "- item",
  "title\n===",
  "<script>ignored</script>",
])("delegates potentially formatted or normalized content to the existing owner: %s", (content) => {
  expect(isPlainMessage(content)).toBe(false);
});
it("resolves real rich formatting and retains safe-link and HTML normalization behavior", async () => {
  await act(async () => {
    root.render(
      <NativeMessageRenderer
        role="assistant"
        content={"**Answer** [bad](javascript:alert(1)) <script>hidden</script>"}
      />,
    );
    await vi.dynamicImportSettled();
  });
  expect(container.querySelector("strong")?.textContent).toBe("Answer");
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.textContent).not.toContain("hidden");
});
it("uses the existing incremental streaming owner even for plain streaming text", async () => {
  await act(async () => {
    root.render(<NativeMessageRenderer role="assistant" content="In progress" running streamTurnId="t1" />);
    await vi.dynamicImportSettled();
  });
  expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  expect(container.querySelector(".mc-assistant-streaming-cursor")).toBeTruthy();
  expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("still being written");
});
it("copies the original answer across a plain-to-rich transition without losing the mounted copy owner", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () => root.render(<NativeMessageRenderer role="assistant" content="Plain answer" />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith("Plain answer");
  await act(async () => {
    root.render(<NativeMessageRenderer role="assistant" content="**Plain answer**" />);
    await vi.dynamicImportSettled();
  });
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Response copied to clipboard");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(writeText).toHaveBeenLastCalledWith("**Plain answer**");
});
