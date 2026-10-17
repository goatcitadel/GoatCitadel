import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findEmptyMessageAlerts, findRefetchHiddenRecords } from "./check-mission-control-next-cockpit-refetch.mjs";

const lines = (source, file = "panel.tsx") => findRefetchHiddenRecords(file, source).map((finding) => finding.line);

describe("cockpit refetch guard", () => {
  it("flags a record hidden behind isFetching", () => {
    assert.deepEqual(lines("const record = query.isFetching ? undefined : query.data;"), [1]);
    assert.deepEqual(lines("const record = query.isFetching ? null : query.data;"), [1]);
    assert.deepEqual(lines('const name = scope.isFetching ? "Reading Citadel…" : scope.data?.name;'), [1]);
    assert.deepEqual(lines("const name = scope.isFetching ? 'Reading…' : scope.data?.name;"), [1]);
  });

  it("flags isFetching || isError ? undefined", () => {
    assert.deepEqual(lines("const proposal = query.isFetching || query.isError ? undefined : query.data;"), [1]);
  });

  it("flags !q.isFetching && … ? q.data", () => {
    assert.deepEqual(
      lines("const data = !resourceQuery.isFetching && !resourceQuery.isError ? resourceQuery.data : undefined;"),
      [1],
    );
    assert.deepEqual(lines("const data = !query.isError && !query.isFetching ? query.data : undefined;"), [1]);
  });

  it("flags a Prettier-split ternary that hides the record", () => {
    assert.deepEqual(
      lines(["const record =", "  query.isFetching", "    ? undefined", "    : query.data;"].join("\n")),
      [2],
    );
    assert.deepEqual(
      lines(["const record = query.isFetching || query.isError", "  ? null", "  : query.data;"].join("\n")),
      [1],
    );
    assert.deepEqual(lines(["{scope.isFetching", '  ? "Reading Citadel…"', "  : scope.data?.name}"].join("\n")), [1]);
    assert.deepEqual(
      lines(["const data = !query.isFetching && !query.isError", "  ? query.data", "  : undefined;"].join("\n")),
      [1],
    );
  });

  it("allows split ternaries that keep the record or only gate a control", () => {
    assert.deepEqual(
      lines(
        ["const label = query.isFetching", '  ? query.data?.name ?? "Unnamed"', "  : query.data?.name;"].join("\n"),
      ),
      [],
    );
    assert.deepEqual(lines(["<Button disabled={query.isFetching}>", "  ? Help", "</Button>"].join("\n")), []);
    assert.deepEqual(
      lines(
        [
          "const record = query.isFetching // refetch-guard: allow export must read a settled record",
          "  ? undefined",
          "  : query.data;",
        ].join("\n"),
      ),
      [],
    );
  });

  it("reports the line of each hit", () => {
    const source = ["const ok = true;", "const record = query.isFetching ? undefined : query.data;", ""].join("\n");
    assert.deepEqual(lines(source), [2]);
  });

  it("allows lines that keep the record", () => {
    assert.deepEqual(lines("const view = recordView(query, (data) => data);"), []);
    assert.deepEqual(
      lines("<Button disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button>"),
      [],
    );
    assert.deepEqual(lines('{runs.isFetchingNextPage ? "Loading runs…" : "Load more runs"}'), []);
    assert.deepEqual(
      lines(
        '{next ? <Button disabled={query.isFetching} onClick={load}>{query.isFetchingNextPage ? "Loading…" : "Load older"}</Button> : null}',
      ),
      [],
    );
  });

  it("allows an opt-out with a reason", () => {
    assert.deepEqual(
      lines(
        "const record = query.isFetching ? undefined : query.data; // refetch-guard: allow export must read a settled record",
      ),
      [],
    );
  });

  it("still flags an opt-out without a real reason", () => {
    assert.deepEqual(lines("const record = query.isFetching ? undefined : query.data; // refetch-guard: allow"), [1]);
    assert.deepEqual(
      lines("const record = query.isFetching ? undefined : query.data; // refetch-guard: allow short"),
      [1],
    );
  });

  it("ignores test files", () => {
    assert.deepEqual(lines("const record = query.isFetching ? undefined : query.data;", "panel.test.tsx"), []);
  });
});

describe("empty message alerts", () => {
  const alerts = (source, file = "panel.tsx") => findEmptyMessageAlerts(file, source).map((finding) => finding.line);

  it("flags an alert whose only content is an optional message", () => {
    assert.deepEqual(alerts('{op.locked ? <Callout tone="warning">{op.attempt?.message}</Callout> : null}'), [1]);
    assert.deepEqual(alerts("<Alert>{query.error?.message}</Alert>"), [1]);
  });

  it("allows an alert gated on its own message", () => {
    assert.deepEqual(
      alerts('{op.locked && op.attempt?.message ? <Callout tone="warning">{op.attempt?.message}</Callout> : null}'),
      [],
    );
    assert.deepEqual(alerts("{query.error?.message && <Alert>{query.error?.message}</Alert>}"), []);
    assert.deepEqual(alerts('<Callout tone="warning">{attempt.message}</Callout>'), []);
  });

  it("allows an opt-out with a reason and ignores test files", () => {
    assert.deepEqual(
      alerts("<Alert>{query.error?.message}</Alert> // refetch-guard: allow the parent gates on query.isError"),
      [],
    );
    assert.deepEqual(alerts("<Alert>{query.error?.message}</Alert>", "panel.test.tsx"), []);
  });
});
