import { describe, expect, it, vi } from "vitest";
import { DEV_RESET_STORAGE_KEY, resetDevBrowserStorage } from "./dev-reset";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("development profile browser reset", () => {
  it("clears preferences, gateway transport auth, OAuth flow, and drafts while preserving unrelated site data", () => {
    const storage = memoryStorage({
      "goatcitadel.ui.shell.v1": "classic",
      "goatcitadel.gateway.auth": "test-transport",
      "goatcitadel:openai-codex:oauth-flow": "test-flow",
      "goatcitadel.chat.draft.session-1": "old draft",
      "mc-next:chat:inspector-pinned": "true",
      "other-app:theme": "dark",
    });
    expect(resetDevBrowserStorage("reset-1", storage)).toBe(true);
    expect(Object.fromEntries(storage.values)).toEqual({
      "other-app:theme": "dark",
      [DEV_RESET_STORAGE_KEY]: "reset-1",
    });
  });

  it("runs once per reset and clears again after a subsequent clear command", () => {
    const storage = memoryStorage();
    resetDevBrowserStorage("reset-1", storage);
    storage.setItem("goatcitadel.chat.draft", "new draft");
    expect(resetDevBrowserStorage("reset-1", storage)).toBe(false);
    expect(storage.getItem("goatcitadel.chat.draft")).toBe("new draft");
    expect(resetDevBrowserStorage("reset-2", storage)).toBe(true);
    expect(storage.getItem("goatcitadel.chat.draft")).toBeNull();
  });

  it("resets session storage independently when another tab has already reset local storage", () => {
    const local = memoryStorage({ [DEV_RESET_STORAGE_KEY]: "reset-2" });
    const session = memoryStorage({ [DEV_RESET_STORAGE_KEY]: "reset-1", "goatcitadel.gateway.auth": "old" });
    expect(resetDevBrowserStorage("reset-2", local)).toBe(false);
    expect(resetDevBrowserStorage("reset-2", session)).toBe(true);
    expect(session.getItem("goatcitadel.gateway.auth")).toBeNull();
  });

  it("leaves storage intact without a dev reset marker, including production builds", () => {
    const storage = memoryStorage({ "goatcitadel.ui.shell.v1": "classic" });
    expect(resetDevBrowserStorage("", storage)).toBe(false);
    expect(storage.getItem("goatcitadel.ui.shell.v1")).toBe("classic");
    expect(resetDevBrowserStorage("reset-1", null)).toBe(false);
  });

  it("does not acknowledge a failed deletion, allowing retry", () => {
    const storage = memoryStorage({ "goatcitadel.chat.draft": "old" });
    const remove = storage.removeItem;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    storage.removeItem = () => {
      throw new Error("storage denied");
    };
    try {
      expect(resetDevBrowserStorage("reset-1", storage)).toBe(false);
      expect(storage.getItem(DEV_RESET_STORAGE_KEY)).toBeNull();
      storage.removeItem = remove;
      expect(resetDevBrowserStorage("reset-1", storage)).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });
});
