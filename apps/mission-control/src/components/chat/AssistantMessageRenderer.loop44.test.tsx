// @vitest-environment happy-dom

import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assistantUiState = vi.hoisted(() => ({
  runtimeCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children?: React.ReactNode; runtime?: unknown }) => (
    <section data-testid="runtime-provider">{children}</section>
  ),
  MessagePrimitive: {
    Parts: ({
      components,
    }: {
      components: {
        Text: React.ComponentType;
      };
    }) => {
      const Text = components.Text;
      return (
        <div data-testid="message-parts">
          <Text />
        </div>
      );
    },
    Root: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <article className={className}>{children}</article>
    ),
  },
  ThreadPrimitive: {
    Messages: ({ children }: { children: () => React.ReactNode }) => <div>{children()}</div>,
    Root: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    Viewport: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
  useExternalStoreRuntime: (input: Record<string, unknown>) => {
    assistantUiState.runtimeCalls.push(input);
    return { runtime: "mock-runtime" };
  },
}));

vi.mock("@assistant-ui/react-markdown", () => ({
  MarkdownTextPrimitive: ({ className }: { className?: string }) => <div className={className}>Runtime markdown</div>,
}));

import { AssistantMessageRenderer } from "./AssistantMessageRenderer";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(" ");
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function forceRuntimeRenderer(): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: "Chrome Mission Control",
  });
}

describe("AssistantMessageRenderer loop44 runtime behavior", () => {
  beforeEach(() => {
    assistantUiState.runtimeCalls = [];
    forceRuntimeRenderer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds a running assistant runtime message and renders assistant markdown primitives", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content="Runtime assistant response"
        running
        className="runtime-shell"
      />,
    );

    expect(renderer.root.findByProps({ className: "mc-assistant-renderer runtime-shell" })).toBeTruthy();
    expect(text(renderer)).toContain("Runtime markdown");
    expect(
      renderer.root.findByProps({ className: "mc-assistant-markdown mc-assistant-markdown-assistant" }),
    ).toBeTruthy();

    expect(assistantUiState.runtimeCalls).toHaveLength(1);
    expect(assistantUiState.runtimeCalls[0]).toEqual(
      expect.objectContaining({
        isRunning: true,
        messages: [
          expect.objectContaining({
            content: [{ text: "Runtime assistant response", type: "text" }],
            id: "assistant-26-running",
            role: "assistant",
            status: { type: "running" },
          }),
        ],
      }),
    );

    const runtimeCall = assistantUiState.runtimeCalls[0] as {
      onCancel: () => Promise<void>;
      onNew: () => Promise<void>;
    };
    await expect(runtimeCall.onNew()).resolves.toBeUndefined();
    await expect(runtimeCall.onCancel()).resolves.toBeUndefined();

    const copyButton = renderer.root.findByProps({ "aria-label": "Copy response to clipboard" });
    await act(async () => {
      copyButton.props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Response copied to clipboard" }).props.onClick();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalled();

    renderer.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("builds complete assistant and user runtime messages with stable visible controls", () => {
    const assistant = create(<AssistantMessageRenderer role="assistant" content="" />);
    const user = create(<AssistantMessageRenderer role="user" content="Operator request" />);

    expect(assistant.root.findByProps({ "aria-label": "Copy response to clipboard" })).toBeTruthy();
    expect(user.root.findAllByType("button")).toHaveLength(0);
    expect(user.root.findByProps({ className: "mc-assistant-markdown mc-assistant-markdown-user" })).toBeTruthy();

    assistant.root.findByProps({ "aria-label": "Copy response to clipboard" }).props.onClick();

    expect(assistantUiState.runtimeCalls.at(0)).toEqual(
      expect.objectContaining({
        isRunning: false,
        messages: [
          expect.objectContaining({
            content: [{ text: " ", type: "text" }],
            id: "assistant-0-complete",
            role: "assistant",
            status: { reason: "stop", type: "complete" },
          }),
        ],
      }),
    );
    expect(assistantUiState.runtimeCalls.at(1)).toEqual(
      expect.objectContaining({
        isRunning: false,
        messages: [
          expect.objectContaining({
            attachments: [],
            content: [{ text: "Operator request", type: "text" }],
            id: "user-16",
            role: "user",
          }),
        ],
      }),
    );
  });
});
