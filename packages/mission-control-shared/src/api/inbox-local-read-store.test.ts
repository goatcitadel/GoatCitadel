// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeLocalInboxUpdate,
  inboxLocalReadKey,
  readLocalInboxUpdates,
  localInboxStorageAvailable,
  subscribeLocalInboxReads,
} from "./inbox-local-read-store";
import { notifyGatewayAccessChanged } from "./access-scope";
const first = { id: "update-a", version: "a".repeat(64) },
  newer = { ...first, version: "b".repeat(64) };
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, fn: () => unknown) => fn() },
  });
});
describe("anonymous read owner", () => {
  it("retains delayed versions and invalidates every workspace even without an Inbox mount", async () => {
    await acknowledgeLocalInboxUpdate("installation", "a", newer);
    await acknowledgeLocalInboxUpdate("installation", "a", first);
    await acknowledgeLocalInboxUpdate("installation", "b", first);
    expect(JSON.parse(readLocalInboxUpdates("installation", "a"))).toEqual([newer, first]);
    notifyGatewayAccessChanged();
    expect(JSON.parse(readLocalInboxUpdates("installation", "a"))).toEqual([]);
    expect(JSON.parse(readLocalInboxUpdates("installation", "b"))).toEqual([]);
  });
  it("reports unsupported locking and set-only denial as unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    expect(await acknowledgeLocalInboxUpdate("installation", "a", first)).toBe(false);
    expect(localInboxStorageAvailable("installation", "a")).toBe(false);
  });
  it("does not claim failed or partial writes, and notifies mounted consumers", async () => {
    const update = vi.fn();
    const unsubscribe = subscribeLocalInboxReads(update);
    expect(await acknowledgeLocalInboxUpdate("installation", "partial", first)).toBe(true);
    const set = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("write denied");
    });
    expect(await acknowledgeLocalInboxUpdate("installation", "partial", newer)).toBe(false);
    expect(localInboxStorageAvailable("installation", "partial")).toBe(false);
    expect(JSON.parse(readLocalInboxUpdates("installation", "partial"))).toEqual([first]);
    expect(update).toHaveBeenCalled();
    set.mockRestore();
    unsubscribe();
  });
  it("aborts queued writes after access or selected workspace changes", async () => {
    let release!: () => void;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, fn: () => unknown) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return fn();
        },
      },
    });
    const pending = acknowledgeLocalInboxUpdate("installation", "queued", first);
    notifyGatewayAccessChanged();
    release();
    expect(await pending).toBe(false);
    expect(JSON.parse(readLocalInboxUpdates("installation", "queued"))).toEqual([]);
    let current = true;
    const moved = acknowledgeLocalInboxUpdate("installation", "queued", first, () => current);
    current = false;
    release();
    expect(await moved).toBe(false);
  });
  it("keeps at most 1000 sanitized references", async () => {
    localStorage.setItem(
      inboxLocalReadKey("installation", "bound"),
      JSON.stringify(
        Array.from({ length: 1000 }, (_, i) => ({ id: String(i), version: first.version, extra: "discard" })),
      ),
    );
    await acknowledgeLocalInboxUpdate("installation", "bound", first);
    const saved = JSON.parse(readLocalInboxUpdates("installation", "bound"));
    expect(saved).toHaveLength(1000);
    expect(saved.every((e: object) => Object.keys(e).length === 2)).toBe(true);
  });
});
