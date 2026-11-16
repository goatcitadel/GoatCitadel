// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import { ChatPendingQuestion } from "./ChatPendingQuestion";

const prompt: ChatUserInputPromptRecord = {
  promptId: "optional-one",
  turnId: "turn-one",
  kind: "text",
  title: "Style",
  question: "Which style?",
  required: false,
  delivery: "background",
};

describe("Cockpit optional question", () => {
  it("announces continuing work and submits an ordinary response while active", async () => {
    const container = document.createElement("div"),
      root = createRoot(container),
      submit = vi.fn();
    try {
      await act(async () => {
        root.render(<ChatPendingQuestion prompt={prompt} pending={false} onSubmit={submit} />);
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Work continues");
      expect(container.textContent).toContain("Do not enter credentials");
      const field = container.querySelector('input[type="text"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "  concise  ");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(submit).toHaveBeenCalledWith({ kind: "text", text: "concise" });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("offers Skip question for an optional background prompt and calls onSkip", async () => {
    const container = document.createElement("div"),
      root = createRoot(container),
      skip = vi.fn();
    try {
      await act(async () => {
        root.render(<ChatPendingQuestion prompt={prompt} pending={false} onSubmit={vi.fn()} onSkip={skip} />);
      });
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Skip question");
      expect(button).toBeDefined();
      expect(button!.getAttribute("type")).toBe("button");
      await act(async () => button!.click());
      expect(skip).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("offers no Skip question for a blocking prompt", async () => {
    const container = document.createElement("div"),
      root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ChatPendingQuestion
            prompt={{ ...prompt, required: true, delivery: undefined }}
            pending={false}
            onSubmit={vi.fn()}
            onSkip={vi.fn()}
          />,
        );
      });
      expect(container.textContent).not.toContain("Skip question");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([true, undefined])("does not label required or legacy input as background (%s)", async (required) => {
    const container = document.createElement("div"),
      root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ChatPendingQuestion
            prompt={{
              ...prompt,
              required: required ?? false,
              delivery: required === undefined ? undefined : "background",
            }}
            pending={false}
            onSubmit={vi.fn()}
          />,
        );
      });
      expect(container.querySelector('[role="status"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
