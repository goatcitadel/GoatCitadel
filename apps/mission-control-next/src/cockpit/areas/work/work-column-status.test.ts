import { describe, expect, it } from "vitest";
import { recordView } from "../../data/record-view";
import { workColumnStatus } from "./work-column-status";

const query = (state: { data?: unknown; isPending?: boolean; isFetching?: boolean; isError?: boolean }) =>
  recordView({
    data: state.data,
    isPending: state.isPending ?? state.data === undefined,
    isFetching: state.isFetching ?? false,
    isError: state.isError ?? false,
    dataUpdatedAt: state.data === undefined ? 0 : 1,
  });

describe("work column status", () => {
  it("keeps the last good count while a background refetch checks it", () => {
    expect(workColumnStatus(query({ data: {} }), 3, "tasks")).toBe("3 tasks");
    expect(workColumnStatus(query({ data: {}, isFetching: true }), 3, "tasks")).toBe("3 tasks (checking)");
    expect(workColumnStatus(query({ data: {}, isError: true }), 2, "runs")).toBe("2 runs (stale)");
  });

  it("uses the singular noun for exactly one record", () => {
    expect(workColumnStatus(query({ data: {} }), 1, "tasks")).toBe("1 task");
    expect(workColumnStatus(query({ data: {}, isFetching: true }), 1, "runs")).toBe("1 run (checking)");
    expect(workColumnStatus(query({ data: {} }), 0, "runs")).toBe("0 runs");
    expect(workColumnStatus(query({ data: {} }), 2, "tasks")).toBe("2 tasks");
  });

  it("says loading before the first answer and unavailable when there is none", () => {
    expect(workColumnStatus(query({ isPending: true, isFetching: true }), undefined, "tasks")).toBe("Tasks loading");
    expect(workColumnStatus(query({ isPending: true, isError: true }), undefined, "runs")).toBe("Runs unavailable");
    expect(workColumnStatus(query({ isPending: true }), undefined, "runs")).toBe("Runs unavailable");
  });
});

describe("WK-06 work column counts", () => {
  it("says how many of the counted records the capped list shows", () => {
    expect(workColumnStatus(query({ data: {} }), 80, "tasks", { shown: 25 })).toBe("25 of 80 tasks shown");
    expect(workColumnStatus(query({ data: {}, isFetching: true }), 30, "runs", { shown: 25 })).toBe(
      "25 of 30 runs shown (checking)",
    );
    expect(workColumnStatus(query({ data: {} }), 3, "tasks", { shown: 3 })).toBe("3 tasks");
  });

  it("names a filtered count as matching", () => {
    expect(workColumnStatus(query({ data: {} }), 1, "tasks", { shown: 1, matching: true })).toBe("1 matching task");
    expect(workColumnStatus(query({ data: {} }), 40, "runs", { shown: 25, matching: true })).toBe(
      "25 of 40 matching runs shown",
    );
  });
});
