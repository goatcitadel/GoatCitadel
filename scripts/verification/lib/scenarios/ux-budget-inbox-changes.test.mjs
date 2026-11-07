import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runScenario, writeJson } from "../shared.mjs";
import { createVerificationRunManifest } from "../validation.mjs";
import { runUxBudgetInboxChanges } from "./ux-budget-inbox-changes.mjs";

async function fixture(mode) {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-inbox-document-evidence-"));
  const context = { artifactRoot, lane: "ux-budgets", manifest: createVerificationRunManifest({ runId: "inbox-document-test", lane: "ux-budgets",
    startedAt: new Date().toISOString(), repoRoot: "fixture", artifactRoot }) };
  const notes = [], proposals = [], items = [], events = [], decisions = [], audits = [], selected = [];
  const rowTitle = "Review note edit";
  const requestJson = async (_gateway, route, options = {}) => {
    if (route === "/api/v1/notes" && options.method === "POST") {
      const note = { noteId: "note-" + (notes.length + 1), revision: 1, ...options.body }; notes.push(note); return { body: note };
    }
    if (route === "/api/v1/chat/document-patch-proposals" && options.method === "POST") {
      const proposal = { proposalId: "proposal-" + (proposals.length + 1), state: "pending", derivedDiff: options.body.proposedContent, ...options.body };
      proposals.push(proposal); items.push({ id: "document_proposal:" + proposal.proposalId, title: rowTitle,
        source: { workspaceId: "workspace", proposalId: proposal.proposalId } });
      return { body: { item: proposal } };
    }
    if (route.startsWith("/api/v1/inbox?")) return { body: { items: items.filter((entry) => proposals.find((proposal) => proposal.proposalId === entry.source.proposalId).state === "pending") } };
    if (route.startsWith("/api/v1/chat/document-patch-proposals?")) {
      if (mode === "stale-owner") proposals.at(-1).workspaceId = "foreign-workspace";
      return { body: { items: proposals } };
    }
    if (route.startsWith("/api/v1/notes?")) return { body: { items: notes } };
    throw new Error("Unexpected API route in document scenario fixture");
  };
  const browser = { async newContext({ viewport }) {
    const variant = viewport.width > 500 ? "desktop" : "mobile";
    const proposal = proposals.at(-1), item = items.at(-1);
    let focusedControl;
    const interaction = (name) => ({
      async count() { return 1; },
      async focus() { focusedControl = name; events.push("focus:" + variant); },
      async press(key) {
        events.push("keyboard:" + variant);
        focusedControl = key === "Shift+Tab" ? "Open notes" : name === "Open notes" ? "Apply change" : "Reject change";
      },
      async evaluate(fn) {
        events.push("geometry:" + variant);
        if (fn.toString().includes("getBoundingClientRect")) {
          if (mode === "measurement-error") throw new Error("Synthetic layout unavailable");
          return { width: 70, height: mode === "geometry" ? 17 : 24, inViewport: true, unobscured: true,
            visible: true, keyboardFocused: mode !== "keyboard" && focusedControl === name, href: "/library/notes?shell=cockpit" };
        }
        return focusedControl === name;
      },
    });
    const details = { async waitFor() {}, async count() { return 1; }, async click() { selected.push(item.id); events.push("open:" + variant); } };
    const row = { async waitFor(options) { assert.equal(options.state, "visible"); }, async count() { return 1; }, async getAttribute(name) { assert.equal(name, "data-inbox-row"); return item.id; },
      getByRole(role, options) { assert.equal(role, "button"); assert.deepEqual(options, { name: "Details", exact: true }); return details; } };
    const detail = { getByText(text) { return { async waitFor() {
      if (text.startsWith("Proposal ")) assert.equal(proposal.state, variant === "desktop" ? "applied" : "rejected");
      else assert.equal(text, proposal.proposedContent);
    } }; }, getByRole(role, { name }) {
      if (role === "link") { assert.equal(name, "Open notes"); return interaction(name); }
      assert.equal(role, "button"); assert.ok(["Apply change", "Reject change", "Refresh"].includes(name));
      return { ...interaction(name), async waitFor() {}, async click() { assert.equal(name, variant === "desktop" ? "Apply change" : "Reject change"); decisions.push([variant, proposal.proposalId]); events.push("decision:" + variant);
        proposal.state = variant === "desktop" ? "applied" : "rejected";
        if (variant === "desktop") notes.find((note) => note.noteId === proposal.targetId).body = proposal.proposedContent;
      } };
    } };
    const page = { variant, async goto() {}, async waitForSelector() {}, async waitForTimeout() {}, async addScriptTag() {},
      async screenshot({ path: file }) { events.push("screenshot:" + path.basename(file)); },
      async evaluate(fn, id) {
        if (typeof id === "string") { assert.match(fn.toString(), /CSS\.escape/); assert.equal(id, item.id); return "CSS_ESCAPED_CANONICAL_ID"; }
        return { scrollWidth: viewport.width + (mode === "overflow" ? 30 : 0), clientWidth: viewport.width };
      }, locator(selector) {
        assert.equal(selector, '[data-inbox-row="CSS_ESCAPED_CANONICAL_ID"][data-inbox-item]'); return row;
      }, getByRole(role, { name }) { assert.equal(role, "region"); assert.equal(name, "Current document proposal"); return detail; },
      async waitForFunction(_fn, id) { if (typeof id === "string") assert.equal(selected.at(-1), id); },
    };
    return { async addInitScript() {}, async newPage() { return page; }, async close() { events.push("close:" + variant); } };
  } };
  const deps = {
    assertOk: () => undefined, axeSourcePath: "unused-in-unit-fixture", path,
    auditPageAccessibility: async (page) => {
      audits.push(page.variant); events.push("audit:" + page.variant);
      const violations = ["target-size", "writer-failure"].includes(mode) ? [{ id: "target-size", impact: "serious", tags: ["wcag22aa"], help: "Check spacing",
        nodes: [{ target: ["#first"], html: '<button data-secret="password=syntheticEvidenceSecret">Details</button>', failureSummary: "Target small" },
          { target: ["#second"], html: "<button>Apply change</button>", failureSummary: "Target small" }] }] : [];
      violations.filter = function (...args) { events.push("blocking-filter:" + page.variant); return Array.prototype.filter.apply(this, args); };
      return { testEngine: { name: "axe-core", version: "4.10" }, url: "https://ui.test/inbox?password=syntheticEvidenceSecret", violations };
    },
    buildVerificationUiUrl: (_origin, route) => route,
    emptyArtifacts: (value) => ({ diagnostics: [], screenshots: [], logs: [], perf: [], traces: [], playwright: [], ...value }),
    installMissionControlNextBrowserState: async () => undefined,
    relativeToRun: (_context, file) => path.relative(artifactRoot, file).replaceAll("\\", "/"), requestJson,
    runScenario: async (value, definition, callback) => {
      if (!definition.id.includes("document-proposal")) return;
      return runScenario(value, definition, callback);
    },
    writeJson: async (file, value) => {
      const variant = value.variant; events.push("write-axe:" + variant);
      assert.equal(JSON.stringify(value).includes("syntheticEvidenceSecret"), false);
      if (["writer-failure", "evidence-only-gap"].includes(mode)) throw new Error("password=syntheticWriterSecret");
      return writeJson(file, value);
    },
  };
  return { context, events, decisions, audits, selected, notes, proposals, items,
    async run() { await runUxBudgetInboxChanges({ context, browser, stack: { gatewayUrl: "mock-gateway", uiUrl: "mock-ui" },
      fixture: { workspaceId: "workspace", citadelId: "citadel" }, deps }); },
    async close() { await fs.rm(artifactRoot, { recursive: true, force: true }); },
  };
}

for (const mode of ["target-size", "overflow", "writer-failure", "evidence-only-gap", "pass", "stale-owner", "geometry", "keyboard", "measurement-error"]) {
  test("document scenario preserves owner fences, same-audit evidence and recorded result for " + mode, async () => {
    const f = await fixture(mode);
    try {
      await f.run();
      assert.deepEqual(f.audits, ["desktop", "mobile"]);
      assert.deepEqual(f.selected, ["document_proposal:proposal-1", "document_proposal:proposal-2"]);
      const scenarios = f.context.manifest.scenarios;
      assert.equal(scenarios.length, 2);
      const persisted = JSON.parse(await fs.readFile(path.join(f.context.artifactRoot, "manifest.json"), "utf8"));
      assert.deepEqual(persisted.scenarios.map((entry) => entry.status), scenarios.map((entry) => entry.status));
      for (const variant of ["desktop", "mobile"]) {
        const capture = f.events.indexOf("write-axe:" + variant), decision = f.events.indexOf("blocking-filter:" + variant);
        assert.ok(capture > f.events.indexOf("audit:" + variant)); assert.ok(capture < decision);
        const interaction = f.events.indexOf("focus:" + variant);
        if (["target-size", "overflow", "writer-failure", "evidence-only-gap"].includes(mode)) assert.equal(interaction, -1);
        else assert.ok(interaction > capture, "Same-audit evidence must be saved before new interaction checks");
      }
      if (mode === "pass") {
        assert.deepEqual(scenarios.map((entry) => entry.status), ["passed", "passed"]);
        assert.deepEqual(f.decisions, [["desktop", "proposal-1"], ["mobile", "proposal-2"]]);
        assert.equal(f.notes[0].body, "After desktop review"); assert.equal(f.notes[1].body, "Before mobile review");
      } else {
        assert.deepEqual(scenarios.map((entry) => entry.status), ["failed", "failed"]);
        assert.deepEqual(f.decisions, []); assert.ok(f.proposals.every((entry) => entry.state === "pending"));
        assert.ok(f.notes.every((entry) => entry.body.startsWith("Before ")));
        assert.equal(f.items[0].title, f.items[1].title);
      }
      for (const scenario of scenarios) {
        if (["target-size", "writer-failure"].includes(mode)) assert.match(scenario.error, /accessibility target-size; overflow 0px/);
        if (mode === "overflow") assert.match(scenario.error, /accessibility clear; overflow 30px/);
        if (mode === "evidence-only-gap") assert.match(scenario.error, /accessibility evidence incomplete/);
        if (["geometry", "keyboard", "measurement-error"].includes(mode)) {
          assert.match(scenario.error, /Library link target or keyboard focus failed/);
          assert.equal(scenario.metrics.libraryLink.pass, false);
        }
        if (["writer-failure", "evidence-only-gap"].includes(mode)) {
          assert.equal(scenario.artifacts.diagnostics.length, 0); assert.match(scenario.notes.join(" "), /evidence gap: write_failure/);
          assert.equal(scenario.error.includes("syntheticWriterSecret"), false);
        } else if (mode !== "stale-owner") {
          assert.equal(scenario.artifacts.diagnostics.length, 1);
          const report = JSON.parse(await fs.readFile(path.join(f.context.artifactRoot, scenario.artifacts.diagnostics[0]), "utf8"));
          assert.equal(report.complete, true); assert.equal(report.counts.expectedNodes, mode === "target-size" ? 2 : 0);
          assert.equal(report.counts.writtenNodes, report.counts.expectedNodes);
        }
        if (mode !== "stale-owner") assert.equal(scenario.artifacts.screenshots.length, mode === "pass" ? 2 : 1);
      }
    } finally { await f.close(); }
  });
}
