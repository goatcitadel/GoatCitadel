import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const arboristMocks = vi.hoisted(() => ({
  Tree: vi.fn(
    ({
      children,
      data,
      onActivate,
      onToggle,
    }: {
      children: (input: { node: Record<string, unknown>; style: React.CSSProperties }) => React.ReactNode;
      data: Array<{
        id: string;
        kind: "file" | "directory";
        children?: Array<{ id: string; kind: "file" | "directory" }>;
      }>;
      onActivate: (node: { data: { kind: "file" | "directory"; path: string } }) => void;
      onToggle: (id: string) => void;
    }) => {
      const directory = data[0]!;
      const file = directory.children?.[0] ?? data.find((node) => node.kind === "file")!;
      return (
        <div data-testid="tree">
          {children({
            node: {
              data: directory,
              isOpen: false,
              isSelected: false,
              handleClick: vi.fn(),
              toggle: () => onToggle(directory.id),
            },
            style: { top: 0 },
          })}
          <button type="button" onClick={() => onActivate({ data: { kind: "file", path: file.id } })}>
            activate-file
          </button>
        </div>
      );
    },
  ),
}));

vi.mock("react-arborist", () => ({
  Tree: arboristMocks.Tree,
}));

import { InlineApprovalPrompt } from "./InlineApprovalPrompt";
import { SideInspectorDrawer } from "./SideInspectorDrawer";
import { WorkbenchFileTree } from "./WorkbenchFileTree";
import { WorkbenchMonacoEditor } from "./WorkbenchMonacoEditor";

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

class FakeHTMLElement {
  public textContent = "";

  public constructor(private readonly closestResult: unknown = null) {}

  public closest() {
    return this.closestResult;
  }

  public blur = vi.fn();

  public getBoundingClientRect() {
    return { left: 100, top: 50, width: 320, height: 240 };
  }
}

describe("workbench tree, inspector drawer, and approval prompt tails", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    renderer = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    renderer?.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as typeof globalThis & { __GOATCITADEL_TEST_ARBORIST_TREE?: boolean })
      .__GOATCITADEL_TEST_ARBORIST_TREE;
  });

  it("renders fallback and arborist workbench file trees", () => {
    const items = [
      { path: "src", name: "src", kind: "directory" as const, depth: 0, changed: false },
      { path: "src/app.ts", name: "app.ts", kind: "file" as const, depth: 1, changed: true },
      { path: "README.md", name: "README.md", kind: "file" as const, depth: 0, changed: false },
    ];
    const onExpandedPathsChange = vi.fn();
    const onSelectFile = vi.fn();

    renderer = create(
      <WorkbenchFileTree
        storageScopeKey="scope-a"
        items={items}
        selectedPath="src/app.ts"
        expandedPaths={["src"]}
        onExpandedPathsChange={onExpandedPathsChange}
        onSelectFile={onSelectFile}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("app.ts");
    act(() => {
      renderer!.root.findAllByType("button")[0]!.props.onClick();
    });
    expect(onSelectFile).toHaveBeenCalledWith("src/app.ts");

    vi.stubGlobal("window", {});
    (
      globalThis as typeof globalThis & { __GOATCITADEL_TEST_ARBORIST_TREE?: boolean }
    ).__GOATCITADEL_TEST_ARBORIST_TREE = true;
    renderer.update(
      <WorkbenchFileTree
        storageScopeKey="scope-b"
        items={items}
        selectedPath="README.md"
        expandedPaths={[]}
        onExpandedPathsChange={onExpandedPathsChange}
        onSelectFile={onSelectFile}
      />,
    );
    expect(arboristMocks.Tree).toHaveBeenCalledWith(
      expect.objectContaining({ height: 320, initialOpenState: {} }),
      undefined,
    );
    act(() => {
      renderer!.root.findAllByType("button")[0]!.props.onClick({ type: "click" });
      renderer!.root.findAllByType("button")[1]!.props.onClick();
    });
    expect(onExpandedPathsChange).toHaveBeenCalledWith(["src"]);
    expect(onSelectFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("routes fallback workbench editor keyboard commands", () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    const onQuickOpen = vi.fn();
    const onCommandPalette = vi.fn();
    const preventDefault = vi.fn();

    renderer = create(
      <WorkbenchMonacoEditor
        value="console.log('workbench');"
        language="typescript"
        onChange={onChange}
        onSave={onSave}
        onQuickOpen={onQuickOpen}
        onCommandPalette={onCommandPalette}
      />,
    );

    const textarea = renderer.root.findByType("textarea");
    act(() => {
      textarea.props.onChange({ target: { value: "next" } });
      textarea.props.onKeyDown({ ctrlKey: true, metaKey: false, shiftKey: false, key: "s", preventDefault });
      textarea.props.onKeyDown({ ctrlKey: true, metaKey: false, shiftKey: false, key: "p", preventDefault });
      textarea.props.onKeyDown({ ctrlKey: true, metaKey: false, shiftKey: true, key: "p", preventDefault });
    });

    expect(onChange).toHaveBeenCalledWith("next");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onQuickOpen).toHaveBeenCalledTimes(1);
    expect(onCommandPalette).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it("supports side inspector actions, drag bounds, close reset, and blocked drag targets", () => {
    const listeners = new Map<string, (event: PointerEvent) => void>();
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("window", {
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: vi.fn((event: string, listener: (event: PointerEvent) => void) =>
        listeners.set(event, listener),
      ),
      removeEventListener: vi.fn((event: string) => listeners.delete(event)),
    });
    const onClose = vi.fn();
    const onTogglePinned = vi.fn();

    renderer = create(
      <SideInspectorDrawer
        title="Inspector"
        kicker="Details"
        subtitle={<span>Selection</span>}
        open
        pinned
        draggable
        actions={<button type="button">Action</button>}
        onClose={onClose}
        onTogglePinned={onTogglePinned}
      >
        Body
      </SideInspectorDrawer>,
      { createNodeMock: () => new FakeHTMLElement() },
    );

    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Unpin"))!
        .props.onClick();
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Close"))!
        .props.onClick();
    });
    expect(onTogglePinned).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();

    const head = renderer.root.findByProps({ className: "side-inspector-drawer-head" });
    const preventDefault = vi.fn();
    act(() => {
      head.props.onPointerDown({
        button: 0,
        pointerId: 7,
        clientX: 120,
        clientY: 80,
        target: new FakeHTMLElement(),
        preventDefault,
      });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("dragging");

    act(() => {
      listeners.get("pointermove")?.({ pointerId: 7, clientX: 900, clientY: 700 } as PointerEvent);
      listeners.get("pointerup")?.({ pointerId: 7 } as PointerEvent);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("--side-inspector-drag-x");

    act(() => {
      head.props.onDoubleClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("0px");

    act(() => {
      head.props.onPointerDown({
        button: 0,
        pointerId: 8,
        clientX: 120,
        clientY: 80,
        target: new FakeHTMLElement({ tagName: "button" }),
        preventDefault: vi.fn(),
      });
    });

    renderer.update(
      <SideInspectorDrawer title="Inspector" open={false} draggable onClose={onClose}>
        Body
      </SideInspectorDrawer>,
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("closed");
  });

  it("drives inline approval actions, expiry, workspace confirmation, and risk summaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const callbacks = {
      onApproveOnce: vi.fn(),
      onApproveInSession: vi.fn(),
      onApproveInWorkspace: vi.fn(),
      onDeny: vi.fn(),
    };

    renderer = create(
      <InlineApprovalPrompt
        approvalId="approval-1"
        kind="tool_call"
        toolName="browser.open"
        reason="Needs browser access"
        riskLevel="nuclear"
        expiresAt="2026-01-01T00:01:30.000Z"
        inspectPath="memory/path"
        requestedOutputIntent="Open page"
        saveCandidateOnSuccess
        remainingCount={2}
        affectedResources={["one", "two", "three", "four", "five"]}
        codePreview="console.log(1)"
        approvalsHref="/approvals/1"
        workspaceAllowAvailable
        {...callbacks}
      />,
    );
    const rendered = textOf(renderer.toJSON());
    expect(rendered).toContain("Nuclear risk");
    expect(rendered).toContain("+ 2");
    expect(rendered).toContain("more waiting");
    expect(rendered).toContain("Expires in 1m 30s");
    expect(rendered).toContain("one, two, three, four, +1 more");

    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Allow once"))!
        .props.onClick();
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Allow in session"))!
        .props.onClick();
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Deny"))!
        .props.onClick();
    });
    expect(callbacks.onApproveOnce).toHaveBeenCalled();
    expect(callbacks.onApproveInSession).toHaveBeenCalled();
    expect(callbacks.onDeny).toHaveBeenCalled();

    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Allow in workspace"))!
        .props.onClick();
    });
    expect(textOf(renderer.toJSON())).toContain("Confirm workspace allow");
    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Confirm workspace allow"))!
        .props.onClick();
    });
    expect(callbacks.onApproveInWorkspace).toHaveBeenCalled();

    renderer.update(
      <InlineApprovalPrompt
        approvalId="approval-2"
        kind="tool_call"
        riskLevel="danger"
        workspaceAllowAvailable={false}
        pending
        {...callbacks}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("Danger risk");
    // Only the approval *decision* controls lock while a decision is pending. The
    // IdentifierChip copy button (class "gc-identifier-chip-copy") is a read-only
    // affordance for copying the approval id and stays enabled by design, so scope
    // the disabled check to the "chat-approval-*" action buttons.
    const pendingActionButtons = renderer.root
      .findAllByType("button")
      .filter((button) => String(button.props.className ?? "").includes("chat-approval-"));
    expect(pendingActionButtons.length).toBeGreaterThan(0);
    expect(pendingActionButtons.every((button) => button.props.disabled)).toBe(true);

    renderer.update(
      <InlineApprovalPrompt
        approvalId="approval-3"
        kind="tool_call"
        riskLevel="safe"
        expiresAt="2026-01-01T00:00:01.000Z"
        {...callbacks}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(textOf(renderer.toJSON())).toContain("Approval expired");

    renderer.update(
      <InlineApprovalPrompt approvalId="approval-4" kind="tool_call" riskLevel="caution" {...callbacks} />,
    );
    expect(textOf(renderer.toJSON())).toContain("Caution risk");
  });

  it("keeps invalid inline approval expiries passive and lets workspace confirmation be cancelled", () => {
    vi.useFakeTimers();
    const callbacks = {
      onApproveOnce: vi.fn(),
      onApproveInSession: vi.fn(),
      onApproveInWorkspace: vi.fn(),
      onDeny: vi.fn(),
    };

    renderer = create(
      <InlineApprovalPrompt
        approvalId="approval-invalid-expiry"
        expiresAt="not-a-date"
        workspaceAllowAvailable
        {...callbacks}
      />,
    );

    expect(textOf(renderer.toJSON())).not.toContain("Expires in");
    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Allow in workspace"))!
        .props.onClick();
    });
    expect(textOf(renderer.toJSON())).toContain("Confirm workspace allow");

    act(() => {
      renderer!.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Cancel"))!
        .props.onClick();
    });
    expect(textOf(renderer.toJSON())).not.toContain("Confirm workspace allow");
    expect(callbacks.onApproveInWorkspace).not.toHaveBeenCalled();
  });
});
