import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assistantUiMocks = vi.hoisted(() => ({
  runtimeCalls: [] as unknown[],
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => (
    <section className="mock-runtime-provider">{children}</section>
  ),
  MessagePrimitive: {
    Root: ({ children, className }: { children: ReactNode; className?: string }) => (
      <article className={className}>{children}</article>
    ),
    Parts: ({
      components,
    }: {
      components: {
        Text: () => ReactNode;
      };
    }) => <>{components.Text()}</>,
  },
  ThreadPrimitive: {
    Root: ({ children, className }: { children: ReactNode; className?: string }) => (
      <section className={className}>{children}</section>
    ),
    Viewport: ({
      autoScroll,
      children,
      className,
      scrollToBottomOnInitialize,
    }: {
      autoScroll?: boolean;
      children: ReactNode;
      className?: string;
      scrollToBottomOnInitialize?: boolean;
    }) => (
      <section
        className={className}
        data-autoscroll={String(autoScroll)}
        data-scroll-init={String(scrollToBottomOnInitialize)}
      >
        {children}
      </section>
    ),
    Messages: ({ children }: { children: () => ReactNode }) => <section>{children()}</section>,
  },
  useExternalStoreRuntime: (input: unknown) => {
    assistantUiMocks.runtimeCalls.push(input);
    return { kind: "mock-runtime" };
  },
}));

vi.mock("@assistant-ui/react-markdown", () => ({
  MarkdownTextPrimitive: ({ className }: { className?: string }) => <p className={className}>mock markdown text</p>,
}));

import { AssistantMessageRenderer } from "./AssistantMessageRenderer";

function installRuntimeDom() {
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: vi.fn(globalThis.clearTimeout),
  });
  vi.stubGlobal("document", {
    createElement: vi.fn(),
    getElementsByTagName: vi.fn(() => []),
  });
  vi.stubGlobal("navigator", {
    userAgent: "Chrome/120",
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
}

describe("AssistantMessageRenderer runtime path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    assistantUiMocks.runtimeCalls.length = 0;
    installRuntimeDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("normalizes assistant messages into assistant-ui runtime shape", () => {
    const renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content={String.raw`Runtime \u0057orld`}
        running
        className="custom-runtime"
      />,
    );

    const runtimeInput = assistantUiMocks.runtimeCalls.at(-1) as {
      isRunning: boolean;
      messages: Array<{
        id: string;
        role: string;
        content: Array<{ type: string; text: string }>;
        status: { type: string; reason?: string };
        metadata: {
          unstable_state: unknown;
          unstable_annotations: unknown[];
          unstable_data: unknown[];
          steps: unknown[];
          custom: Record<string, unknown>;
        };
      }>;
      onNew: () => Promise<void>;
      onCancel: () => Promise<void>;
    };
    expect(runtimeInput.isRunning).toBe(true);
    expect(runtimeInput.messages[0]).toMatchObject({
      id: "assistant-13-running",
      role: "assistant",
      content: [{ type: "text", text: "Runtime World" }],
      status: { type: "running" },
    });
    expect(runtimeInput.messages[0]!.metadata).toMatchObject({
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {},
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("custom-runtime");
    expect(JSON.stringify(renderer.toJSON())).toContain("mock markdown text");
  });

  it("normalizes complete user messages without assistant copy controls", async () => {
    const renderer = create(<AssistantMessageRenderer role="user" content="User request" running={false} />);

    const runtimeInput = assistantUiMocks.runtimeCalls.at(-1) as {
      isRunning: boolean;
      messages: Array<{
        id: string;
        role: string;
        content: Array<{ type: string; text: string }>;
        attachments: unknown[];
        metadata: { custom: Record<string, unknown> };
      }>;
      onNew: () => Promise<void>;
      onCancel: () => Promise<void>;
    };
    expect(runtimeInput.isRunning).toBe(false);
    expect(runtimeInput.messages[0]).toMatchObject({
      id: "user-12",
      role: "user",
      content: [{ type: "text", text: "User request" }],
      attachments: [],
      metadata: { custom: {} },
    });
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    await expect(runtimeInput.onNew()).resolves.toBeUndefined();
    await expect(runtimeInput.onCancel()).resolves.toBeUndefined();
  });

  it("uses complete assistant status, ignores blank copy attempts, and clears pending copy timers", async () => {
    const renderer = create(<AssistantMessageRenderer role="assistant" content="" running={false} />);
    const firstRuntimeInput = assistantUiMocks.runtimeCalls.at(-1) as {
      messages: Array<{ content: Array<{ text: string }>; status: { type: string; reason?: string } }>;
    };
    expect(firstRuntimeInput.messages[0]).toMatchObject({
      content: [{ text: " " }],
      status: { type: "complete", reason: "stop" },
    });
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    renderer.update(<AssistantMessageRenderer role="assistant" content="Copy me" running={false} />);
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Copy me");
    expect(renderer.root.findByType("button").props.title).toBe("Copied");
    renderer.unmount();
    expect(window.clearTimeout).toHaveBeenCalled();
  });
});
