import assert from "node:assert/strict";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  COPY_ROOTS,
  countCopyRatchets,
  evaluateCopyRatchets,
  findClassicHandoffCopy,
  walk,
} from "./check-mission-control-next-cockpit-copy.mjs";

const texts = (source) => findClassicHandoffCopy("item.tsx", source).map((finding) => finding.text);

describe("cockpit copy guard", () => {
  it("flags handoff phrasing that points at the classic shell as 'current'", () => {
    assert.deepEqual(texts('return "A decision is pending. Resolve it in current Chat.";'), [
      "Resolve it in current Chat",
    ]);
    assert.deepEqual(texts('<ClassicOwnerLink label="current Ops Kanban" />'), ["current Ops Kanban"]);
    assert.deepEqual(texts("<p>Connection setup is available in current Settings.</p>"), ["current Settings"]);
    assert.deepEqual(texts('<ClassicOwnerLink label="Review in current controls" />'), ["current controls"]);
  });

  it("allows descriptive uses that mean the present Chat", () => {
    assert.deepEqual(texts("<p>This legacy-only grant does not govern current Chat.</p>"), []);
    assert.deepEqual(texts('description="The Gateway will record this answer for the current Chat turn."'), []);
    assert.deepEqual(texts("`history is unavailable; current Chat turns are unchanged.`"), []);
    assert.deepEqual(texts('aria-label="Current Chat question"'), []);
    assert.deepEqual(texts("// the only destination is the bound current Chat selection."), []);
  });

  it("accepts the classic-view vocabulary", () => {
    assert.deepEqual(texts('<ClassicOwnerLink label="Open this question in the classic view" />'), []);
  });
});

describe("operator-language ratchets", () => {
  it("counts internal terms only in text an operator can read", () => {
    const source = [
      "const durableRun = await fetchDurableRun(runId);",
      'const key = ["durable", "projection"];',
      "<p>The Gateway-authored Inbox projection is stale.</p>",
      'description="Cost posture comes from the canonical record."',
      "      Read status is checked for this caller.",
      "// The durable projection is canonical.",
    ].join("\n");
    // "Gateway-authored" is both an internal term and a glossary word.
    assert.deepEqual(countCopyRatchets("areas/inbox/X.tsx", source), { "internal-terms": 5, "glossary-terms": 1 });
  });

  it("counts pointers without links and accessible names that read IDs", () => {
    assert.deepEqual(countCopyRatchets("areas/work/X.tsx", "<p>Review recovery in Ops.</p>"), {
      "dead-end-pointer": 1,
    });
    assert.deepEqual(countCopyRatchets("areas/work/X.tsx", "<p>Open run</p>"), {});
    assert.deepEqual(
      countCopyRatchets("areas/inbox/X.tsx", "<button aria-label={`Inspect decision ${approval.approvalId}`}>"),
      { "aria-label-id": 1 },
    );
  });

  it("fails above the budget and asks for a lower budget below it", () => {
    const rules = [{ id: "internal-terms", budget: 2, help: "use the glossary" }];
    assert.deepEqual(evaluateCopyRatchets({ "internal-terms": 2 }, rules), []);
    assert.match(evaluateCopyRatchets({ "internal-terms": 3 }, rules)[0], /3 uses, budget 2/);
    assert.match(evaluateCopyRatchets({}, rules)[0], /lower the budget to 0/);
  });
});

describe("glossary and plurals (GL-R02)", () => {
  it("flags glossary words in JSX text and string props", () => {
    const source = [
      "<p>The Gateway returned evidence for this owner.</p>",
      'description="Replay the revision from the snapshot."',
      "<span>Cost posture and canonical durable projection</span>",
    ].join("\n");
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", source), { "glossary-terms": 6, "internal-terms": 4 });
  });

  it("reads one-word copy props but not one-word code values", () => {
    const source = [
      '<Field label="Gateway">',
      "<Button title='Evidence' />",
      'if (kind === "evidence") return source === "gateway";',
      'const owner = { id: "owner" };',
    ].join("\n");
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", source), { "glossary-terms": 2 });
  });

  it("does not flag glossary words inside TechnicalDetails, code identifiers or className", () => {
    const source = [
      "const ownerId = gatewayEvidence.revision;",
      '<div className="evidence-panel owner-row grid gap-2">',
      "<TechnicalDetails>",
      "  <p>Gateway revision 41 from the owner snapshot.</p>",
      "</TechnicalDetails>",
      '<TechnicalDetails><code>Replay evidence</code></TechnicalDetails>',
    ].join("\n");
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", source), {});
  });

  it("still reads a TechnicalDetails label, concatenated copy and adjective plurals", () => {
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", '<TechnicalDetails label="Recall evidence">x</TechnicalDetails>'), {
      "glossary-terms": 1,
    });
    assert.deepEqual(countCopyRatchets("areas/x/X.ts", 'const text = "Waiting on evidence, " + name;'), {
      "glossary-terms": 1,
    });
    assert.deepEqual(countCopyRatchets("areas/x/X.ts", "const text = `${count.known} known workspace items`;"), {
      "plural-template": 1,
    });
    // A ternary picks a verb for an already-pluralised count; it isn't a number-noun pair.
    assert.deepEqual(
      countCopyRatchets("areas/x/X.ts", 'const text = `${plural(n, "run")} ${count === 1 ? "is" : "are"} in this list`;'),
      {},
    );
  });

  it("skips a line marked as not copy, such as search keywords", () => {
    const source = ["  // copy-guard: not copy (search keywords)", '  access: "gateway sign-in token",'].join("\n");
    assert.deepEqual(countCopyRatchets("areas/settings/settings-index.ts", source), {});
    assert.deepEqual(countCopyRatchets("areas/settings/x.ts", '  access: "gateway sign-in token",'), {
      "glossary-terms": 1,
    });
  });

  it("does not count identifiers inside a template's ${…} as copy", () => {
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", "const text = `Saved as version ${note.revision}.`;"), {});
  });

  it("does not read the code between two string literals as copy", () => {
    const source = 'return kind === "run" && (owner === "gateway" || owner.startsWith("mesh:"));';
    assert.deepEqual(countCopyRatchets("data/x.ts", source), {});
    const jsx = '<Button size="sm" onClick={() => owner.open({ kind: "catalog", packId })}>';
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", jsx), {});
  });

  it("flags number-noun templates that bypass plural()", () => {
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", "const text = `${count} items waiting`;"), {
      "plural-template": 1,
    });
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", "const text = `${items.length} runs`;"), {
      "plural-template": 1,
    });
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", '<p>Approval(s) are pending.</p>'), { "plural-template": 1 });
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", "const text = plural(count, \"item\");"), {});
    assert.deepEqual(
      countCopyRatchets("areas/x/X.tsx", 'const text = `Rejects ${plural(count, "request")} across workspaces`;'),
      {},
    );
  });

  it("fails on an unreadable directory", async () => {
    await assert.rejects(walk(path.join(os.tmpdir(), `missing-copy-root-${process.pid}-${Date.now()}`)));
  });

  it("walks features/native-routes and packages/mission-control-shared/src/components", async () => {
    const roots = COPY_ROOTS.map((root) => root.dir.split(path.sep).join("/"));
    assert.ok(roots.some((dir) => dir.endsWith("apps/mission-control-next/src/cockpit")));
    assert.ok(roots.some((dir) => dir.endsWith("apps/mission-control-next/src/features/native-routes")));
    assert.ok(roots.some((dir) => dir.endsWith("packages/mission-control-shared/src/components")));
    for (const root of COPY_ROOTS) await fs.access(root.dir);
  });
});
