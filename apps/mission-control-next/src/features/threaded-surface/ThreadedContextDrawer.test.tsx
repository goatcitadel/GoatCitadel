import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatTraceCard } from "@goatcitadel/mission-control-shared/components/ChatTraceCard";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ThreadedContextDrawer } from "./ThreadedContextDrawer";

function traceFixture(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    failure: null,
    mode: "chat",
    webMode: "off",
    memoryMode: "workspace",
    thinkingLevel: "standard",
    startedAt: "2026-05-01T00:00:00.000Z",
    toolRuns: [],
    citations: [],
    routing: {
      fallbackUsed: false,
      primaryProviderId: "openai",
      primaryModel: "gpt-5.4-mini",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4-mini",
      fallbackReason: null,
    },
    ...overrides,
  };
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findButtons(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === "button" && collectText(node).includes(label));
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

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    selectedProviderId: "openai",
    selectedModel: "gpt-5.4-mini",
    streamEnabled: true,
    visualStreamMode: "smooth",
    planningMode: "advisory",
    routePreflight: { selectionSource: "session_prefs" },
    onStreamEnabledChange: vi.fn(),
    onVisualStreamModeChange: vi.fn(),
    onPrefPatch: vi.fn(),
    activeGeneratedArtifact: null,
    onCloseGeneratedArtifact: vi.fn(),
    selectedTurn: null,
    capabilitySuggestions: [],
    specialistSuggestions: [],
    learnedMemory: [],
    delegationSuggestion: null,
    onCapabilitySuggestionAction: vi.fn(),
    onAcceptDelegation: vi.fn(),
    onCreateSpecialistDraft: vi.fn(),
    onActivateCatalogSpecialist: vi.fn(),
    onUpdateMemoryStatus: vi.fn(),
    onRebuildLearnedMemory: vi.fn(),
    renameTitle: "",
    folderName: "",
    tagsValue: "",
    selectedSessionProjectValue: "",
    projectOptions: [],
    selectedSession: {
      sessionId: "session-1",
      title: "Session title",
      pinned: false,
      lifecycleStatus: "active",
    },
    onRenameTitleChange: vi.fn(),
    onFolderNameChange: vi.fn(),
    onTagsValueChange: vi.fn(),
    onAssignProject: vi.fn(),
    onRenameSession: vi.fn(),
    onSaveOrganization: vi.fn(),
    onTogglePinSession: vi.fn(),
    onToggleArchiveSession: vi.fn(),
    onExportSnapshot: vi.fn(),
    onDeleteSession: vi.fn(),
    integrationConnectionId: "",
    integrationTarget: "",
    onIntegrationConnectionIdChange: vi.fn(),
    onIntegrationTargetChange: vi.fn(),
    onSaveExternalBinding: vi.fn(),
    ...overrides,
  } as any;
}

describe("ThreadedContextDrawer", () => {
  it("copies the selected Chat trust report from Working Context", async () => {
    const onCopyTrustReport = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="chat"
          props={baseProps({
            selectedSessionId: "session-1",
            selectedTurn: {
              turnId: "turn-1",
              trace: traceFixture(),
            },
          })}
          onCopyTrustReport={onCopyTrustReport}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Copy trust report").props.onClick();
    });

    expect(onCopyTrustReport).toHaveBeenCalledWith("session-1", "turn-1");
    expect(collectText(renderer!.root)).toContain("openai / gpt-5.4-mini");
    expect(collectText(renderer!.root)).toContain("Memory");
    expect(collectText(renderer!.root)).toContain("Runtime controls");
  });

  it("summarizes the selected session project instead of the rail filter project", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="code"
          props={baseProps({
            selectedProject: { projectId: "project-rail", name: "Rail Filter Project" },
            projectOptions: [
              { value: "project-session", label: "Session Bound Project" },
              { value: "project-rail", label: "Rail Filter Project" },
            ],
            selectedSession: {
              sessionId: "session-1",
              title: "Session title",
              pinned: false,
              lifecycleStatus: "active",
              projectId: "project-session",
              projectName: "Stale Session Project Name",
            },
          })}
        />,
      );
    });

    const text = collectText(renderer!.root);
    expect(text).toContain("Session Bound Project");
    expect(text).not.toContain("Rail Filter Project");
  });

  it("lets users toggle planning mode from the context panel", async () => {
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

    const button = findButton(renderer!.root, "Turn planning off");
    await act(async () => {
      button.props.onClick();
    });

    expect(onPrefPatch).toHaveBeenCalledWith({ planningMode: "off" });

    await act(async () => {
      renderer!.update(
        <ThreadedContextDrawer
          surface="cowork"
          props={
            {
              selectedProviderId: "openai",
              selectedModel: "gpt-5.4-mini",
              streamEnabled: true,
              planningMode: "off",
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

    const turnOnButton = findButton(renderer!.root, "Turn planning on");
    await act(async () => {
      turnOnButton.props.onClick();
    });

    expect(onPrefPatch).toHaveBeenCalledWith({ planningMode: "advisory" });
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
              planningMode: "off",
              routePreflight: {
                selectionSource: "session_prefs",
              },
              onStreamEnabledChange: vi.fn(),
              onPrefPatch: vi.fn(),
              activeGeneratedArtifact: null,
              onCloseGeneratedArtifact: vi.fn(),
              selectedSession: {
                sessionId: "session-1",
                title: "Session title",
                pinned: false,
                lifecycleStatus: "active",
              },
              selectedTurn: {
                turnId: "turn-1",
                trace: traceFixture(),
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

  it("renders context route controls, route warnings, and generated artifact actions", async () => {
    const onStreamEnabledChange = vi.fn();
    const onPrefPatch = vi.fn();
    const onCloseGeneratedArtifact = vi.fn();
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="code"
          props={baseProps({
            streamEnabled: false,
            planningMode: "off",
            routePreflight: {
              selectionSource: null,
              degradedReason: "Provider is degraded.",
              blockedReason: "Route requires credentials.",
            },
            onStreamEnabledChange,
            onPrefPatch,
            activeGeneratedArtifact: {
              artifactId: "artifact-1",
              title: "Generated report",
              kind: "markdown",
              content: "# Report",
              version: 1,
              sourceSurface: "code",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
            onCloseGeneratedArtifact,
          })}
        />,
      );
    });

    expect(collectText(renderer!.root)).toContain("Route requires credentials.");
    await act(async () => {
      findButton(renderer!.root, "Enable streaming").props.onClick();
      findButton(renderer!.root, "Reapply route").props.onClick();
      findButton(renderer!.root, "Close").props.onClick();
    });

    expect(onStreamEnabledChange).toHaveBeenCalledWith(true);
    expect(onPrefPatch).toHaveBeenCalledWith({ providerId: "openai", model: "gpt-5.4-mini" });
    expect(onCloseGeneratedArtifact).toHaveBeenCalledTimes(1);
  });

  it("renders full gateway, policy, and security wording in wrapping context copy", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="code"
          permissionSummary="Policy: Trusted Local Power · skips normal prompts · override until 20:30 UTC"
          permissionOverrideActive
          props={baseProps({
            trust: {
              workspaceLabel: "Workspace One",
              gatewayTone: "success",
              gatewayLabel: "Gateway ready",
              gatewayDetail: "Gateway ready. Daemon health is serving.",
              approvalsSummary: "Decisions clear",
              runStateSummary: "Run: waiting for approval",
              activeModeLabel: "Code",
              providerModelSummary: "OpenAI / gpt-5.4-mini",
              runtimeSummary: "Provider reachable",
              requestedProviderModelSummary: "OpenAI / gpt-5.4-mini",
              effectiveProviderModelSummary: "OpenAI / gpt-5.4-mini",
              selectionSourceSummary: "Selection: session",
              fallbackSummary: "Fallback off",
            },
          })}
        />,
      );
    });

    const text = collectText(renderer!.root);
    expect(text).toContain("Policy and security");
    expect(text).toContain("Gateway ready. Daemon health is serving.");
    expect(text).toContain("Policy: Trusted Local Power · skips normal prompts · override until 20:30 UTC");
    expect(text).toContain("Deny-wins policy, approval gates, auth boundaries, path jails");
    expect(text).toContain("does not claim hostile-code sandboxing");
    expect(text).toContain("requested OpenAI / gpt-5.4-mini; effective OpenAI / gpt-5.4-mini");
  });

  it("renders failed fallback trace state and the no-selection trace placeholder", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="chat"
          props={baseProps({
            selectedProviderId: null,
            selectedModel: null,
            selectedSession: {
              sessionId: "session-1",
              workspaceId: "workspace-7",
              title: "Session title",
              pinned: false,
              lifecycleStatus: "active",
            },
            selectedTurn: {
              turnId: "turn-failed",
              trace: traceFixture({
                status: "failed",
                failure: { message: "Tool execution failed." },
                routing: {
                  fallbackUsed: true,
                  primaryProviderId: null,
                  primaryModel: null,
                  effectiveProviderId: "anthropic",
                  effectiveModel: "claude",
                  fallbackReason: "Primary timed out.",
                },
              }),
            },
          })}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Trace").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("Fallback used");
    expect(collectText(renderer!.root)).toContain("Tool execution failed.");
    // The rich trace card replaces the old thin routing section and receives
    // the session's workspace so the artifact inspector can fetch raw output.
    const traceCard = renderer!.root.findByType(ChatTraceCard);
    expect(traceCard.props.workspaceId).toBe("workspace-7");
    expect(collectText(renderer!.root)).toContain("Requested: not recorded");
    expect(collectText(renderer!.root)).toContain("Effective: anthropic · claude");
    expect(collectText(renderer!.root)).toMatch(/Fallback reason:\s+Primary timed out\./);

    await act(async () => {
      renderer!.update(<ThreadedContextDrawer surface="chat" props={baseProps({ selectedProviderId: null })} />);
    });
    expect(collectText(renderer!.root)).toContain("No turn is selected yet.");
  });

  it("renders optional context sections without close handlers or assist suggestions", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="chat"
          props={baseProps({
            activeGeneratedArtifact: {
              artifactId: "artifact-optional",
              title: "Readonly artifact",
              kind: "markdown",
              content: "Readonly content",
              version: 1,
              sourceSurface: "chat",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
            onCloseGeneratedArtifact: undefined,
            selectedTurn: {
              turnId: "turn-running",
              trace: traceFixture({
                status: "running",
                routing: {
                  fallbackUsed: false,
                  primaryProviderId: "openai",
                  primaryModel: "gpt",
                  effectiveProviderId: "openai",
                  effectiveModel: "gpt",
                  fallbackReason: null,
                },
              }),
            },
          })}
        />,
      );
    });

    expect(collectText(renderer!.root)).toContain("Readonly artifact");
    expect(findButtons(renderer!.root, "Close")).toHaveLength(0);

    await act(async () => {
      findButton(renderer!.root, "Trace").props.onClick();
    });
    expect(collectText(renderer!.root)).toContain("running");

    await act(async () => {
      findButton(renderer!.root, "Assist").props.onClick();
    });
    expect(collectText(renderer!.root)).not.toContain("Review suggestion");
    expect(collectText(renderer!.root)).not.toContain("Use subagents");
    expect(collectText(renderer!.root)).not.toContain("Rebuild learned memory");
  });

  it("drives assist suggestions, delegation, specialists, and learned memory actions", async () => {
    const onCapabilitySuggestionAction = vi.fn();
    const onAcceptDelegation = vi.fn();
    const onCreateSpecialistDraft = vi.fn();
    const onActivateCatalogSpecialist = vi.fn();
    const onUpdateMemoryStatus = vi.fn();
    const onRebuildLearnedMemory = vi.fn();
    const capability = { kind: "tool", title: "Use browser", summary: "Inspect a source." };
    const specialist = { candidateId: "specialist-1", title: "Researcher", summary: "Research support." };
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(
        <ThreadedContextDrawer
          surface="cowork"
          props={baseProps({
            capabilitySuggestions: [capability],
            delegationSuggestion: { mode: "parallel", objective: "Split the work.", roles: ["Researcher", "QA"] },
            specialistSuggestions: [specialist],
            learnedMemory: [{ itemId: "memory-1", content: "User prefers concise reviews.", status: "draft" }],
            onCapabilitySuggestionAction,
            onAcceptDelegation,
            onCreateSpecialistDraft,
            onActivateCatalogSpecialist,
            onUpdateMemoryStatus,
            onRebuildLearnedMemory,
          })}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!.root, "Assist").props.onClick();
    });
    await act(async () => {
      findButton(renderer!.root, "Review suggestion").props.onClick();
      findButton(renderer!.root, "Use subagents").props.onClick();
      findButton(renderer!.root, "Draft").props.onClick();
      findButton(renderer!.root, "Activate").props.onClick();
      findButton(renderer!.root, "Keep active").props.onClick();
      findButton(renderer!.root, "Mark stale").props.onClick();
      findButton(renderer!.root, "Rebuild learned memory").props.onClick();
    });

    expect(onCapabilitySuggestionAction).toHaveBeenCalledWith(capability);
    expect(onAcceptDelegation).toHaveBeenCalledTimes(1);
    expect(onCreateSpecialistDraft).toHaveBeenCalledWith(specialist);
    expect(onActivateCatalogSpecialist).toHaveBeenCalledWith(specialist);
    expect(onUpdateMemoryStatus).toHaveBeenCalledWith("memory-1", "active");
    expect(onUpdateMemoryStatus).toHaveBeenCalledWith("memory-1", "superseded");
    expect(onRebuildLearnedMemory).toHaveBeenCalledTimes(1);
  });

  it("drives session organization, project assignment, binding, export, and destructive actions", async () => {
    const props = baseProps({
      renameTitle: "Draft title",
      folderName: "Ops",
      tagsValue: "coverage",
      selectedSessionProjectValue: "project-1",
      projectOptions: [
        { value: "", label: "No project" },
        { value: "project-1", label: "Project One" },
        { value: "project-2", label: "Project Two" },
      ],
      selectedSession: {
        sessionId: "session-1",
        title: null,
        pinned: true,
        lifecycleStatus: "archived",
      },
    });
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = create(<ThreadedContextDrawer surface="chat" props={props} />);
    });
    await act(async () => {
      findButton(renderer!.root, "Session").props.onClick();
    });

    const inputs = renderer!.root.findAllByType("input");
    const select = renderer!.root.findByType("select");
    await act(async () => {
      inputs.find((input) => input.props.placeholder === "Session title")?.props.onChange({ target: { value: "New" } });
      inputs.find((input) => input.props.placeholder === "Folder")?.props.onChange({ target: { value: "Archive" } });
      inputs
        .find((input) => input.props.placeholder === "tag-one, tag-two")
        ?.props.onChange({
          target: { value: "one,two" },
        });
      inputs
        .find((input) => input.props.placeholder === "Connection id")
        ?.props.onChange({
          target: { value: "connection-1" },
        });
      inputs
        .find((input) => input.props.placeholder === "Target thread / channel")
        ?.props.onChange({
          target: { value: "target-1" },
        });
      select.props.onChange({ target: { value: "project-2" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Save title").props.onClick();
      findButton(renderer!.root, "Save organization").props.onClick();
      findButton(renderer!.root, "Unpin").props.onClick();
      findButton(renderer!.root, "Restore").props.onClick();
      findButton(renderer!.root, "Export snapshot").props.onClick();
      findButton(renderer!.root, "Delete session").props.onClick();
      findButton(renderer!.root, "Save binding").props.onClick();
    });

    expect(props.onRenameTitleChange).toHaveBeenCalledWith("New");
    expect(props.onFolderNameChange).toHaveBeenCalledWith("Archive");
    expect(props.onTagsValueChange).toHaveBeenCalledWith("one,two");
    expect(props.onIntegrationConnectionIdChange).toHaveBeenCalledWith("connection-1");
    expect(props.onIntegrationTargetChange).toHaveBeenCalledWith("target-1");
    expect(props.onAssignProject).toHaveBeenCalledWith("project-2");
    expect(props.onRenameSession).toHaveBeenCalledTimes(1);
    expect(props.onSaveOrganization).toHaveBeenCalledTimes(1);
    expect(props.onTogglePinSession).toHaveBeenCalledTimes(1);
    expect(props.onToggleArchiveSession).toHaveBeenCalledTimes(1);
    expect(props.onExportSnapshot).toHaveBeenCalledTimes(1);
    expect(props.onDeleteSession).toHaveBeenCalledTimes(1);
    expect(props.onSaveExternalBinding).toHaveBeenCalledTimes(1);
  });

  it("renders run-shape controls on the assist tab and routes changes through onPrefPatch", async () => {
    const onPrefPatch = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    const props = baseProps({
      selectedSessionId: "session-with-acked-auto",
      prefs: {
        sessionId: "session-with-acked-auto",
        thinkingLevel: "standard",
        speedMode: "standard",
        subagentPolicy: "ask_when_useful",
        planningMode: "off",
      },
      onPrefPatch,
    });

    await act(async () => {
      renderer = create(<ThreadedContextDrawer surface="cowork" props={props} />);
    });
    await act(async () => {
      findButton(renderer!.root, "Assist").props.onClick();
    });

    const selects = renderer!.root.findAllByType("select");
    const thinkingSelect = selects.find((node) => node.props["aria-label"] === "Thinking level")!;
    const speedSelect = selects.find((node) => node.props["aria-label"] === "Speed mode")!;
    const subagentSelect = selects.find((node) => node.props["aria-label"] === "Subagent policy")!;

    await act(async () => {
      thinkingSelect.props.onChange({ target: { value: "deep" } });
      speedSelect.props.onChange({ target: { value: "fast" } });
      // Pick a non-auto subagent policy first to confirm it passes through immediately.
      subagentSelect.props.onChange({ target: { value: "off" } });
    });

    expect(onPrefPatch).toHaveBeenCalledWith({ thinkingLevel: "deep" });
    expect(onPrefPatch).toHaveBeenCalledWith({ speedMode: "fast" });
    expect(onPrefPatch).toHaveBeenCalledWith({ subagentPolicy: "off" });
  });

  it("lets users choose smooth or instant visual streaming locally", async () => {
    const onVisualStreamModeChange = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    const props = baseProps({
      visualStreamMode: "smooth",
      onVisualStreamModeChange,
    });

    await act(async () => {
      renderer = create(<ThreadedContextDrawer surface="chat" props={props} />);
    });

    expect(findButton(renderer!.root, "Smooth").props["aria-pressed"]).toBe(true);
    await act(async () => {
      findButton(renderer!.root, "Instant").props.onClick();
    });

    expect(onVisualStreamModeChange).toHaveBeenCalledWith("instant");
  });

  it("gates the first auto-subagent selection behind a consent confirmation", async () => {
    const onPrefPatch = vi.fn();
    // Stub a minimal localStorage on globalThis.window so the hook can read
    // and write the per-session acknowledgement without depending on jsdom or
    // happy-dom (those environments cause Radix to portal-mount into a fake
    // DOM that react-test-renderer cannot adopt).
    const store = new Map<string, string>();
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    };
    vi.stubGlobal("window", fakeWindow);

    try {
      let renderer: ReactTestRenderer | null = null;
      const props = baseProps({
        selectedSessionId: "session-needs-consent",
        prefs: {
          sessionId: "session-needs-consent",
          thinkingLevel: "standard",
          speedMode: "standard",
          subagentPolicy: "ask_when_useful",
          planningMode: "off",
        },
        onPrefPatch,
      });

      await act(async () => {
        renderer = create(<ThreadedContextDrawer surface="cowork" props={props} />);
      });
      await act(async () => {
        findButton(renderer!.root, "Assist").props.onClick();
      });

      const subagentSelect = renderer!.root
        .findAllByType("select")
        .find((node) => node.props["aria-label"] === "Subagent policy")!;

      await act(async () => {
        subagentSelect.props.onChange({ target: { value: "auto_when_useful" } });
      });

      // The change should NOT propagate yet — the confirm modal is in the way.
      expect(onPrefPatch).not.toHaveBeenCalled();

      const consentModal = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.open);
      expect(consentModal?.props.title).toBe("Allow Chat to auto-delegate to subagents?");

      await act(async () => {
        consentModal?.props.onConfirm();
      });

      expect(onPrefPatch).toHaveBeenCalledWith({ subagentPolicy: "auto_when_useful" });
      expect(store.get("mc-next:subagent-auto-ack:session-needs-consent")).toBe("1");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
