import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const monacoMocks = vi.hoisted(() => ({
  loadMonacoEditorRuntime: vi.fn(),
  normalizeMonacoLoaderLanguage: vi.fn((language?: string) => language?.trim().toLowerCase() || "plaintext"),
  shouldRenderMonacoRuntime: vi.fn(() => false),
}));

vi.mock("./ui", () => ({
  GCModal: ({
    open,
    title,
    description,
    confirmLabel,
    cancelLabel,
    confirmDisabled,
    dismissDisabled,
    onConfirm,
    onOpenChange,
    children,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    confirmDisabled?: boolean;
    dismissDisabled?: boolean;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
    children?: React.ReactNode;
  }) =>
    open ? (
      <section
        data-confirm-disabled={String(Boolean(confirmDisabled))}
        data-dismiss-disabled={String(Boolean(dismissDisabled))}
      >
        <h1>{title}</h1>
        <p>{description}</p>
        <button type="button" disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" disabled={dismissDisabled} onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </button>
        {children}
      </section>
    ) : null,
}));

vi.mock("./monaco-loader", () => ({
  loadMonacoEditorRuntime: monacoMocks.loadMonacoEditorRuntime,
  normalizeMonacoLoaderLanguage: monacoMocks.normalizeMonacoLoaderLanguage,
}));

vi.mock("./monaco-runtime", () => ({
  shouldRenderMonacoRuntime: monacoMocks.shouldRenderMonacoRuntime,
}));

import { ChatQueueBar, buildVisibleQueueItems, type ChatQueueItemView } from "./chat/ChatQueueBar";
import { ChatExecutionPlanSummary } from "./chat/ChatExecutionPlanSummary";
import { ConfigFormBuilder } from "./ConfigFormBuilder";
import { DeviceAccessApprovalModal } from "./DeviceAccessApprovalModal";
import { RemoteApprovalActionModal } from "./RemoteApprovalActionModal";
import { GCSegmentedControl } from "./ui/GCSegmentedControl";
import { WorkbenchMonacoEditor } from "./WorkbenchMonacoEditor";

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

function queueItem(id: string, action: ChatQueueItemView["action"], paused = false): ChatQueueItemView {
  return {
    id,
    action,
    paused,
    label: `Queued ${id}`,
    createdAt: `2026-05-15T00:0${id}.000Z`,
  };
}

function keyEvent(key: string) {
  return { key, preventDefault: vi.fn() };
}

describe("shared loop 24 component tails", () => {
  it("handles segmented-control disabled and keyboard navigation branches", () => {
    const onChange = vi.fn();
    const disabled = create(
      <GCSegmentedControl
        value="alpha"
        ariaLabel="Mode"
        onChange={onChange}
        options={[
          { value: "alpha", label: "Alpha", disabled: true },
          { value: "beta", label: "Beta", disabled: true },
        ]}
      />,
      { createNodeMock: () => ({ focus: vi.fn() }) },
    );
    act(() => {
      disabled.root.findAllByType("button")[0]!.props.onKeyDown(keyEvent("ArrowRight"));
    });
    expect(onChange).not.toHaveBeenCalled();

    const enabled = create(
      <GCSegmentedControl
        value="alpha"
        ariaLabel="Mode"
        onChange={onChange}
        className="extra"
        options={[
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta", disabled: true },
          { value: "gamma", label: "Gamma" },
        ]}
      />,
      { createNodeMock: () => ({ focus: vi.fn() }) },
    );
    const [alpha, beta, gamma] = enabled.root.findAllByType("button");
    act(() => {
      beta!.props.onKeyDown(keyEvent("ArrowRight"));
    });
    expect(onChange).not.toHaveBeenCalled();
    for (const [button, key, value] of [
      [alpha, "ArrowRight", "gamma"],
      [gamma, "ArrowLeft", "alpha"],
      [alpha, "ArrowDown", "gamma"],
      [gamma, "ArrowUp", "alpha"],
      [gamma, "Home", "alpha"],
      [alpha, "End", "gamma"],
    ] as const) {
      const event = keyEvent(key);
      act(() => {
        button!.props.onKeyDown(event);
      });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(onChange).toHaveBeenLastCalledWith(value);
    }
  });

  it("summarizes queue overflow and exposes queue actions without rendering an empty bar", () => {
    expect(buildVisibleQueueItems([])).toEqual([]);
    const items = [
      queueItem("1", "send"),
      queueItem("2", "edit"),
      queueItem("3", "retry", true),
      queueItem("4", "send"),
    ];
    expect(buildVisibleQueueItems(items)).toMatchObject([
      { id: "1" },
      { id: "2" },
      { id: "__overflow__", label: "+2 more queued", paused: true, createdAt: items[2]!.createdAt },
    ]);

    const onResumeAll = vi.fn();
    const onRemove = vi.fn();
    expect(create(<ChatQueueBar items={[]} onResumeAll={onResumeAll} onRemove={onRemove} />).toJSON()).toBeNull();

    const renderer = create(
      <ChatQueueBar items={items} title="Queued messages" onResumeAll={onResumeAll} onRemove={onRemove} />,
    );
    const text = textOf(renderer.toJSON());
    expect(text).toMatch(/4\s+pending/);
    expect(text).toContain("Resume queued messages");
    expect(text).toContain("Edit queued");
    expect(text).toContain("Additional queued work stays staged");

    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Resume queued messages"))!
        .props.onClick();
      renderer.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Remove"))!
        .props.onClick();
    });
    expect(onResumeAll).toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith("1");
  });

  it("renders device approval prompt variants and actions", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onDismiss = vi.fn();
    const renderer = create(
      <DeviceAccessApprovalModal
        open
        busy={false}
        onApprove={onApprove}
        onReject={onReject}
        onDismiss={onDismiss}
        prompt={{
          approvalId: "approval-1",
          requestId: "request-1",
          deviceLabel: "Surface Laptop",
          deviceType: "desktop",
          platform: "Windows",
          requestedIp: "127.0.0.1",
          requestedOrigin: "companion",
        }}
      />,
    );
    const text = textOf(renderer.toJSON());
    expect(text).toContain("Surface Laptop is waiting");
    expect(text).toContain("Windows");
    expect(text).toContain("desktop");
    expect(text).toContain("127.0.0.1");
    expect(text).toContain("companion");

    act(() => {
      renderer.root.findAllByType("button")[0]!.props.onClick();
      renderer.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Reject device"))!
        .props.onClick();
      renderer.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Not now"))!
        .props.onClick();
    });
    expect(onApprove).toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();

    renderer.update(
      <DeviceAccessApprovalModal
        open
        busy
        onApprove={onApprove}
        onReject={onReject}
        onDismiss={onDismiss}
        prompt={undefined}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("A new device is requesting access.");
    expect(textOf(renderer.toJSON())).toContain("Working...");
  });

  it("renders remote approval actionable, busy, and expired-token branches", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onDismiss = vi.fn();
    const renderer = create(
      <RemoteApprovalActionModal
        open
        busy={false}
        onApprove={onApprove}
        onReject={onReject}
        onDismiss={onDismiss}
        prompt={{
          approvalId: "approval-2",
          actionType: "approval.resolve",
          tokenId: "token-1",
          token: "secret-token",
          kind: "shell.run",
          riskLevel: "high",
          status: "pending",
          preview: { command: "pnpm test" },
          expiresAt: "2999-01-01T00:00:00.000Z",
        }}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("shell.run is ready");
    expect(textOf(renderer.toJSON())).toContain("pnpm test");
    act(() => {
      renderer.root.findAllByType("button")[0]!.props.onClick();
      renderer.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Reject action"))!
        .props.onClick();
      renderer.root
        .findAllByType("button")
        .find((button) => textOf(button.props.children).includes("Dismiss"))!
        .props.onClick();
    });
    expect(onApprove).toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();

    renderer.update(
      <RemoteApprovalActionModal
        open
        busy={false}
        onApprove={onApprove}
        onReject={onReject}
        onDismiss={onDismiss}
        prompt={{
          approvalId: "approval-3",
          actionType: "approval.resolve",
          tokenId: "token-2",
          token: "secret-token",
          kind: "tool.call",
          riskLevel: "medium",
          status: "pending",
          expiresAt: "2000-01-01T00:00:00.000Z",
        }}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("single-use connector token expired");
    expect(textOf(renderer.toJSON())).toContain("This approval token expired");
    expect(renderer.root.findByType("section").props["data-confirm-disabled"]).toBe("true");

    renderer.update(
      <RemoteApprovalActionModal
        open
        busy
        onApprove={onApprove}
        onReject={onReject}
        onDismiss={onDismiss}
        prompt={undefined}
      />,
    );
    expect(textOf(renderer.toJSON())).toContain("A remote approval action is ready.");
    expect(textOf(renderer.toJSON())).toContain("Working...");
    expect(renderer.root.findByType("section").props["data-dismiss-disabled"]).toBe("true");
  });

  it("renders config fields and handles number, boolean, and circular-value input branches", () => {
    const onChange = vi.fn();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const renderer = create(
      <ConfigFormBuilder
        value={{ payload: circular, count: 2, enabled: false }}
        onChange={onChange}
        schema={
          {
            catalogId: "integration.loop24",
            title: "Loop 24 config",
            fields: [
              { key: "payload", label: "Payload", type: "text" },
              { key: "count", label: "Count", type: "number" },
              { key: "enabled", label: "Enabled", type: "boolean", advanced: true },
            ],
          } as any
        }
      />,
    );

    expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("");
    act(() => {
      renderer.root.findByType("button").props.onClick();
    });
    const inputs = renderer.root.findAllByType("input");
    act(() => {
      inputs[0]!.props.onChange({ target: { value: "plain" } });
      inputs[1]!.props.onChange({ target: { value: "not-a-number" } });
      inputs[1]!.props.onChange({ target: { value: "42" } });
      inputs[2]!.props.onChange({ target: { checked: true } });
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ payload: "plain" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ count: undefined }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ count: 42 }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("renders compact execution plan lineage and suppressed childRunId branches", () => {
    const basePlan = {
      planId: "plan-1",
      mode: "chat",
      objective: "Ship loop 24 tests",
      status: "running",
      summary: "Coverage run active",
      source: "operator",
      planningMode: "adaptive",
      advisoryOnly: true,
      steps: [
        {
          stepId: "step-1",
          objective: "Run coverage",
          status: "running",
          summary: "In progress",
          childRunId: "legacy-child-run",
        },
      ],
    } as any;

    expect(textOf(create(<ChatExecutionPlanSummary plan={basePlan} />).toJSON())).toContain(
      "deprecated childRunId legacy-child-run",
    );
    expect(
      textOf(
        create(
          <ChatExecutionPlanSummary
            plan={{
              ...basePlan,
              steps: [{ ...basePlan.steps[0], childRunId: undefined, status: "pending" }],
            }}
          />,
        ).toJSON(),
      ),
    ).toMatch(/Status:\s+pending/);
  });

  it("renders WorkbenchMonacoEditor fallback and runtime update paths", async () => {
    monacoMocks.shouldRenderMonacoRuntime.mockReset();
    monacoMocks.shouldRenderMonacoRuntime.mockReturnValue(false);
    monacoMocks.loadMonacoEditorRuntime.mockReset();
    monacoMocks.normalizeMonacoLoaderLanguage.mockClear();

    const onFallbackChange = vi.fn();
    const readOnlyFallback = create(<WorkbenchMonacoEditor value="read only source" readOnly />);
    expect(textOf(readOnlyFallback.toJSON())).toContain("read only source");
    const fallback = create(<WorkbenchMonacoEditor value="editable source" height={140} onChange={onFallbackChange} />);
    act(() => {
      fallback.root.findByType("textarea").props.onChange({ target: { value: "typed fallback" } });
    });
    expect(onFallbackChange).toHaveBeenCalledWith("typed fallback");
    expect(fallback.root.findByType("textarea").props.style).toEqual({ minHeight: "140px" });
    readOnlyFallback.unmount();
    fallback.unmount();

    monacoMocks.shouldRenderMonacoRuntime.mockReturnValue(true);
    let changeHandler: (() => void) | undefined;
    let modelValue = "source";
    const model = {
      dispose: vi.fn(),
      getValue: vi.fn(() => modelValue),
      setValue: vi.fn((next: string) => {
        modelValue = next;
        changeHandler?.();
      }),
    };
    const editor = {
      addCommand: vi.fn(),
      dispose: vi.fn(),
      getValue: vi.fn(() => "typed runtime"),
      onDidChangeModelContent: vi.fn((handler: () => void) => {
        changeHandler = handler;
      }),
      updateOptions: vi.fn(),
    };
    const monaco = {
      KeyMod: {
        CtrlCmd: 2048,
        Shift: 1024,
        Alt: 512,
        WinCtrl: 256,
      },
      KeyCode: {
        KeyS: 49,
        KeyP: 46,
      },
      editor: {
        create: vi.fn(() => editor),
        createModel: vi.fn(() => model),
        setModelLanguage: vi.fn(),
        setTheme: vi.fn(),
      },
    };
    const onRuntimeChange = vi.fn();
    monacoMocks.loadMonacoEditorRuntime.mockResolvedValue(monaco);

    let runtime = create(<WorkbenchMonacoEditor value="source" language="diff" onChange={onRuntimeChange} />, {
      createNodeMock: () => ({}),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(monacoMocks.loadMonacoEditorRuntime).toHaveBeenCalledWith("plaintext");
    expect(monaco.editor.setTheme).toHaveBeenCalledWith("vs-dark");
    act(() => {
      changeHandler?.();
    });
    expect(onRuntimeChange).toHaveBeenCalledWith("typed runtime");

    onRuntimeChange.mockClear();
    model.getValue.mockReturnValueOnce("old source");
    await act(async () => {
      runtime.update(
        <WorkbenchMonacoEditor value="updated source" language="diff" readOnly onChange={onRuntimeChange} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(model, "plaintext");
    expect(editor.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, renderLineHighlight: "none", wordWrap: "off" }),
    );
    expect(model.setValue).toHaveBeenCalledWith("updated source");
    expect(onRuntimeChange).not.toHaveBeenCalled();
    runtime.unmount();
    expect(editor.dispose).toHaveBeenCalled();
    expect(model.dispose).toHaveBeenCalled();

    let resolveRuntime!: (value: typeof monaco) => void;
    monacoMocks.loadMonacoEditorRuntime.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRuntime = resolve;
      }),
    );
    runtime = create(<WorkbenchMonacoEditor value="late source" />, { createNodeMock: () => ({}) });
    runtime.unmount();
    await act(async () => {
      resolveRuntime(monaco);
      await Promise.resolve();
    });
    expect(monaco.editor.create).toHaveBeenCalledTimes(1);
  });
});
