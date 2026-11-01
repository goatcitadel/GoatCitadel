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
      '<Field description="Cost posture comes from the canonical record." />',
      "<p>",
      "      Read status is checked for this caller.",
      "</p>",
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
      '<Field description="Replay the revision from the snapshot." />',
      "<span>Cost posture and canonical durable projection</span>",
    ].join("\n");
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", source), { "glossary-terms": 6, "internal-terms": 4 });
  });

  it("reads one-word copy props but not one-word code values", () => {
    const source = [
      '<Field label="Gateway" />',
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
      "<TechnicalDetails><code>Replay evidence</code></TechnicalDetails>",
    ].join("\n");
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", source), {});
  });

  it("still reads a TechnicalDetails label, concatenated copy and adjective plurals", () => {
    assert.deepEqual(
      countCopyRatchets("areas/x/X.tsx", '<TechnicalDetails label="Recall evidence">x</TechnicalDetails>'),
      {
        "glossary-terms": 1,
      },
    );
    assert.deepEqual(countCopyRatchets("areas/x/X.ts", 'const text = "Waiting on evidence, " + name;'), {
      "glossary-terms": 1,
    });
    assert.deepEqual(countCopyRatchets("areas/x/X.ts", "const text = `${count.known} known workspace items`;"), {
      "plural-template": 1,
    });
    // A ternary picks a verb for an already-pluralised count; it isn't a number-noun pair.
    assert.deepEqual(
      countCopyRatchets(
        "areas/x/X.ts",
        'const text = `${plural(n, "run")} ${count === 1 ? "is" : "are"} in this list`;',
      ),
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

  it("reads the JSX text the line scanner missed", () => {
    // Text followed by an expression on the same line.
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", "<p>The Gateway sent {count} items.</p>"), {
      "glossary-terms": 1,
    });
    // A single word on its own line.
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", ["<dt>", "  Evidence", "</dt>"].join("\n")), {
      "glossary-terms": 1,
    });
    // A text line that ends in a semicolon.
    assert.deepEqual(
      countCopyRatchets("areas/x/X.tsx", ["<p>", "  Ask the owner to review it; then retry.", "</p>"].join("\n")),
      { "glossary-terms": 1 },
    );
  });

  it("reads literals rendered as JSX children or copy props, but not other one-word values", () => {
    const source = [
      '<p>{ready ? "Snapshot" : "Waiting"}</p>',
      '<Field label={name ?? "Owner"} />',
      'const tab = { id: "evidence", title: "Evidence" };',
      '<Link href="/evidence" data-kind="owner" />',
    ].join("\n");
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", source), { "glossary-terms": 3 });
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
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", "<p>Approval(s) are pending.</p>"), { "plural-template": 1 });
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", 'const text = plural(count, "item");'), {});
    assert.deepEqual(
      countCopyRatchets("areas/x/X.tsx", 'const text = `Rejects ${plural(count, "request")} across workspaces`;'),
      {},
    );
  });

  it("counts a template once when a ${…} holds literals, but keeps counts that only use a literal in code", () => {
    const nested = 'const text = `${ok ? "Nothing to show." : `${response.total} matching records`} here`;';
    assert.deepEqual(countCopyRatchets("areas/x/X.ts", nested), { "plural-template": 1 });
    const filtered = 'const text = `${items.filter((item) => item.kind === "active").length} items`;';
    assert.deepEqual(countCopyRatchets("areas/x/X.ts", filtered), { "plural-template": 1 });
  });

  it("reads one-word literals joined into rendered copy or interpolated by a copy template", () => {
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", '<p>{"Gateway" + " status"}</p>'), { "glossary-terms": 1 });
    assert.deepEqual(countCopyRatchets("areas/x/X.tsx", '<p>{`${ready ? "Gateway" : "Owner"} status`}</p>'), {
      "glossary-terms": 2,
    });
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

  it("reads the copy written outside the cockpit that the cockpit shows as written", async () => {
    const shown = COPY_ROOTS.find((root) => root.id === "shown-as-written");
    assert.deepEqual(shown?.files, [
      "packages/contracts/src/hooks.ts",
      "apps/gateway/src/routes/capability-plugins.ts",
      "apps/gateway/src/services/capability-plugin-actions-service.ts",
      "apps/gateway/src/services/capability-plugin-inspection-service.ts",
      "apps/gateway/src/services/capability-plugin-detail.ts",
      "apps/gateway/src/services/capability-plugins-route-service.ts",
      "apps/gateway/src/services/plugin-owned-refusal.ts",
      "apps/gateway/src/services/plugin-uninstall-change-plan-adapter.ts",
      "apps/gateway/src/services/plugin-uninstall-scope.ts",
      "apps/gateway/src/services/plugin-uninstall-words.ts",
      "apps/gateway/src/services/plugin-source-service.ts",
      "apps/gateway/src/services/plugin-snapshot-store.ts",
      "apps/gateway/src/services/plugin-git-messages.ts",
      "apps/gateway/src/services/skill-hub-plugin-skill-source.ts",
    ]);
    // The skill import's Git words stay out: only a plugin fetch's own file is read.
    for (const skillWords of ["hardened-git.ts", "hardened-git-wording.ts"]) {
      assert.ok(!shown.files.includes(`apps/gateway/src/services/${skillWords}`), skillWords);
    }
    for (const file of shown.files) {
      const contents = await fs.readFile(path.join(shown.dir, ...file.split("/")), "utf8");
      // The guard really reads these files' copy: a glossary word in one of their lines would count.
      assert.deepEqual(countCopyRatchets(file, `${contents}\nconst line = "Read the Gateway snapshot.";\n`), {
        "glossary-terms": 2,
      });
    }
  });
});
