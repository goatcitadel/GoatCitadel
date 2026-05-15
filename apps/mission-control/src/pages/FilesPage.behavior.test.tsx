import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
  fallback: null as null | ((fallback: boolean) => void),
}));

const apiMocks = vi.hoisted(() => ({
  createFileFromTemplate: vi.fn(),
  downloadFile: vi.fn(),
  evaluateUiChangeRisk: vi.fn(),
  fetchFileTemplates: vi.fn(),
  fetchFilesList: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../api/client", () => ({
  createFileFromTemplate: apiMocks.createFileFromTemplate,
  downloadFile: apiMocks.downloadFile,
  evaluateUiChangeRisk: apiMocks.evaluateUiChangeRisk,
  fetchFileTemplates: apiMocks.fetchFileTemplates,
  fetchFilesList: apiMocks.fetchFilesList,
  uploadFile: apiMocks.uploadFile,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    _topic: string,
    callback: (signal: unknown) => Promise<void> | void,
    options?: { onFallbackStateChange?: (fallback: boolean) => void },
  ) => {
    refreshState.callback = callback;
    refreshState.fallback = options?.onFallbackStateChange ?? null;
  },
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: {
    data: Array<{ relativePath: string; size: number; modifiedAt: string }>;
    itemContent: (index: number, item: { relativePath: string; size: number; modifiedAt: string }) => React.ReactNode;
  }) => <div>{props.data.map((item, index) => props.itemContent(index, item))}</div>,
}));

vi.mock("../components/ChangeBadge", () => ({
  ChangeBadge: ({ level }: { level: string }) => <span>Risk {level}</span>,
}));

vi.mock("../components/ChangeReviewPanel", () => ({
  ChangeReviewPanel: (props: { overall: string; items?: Array<{ hint?: string }> }) => (
    <div>
      Change review {props.overall}
      {props.items?.map((item) => (item.hint ? <span key={item.hint}>{item.hint}</span> : null))}
    </div>
  ),
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      {primary}
      {secondary}
    </div>
  ),
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({ primary, inspector }: { primary?: React.ReactNode; inspector?: React.ReactNode }) => (
    <div>
      {primary}
      {inspector}
    </div>
  ),
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <header>
      {title}
      {actions}
    </header>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ title, children }: { title?: string; children?: React.ReactNode }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/SelectOrCustom", () => ({
  SelectOrCustom: (props: { value: string; onChange: (value: string) => void; customLabel?: string }) => (
    <input
      aria-label={props.customLabel ?? "custom select"}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

vi.mock("../components/SmartPathInput", () => ({
  SmartPathInput: (props: { label: string; value: string; onChange: (value: string) => void }) => (
    <input aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
  ),
}));

import { FilesPage } from "./FilesPage";

const fileItems = [
  {
    relativePath: "workspaces/research/notes/a.txt",
    size: 512,
    modifiedAt: "2026-05-14T12:00:00.000Z",
  },
  {
    relativePath: "workspaces/research/images/logo.png",
    size: 2048,
    modifiedAt: "2026-05-14T12:01:00.000Z",
  },
  {
    relativePath: "workspaces/research/bin/tool.bin",
    size: 4096,
    modifiedAt: "2026-05-14T12:02:00.000Z",
  },
  {
    relativePath: "outside/skip.txt",
    size: 10,
    modifiedAt: "2026-05-14T12:03:00.000Z",
  },
];

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map((child) => instanceText(child)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAll((node) => node.type === "button" && instanceText(node).includes(label)).at(0);
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    findButton(renderer, label).props.onClick();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("FilesPage behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
    refreshState.callback = null;
    refreshState.fallback = null;
    apiMocks.fetchFilesList.mockResolvedValue({ items: fileItems });
    apiMocks.fetchFileTemplates.mockResolvedValue({
      items: [{ templateId: "release", title: "Release notes" }],
    });
    apiMocks.downloadFile.mockImplementation((relativePath: string) => {
      if (relativePath.endsWith(".png")) {
        return Promise.resolve({
          relativePath,
          fullPath: `F:/code/personal-ai/${relativePath}`,
          size: 2048,
          modifiedAt: "2026-05-14T12:01:00.000Z",
          contentType: "image/png",
          encoding: "base64",
          content: "aW1hZ2U=",
        });
      }
      if (relativePath.endsWith(".bin")) {
        return Promise.resolve({
          relativePath,
          fullPath: `F:/code/personal-ai/${relativePath}`,
          size: 4096,
          modifiedAt: "2026-05-14T12:02:00.000Z",
          contentType: "application/octet-stream",
          encoding: "base64",
          content: "AAE=",
        });
      }
      return Promise.resolve({
        relativePath,
        fullPath: `F:/code/personal-ai/${relativePath}`,
        size: 512,
        modifiedAt: "2026-05-14T12:00:00.000Z",
        contentType: "text/plain",
        encoding: "utf8",
        content: "hello trail",
      });
    });
    apiMocks.evaluateUiChangeRisk.mockResolvedValue({
      overall: "safe",
      items: [{ field: "uploadPath", level: "safe", hint: "Path stays scoped." }],
    });
    apiMocks.uploadFile.mockResolvedValue({ relativePath: "workspaces/research/notes/a.txt" });
    apiMocks.createFileFromTemplate.mockResolvedValue({
      relativePath: "workspaces/research/release-notes.md",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("loads workspace-scoped files, edits selected text, saves content, and creates a template", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<FilesPage workspaceId="research" />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("3 visible files");
      expect(rendererText(renderer)).not.toContain("outside/skip.txt");
      expect(rendererText(renderer)).toContain("hello trail");

      await clickButton(renderer, "Edit Selected File");
      const editor = renderer.root.findByProps({ placeholder: "File content" });
      expect(editor.props.value).toBe("hello trail");

      await act(async () => {
        editor.props.onChange({ target: { value: "updated trail" } });
      });
      await clickButton(renderer, "Use Selected Path");
      await clickButton(renderer, "Show advanced save details");
      expect(rendererText(renderer)).toContain("Advanced mode allows arbitrary file paths");

      await clickButton(renderer, "Save File");
      await flush();

      expect(apiMocks.uploadFile).toHaveBeenCalledWith("workspaces/research/notes/a.txt", "updated trail");
      expect(rendererText(renderer)).toContain("Saved file: workspaces/research/notes/a.txt");

      await clickButton(renderer, "Release notes");
      await flush();

      expect(apiMocks.createFileFromTemplate).toHaveBeenCalledWith("release", undefined);
      expect(rendererText(renderer)).toContain("Created template file: workspaces/research/release-notes.md");
    } finally {
      renderer.unmount();
    }
  });

  it("renders image and binary previews when selecting non-text files", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<FilesPage workspaceId="research" />);
      });
      await flush();

      await clickButton(renderer, "images/logo.png");
      await flush();

      const image = renderer.root.findByType("img");
      expect(image.props.src).toBe("data:image/png;base64,aW1hZ2U=");
      expect(image.props.alt).toBe("Preview of workspaces/research/images/logo.png");
      expect(findButton(renderer, "Edit Selected File").props.disabled).toBe(true);

      await clickButton(renderer, "bin/tool.bin");
      await flush();

      expect(rendererText(renderer)).toContain("Binary file detected.");
      expect(rendererText(renderer)).toContain("Trail preview shows text and images.");
    } finally {
      renderer.unmount();
    }
  });

  it("debounces path risk checks, surfaces degraded risk copy, and handles fallback refresh state", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
    apiMocks.evaluateUiChangeRisk.mockRejectedValueOnce(new Error("risk down"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<FilesPage workspaceId="research" />);
      });
      await flush();

      const savePath = renderer.root.findByProps({ "aria-label": "Save path" });
      await act(async () => {
        savePath.props.onChange({ target: { value: "manual/path.txt" } });
      });

      await act(async () => {
        vi.advanceTimersByTime(399);
      });
      expect(apiMocks.evaluateUiChangeRisk).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await flush();

      expect(apiMocks.evaluateUiChangeRisk).toHaveBeenCalledWith(
        {
          pageId: "files",
          changes: [
            {
              field: "uploadPath",
              from: "manual/path.txt",
              to: "manual/path.txt",
            },
          ],
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(rendererText(renderer)).toContain("Risk preflight unavailable; local validation only.");

      await act(async () => {
        refreshState.fallback?.(true);
      });
      expect(rendererText(renderer)).toContain("Live updates degraded, checking periodically.");

      await act(async () => {
        await refreshState.callback?.({ topic: "files" });
      });
      await flush();
      expect(apiMocks.fetchFilesList).toHaveBeenCalledTimes(2);
    } finally {
      renderer.unmount();
    }
  });
});
