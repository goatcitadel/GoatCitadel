import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ThreadedContextDrawer } from "./ThreadedContextDrawer";

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}

describe("ThreadedContextDrawer", () => {
  it("lets users turn planning mode off from the context panel", async () => {
    const onPrefPatch = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="cowork"
          props={
            {
              selectedProviderId: "openai",
              selectedModel: "gpt-5.4-mini",
              streamEnabled: true,
              planningMode: "advisory",
              routePreflight: {
                selectionSource: "session_prefs",
              },
              onStreamEnabledChange: vi.fn(),
              onPrefPatch,
              activeGeneratedArtifact: null,
              onCloseGeneratedArtifact: vi.fn(),
              selectedTurn: null,
            } as any
          }
        />,
      );
    });

    const button = findButton(renderer!.root, "Turn off planning");
    await act(async () => {
      button.props.onClick();
    });

    expect(onPrefPatch).toHaveBeenCalledWith({ planningMode: "off" });
  });

  it("shows the export affordance on the trace tab when a run export handler exists", async () => {
    const onExportRunBundle = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="cowork"
          props={
            {
              selectedProviderId: "openai",
              selectedModel: "gpt-5.4-mini",
              streamEnabled: true,
              planningMode: "guided",
              routePreflight: {
                selectionSource: "session_prefs",
              },
              onStreamEnabledChange: vi.fn(),
              onPrefPatch: vi.fn(),
              activeGeneratedArtifact: null,
              onCloseGeneratedArtifact: vi.fn(),
              selectedTurn: {
                turnId: "turn-1",
                trace: {
                  status: "completed",
                  failure: null,
                  routing: {
                    fallbackUsed: false,
                    primaryProviderId: "openai",
                    primaryModel: "gpt-5.4-mini",
                    effectiveProviderId: "openai",
                    effectiveModel: "gpt-5.4-mini",
                    fallbackReason: null,
                  },
                },
              },
              onExportRunBundle,
            } as any
          }
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Trace").props.onClick();
    });

    const exportButton = findButton(renderer!.root, "Export run bundle");
    expect(exportButton).toBeTruthy();

    await act(async () => {
      exportButton.props.onClick();
    });

    expect(onExportRunBundle).toHaveBeenCalledTimes(1);
  });
});
