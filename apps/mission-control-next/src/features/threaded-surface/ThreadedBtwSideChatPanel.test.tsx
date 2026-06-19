// @vitest-environment happy-dom
import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedBtwSideChatProps } from "@goatcitadel/threaded-surface-core";
import {
  ThreadedBtwSideChatPanel,
  clampBtwSideChatPosition,
  getBtwSideChatStorageKey,
  getDefaultBtwSideChatPosition,
  readBtwSideChatPosition,
  removeBtwSideChatPosition,
  writeBtwSideChatPosition,
} from "./ThreadedBtwSideChatPanel";

const mediaQueryMock = vi.hoisted(() => ({
  compact: false,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({
  useMediaQuery: () => mediaQueryMock.compact,
}));

function buildSideChat(overrides: Partial<MissionThreadedBtwSideChatProps> = {}): MissionThreadedBtwSideChatProps {
  return {
    open: true,
    workspaceId: "workspace-a",
    parentSessionId: "parent-1",
    parentTitle: "Parent thread",
    childSessionId: "child-1",
    thread: null,
    streamingPreview: null,
    draft: "",
    loading: false,
    sending: false,
    error: null,
    onClose: vi.fn(),
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value));
  }
}

function getTestLocalStorage(): Storage {
  if (window.localStorage) {
    return window.localStorage;
  }

  const storage = new MemoryStorage();
  Object.defineProperty(window, "Storage", { configurable: true, writable: true, value: MemoryStorage });
  Object.defineProperty(globalThis, "Storage", { configurable: true, writable: true, value: MemoryStorage });
  Object.defineProperty(window, "localStorage", { configurable: true, writable: true, value: storage });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
  return storage;
}

describe("ThreadedBtwSideChatPanel local position", () => {
  beforeEach(() => {
    mediaQueryMock.compact = false;
    getTestLocalStorage().clear();
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("clamps defaults and restored coordinates to the viewport", () => {
    expect(getDefaultBtwSideChatPosition({ width: 1000, height: 800 }, { width: 352, height: 430 })).toEqual({
      x: 620,
      y: 266,
    });
    expect(
      clampBtwSideChatPosition({ x: -100, y: 900 }, { width: 500, height: 360 }, { width: 260, height: 180 }),
    ).toEqual({
      x: 14,
      y: 166,
    });
  });

  it("persists valid coordinates and ignores malformed or blocked localStorage", () => {
    writeBtwSideChatPosition("workspace-a", { x: 44, y: 88 });
    expect(readBtwSideChatPosition("workspace-a")).toEqual({ x: 44, y: 88 });

    getTestLocalStorage().setItem(getBtwSideChatStorageKey("workspace-a"), "{nope");
    expect(readBtwSideChatPosition("workspace-a")).toBeNull();

    const setItem = vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeBtwSideChatPosition("workspace-a", { x: 12, y: 14 })).not.toThrow();
    setItem.mockRestore();
  });

  it("resets stored desktop position from the header", async () => {
    writeBtwSideChatPosition("workspace-a", { x: 120, y: 180 });
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<ThreadedBtwSideChatPanel sideChat={buildSideChat()} />);
    });

    const header = renderer!.root.findByProps({ className: "mc-next-btw-side-chat-header" });
    await act(async () => {
      header.props.onDoubleClick();
    });

    expect(readBtwSideChatPosition("workspace-a")).toBeNull();
    await act(async () => {
      renderer?.unmount();
    });
  });

  it("does not write desktop position controls for compact layouts", async () => {
    mediaQueryMock.compact = true;
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<ThreadedBtwSideChatPanel sideChat={buildSideChat()} />);
    });

    expect(renderer!.root.findAllByProps({ "aria-label": "Reset side chat position" })).toHaveLength(0);
    removeBtwSideChatPosition("workspace-a");
    await act(async () => {
      renderer?.unmount();
    });
  });
});
