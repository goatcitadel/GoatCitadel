import type { ChatGeneratedArtifactRecord, ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantMessageRenderer, copyTextToClipboard, splitStreamingMarkdown } from "./AssistantMessageRenderer";
import { normalizeAssistantDisplayText, normalizeCitationDisplayText } from "./assistant-display-text";
import {
  ChatAttachmentActions,
  downloadChatAttachmentToDevice,
  openChatAttachmentInBrowser,
} from "./ChatAttachmentActions";
import { ChatAttachmentPreviewStack, resetAttachmentPreviewStateForTests } from "./ChatAttachmentPreviewStack";
import { ChatPendingUserInputPanel } from "./ChatPendingUserInputPanel";
import { GeneratedArtifactViewer } from "./GeneratedArtifactViewer";

const apiMocks = vi.hoisted(() => ({
  downloadChatAttachment: vi.fn(),
  fetchChatAttachmentPreview: vi.fn(),
}));

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  downloadChatAttachment: apiMocks.downloadChatAttachment,
  fetchChatAttachmentPreview: apiMocks.fetchChatAttachmentPreview,
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mermaidMocks.initialize,
    render: mermaidMocks.render,
  },
}));

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

function normalizedTextOf(node: unknown): string {
  return textOf(node).replace(/\s+/g, " ").trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushMacroTask(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

async function waitForRenderedContent(renderer: ReactTestRenderer, expected: string): Promise<void> {
  let rendered = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flush();
    await flushMacroTask();
    const tree = renderer.toJSON();
    rendered = `${textOf(tree)} ${JSON.stringify(tree)}`;
    if (rendered.includes(expected)) {
      return;
    }
  }
  expect(rendered).toContain(expected);
}

function artifact(overrides: Partial<ChatGeneratedArtifactRecord> = {}): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "session-1",
    workspaceId: "default",
    turnId: "turn-1",
    title: "Generated plan",
    kind: "code",
    content: "console.log('ok')",
    language: "ts",
    sourceSurface: "chat",
    version: 2,
    providerId: "openai",
    model: "gpt-5.4",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function prompt(overrides: Partial<ChatUserInputPromptRecord> = {}): ChatUserInputPromptRecord {
  return {
    promptId: "prompt-1",
    turnId: "turn-1",
    kind: "single_select",
    title: "Choose direction",
    question: "Which path should continue?",
    required: true,
    dismissible: true,
    submitLabel: "Continue",
    expiresAt: "2026-01-01T01:00:00.000Z",
    options: [
      { optionId: "fast", label: "Fast", description: "Prefer speed", helpText: "Useful for a quick pass." },
      { optionId: "deep", label: "Deep", description: "Prefer depth" },
    ],
    ...overrides,
  };
}

function installBrowserDownloadStubs(options: { openedWindow?: Record<string, unknown> | null } = {}) {
  const anchor = {
    href: "",
    download: "",
    rel: "",
    style: { display: "" },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  const createObjectURL = vi.fn(() => "blob:attachment");
  const revokeObjectURL = vi.fn();
  const openedWindow =
    options.openedWindow === undefined
      ? {
          closed: false,
          opener: {},
          document: { title: "", body: { textContent: "" } },
          location: { href: "" },
          close: vi.fn(),
        }
      : options.openedWindow;

  vi.stubGlobal("window", {
    open: vi.fn(() => openedWindow),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", {
    createElement: vi.fn(() => anchor),
    body: {
      appendChild,
      removeChild: vi.fn(),
    },
  });
  vi.stubGlobal("URL", {
    createObjectURL,
    revokeObjectURL,
  });
  return { anchor, appendChild, createObjectURL, revokeObjectURL, openedWindow };
}

describe("chat rendering tail coverage", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer = null;
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetAttachmentPreviewStateForTests();
    apiMocks.downloadChatAttachment.mockResolvedValue({
      blob: new Blob(["hello"], { type: "text/plain" }),
      fileName: "result.txt",
    });
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue({
      attachmentId: "att-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      mediaType: "text",
      extractPreview: "Preview copy",
      analysisStatus: "ready",
    });
    mermaidMocks.render.mockResolvedValue({ svg: "<svg><text>diagram</text></svg>" });
  });

  afterEach(() => {
    renderer?.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("strips raw html comments even when one pass reveals another comment marker", () => {
    const content = "<!<!-- hidden -->--><strong>Visible</strong>";

    expect(normalizeAssistantDisplayText(content)).toBe("Visible");
    expect(normalizeCitationDisplayText(content)).toBe("Visible");
  });

  it("renders assistant markdown fallback and copies decoded content through clipboard APIs", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderer = create(
      <AssistantMessageRenderer role="assistant" content={String.raw`Hello \u0057orld`} className="custom" />,
    );
    expect(normalizedTextOf(renderer.toJSON())).toContain("Hello World");

    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("Hello World");
    expect(renderer.root.findByType("button").props["aria-label"]).toBe("Response copied to clipboard");

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(renderer.root.findByType("button").props["aria-label"]).toBe("Copy response to clipboard");

    renderer.update(<AssistantMessageRenderer role="user" content="User copy" />);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("disables response copy while the assistant is still streaming", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderer = create(<AssistantMessageRenderer role="assistant" content="Partial response" running />);
    const copyButton = renderer.root.findByType("button");
    expect(copyButton.props.disabled).toBe(true);
    expect(copyButton.props["aria-label"]).toBe("Copy available when response completes");

    await act(async () => {
      copyButton.props.onClick();
      await Promise.resolve();
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("renders gated OpenUI assistant blocks and falls back safely", async () => {
    const openUiProgram = 'root = StatusCard("Renderer ready", "success", "Structured UI rendered.")';

    renderer = create(<AssistantMessageRenderer role="assistant" content={`\`\`\`openui\n${openUiProgram}\n\`\`\``} />);
    expect(renderer.root.findAllByProps({ className: "gc-openui-renderer" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: "mc-assistant-code-shell" })).toHaveLength(1);

    vi.stubGlobal("__GOATCITADEL_OPENUI_RENDERER__", true);
    renderer.unmount();
    renderer = create(<AssistantMessageRenderer role="assistant" content={`\`\`\`openui\n${openUiProgram}\n\`\`\``} />);
    await waitForRenderedContent(renderer, "Renderer ready");
    expect(renderer.root.findAllByProps({ className: "gc-openui-renderer" })).toHaveLength(1);
    expect(normalizedTextOf(renderer.toJSON())).toContain("Structured UI rendered.");

    renderer.update(
      <AssistantMessageRenderer role="assistant" content={'```openui\nroot = RawHtml("<b>no</b>")\n```'} />,
    );
    expect(renderer.root.findAllByProps({ className: "gc-openui-renderer" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: "mc-assistant-code-shell" })).toHaveLength(1);

    renderer.update(<AssistantMessageRenderer role="user" content={`\`\`\`openui\n${openUiProgram}\n\`\`\``} />);
    expect(renderer.root.findAllByProps({ className: "gc-openui-renderer" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: "mc-assistant-code-shell" })).toHaveLength(1);
  });

  it("keeps streaming markdown splits outside open fenced code blocks", () => {
    expect(splitStreamingMarkdown("foo\n```js\nbar\n```\n\nbaz")).toEqual({
      stable: "foo\n```js\nbar\n```\n\n",
      tail: "baz",
    });
    expect(splitStreamingMarkdown("foo\n   ```js\nbar\n   ```   \n\nbaz")).toEqual({
      stable: "foo\n   ```js\nbar\n   ```   \n\n",
      tail: "baz",
    });
    expect(splitStreamingMarkdown("intro\n\n```js\nbar\n\nbaz")).toEqual({
      stable: "intro\n\n",
      tail: "```js\nbar\n\nbaz",
    });
    expect(splitStreamingMarkdown("intro\n\n```js\n```not closed\n\nstill code")).toEqual({
      stable: "intro\n\n",
      tail: "```js\n```not closed\n\nstill code",
    });
    expect(splitStreamingMarkdown("intro\n\n~~~txt\n~~~not closed\n\nstill code")).toEqual({
      stable: "intro\n\n",
      tail: "~~~txt\n~~~not closed\n\nstill code",
    });
  });

  it("animates the streaming tail as one stable container instead of per-token spans", () => {
    renderer = create(
      <AssistantMessageRenderer
        role="assistant"
        content="Visible preview tail"
        running
        streamPresentationMode="smooth"
      />,
    );

    expect(renderer.root.findAllByProps({ className: "mc-assistant-stream-token" })).toHaveLength(0);
    expect(
      renderer.root.findByProps({
        className: "mc-assistant-streaming-tail mc-assistant-streaming-tail-smooth",
      }),
    ).toBeTruthy();
  });

  it("reports clipboard API unavailability without deprecated execCommand fallback", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("navigator", {});

    await expect(copyTextToClipboard("Copy via textarea")).rejects.toThrow(
      "Clipboard API is unavailable in this environment.",
    );

    renderer = create(<AssistantMessageRenderer role="assistant" content="Copy via textarea" />);
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
      await Promise.resolve();
    });
    expect(renderer.root.findByType("button").props["aria-label"]).toBe("Copy unavailable from this browser");

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(renderer.root.findByType("button").props["aria-label"]).toBe("Copy response to clipboard");
  });

  it("renders generated artifact variants including Mermaid success and failure states", async () => {
    renderer = create(<GeneratedArtifactViewer artifact={artifact()} compact />);
    expect(textOf(renderer.toJSON())).toContain("Generated plan");
    expect(textOf(renderer.toJSON())).toContain("console.log");

    renderer.update(
      <GeneratedArtifactViewer
        artifact={artifact({
          kind: "text",
          language: undefined,
          content: "plain",
          createdAt: "not-a-date",
          providerId: undefined,
          model: "standalone-model",
          supersedesArtifactId: "artifact-previous",
        })}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("plain");
    expect(textOf(renderer.toJSON())).toContain("not-a-date");
    expect(textOf(renderer.toJSON())).toContain("standalone-model");
    expect(textOf(renderer.toJSON())).toContain("Supersedes prior version");

    renderer.update(<GeneratedArtifactViewer artifact={artifact({ kind: "html", content: "<strong>Hi</strong>" })} />);
    expect(renderer.root.findByType("iframe").props.srcDoc).toBe("<strong>Hi</strong>");

    renderer.update(<GeneratedArtifactViewer artifact={artifact({ kind: "markdown", content: "**Bold**" })} />);
    expect(textOf(renderer.toJSON())).toContain("Bold");

    renderer.unmount();
    renderer = create(<GeneratedArtifactViewer artifact={artifact({ kind: "mermaid", content: "graph TD; A-->B" })} />);
    expect(textOf(renderer.toJSON())).toContain("Rendering diagram");
    await waitForRenderedContent(renderer, "<svg><text>diagram</text></svg>");

    mermaidMocks.render.mockRejectedValueOnce(new Error("bad diagram"));
    renderer.update(<GeneratedArtifactViewer artifact={artifact({ kind: "mermaid", content: "graph TD; bad" })} />);
    await waitForRenderedContent(renderer, "Mermaid render failed");
    expect(textOf(renderer.toJSON())).toContain("bad diagram");
    expect(textOf(renderer.toJSON())).toContain("graph TD; bad");
  });

  it("submits and dismisses pending user input prompts", () => {
    const onSubmit = vi.fn();
    const onDismiss = vi.fn();
    renderer = create(
      <ChatPendingUserInputPanel
        pendingUserInput={prompt()}
        pending={false}
        onSubmit={onSubmit}
        onDismiss={onDismiss}
      />,
    );
    expect(renderer.root.findByProps({ className: "gc-button chat-approval-allow" }).props.disabled).toBe(true);
    act(() => {
      renderer!.root.findAllByType("input")[0]!.props.onChange();
    });
    act(() => {
      renderer!.root.findByProps({ className: "gc-button chat-approval-allow" }).props.onClick();
    });
    expect(onSubmit).toHaveBeenCalledWith({ kind: "single_select", optionId: "fast" });
    act(() => {
      renderer!.root.findByProps({ className: "gc-button chat-approval-deny" }).props.onClick();
    });
    expect(onDismiss).toHaveBeenCalled();

    renderer.update(
      <ChatPendingUserInputPanel
        pendingUserInput={prompt({
          promptId: "prompt-2",
          kind: "text",
          options: undefined,
          multiline: true,
          placeholder: "Explain",
        })}
        pending={false}
        onSubmit={onSubmit}
      />,
    );
    act(() => {
      renderer!.root.findByType("textarea").props.onChange({ target: { value: "  typed answer  " } });
    });
    act(() => {
      renderer!.root.findByProps({ className: "gc-button chat-approval-allow" }).props.onClick();
    });
    expect(onSubmit).toHaveBeenCalledWith({ kind: "text", text: "typed answer" });

    renderer.update(
      <ChatPendingUserInputPanel
        pendingUserInput={prompt({ promptId: "prompt-3", kind: "text", multiline: false, options: undefined })}
        pending
        onSubmit={onSubmit}
        onDismiss={onDismiss}
      />,
    );
    expect(renderer.root.findByType("input").props.disabled).toBe(true);
    renderer.update(<ChatPendingUserInputPanel pendingUserInput={null} pending={false} onSubmit={onSubmit} />);
    expect(renderer.toJSON()).toBeNull();
  });

  it("opens, downloads, and reports attachment action outcomes", async () => {
    vi.useFakeTimers();
    const browser = installBrowserDownloadStubs();

    await expect(openChatAttachmentInBrowser({ attachmentId: "att-1", fileName: " " })).resolves.toBe("opened");
    expect((browser.openedWindow as { location: { href: string } }).location.href).toBe("blob:attachment");

    installBrowserDownloadStubs({ openedWindow: null });
    await expect(openChatAttachmentInBrowser({ attachmentId: "att-1", fileName: "fallback.txt" })).resolves.toBe(
      "downloaded",
    );

    await expect(
      downloadChatAttachmentToDevice({ attachmentId: "att-1", fileName: "fallback.txt" }),
    ).resolves.toBeUndefined();
    expect(apiMocks.downloadChatAttachment).toHaveBeenCalledWith("att-1");

    const onError = vi.fn();
    apiMocks.downloadChatAttachment.mockRejectedValueOnce(new Error("network down"));
    renderer = create(<ChatAttachmentActions attachmentId="att-1" fileName="notes.txt" onError={onError} />);
    await act(async () => {
      renderer!.root.findAllByType("button")[0]!.props.onClick();
      await Promise.resolve();
    });
    expect(textOf(renderer.toJSON())).toContain("network down");
    expect(onError).toHaveBeenCalledWith("network down");

    vi.stubGlobal("window", undefined);
    await expect(downloadChatAttachmentToDevice({ attachmentId: "att-1", fileName: "fallback.txt" })).rejects.toThrow(
      "Attachment downloads are only available",
    );
  });

  it("loads attachment previews, caches in-flight requests, and renders retryable states", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    renderer = create(
      <ChatAttachmentPreviewStack
        attachments={[{ attachmentId: "att-1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 1536 }]}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("Extraction is still preparing");
    await flush();
    expect(textOf(renderer.toJSON())).toContain("Preview copy");

    renderer.update(
      <ChatAttachmentPreviewStack
        attachments={[{ attachmentId: "att-1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 1536 }]}
      />,
    );
    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(1);

    apiMocks.fetchChatAttachmentPreview.mockResolvedValueOnce({
      attachmentId: "att-2",
      fileName: "audio.mp3",
      mimeType: "audio/mpeg",
      mediaType: "audio",
      transcriptText: "",
      analysisStatus: "queued",
    });
    renderer.update(
      <ChatAttachmentPreviewStack
        attachments={[{ attachmentId: "att-2", fileName: "audio.mp3", mimeType: "audio/mpeg", sizeBytes: 300 }]}
      />,
    );
    await flush();
    expect(textOf(renderer.toJSON())).toContain("queued");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledWith("att-2");

    apiMocks.fetchChatAttachmentPreview.mockRejectedValueOnce(new Error("preview failed"));
    renderer.update(
      <ChatAttachmentPreviewStack
        attachments={[
          { attachmentId: "att-3", fileName: "bad.bin", mimeType: "application/octet-stream", sizeBytes: 1 },
        ]}
      />,
    );
    await flush();
    expect(textOf(renderer.toJSON())).toContain("Preview unavailable");
    expect(textOf(renderer.toJSON())).toContain("preview failed");

    renderer.update(<ChatAttachmentPreviewStack attachments={[]} />);
    expect(renderer.toJSON()).toBeNull();
  });
});
