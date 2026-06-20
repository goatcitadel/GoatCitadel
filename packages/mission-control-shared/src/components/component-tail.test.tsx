import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigFormBuilder } from "./ConfigFormBuilder";
import { ConfigureHubLayout } from "./ConfigureHubLayout";
import { EmbeddedPageChromeProvider } from "./EmbeddedPageChrome";
import { buildRealtimeEventSummary, EventCard } from "./EventCard";
import { PageGuideCard } from "./PageGuideCard";
import { PageTabs } from "./PageTabs";
import { Panel } from "./Panel";
import { SelectOrCustom } from "./SelectOrCustom";
import { ShellDetailPanelProvider, useShellDetailPanel, type ShellDetailPanelEntry } from "./ShellDetailPanelContext";
import { cycleShellNavMode, ShellNavRail } from "./ShellNavRail";
import { SmartPathInput } from "./SmartPathInput";
import { ChatQueueBar, buildVisibleQueueItems } from "./chat/ChatQueueBar";
import { SurfaceReconnectBanner } from "./chat/SurfaceReconnectBanner";
import { UiPreferencesProvider } from "../state/ui-preferences";

const apiMocks = vi.hoisted(() => ({
  fetchPathSuggestions: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchPathSuggestions: apiMocks.fetchPathSuggestions,
}));

function findText(node: { children?: unknown[] }, text: string): boolean {
  return JSON.stringify(node).includes(text);
}

describe("shared component tail coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => globalThis.clearTimeout(id));
    apiMocks.fetchPathSuggestions.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds configurable integration forms and emits typed field changes", () => {
    const onChange = vi.fn();
    const renderer = create(<ConfigFormBuilder value={{ enabled: false }} onChange={onChange} />);
    expect(findText(renderer.toJSON() as never, "No guided schema")).toBe(true);

    const schema = {
      title: "Slack",
      description: "Connect Slack",
      fields: [
        { key: "enabled", label: "Enabled", type: "boolean", required: true },
        {
          key: "channel",
          label: "Channel",
          type: "select",
          options: [
            { value: "ops", label: "Ops" },
            { value: "ops", label: "Duplicate" },
            { value: "dev", label: "Dev" },
          ],
          placeholder: "Choose channel",
        },
        { key: "payload", label: "Payload", type: "json", defaultValue: { ok: true }, description: "JSON body" },
        { key: "count", label: "Count", type: "number", advanced: true, secretRef: true },
        { key: "token", label: "Token", type: "password", advanced: true },
        { key: "notes", label: "Notes", type: "textarea" },
      ],
    };
    renderer.update(
      <ConfigFormBuilder schema={schema as never} value={{ enabled: false, channel: "custom" }} onChange={onChange} />,
    );

    expect(findText(renderer.toJSON() as never, "Connect Slack")).toBe(true);
    act(() => {
      renderer.root.findByProps({ id: "integration-field-enabled" }).props.onChange({ target: { checked: true } });
      renderer.root.findAllByType("textarea")[0]!.props.onChange({ target: { value: '{"ok":false}' } });
      renderer.root.findAllByType("textarea")[1]!.props.onChange({ target: { value: "notes" } });
      renderer.root.findAllByType("button")[0]!.props.onClick();
    });
    expect(onChange).toHaveBeenCalledWith({ enabled: true, channel: "custom" });
    expect(onChange).toHaveBeenCalledWith({ enabled: false, channel: "custom", payload: '{"ok":false}' });
    expect(onChange).toHaveBeenCalledWith({ enabled: false, channel: "custom", notes: "notes" });

    const numberInput = renderer.root.findByProps({ id: "integration-field-count" });
    act(() => {
      numberInput.props.onChange({ target: { value: "5" } });
      numberInput.props.onChange({ target: { value: "not-a-number" } });
    });
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(onChange).toHaveBeenCalledWith({ enabled: false, channel: "custom", count: 5 });
  });

  it("switches select-or-custom modes and auto-selects suggested values", () => {
    const onChange = vi.fn();
    const onCustomModeChange = vi.fn();
    const renderer = create(
      <SelectOrCustom
        value="unknown"
        onChange={onChange}
        onCustomModeChange={onCustomModeChange}
        autoSelectFirstOption
        customLabel="Custom value"
        inputType="password"
        options={[
          { value: "", label: "Blank" },
          { value: "alpha", label: "Alpha" },
          { value: "alpha", label: "Duplicate" },
          { value: "beta", label: "Beta" },
        ]}
      />,
    );

    expect(onChange).toHaveBeenCalledWith("alpha");
    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons[1]!.props.onClick();
    });
    expect(onCustomModeChange).toHaveBeenCalledWith(true);
    expect(renderer.root.findByType("input").props.type).toBe("password");
    act(() => {
      renderer.root.findByType("input").props.onChange({ target: { value: "manual" } });
      buttons[0]!.props.onClick();
    });
    expect(onChange).toHaveBeenCalledWith("manual");
    expect(onCustomModeChange).toHaveBeenCalledWith(false);

    renderer.update(<SelectOrCustom value="alpha" onChange={onChange} options={[]} allowCustom={false} />);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("renders nav rails, page tabs, panels, and configure layouts", () => {
    expect(cycleShellNavMode("expanded")).toBe("compact");
    expect(cycleShellNavMode("compact")).toBe("icon");
    expect(cycleShellNavMode("icon")).toBe("expanded");

    const navCallbacks = {
      onSelectSpace: vi.fn(),
      onSelectVisiblePage: vi.fn(),
      onCycleNavMode: vi.fn(),
    };
    const nav = create(
      <ShellNavRail
        route={{ space: "operate", page: "surface", surface: "chat" }}
        visiblePage="approvals"
        navMode="expanded"
        approvalsCount={4}
        {...navCallbacks}
      />,
    );
    const navButtons = nav.root.findAllByType("button");
    act(() => {
      navButtons[0]!.props.onClick();
      navButtons.find((button) => button.props["aria-label"] === "Observe")!.props.onClick();
      navButtons.find((button) => button.props["aria-label"] === "Approvals")!.props.onClick();
    });
    expect(navCallbacks.onCycleNavMode).toHaveBeenCalled();
    expect(navCallbacks.onSelectSpace).toHaveBeenCalledWith("observe");
    expect(navCallbacks.onSelectVisiblePage).toHaveBeenCalledWith("approvals");
    expect(findText(nav.toJSON() as never, "4 pending")).toBe(true);

    const onSelectTab = vi.fn();
    const tabItems = [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ];
    const tabs = create(<PageTabs items={tabItems} activeId="one" tier="page" onSelect={onSelectTab} />);
    act(() => {
      tabs.root.findAllByType("button")[1]!.props.onClick();
    });
    expect(onSelectTab).toHaveBeenCalledWith("two");

    const panel = create(
      <Panel
        title="Panel"
        subtitle="Details"
        actions={<button type="button">Action</button>}
        collapsible
        defaultExpanded={false}
      >
        Body
      </Panel>,
    );
    expect(findText(panel.toJSON() as never, "Panel")).toBe(true);
    act(() => {
      panel.root.findByProps({ className: "panel-summary mc-panel-summary" }).props.onClick({
        defaultPrevented: false,
        preventDefault: vi.fn(),
      });
    });

    const configure = create(
      <ConfigureHubLayout
        title="Settings"
        subtitle="Runtime posture"
        summaries={[
          { label: "Ready", value: "2", note: "ok", tone: "success" },
          { label: "Hidden", value: null },
        ]}
        showSummaryNotes
        guideTitle="Guide"
        guideBody={<p>Guide body</p>}
        tabItems={tabItems}
        activeTab="one"
        onTabChange={onSelectTab}
      >
        <p>Content</p>
      </ConfigureHubLayout>,
    );
    expect(findText(configure.toJSON() as never, "Settings")).toBe(true);
    configure.update(
      <ConfigureHubLayout
        title="Settings"
        subtitle="Runtime posture"
        summaries={[{ label: "Ready", value: "2", tone: "warning" }]}
        summaryMode="posture"
      >
        <p>Content</p>
      </ConfigureHubLayout>,
    );
    expect(findText(configure.toJSON() as never, "Ready")).toBe(true);
  });

  it("switches page tabs between compact select and full tablist layouts", () => {
    let mediaListener: ((event?: { matches: boolean }) => void) | undefined;
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn((_event: string, listener: (event?: { matches: boolean }) => void) => {
          mediaListener = listener;
        }),
        removeEventListener: vi.fn(),
      })),
    });
    const onSelect = vi.fn();
    const tabItems = [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ];
    const renderer = create(<PageTabs items={tabItems} activeId="one" tier="section" vertical onSelect={onSelect} />);
    expect(JSON.stringify(renderer.toJSON())).toContain("page-tabs-compact");
    act(() => {
      renderer.root.findByType("select").props.onChange({ target: { value: "two" } });
    });
    expect(onSelect).toHaveBeenCalledWith("two");

    act(() => {
      mediaListener?.({ matches: false });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("page-tabs-vertical");
    expect(JSON.stringify(renderer.toJSON())).toContain("Section navigation");
    renderer.unmount();

    Reflect.deleteProperty(globalThis, "window");
    const serverTabs = create(<PageTabs items={tabItems} activeId="one" tier="space" onSelect={onSelect} />);
    expect(JSON.stringify(serverTabs.toJSON())).toContain("Space navigation");
  });

  it("uses default page-tab aria labels per tier", () => {
    const tabItems = [{ id: "one", label: "One" }];
    expect(
      JSON.stringify(
        create(<PageTabs items={tabItems} activeId="one" tier="page" onSelect={() => undefined} />).toJSON(),
      ),
    ).toContain("Page navigation");
    expect(
      JSON.stringify(
        create(
          <PageTabs
            items={tabItems}
            activeId="one"
            tier="section"
            ariaLabel="Custom section tabs"
            onSelect={() => undefined}
          />,
        ).toJSON(),
      ),
    ).toContain("Custom section tabs");
  });

  it("registers shell detail panel entries and page guide details", () => {
    const activeEntries: Array<ShellDetailPanelEntry | null> = [];
    const onOpen = vi.fn();
    const onClose = vi.fn();

    function EntryControls() {
      const { activeEntry, closePanel, openPanel, registerEntry } = useShellDetailPanel();
      React.useEffect(
        () =>
          registerEntry({
            id: "low",
            title: "Low",
            body: "Low body",
            priority: 1,
          }),
        [registerEntry],
      );
      React.useEffect(
        () =>
          registerEntry({
            id: "high",
            title: "High",
            body: "High body",
            priority: 30,
          }),
        [registerEntry],
      );
      return (
        <>
          <button type="button" onClick={openPanel}>
            Open
          </button>
          <button type="button" onClick={closePanel}>
            Close
          </button>
          <span>{activeEntry?.title ?? "none"}</span>
        </>
      );
    }

    const renderer = create(
      <ShellDetailPanelProvider
        isOpen={false}
        onOpenPanel={onOpen}
        onClosePanel={onClose}
        onActiveEntryChange={(entry) => activeEntries.push(entry)}
      >
        <EntryControls />
        <PageGuideCard
          pageId="guide"
          what="Use this page"
          when="When testing"
          mostCommonAction="Review"
          actions={["Open", "Close"]}
          terms={[{ term: "Run", meaning: "A task execution" }]}
          compact={false}
        />
      </ShellDetailPanelProvider>,
    );

    expect(activeEntries.at(-1)?.title).toBe("High");
    const buttons = renderer.root.findAllByType("button");
    act(() => {
      buttons.find((button) => button.children.join("") === "Open")!.props.onClick();
      buttons.find((button) => button.children.join("") === "Close")!.props.onClick();
    });
    expect(onOpen).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(findText(renderer.toJSON() as never, "Use this page")).toBe(true);

    renderer.update(
      <ShellDetailPanelProvider
        isOpen={false}
        onOpenPanel={onOpen}
        onClosePanel={onClose}
        onActiveEntryChange={(entry) => activeEntries.push(entry)}
      >
        <EntryControls />
        <PageGuideCard what="Compact page" when="When compact" actions={["Inspect"]} compact={false} />
      </ShellDetailPanelProvider>,
    );
    expect(findText(renderer.toJSON() as never, "Compact page")).toBe(true);
    expect(findText(renderer.toJSON() as never, "Most common action")).toBe(false);
  });

  it("registers page guides while respecting embedded and advanced chrome modes", async () => {
    const activeEntries: Array<ShellDetailPanelEntry | null> = [];
    const localStorageMock = {
      getItem: vi.fn((key: string) => (key === "goatcitadel.ui.mode.v1" ? "advanced" : null)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", {
      localStorage: localStorageMock,
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <UiPreferencesProvider>
          <ShellDetailPanelProvider
            isOpen={false}
            onOpenPanel={() => undefined}
            onClosePanel={() => undefined}
            onActiveEntryChange={(entry) => activeEntries.push(entry)}
          >
            <EmbeddedPageChromeProvider>
              <PageGuideCard what="Embedded guide" when="When embedded" actions={["Confirm"]} />
            </EmbeddedPageChromeProvider>
            <PageGuideCard
              pageId="advanced"
              what="Advanced guide"
              when="When advanced"
              mostCommonAction="Audit"
              actions={["Audit"]}
              compact={false}
            />
          </ShellDetailPanelProvider>
        </UiPreferencesProvider>,
      );
    });

    expect(findText(renderer!.toJSON() as never, "Embedded guide")).toBe(false);
    expect(findText(renderer!.toJSON() as never, "Advanced guide")).toBe(true);
    expect(findText(renderer!.toJSON() as never, "Guidance stays in the detail panel")).toBe(false);
    expect(activeEntries.at(-1)?.subtitle).toBe("Advanced guide");
    expect(JSON.stringify(activeEntries.at(-1)?.actions)).toContain(
      "Advanced mode keeps the main workspace tight and shifts rationale into the inspector.",
    );
  });

  it("summarizes events, queues, reconnect banners, and smart path input state", async () => {
    const event = {
      eventId: "event-1",
      sequence: 7,
      source: "system",
      eventType: "approval_required",
      eventClass: "approval",
      eventAuthority: "durable",
      timestamp: "2026-01-01T12:00:00.000Z",
      payload: { message: "Needs review" },
      links: { approvalId: "approval-1", runId: "run-1" },
      traceId: "trace-1",
      correlationId: "corr-1",
    };
    expect(buildRealtimeEventSummary(event as never)).toBe("System reported approval required: Needs review.");
    expect(
      buildRealtimeEventSummary({
        ...event,
        source: "chat",
        payload: {},
        links: { sessionId: "session-abcdef" },
      } as never),
    ).toBe("Chat reported approval required: session abcdef.");
    expect(
      buildRealtimeEventSummary({ ...event, source: "tasks", payload: {}, links: { taskId: "task-123456" } } as never),
    ).toBe("Tasks reported approval required: task 123456.");
    expect(
      buildRealtimeEventSummary({ ...event, source: "ops", payload: { title: "Title detail" }, links: {} } as never),
    ).toBe("Ops reported approval required: Title detail.");
    expect(
      buildRealtimeEventSummary({ ...event, source: "ops", payload: { name: "Name detail" }, links: {} } as never),
    ).toBe("Ops reported approval required: Name detail.");
    expect(
      buildRealtimeEventSummary({ ...event, source: "ops", payload: { status: "ready" }, links: {} } as never),
    ).toBe("Ops reported approval required: ready.");
    expect(
      buildRealtimeEventSummary({ ...event, source: "ops", payload: { action: "retry" }, links: {} } as never),
    ).toBe("Ops reported approval required: retry.");
    expect(
      buildRealtimeEventSummary({ ...event, source: "ops", payload: { kind: "heartbeat" }, links: {} } as never),
    ).toBe("Ops reported approval required: heartbeat.");
    expect(buildRealtimeEventSummary({ ...event, source: "ops", payload: {}, links: {} } as never)).toBe(
      "Ops reported approval required.",
    );
    const onTrace = vi.fn();
    const eventCard = create(
      <EventCard
        event={{ ...event, links: { ...event.links, proactiveRunId: "proactive-1", taskId: "task-1" } } as never}
        summary="Summary"
        tracePreview={["Step one"]}
        onLoadTracePreview={onTrace}
      />,
    );
    act(() => {
      eventCard.root.findByProps({ className: "gc-button" }).props.onClick();
    });
    expect(onTrace).toHaveBeenCalled();
    expect(findText(eventCard.toJSON() as never, "proactive-1")).toBe(true);
    expect(findText(eventCard.toJSON() as never, "task-1")).toBe(true);
    eventCard.update(<EventCard event={event as never} summary="Summary" onLoadTracePreview={onTrace} />);
    expect(findText(eventCard.toJSON() as never, "Load trace detail")).toBe(true);
    eventCard.update(
      <EventCard
        event={
          { ...event, traceId: undefined, correlationId: undefined, links: { approvalId: "approval-only" } } as never
        }
        summary="Summary"
      />,
    );
    expect(findText(eventCard.toJSON() as never, "approval-only")).toBe(true);
    eventCard.update(
      <EventCard
        event={
          {
            ...event,
            traceId: undefined,
            correlationId: undefined,
            links: { proactiveRunId: "proactive-only" },
          } as never
        }
        summary="Summary"
      />,
    );
    expect(findText(eventCard.toJSON() as never, "proactive-only")).toBe(true);
    eventCard.update(
      <EventCard
        event={{ ...event, traceId: undefined, correlationId: undefined, links: { taskId: "task-only" } } as never}
        summary="Summary"
      />,
    );
    expect(findText(eventCard.toJSON() as never, "task-only")).toBe(true);
    eventCard.update(
      <EventCard
        event={{ ...event, traceId: undefined, correlationId: undefined, links: { runId: "run-only" } } as never}
        summary="Summary"
      />,
    );
    expect(findText(eventCard.toJSON() as never, "run-only")).toBe(true);
    eventCard.update(
      <EventCard
        event={{ ...event, traceId: undefined, correlationId: undefined, links: undefined } as never}
        summary="Summary"
        tracePreview={[]}
        onLoadTracePreview={onTrace}
      />,
    );
    expect(findText(eventCard.toJSON() as never, "event-card-links")).toBe(false);
    expect(findText(eventCard.toJSON() as never, "Trace detail")).toBe(false);

    const queueItems = [
      { id: "1", action: "send", label: "First", createdAt: "2026-01-01T12:00:00.000Z" },
      { id: "2", action: "edit", label: "Second", createdAt: "2026-01-01T12:01:00.000Z", paused: true },
      { id: "3", action: "retry", label: "Third", createdAt: "2026-01-01T12:02:00.000Z" },
      { id: "4", action: "send", label: "Fourth", createdAt: "2026-01-01T12:03:00.000Z", paused: true },
    ] as const;
    expect(buildVisibleQueueItems(queueItems as never).at(-1)).toMatchObject({ id: "__overflow__", paused: true });
    const onResumeAll = vi.fn();
    const onRemove = vi.fn();
    const queue = create(
      <ChatQueueBar
        items={queueItems as never}
        title="Queued messages"
        onResumeAll={onResumeAll}
        onRemove={onRemove}
      />,
    );
    act(() => {
      queue.root.findAllByType("button")[0]!.props.onClick();
      queue.root.findAllByType("button")[1]!.props.onClick();
    });
    expect(onResumeAll).toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith("1");
    expect(
      create(<ChatQueueBar items={[]} onResumeAll={() => undefined} onRemove={() => undefined} />).toJSON(),
    ).toBeNull();

    const onRefresh = vi.fn();
    const banner = create(
      <SurfaceReconnectBanner status={{ state: "connecting", reconnectAttempts: 0 }} onRefresh={onRefresh} />,
    );
    expect(findText(banner.toJSON() as never, "Opening the live event stream")).toBe(true);
    banner.update(
      <SurfaceReconnectBanner status={{ state: "retrying", reconnectAttempts: 3 }} onRefresh={onRefresh} />,
    );
    expect(findText(banner.toJSON() as never, "Retry 3 is in progress")).toBe(true);
    banner.update(
      <SurfaceReconnectBanner
        mode="cowork"
        status={{ state: "connecting", reconnectAttempts: 0 }}
        onRefresh={onRefresh}
      />,
    );
    expect(findText(banner.toJSON() as never, "Run events reconnecting")).toBe(true);
    banner.update(<SurfaceReconnectBanner status={{ state: "error", reconnectAttempts: 2 }} onRefresh={onRefresh} />);
    expect(findText(banner.toJSON() as never, "Live updates interrupted")).toBe(true);
    banner.update(
      <SurfaceReconnectBanner mode="cowork" status={{ state: "error", reconnectAttempts: 2 }} onRefresh={onRefresh} />,
    );
    act(() => {
      banner.root.findByType("button").props.onClick();
    });
    expect(onRefresh).toHaveBeenCalled();
    banner.update(
      <SurfaceReconnectBanner mode="cowork" status={{ state: "open", reconnectAttempts: 0 }} onRefresh={onRefresh} />,
    );
    expect(findText(banner.toJSON() as never, "Run events restored")).toBe(true);
    // D-Low: the 1s ticker must tear itself down once the 4s restored-banner
    // window elapses, not keep firing for the surface lifetime.
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(banner.toJSON()).toBeNull();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockClear();
    // Further ticks do nothing: the interval is gone, so no pending timers fire.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
    banner.update(<SurfaceReconnectBanner status={{ state: "error", reconnectAttempts: 1 }} onRefresh={onRefresh} />);
    banner.update(<SurfaceReconnectBanner status={{ state: "open", reconnectAttempts: 0 }} onRefresh={onRefresh} />);
    expect(findText(banner.toJSON() as never, "Live updates restored")).toBe(true);

    const onPathChange = vi.fn();
    apiMocks.fetchPathSuggestions.mockResolvedValueOnce({ items: ["docs/a.md"] });
    const pathInput = create(<SmartPathInput label="Path" value="" onChange={onPathChange} helpText="Pick a path" />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      pathInput.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Browse")!
        .props.onClick();
    });
    expect(onPathChange).toHaveBeenCalledWith("docs/a.md");
    pathInput.update(<SmartPathInput label="Path" value="manual.md" onChange={onPathChange} />);
    expect(findText(pathInput.toJSON() as never, "Path edited after auto-fill")).toBe(true);

    apiMocks.fetchPathSuggestions.mockRejectedValueOnce(new Error("offline"));
    const failingPathInput = create(<SmartPathInput label="Path" value="" onChange={onPathChange} root="missing" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      failingPathInput.root.findAllByType("button").find((button) => button.children.join("") === "Browse")!.props
        .disabled,
    ).toBe(true);
  });
});
