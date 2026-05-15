import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedPageChromeProvider } from "./EmbeddedPageChrome";
import { PageGuideCard } from "./PageGuideCard";
import { ShellDetailPanelProvider, type ShellDetailPanelEntry } from "./ShellDetailPanelContext";
import { UiPreferencesProvider } from "../state/ui-preferences";

function installWindowStorage(): void {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function reactNodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => reactNodeText(child)).join(" ");
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return reactNodeText(node.props.children);
  }
  return "";
}

function testRendererText(node: unknown): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => testRendererText(child)).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return testRendererText((node as { children?: unknown }).children);
  }
  return "";
}

describe("PageGuideCard", () => {
  it("renders compact guide copy without an inline details button", () => {
    const renderer = create(
      <UiPreferencesProvider>
        <ShellDetailPanelProvider isOpen={false} onOpenPanel={() => {}} onClosePanel={() => {}}>
          <PageGuideCard
            pageId="tasks"
            what="Track queue state and recovery."
            when="When you need to inspect delegated execution."
            actions={["Open a task", "Review the durable run", "Update the next checkpoint"]}
          />
        </ShellDetailPanelProvider>
      </UiPreferencesProvider>,
    );
    const text = testRendererText(renderer.toJSON());

    expect(text).toContain("Guide");
    expect(text).toContain("Track queue state and recovery.");
    expect(text).not.toContain("Open details");
    expect(text).not.toContain("Hide details");
  });

  it("registers detailed guidance with terms and advanced-mode inspector copy", async () => {
    installWindowStorage();
    window.localStorage.setItem("goatcitadel.ui.mode.v1", "advanced");
    const panelState: { activeEntry?: ShellDetailPanelEntry } = {};
    const rendererRef: { current?: ReactTestRenderer } = {};

    await act(async () => {
      rendererRef.current = create(
        <UiPreferencesProvider>
          <ShellDetailPanelProvider
            isOpen
            onOpenPanel={() => {}}
            onClosePanel={() => {}}
            onActiveEntryChange={(entry) => {
              panelState.activeEntry = entry ?? undefined;
            }}
          >
            <PageGuideCard
              pageId="runtime"
              what="Inspect runtime truth."
              when="When a gateway state looks stale."
              mostCommonAction="Open diagnostics."
              actions={["Check health", "Review event stream"]}
              terms={[{ term: "Lease", meaning: "The active realtime stream ownership marker." }]}
              compact={false}
            />
          </ShellDetailPanelProvider>
        </UiPreferencesProvider>,
      );
    });
    rendererRef.current?.unmount();

    const actionsText = reactNodeText(panelState.activeEntry?.actions);
    const bodyText = reactNodeText(panelState.activeEntry?.body);

    expect(panelState.activeEntry).toMatchObject({
      id: "page-guide:runtime",
      subtitle: "Inspect runtime truth.",
      priority: 20,
    });
    expect(actionsText).toContain("Advanced mode keeps the main workspace tight");
    expect(bodyText).toContain("Open diagnostics.");
    expect(bodyText).toContain("Lease");
    expect(bodyText).toContain("The active realtime stream ownership marker.");
  });

  it("suppresses inline guide chrome when rendered inside an embedded page", () => {
    const renderer = create(
      <UiPreferencesProvider>
        <ShellDetailPanelProvider isOpen={false} onOpenPanel={() => {}} onClosePanel={() => {}}>
          <EmbeddedPageChromeProvider>
            <PageGuideCard
              what="Embedded route"
              when="When the shell already owns the surrounding chrome."
              actions={["Use parent controls"]}
            />
          </EmbeddedPageChromeProvider>
        </ShellDetailPanelProvider>
      </UiPreferencesProvider>,
    );

    expect(renderer.toJSON()).toBeNull();
  });
});
