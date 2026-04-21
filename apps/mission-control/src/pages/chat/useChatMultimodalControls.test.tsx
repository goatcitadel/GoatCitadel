import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatMultimodalControls } from "./useChatMultimodalControls";

const fetchVoiceStatusMock = vi.fn(async () => ({
  talk: {
    activeSessionId: null,
  },
}));
const fetchVoiceRuntimeStatusMock = vi.fn(async () => ({
  readiness: "ready",
  selectedModelId: "voice-mini",
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<object>("../../api/client");
  return {
    ...actual,
    fetchVoiceStatus: () => fetchVoiceStatusMock(),
    fetchVoiceRuntimeStatus: () => fetchVoiceRuntimeStatusMock(),
    downloadChatAttachment: vi.fn(),
    generateLlmImage: vi.fn(),
    startVoiceTalkSession: vi.fn(),
    stopVoiceTalkSession: vi.fn(),
    transcribeVoice: vi.fn(),
  };
});

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

async function settlePromises(iterations = 4): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

type HarnessState = {
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveThreadSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setLatestAssistantMessageId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setLatestAssistantContent: React.Dispatch<React.SetStateAction<string | undefined>>;
  setLatestAssistantStatus: React.Dispatch<React.SetStateAction<any>>;
};

let latest: HarnessState | null = null;

function Harness() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>("sess-1");
  const [activeThreadSessionId, setActiveThreadSessionId] = useState<string | null>("sess-1");
  const [draft, setDraft] = useState("");
  const [latestAssistantMessageId, setLatestAssistantMessageId] = useState<string | undefined>("assistant-history");
  const [latestAssistantContent, setLatestAssistantContent] = useState<string | undefined>("Historical reply");
  const [latestAssistantStatus, setLatestAssistantStatus] = useState<any>("completed");

  useChatMultimodalControls({
    providerOptions: [
      {
        providerId: "openai",
        label: "OpenAI",
        capabilities: {
          voiceOutput: true,
        },
      },
    ],
    selectedProviderId: "openai",
    routePreflight: null,
    selectedSessionId,
    activeThreadSessionId,
    pendingAttachments: [],
    draft,
    latestAssistantMessageId,
    latestAssistantContent,
    latestAssistantStatus,
    setDraft,
    setError: vi.fn(),
    pushLocalNotice: vi.fn(),
    uploadAttachments: vi.fn(async () => undefined),
  });

  latest = {
    setSelectedSessionId,
    setActiveThreadSessionId,
    setLatestAssistantMessageId,
    setLatestAssistantContent,
    setLatestAssistantStatus,
  };

  return null;
}

describe("useChatMultimodalControls", () => {
  beforeEach(() => {
    latest = null;
    fetchVoiceStatusMock.mockClear();
    fetchVoiceRuntimeStatusMock.mockClear();

    const localStorage = createMemoryStorage();
    localStorage.setItem("goatcitadel.chat.speak-replies.enabled", "true");
    const speechSynthesis = {
      speak: vi.fn(),
      cancel: vi.fn(),
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        localStorage,
        speechSynthesis,
        SpeechSynthesisUtterance: class SpeechSynthesisUtterance {
          public constructor(public text: string) {}
        },
      },
    });
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      writable: true,
      value: class SpeechSynthesisUtterance {
        public constructor(public text: string) {}
      },
    });
  });

  it("does not replay the latest historical assistant reply when a session is opened", async () => {
    create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("speaks only after a new assistant reply reaches completed status", async () => {
    create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    await act(async () => {
      latest?.setLatestAssistantMessageId("assistant-streaming");
      latest?.setLatestAssistantContent("Partial reply");
      latest?.setLatestAssistantStatus("running");
      await settlePromises();
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();

    await act(async () => {
      latest?.setLatestAssistantContent("Completed reply");
      latest?.setLatestAssistantStatus("completed");
      await settlePromises();
    });

    expect(window.speechSynthesis.cancel as any).toHaveBeenCalled();
    expect(window.speechSynthesis.speak as any).toHaveBeenCalledTimes(1);
    expect((window.speechSynthesis.speak as any).mock.calls[0]?.[0]?.text).toBe("Completed reply");
  });

  it("primes the newly loaded thread after a session switch instead of speaking its history", async () => {
    create(<Harness />);

    await act(async () => {
      await settlePromises();
    });

    await act(async () => {
      latest?.setSelectedSessionId("sess-2");
      latest?.setActiveThreadSessionId("sess-2");
      latest?.setLatestAssistantMessageId("assistant-history-2");
      latest?.setLatestAssistantContent("Second session history");
      latest?.setLatestAssistantStatus("completed");
      await settlePromises();
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });
});
