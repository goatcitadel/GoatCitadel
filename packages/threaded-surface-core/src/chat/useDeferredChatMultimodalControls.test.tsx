import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { useDeferredChatMultimodalControls } from "./useDeferredChatMultimodalControls";
import type { ChatMultimodalInput } from "./useChatMultimodalControls";

const runtime = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release, load: vi.fn(), generate: vi.fn(async () => true) };
});

vi.mock("./ChatMultimodalRuntime", async () => {
  runtime.load();
  await runtime.gate;
  const { useLayoutEffect } = await import("react");
  return {
    ChatMultimodalRuntime({ publish }: { publish: (next: object) => void }) {
      useLayoutEffect(() => publish({ handleGenerateImage: runtime.generate }), [publish]);
      return null;
    },
  };
});

it("keeps image routing synchronous and never dispatches a first image intent into another conversation", async () => {
  let current: ReturnType<typeof useDeferredChatMultimodalControls>;
  let renderer: ReactTestRenderer | undefined;
  const input: ChatMultimodalInput = {
    deferVoiceReadiness: true,
    workspaceId: "workspace",
    selectedSessionId: "original",
    providerOptions: [{ providerId: "openai", models: ["gpt-image-1"] }] as ChatMultimodalInput["providerOptions"],
    routePreflight: null,
    pendingAttachments: [],
    draft: "Draw a lighthouse",
    setDraft: vi.fn(),
    setError: vi.fn(),
    pushLocalNotice: vi.fn(),
    uploadAttachments: vi.fn(async () => true),
  };
  function Harness({ sessionId }: { sessionId: string }) {
    current = useDeferredChatMultimodalControls({ ...input, selectedSessionId: sessionId });
    return current.multimodalRuntime;
  }
  try {
    await act(async () => {
      renderer = create(<Harness sessionId="original" />);
    });
    expect(current!.multimodal.imageGenerationAvailable).toBe(true);
    expect(runtime.load).not.toHaveBeenCalled();
    let oldAttempt: Promise<boolean> | undefined;
    await act(async () => {
      oldAttempt = current!.multimodal.handleGenerateImage();
      await vi.waitFor(() => expect(runtime.load).toHaveBeenCalledOnce());
    });
    await act(async () => {
      renderer?.update(<Harness sessionId="replacement" />);
    });
    await act(async () => {
      runtime.release();
      await vi.dynamicImportSettled();
    });
    await expect(oldAttempt).resolves.toBe(false);
    expect(runtime.generate).not.toHaveBeenCalled();
    await act(async () => {
      await expect(current!.multimodal.handleGenerateImage()).resolves.toBe(true);
    });
    expect(runtime.generate).toHaveBeenCalledOnce();
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
  }
});
