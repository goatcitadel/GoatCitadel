import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countFile, evaluate } from "./check-mission-control-next-raw-values.mjs";

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

  it("fails above the budget and asks for a lower budget below it", () => {
    const rules = [{ id: "humanize-token", budget: 2, help: "use a presenter" }];
    assert.deepEqual(evaluate({ "humanize-token": 2 }, rules), []);
    assert.match(evaluate({ "humanize-token": 3 }, rules)[0], /3 uses, budget 2/);
    assert.match(evaluate({ "humanize-token": 1 }, rules)[0], /lower the budget to 1/);
  });
});
