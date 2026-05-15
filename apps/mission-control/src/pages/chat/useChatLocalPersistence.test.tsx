import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearChatSessionLocalState,
  createAttachmentStorageKey,
  createDraftStorageKey,
  createQueueStorageKey,
  useDebouncedLocalStoragePersistence,
} from "./useChatLocalPersistence";

const originalWindow = globalThis.window;

function installWindowStorage({ throwOnAccess = false }: { throwOnAccess?: boolean } = {}) {
  const store = new Map<string, string>();
  const localStorage = {
    setItem: vi.fn((key: string, value: string) => {
      if (throwOnAccess) {
        throw new Error("local storage blocked");
      }
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      if (throwOnAccess) {
        throw new Error("local storage blocked");
      }
      store.delete(key);
    }),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
    },
  });
  return localStorage;
}

let latestSetValue: ((value: string) => void) | null = null;

function PersistenceHarness(props: { storageKey: string; initialValue: string; delayMs?: number }) {
  const [value, setValue] = useState(props.initialValue);
  latestSetValue = setValue;
  useDebouncedLocalStoragePersistence(props.storageKey, value, props.delayMs);
  return null;
}

describe("useChatLocalPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    latestSetValue = null;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("builds stable local storage keys including default new-session keys", () => {
    expect(createDraftStorageKey("workspace-1", null)).toBe("goatcitadel.chat.draft.workspace-1.new");
    expect(createAttachmentStorageKey("workspace-1", null)).toBe("goatcitadel.chat.attachments.workspace-1.new");
    expect(createQueueStorageKey("workspace-1", null)).toBe("goatcitadel.chat.queue.workspace-1.new");
    expect(createDraftStorageKey("workspace-1", "session-1")).toBe("goatcitadel.chat.draft.workspace-1.session-1");
  });

  it("clears draft, attachment, and queue state when browser storage is available", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    clearChatSessionLocalState("workspace-1", "session-1");

    const storage = installWindowStorage();
    clearChatSessionLocalState("workspace-1", "session-1");

    expect(storage.removeItem).toHaveBeenCalledWith("goatcitadel.chat.draft.workspace-1.session-1");
    expect(storage.removeItem).toHaveBeenCalledWith("goatcitadel.chat.attachments.workspace-1.session-1");
    expect(storage.removeItem).toHaveBeenCalledWith("goatcitadel.chat.queue.workspace-1.session-1");
  });

  it("debounces writes, flushes when keys change, and flushes on unmount", () => {
    const storage = installWindowStorage();
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(<PersistenceHarness storageKey="draft-1" initialValue="one" delayMs={100} />);
    });
    expect(storage.setItem).not.toHaveBeenCalled();

    act(() => {
      latestSetValue?.("two");
    });
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(storage.setItem).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(storage.setItem).toHaveBeenLastCalledWith("draft-1", "two");

    act(() => {
      renderer!.update(<PersistenceHarness storageKey="draft-2" initialValue="ignored" delayMs={100} />);
    });
    act(() => {
      latestSetValue?.("three");
    });
    act(() => {
      renderer!.update(<PersistenceHarness storageKey="draft-3" initialValue="ignored" delayMs={100} />);
    });
    expect(storage.setItem).toHaveBeenLastCalledWith("draft-2", "three");

    act(() => {
      latestSetValue?.("four");
    });
    act(() => {
      renderer!.unmount();
    });
    expect(storage.setItem).toHaveBeenLastCalledWith("draft-3", "four");
  });

  it("skips cleanup persistence when browser storage is unavailable", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(<PersistenceHarness storageKey="draft-1" initialValue="one" delayMs={100} />);
    });
    act(() => {
      latestSetValue?.("two");
    });

    expect(() => {
      act(() => {
        renderer!.unmount();
      });
    }).not.toThrow();
  });

  it("treats local storage write and clear errors as best-effort", () => {
    const storage = installWindowStorage({ throwOnAccess: true });
    let renderer: ReactTestRenderer;

    expect(() => clearChatSessionLocalState("workspace-1", "session-1")).not.toThrow();
    expect(storage.removeItem).toHaveBeenCalledTimes(3);

    act(() => {
      renderer = create(<PersistenceHarness storageKey="draft-1" initialValue="one" delayMs={100} />);
    });
    act(() => {
      latestSetValue?.("two");
    });

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }).not.toThrow();

    act(() => {
      latestSetValue?.("three");
    });
    expect(() => {
      act(() => {
        renderer!.update(<PersistenceHarness storageKey="draft-2" initialValue="ignored" delayMs={100} />);
      });
    }).not.toThrow();

    expect(() => {
      act(() => {
        renderer!.unmount();
      });
    }).not.toThrow();
    expect(storage.setItem).toHaveBeenCalled();
  });
});
