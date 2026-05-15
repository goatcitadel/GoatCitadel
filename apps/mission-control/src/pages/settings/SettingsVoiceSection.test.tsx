import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VoiceOperatorGuidance,
  VoiceRecoveryAction,
  VoiceRuntimeStatus,
  VoiceStatus,
  VoiceTalkSessionRecord,
} from "@goatcitadel/contracts";

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("../../components/HelpHint", () => ({
  HelpHint: ({ label, text }: { label: string; text: string }) => <span title={text}>{label}</span>,
}));

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <div>{subtitle}</div>
      {children}
    </section>
  ),
}));

vi.mock("../../components/StatusChip", () => ({
  StatusChip: ({ children, tone }: { children?: React.ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
}));

vi.mock("../../components/ui", () => ({
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { SettingsVoiceSection, type SettingsVoiceSectionProps } from "./SettingsVoiceSection";

function makeVoiceStatus(overrides: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    stt: {
      provider: "whisper.cpp",
      state: "stopped",
      runtimeReady: true,
      modelId: "base.en",
      updatedAt: "2026-05-14T12:00:00.000Z",
    },
    talk: {
      state: "stopped",
      mode: "push_to_talk",
      activeSessionId: undefined,
      updatedAt: "2026-05-14T12:01:00.000Z",
    },
    wake: {
      enabled: false,
      state: "stopped",
      model: "openwakeword",
      updatedAt: "2026-05-14T12:02:00.000Z",
    },
    ...overrides,
  } as VoiceStatus;
}

function makeVoiceRuntime(overrides: Partial<VoiceRuntimeStatus> = {}): VoiceRuntimeStatus {
  return {
    provider: "whisper.cpp",
    source: "managed",
    readiness: "ready",
    binaryReady: true,
    ffmpegReady: true,
    selectedModelId: "base.en",
    binaryPath: "C:\\goatcitadel\\whisper.exe",
    installedModels: [
      {
        modelId: "base.en",
        filePath: "C:\\models\\base.en.bin",
        sizeBytes: 1,
        active: true,
      },
    ],
    catalog: [
      {
        id: "base.en",
        label: "Base English",
        languageScope: "english",
        sizeBytes: 142 * 1024 * 1024,
        approxSizeLabel: "142 MB",
        recommended: true,
        defaultInstall: true,
      },
      {
        id: "small",
        label: "Small Multilingual",
        languageScope: "multilingual",
        sizeBytes: 466 * 1024 * 1024,
        approxSizeLabel: "466 MB",
        recommended: false,
        defaultInstall: false,
      },
    ],
    updatedAt: "2026-05-14T12:03:00.000Z",
    ...overrides,
  } as VoiceRuntimeStatus;
}

function makeProps(overrides: Partial<SettingsVoiceSectionProps> = {}): SettingsVoiceSectionProps {
  return {
    voiceStatus: makeVoiceStatus(),
    voiceRuntime: makeVoiceRuntime(),
    voiceTalkSessions: [],
    voiceActionInfo: null,
    voiceOperatorGuidance: {
      postureSummary: "Voice runtime is ready.",
      recommendedActions: [],
      blockingIssues: [],
      recoveryActions: [],
    } as VoiceOperatorGuidance,
    voiceRecoveryActions: [],
    voiceBusy: false,
    installedVoiceModelIds: new Set(["base.en"]),
    voiceTalkMode: "push_to_talk",
    onVoiceTalkModeChange: vi.fn(),
    voiceFile: null,
    onVoiceFileChange: vi.fn(),
    voiceTranscriptResult: null,
    onInstallManagedVoiceRuntime: vi.fn(),
    onSelectManagedVoiceModel: vi.fn(),
    onRemoveManagedVoiceModel: vi.fn(),
    onStartVoiceTalk: vi.fn(),
    onStopVoiceTalk: vi.fn(),
    onStartWake: vi.fn(),
    onStopWake: vi.fn(),
    onRunVoiceTranscribeTest: vi.fn(),
    refreshVoiceRuntime: vi.fn(),
    ...overrides,
  };
}

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => flattenChildren(button.props.children) === label);
}

function flattenChildren(children: React.ReactNode): string {
  if (Array.isArray(children)) {
    return children.map((child) => flattenChildren(child)).join("");
  }
  return typeof children === "string" || typeof children === "number" ? String(children) : "";
}

describe("SettingsVoiceSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders ready runtime state, model catalog actions, and transcription controls", () => {
    const props = makeProps({
      voiceFile: new File(["audio"], "sample.wav", { type: "audio/wav" }),
      voiceTranscriptResult: "hello citadel",
      voiceTalkSessions: [
        {
          talkSessionId: "talk-1",
          mode: "wake",
          state: "stopped",
          createdAt: "2026-05-14T11:00:00.000Z",
          startedAt: "2026-05-14T11:01:00.000Z",
          stoppedAt: "2026-05-14T11:02:00.000Z",
          sessionId: "chat-1",
        } as VoiceTalkSessionRecord,
      ],
      voiceOperatorGuidance: {
        postureSummary: "Ready for local proof.",
        recommendedActions: ["Run one local transcription."],
        blockingIssues: [],
        recoveryActions: [],
      } as VoiceOperatorGuidance,
    });
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(<SettingsVoiceSection {...props} />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("Voice Runtime");
      expect(text).toContain("whisper.cpp");
      expect(text).toContain("Selected model: base.en");
      expect(text).toContain("Base English");
      expect(text).toContain("Small Multilingual");
      expect(text).toContain("Available");
      expect(text).toContain("Run one local transcription.");
      expect(text).toContain("talk-1");
      expect(text).toContain("hello citadel");
      expect(findButton(renderer, "Run Local Transcription")?.props.disabled).toBe(false);
    } finally {
      renderer.unmount();
    }
  });

  it("wires primary runtime and talk controls to their callbacks", () => {
    const props = makeProps();
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(<SettingsVoiceSection {...props} />);
      });

      act(() => {
        findButton(renderer, "Repair Voice Runtime")?.props.onClick();
        findButton(renderer, "Refresh Voice Status")?.props.onClick();
        renderer.root.findByProps({ id: "voiceTalkMode" }).props.onChange("wake");
        findButton(renderer, "Start Talk Mode")?.props.onClick();
        findButton(renderer, "Enable Wake")?.props.onClick();
      });

      expect(props.onInstallManagedVoiceRuntime).toHaveBeenCalledWith("base.en", true);
      expect(props.refreshVoiceRuntime).toHaveBeenCalledTimes(1);
      expect(props.onVoiceTalkModeChange).toHaveBeenCalledWith("wake");
      expect(props.onStartVoiceTalk).toHaveBeenCalledTimes(1);
      expect(props.onStartWake).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });

  it("wires model catalog download, activate, remove, and file-change actions", () => {
    const props = makeProps({
      voiceRuntime: makeVoiceRuntime({
        selectedModelId: "base.en",
        catalog: [
          {
            id: "small",
            label: "Small Multilingual",
            languageScope: "multilingual",
            sizeBytes: 466 * 1024 * 1024,
            approxSizeLabel: "466 MB",
            recommended: false,
            defaultInstall: false,
          },
          {
            id: "medium",
            label: "Medium Multilingual",
            languageScope: "multilingual",
            sizeBytes: 1536 * 1024 * 1024,
            approxSizeLabel: "1.5 GB",
            recommended: false,
            defaultInstall: false,
          },
        ],
      }),
      installedVoiceModelIds: new Set(["medium"]),
    });
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(<SettingsVoiceSection {...props} />);
      });

      act(() => {
        findButton(renderer, "Download model")?.props.onClick();
        findButton(renderer, "Activate model")?.props.onClick();
        findButton(renderer, "Remove model")?.props.onClick();
        renderer.root.findByProps({ id: "voiceTestFile" }).props.onChange({
          target: { files: [new File(["voice"], "voice.wav", { type: "audio/wav" })] },
        });
      });

      expect(props.onInstallManagedVoiceRuntime).toHaveBeenCalledWith("small", false);
      expect(props.onSelectManagedVoiceModel).toHaveBeenCalledWith("medium");
      expect(props.onRemoveManagedVoiceModel).toHaveBeenCalledWith("medium");
      expect(props.onVoiceFileChange).toHaveBeenCalledWith(expect.objectContaining({ name: "voice.wav" }));
    } finally {
      renderer.unmount();
    }
  });

  it("renders and executes recovery actions for unhealthy voice state", () => {
    const recoveryActions: VoiceRecoveryAction[] = [
      {
        id: "repair-runtime",
        title: "Repair runtime",
        description: "Runtime is missing.",
        tone: "critical",
      },
      {
        id: "install-starter-model",
        title: "Install starter",
        description: "Starter model is missing.",
        tone: "warning",
      },
      {
        id: "activate-installed-model",
        title: "Activate model",
        description: "Select the installed model.",
        tone: "warning",
        modelId: "small",
      },
      {
        id: "stop-talk-session",
        title: "Stop talk",
        description: "Talk mode is active.",
        tone: "warning",
      },
      {
        id: "stop-wake-listener",
        title: "Stop wake",
        description: "Wake listener is active.",
        tone: "warning",
      },
      {
        id: "refresh-runtime-state",
        title: "Refresh",
        description: "Re-read runtime status.",
        tone: "muted",
      },
    ] as VoiceRecoveryAction[];
    const props = makeProps({
      voiceStatus: makeVoiceStatus({
        stt: {
          provider: "whisper.cpp",
          state: "error",
          runtimeReady: false,
          modelId: undefined,
          lastError: "binary missing",
          updatedAt: "2026-05-14T12:00:00.000Z",
        },
        talk: {
          state: "running",
          mode: "wake",
          activeSessionId: "talk-2",
          updatedAt: "2026-05-14T12:01:00.000Z",
        },
        wake: {
          enabled: true,
          state: "running",
          model: "openwakeword",
          updatedAt: "2026-05-14T12:02:00.000Z",
        },
      }),
      voiceRuntime: makeVoiceRuntime({
        readiness: "missing",
        binaryReady: false,
        ffmpegReady: false,
        selectedModelId: undefined,
        lastError: "runtime missing",
      }),
      voiceActionInfo: "Repair queued.",
      voiceRecoveryActions: recoveryActions,
    });
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(<SettingsVoiceSection {...props} />);
      });

      const text = rendererText(renderer);
      expect(text).toContain("Last STT error:");
      expect(text).toContain("binary missing");
      expect(text).toContain("Last runtime error:");
      expect(text).toContain("runtime missing");
      expect(text).toContain("Repair queued.");

      act(() => {
        findButton(renderer, "Repair Voice Runtime")?.props.onClick();
        findButton(renderer, "Install Starter Model")?.props.onClick();
        findButton(renderer, "Activate small")?.props.onClick();
        findButton(renderer, "Stop Talk Mode")?.props.onClick();
        findButton(renderer, "Disable Wake")?.props.onClick();
        findButton(renderer, "Refresh Voice Status")?.props.onClick();
      });

      expect(props.onInstallManagedVoiceRuntime).toHaveBeenCalledWith("base.en", true);
      expect(props.onInstallManagedVoiceRuntime).toHaveBeenCalledWith("base.en", true);
      expect(props.onSelectManagedVoiceModel).toHaveBeenCalledWith("small");
      expect(props.onStopVoiceTalk).toHaveBeenCalledTimes(1);
      expect(props.onStopWake).toHaveBeenCalledTimes(1);
      expect(props.refreshVoiceRuntime).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });

  it("keeps controls disabled while voice work is busy or state is incompatible", () => {
    const props = makeProps({
      voiceBusy: true,
      voiceStatus: makeVoiceStatus({
        talk: {
          state: "running",
          mode: "push_to_talk",
          activeSessionId: "talk-3",
          updatedAt: "2026-05-14T12:01:00.000Z",
        },
        wake: {
          enabled: true,
          state: "running",
          model: "openwakeword",
          updatedAt: "2026-05-14T12:02:00.000Z",
        },
      }),
    });
    let renderer = create(<div />);
    try {
      act(() => {
        renderer = create(<SettingsVoiceSection {...props} />);
      });

      expect(findButton(renderer, "Repair Voice Runtime")?.props.disabled).toBe(true);
      expect(findButton(renderer, "Start Talk Mode")?.props.disabled).toBe(true);
      expect(findButton(renderer, "Stop Talk Mode")?.props.disabled).toBe(true);
      expect(findButton(renderer, "Enable Wake")?.props.disabled).toBe(true);
      expect(findButton(renderer, "Disable Wake")?.props.disabled).toBe(true);
      expect(findButton(renderer, "Run Local Transcription")?.props.disabled).toBe(true);
    } finally {
      renderer.unmount();
    }
  });
});
