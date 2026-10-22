import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { promises as fs } from "node:fs";
import { countFile, evaluate, RAW_VALUE_ROOTS } from "./check-mission-control-next-raw-values.mjs";

describe("raw-values guard", () => {
  it("counts each raw-value pattern", () => {
    const source = [
      "const label = humanizeToken(run.status);",
      'const mode = server.mode.replaceAll("_", " ");',
      "const when = new Date(item.createdAt).toLocaleString();",
      "const day = new Intl.DateTimeFormat(undefined, {}).format(at);",
      "const text = `Uploading ${count} attachment(s)`;",
      'const noun = `update${count === 1 ? "" : "s"}`;',
      "return <p>Workspace {approval.workspaceId}</p>;",
    ].join("\n");
    assert.deepEqual(countFile("areas/chat/X.tsx", source), {
      "humanize-token": 1,
      "manual-humanize": 1,
      "local-date-format": 2,
      "optional-plural": 1,
      "inline-plural": 1,
      "jsx-raw-id": 1,
    });
  });

  it("ignores number formatting, the TimeText primitive and IDs in plain .ts files", () => {
    assert.deepEqual(countFile("areas/work/X.ts", "const n = total.toLocaleString(); const id = `${run.runId}`;"), {});
    assert.deepEqual(countFile("ui/TimeText.tsx", "new Intl.DateTimeFormat().format(at)"), {});
    assert.deepEqual(countFile("areas/work/X.ts", "const raw = {item.workspaceId};"), {});
    assert.deepEqual(countFile("areas/work/X.tsx", "<li key={run.runId} data-id={run.taskId}>Run</li>"), {});
  });

  it("flags {x.checkedAt}-style ISO fields rendered outside TimeText or TechnicalDetails (ST-R03)", () => {
    assert.deepEqual(countFile("areas/x/X.tsx", "<p>Checked {probe.checkedAt} · built {report.generatedAt}</p>"), {
      "raw-iso-time": 2,
    });
    assert.deepEqual(countFile("areas/x/X.tsx", "<p>Updated {item.updatedAt}</p>"), { "raw-iso-time": 1 });
    assert.deepEqual(countFile("areas/x/X.tsx", "<TimeText value={probe.checkedAt} />"), {});
    // A template interpolation (a key or href) is not rendered text.
    assert.deepEqual(countFile("areas/x/X.tsx", "<li key={`${file.path}:${file.modifiedAt}`}>{file.path}</li>"), {});
    assert.deepEqual(countFile("areas/x/X.tsx", "<a href={`/runs/${run.runId}`}>Open run</a>"), {});
    // A rendered template still shows its interpolation.
    assert.deepEqual(countFile("areas/x/X.tsx", "<h2>{`Run ${run.runId}`}</h2>"), { "jsx-raw-id": 1 });
  });

  it("does not count ids inside TechnicalDetails or key= toward the budget", () => {
    const source = [
      "<TechnicalDetails>",
      "  <p>Run {run.runId} at {run.startedAt}: {run.lastError}</p>",
      "</TechnicalDetails>",
      '<TechnicalDetails label="IDs"><code>{approval.approvalId}</code></TechnicalDetails>',
      "<li key={run.runId}>Run</li>",
    ].join("\n");
    assert.deepEqual(countFile("areas/x/X.tsx", source), {});
  });

  it("flags lastError, step.error and report.error rendered as text", () => {
    const source = "<p>{runtime.lastError}</p><p>{step.error}</p><span>{report.error}</span>";
    assert.deepEqual(countFile("areas/x/X.tsx", source), { "raw-error-text": 3 });
    assert.deepEqual(countFile("areas/x/X.tsx", "<p>{presentErrorText(step.error).summary}</p>"), {});
    assert.deepEqual(countFile("areas/x/X.tsx", "<li>{tool.error}</li>"), { "raw-error-text": 1 });
    assert.deepEqual(countFile("areas/x/X.tsx", "<p>Grant ID: {record.grantId}</p>"), { "jsx-raw-id": 1 });
    // Hook state is already a presented message.
    assert.deepEqual(countFile("areas/x/X.tsx", "<p role=\"alert\">{owner.error}</p>"), {});
  });

  it("walks features/native-routes/settings and features/native-routes/ops", async () => {
    const dirs = RAW_VALUE_ROOTS.map((root) => root.dir.split(path.sep).join("/"));
    assert.ok(dirs.some((dir) => dir.endsWith("apps/mission-control-next/src/cockpit")));
    assert.ok(dirs.some((dir) => dir.endsWith("apps/mission-control-next/src/features/native-routes/settings")));
    assert.ok(dirs.some((dir) => dir.endsWith("apps/mission-control-next/src/features/native-routes/ops")));
    for (const root of RAW_VALUE_ROOTS) await fs.access(root.dir);
  });

  it("fails above the budget and asks for a lower budget below it", () => {
    const rules = [{ id: "humanize-token", budget: 2, help: "use a presenter" }];
    assert.deepEqual(evaluate({ "humanize-token": 2 }, rules), []);
    assert.match(evaluate({ "humanize-token": 3 }, rules)[0], /3 uses, budget 2/);
    assert.match(evaluate({ "humanize-token": 1 }, rules)[0], /lower the budget to 1/);
  });
});
