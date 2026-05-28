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

function collectTreeText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const node = value as { children?: unknown[] };
  return Array.isArray(node.children) ? node.children.map(collectTreeText).join("") : "";
}

function installRuntimeDom() {
  vi.stubGlobal("__GOATCITADEL_ENABLE_ASSISTANT_UI_RENDERER", true);
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
      id: expect.any(String),
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
    expect(JSON.stringify(renderer.toJSON())).toContain("Runtime World");
  });

  it("removes raw HTML noise before passing assistant text to the runtime and copy control", async () => {
    const renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content={'<!-- noise --><table><tr><td>Store</td><td>Hours</td></tr></table><svg><path d="x" /></svg>'}
      />,
    );

    const runtimeInput = assistantUiMocks.runtimeCalls.at(-1) as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(runtimeInput.messages[0]?.content[0]?.text).toBe("Store\n\nHours");

    await act(async () => {
      renderer.root.findByType("button").props.onClick();
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Store\n\nHours");
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
      id: expect.any(String),
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
      messages: Array<{ id: string; content: Array<{ text: string }>; status: { type: string; reason?: string } }>;
    };
    const firstMessageId = firstRuntimeInput.messages[0]!.id;
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
    const secondRuntimeInput = assistantUiMocks.runtimeCalls.at(-1) as {
      messages: Array<{ id: string; content: Array<{ text: string }> }>;
    };
    expect(secondRuntimeInput.messages[0]!.id).toBe(firstMessageId);
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Copy me");
    expect(renderer.root.findByType("button").props.title).toBe("Copied");
    renderer.unmount();
    expect(window.clearTimeout).toHaveBeenCalled();
  });

  it("wraps the fallback streaming tail in smooth visual tokens", () => {
    vi.unstubAllGlobals();

    const renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content="Visible preview tail"
        running
        streamPresentationMode="smooth"
      />,
    );

    const tokens = renderer.root.findAllByProps({ className: "mc-assistant-stream-token" });
    expect(tokens.map((token) => collectTreeText(token))).toEqual(["Visible ", "preview ", "tail"]);
    expect(JSON.stringify(renderer.toJSON())).toContain("mc-assistant-stream-smooth");
  });

  it("keeps instant fallback streaming unwrapped while preserving display markdown", () => {
    vi.unstubAllGlobals();

    const renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content={"| Store | Hours |\n| --- | --- |\n| Bakery | 9-5 |\n\n```ts\nconst open = true;\n```"}
        running
        streamPresentationMode="instant"
      />,
    );

    expect(renderer.root.findAllByProps({ className: "mc-assistant-stream-token" })).toHaveLength(0);
    expect(renderer.root.findByProps({ className: "mc-assistant-table-scroll" })).toBeTruthy();
    expect(renderer.root.findByProps({ className: "mc-assistant-code-block", "data-language": "ts" })).toBeTruthy();
  });

  it("keeps unsafe markdown links inert while preserving safe references", () => {
    vi.unstubAllGlobals();

    const renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content="[safe](https://example.test/report) [local](/ops) [bad](javascript:alert(1))"
      />,
    );

    expect(renderer.root.findAllByType("a").map((link) => link.props.href)).toEqual([
      "https://example.test/report",
      "/ops",
    ]);
    expect(renderer.root.findByProps({ className: "mc-assistant-link-disabled" })).toBeTruthy();
  });
});
