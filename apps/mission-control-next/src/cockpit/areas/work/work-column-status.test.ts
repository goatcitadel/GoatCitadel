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

  it("says loading before the first answer and unavailable when there is none", () => {
    expect(workColumnStatus(query({ isPending: true, isFetching: true }), undefined, "tasks")).toBe("Tasks loading");
    expect(workColumnStatus(query({ isPending: true, isError: true }), undefined, "runs")).toBe("Runs unavailable");
    expect(workColumnStatus(query({ isPending: true }), undefined, "runs")).toBe("Runs unavailable");
  });
});
