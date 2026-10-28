// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageBody } from "./AssistantMessageRenderer";
import { STREAMING_WORD_CLASS } from "./rehype-fade-new-words";
import { STEADY_STREAM_TICK_MS, useSteadyStreamText } from "./use-steady-stream-text";

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
  vi.useRealTimers();
});

function Probe({ target, paced }: { target: string; paced: boolean }) {
  return <p>{useSteadyStreamText(target, paced)}</p>;
}

describe("useSteadyStreamText", () => {
  it("reveals a burst over a few ticks instead of all at once", () => {
    vi.useFakeTimers();
    act(() => root.render(<Probe target="Hi" paced />));
    expect(container.textContent).toBe("Hi");
    const burst = `Hi${" there".repeat(20)}`;
    act(() => root.render(<Probe target={burst} paced />));
    act(() => vi.advanceTimersByTime(0));
    const early = container.textContent ?? "";
    expect(early.length).toBeGreaterThan(2);
    expect(early.length).toBeLessThan(burst.length);
    expect(burst.startsWith(early)).toBe(true);
    act(() => vi.advanceTimersByTime(STEADY_STREAM_TICK_MS * 40));
    expect(container.textContent).toBe(burst);
  });

  it("shows text in full at once when it is not paced", () => {
    act(() => root.render(<Probe target="Hi" paced={false} />));
    act(() => root.render(<Probe target="Hi there, all of it" paced={false} />));
    expect(container.textContent).toBe("Hi there, all of it");
  });
});

describe("reduced motion", () => {
  it("shows streamed text as it arrives instead of pacing it", () => {
    vi.useFakeTimers();
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    try {
      const render = (content: string) =>
        act(() => root.render(<AssistantMessageBody role="assistant" content={content} running streamTurnId="t1" />));
      render("Hi");
      const burst = `Hi${" there".repeat(20)}`;
      render(burst);
      expect(container.textContent).toBe(burst);
    } finally {
      matchMedia.mockRestore();
    }
  });
});

describe("new-word fade on the streaming tail", () => {
  // The second paragraph's first line is complete, so the first paragraph is settled and only the second is the tail.
  const content = "Settled paragraph.\n\nStill **arriving** text\nwith `code`";
  const words = () => [...container.querySelectorAll(`.${STREAMING_WORD_CLASS}`)].map((span) => span.textContent);

  it("wraps the tail's words in Smooth mode, but not code or settled blocks", () => {
    act(() => root.render(<AssistantMessageBody role="assistant" content={content} running streamTurnId="t1" />));
    expect(words()).toEqual(["Still", "arriving", "text", "with"]);
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("adds no spans in Instant mode or once the reply settles", () => {
    act(() =>
      root.render(
        <AssistantMessageBody
          role="assistant"
          content={content}
          running
          streamPresentationMode="instant"
          streamTurnId="t1"
        />,
      ),
    );
    expect(words()).toEqual([]);
    act(() => root.render(<AssistantMessageBody role="assistant" content={content} streamTurnId="t1" />));
    expect(words()).toEqual([]);
  });
});
