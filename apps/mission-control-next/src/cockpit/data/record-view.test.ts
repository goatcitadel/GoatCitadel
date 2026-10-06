import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { lastVersionNote, recordTime, recordView, type RecordQuery, keepRecordForSameItem } from "./record-view";

const at = new Date(2026, 9, 5, 10, 42).getTime();
const query = (overrides: Partial<RecordQuery<{ id: string }>>): RecordQuery<{ id: string }> => ({
  data: undefined,
  isPending: false,
  isFetching: false,
  isError: false,
  dataUpdatedAt: 0,
  ...overrides,
});

describe("recordView", () => {
  it("is loading only while pending with a read in flight", () => {
    expect(recordView(query({ isPending: true, isFetching: true }))).toEqual({
      record: undefined,
      phase: "loading",
      stale: false,
      checkedAt: undefined,
    });
    // A disabled read with nothing cached has nothing to show, but is not loading.
    expect(recordView(query({ isPending: true })).phase).toBe("ready");
  });

  it("keeps the record during a background refetch", () => {
    const view = recordView(query({ data: { id: "a" }, isFetching: true, dataUpdatedAt: at }));
    expect(view).toEqual({ record: { id: "a" }, phase: "checking", stale: true, checkedAt: at });
  });

  it("keeps the record beside an error and says how old it is", () => {
    const view = recordView(query({ data: { id: "a" }, isError: true, dataUpdatedAt: at }));
    expect(view.record).toEqual({ id: "a" });
    expect(view.phase).toBe("error");
    expect(view.stale).toBe(true);
    expect(lastVersionNote(view)).toBe(`Showing the last version from ${recordTime(at)}.`);
  });

  it("has no last-version note without a record or without an error", () => {
    expect(lastVersionNote(recordView(query({ isError: true })))).toBeUndefined();
    expect(lastVersionNote(recordView(query({ data: { id: "a" }, dataUpdatedAt: at })))).toBeUndefined();
  });

  it("applies the selector", () => {
    const view = recordView(query({ data: { id: "a" }, dataUpdatedAt: at }), (data) => data.id);
    expect(view).toEqual({ record: "a", phase: "ready", stale: false, checkedAt: at });
  });

  it("follows a real query through refetch, failure and reset", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let next: () => Promise<{ id: string }> = async () => ({ id: "first" });
    const observer = new QueryObserver(client, { queryKey: ["record"], queryFn: () => next() });
    const unsubscribe = observer.subscribe(() => undefined);
    await client.fetchQuery({ queryKey: ["record"], queryFn: () => next() });
    expect(recordView(observer.getCurrentResult()).phase).toBe("ready");

    let release!: (value: { id: string }) => void;
    next = () => new Promise((resolve) => (release = resolve));
    void observer.refetch();
    const checking = recordView(observer.getCurrentResult());
    expect(checking).toMatchObject({ record: { id: "first" }, phase: "checking", stale: true });
    release({ id: "second" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordView(observer.getCurrentResult()).record).toEqual({ id: "second" });

    next = async () => {
      throw new Error("offline");
    };
    await observer.refetch();
    expect(recordView(observer.getCurrentResult())).toMatchObject({ record: { id: "second" }, phase: "error" });

    next = () => new Promise(() => undefined);
    void client.resetQueries({ queryKey: ["record"], exact: true });
    expect(recordView(observer.getCurrentResult())).toMatchObject({ record: undefined, phase: "loading" });
    unsubscribe();
    client.clear();
  });
});

describe("keepRecordForSameItem", () => {
  it("keeps the last record only for the same item read again under a new fingerprint", () => {
    const keep = keepRecordForSameItem(["chat", "inbox-user-input", "w", "item-a", "fingerprint-2"]);
    expect(keep("record", { queryKey: ["chat", "inbox-user-input", "w", "item-a", "fingerprint-1"] })).toBe("record");
    expect(keep("record", { queryKey: ["chat", "inbox-user-input", "w", "item-b", "fingerprint-1"] })).toBeUndefined();
    expect(keep(undefined, { queryKey: ["chat", "inbox-user-input", "w", "item-a", "fingerprint-1"] })).toBeUndefined();
    expect(keep("record", undefined)).toBeUndefined();
  });
});
