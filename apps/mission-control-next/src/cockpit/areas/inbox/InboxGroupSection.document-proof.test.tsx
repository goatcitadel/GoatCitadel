// @vitest-environment happy-dom
import { act, useState } from "react";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { InboxGroupSection } from "./InboxGroupSection";
let openInboxDocumentProposalRow: (page: ReturnType<typeof bridge>, item: OperatorInboxItem, workspaceId: string) => Promise<void>;
beforeAll(() => {
  // happy-dom/Vite can rewrite import.meta.url to HTTP. Resolve the current checkout through Node's filesystem instead.
  let directory = process.cwd();
  let proofPath: string | undefined;
  while (!proofPath) {
    const candidate = resolve(directory, "scripts/verification/lib/scenarios/ux-budget-inbox-changes.mjs");
    if (existsSync(candidate)) { proofPath = candidate; break; }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the maintained Inbox verification helper from this checkout.");
    directory = parent;
  }
  expect(statSync(proofPath).isFile()).toBe(true);
  // Bypass Vitest's transformed dynamic importer. Node22 can require this ESM graph: all awaits are inside functions.
  const requireFromProof = createRequire(proofPath);
  const module = requireFromProof(proofPath) as { openInboxDocumentProposalRow: typeof openInboxDocumentProposalRow };
  openInboxDocumentProposalRow = module.openInboxDocumentProposalRow;
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root; let opened: string[];
const item = (proposalId: string, workspaceId = "workspace"): OperatorInboxItem => ({
  id: "document_proposal:" + proposalId, kind: "document_proposal", group: "proposals", title: "Review note edit", summary: "Review note edit",
  source: { proposalId, workspaceId }, href: "/library/notes", createdAt: "2026-11-04T00:00:00Z",
});
const receiveList = () => undefined;
function Harness({ items }: { items: OperatorInboxItem[] }) {
  const [selected, select] = useState<string | null>(null);
  return <><InboxGroupSection group={{ id: "proposals", label: "Proposals" }} items={items} known={items.length} exact filtered={false}
    emptyMessage="None" selectedId={selected} listRef={receiveList} renderItem={(entry) => <article>
      <h3>{entry.title}</h3><button type="button" onClick={() => { opened.push(entry.source.proposalId!); select(entry.id); }}>Details</button>
    </article>} />{selected ? <section aria-label="Current document proposal">{selected}</section> : null}</>;
}
type LocatorBridge = {
  waitFor: () => Promise<void>; count: () => Promise<number>; getAttribute: (name: string) => Promise<string | null>;
  getByRole: (role: string, options: { name: string; exact: boolean }) => LocatorBridge; click: () => Promise<void>;
};
function bridge() {
  let captured: { id: string; escaped: string } | undefined;
  const locate = (read: () => Element[]): LocatorBridge => ({
    async waitFor() { if (read().length !== 1) throw new Error("Missing or ambiguous exact row/control"); },
    async count() { return read().length; },
    async getAttribute(name: string) { const values = read(); if (values.length !== 1) throw new Error("Ambiguous attribute"); return values[0]!.getAttribute(name); },
    getByRole(role: string, options: { name: string; exact: boolean }) {
      expect(role).toBe("button"); expect(options.exact).toBe(true);
      return locate(() => read().flatMap((element) => [...element.querySelectorAll("button")]).filter((button) => button.textContent === options.name));
    },
    async click() { const values = read(); if (values.length !== 1) throw new Error("Ambiguous click"); await act(async () => (values[0] as HTMLElement).click()); },
  });
  return { async evaluate(fn: (id: string) => string, id: string) {
      const escaped = fn(id);
      expect(escaped).toBe(CSS.escape(id));
      captured = { id, escaped };
      return escaped;
    },
    locator(selector: string) {
      if (!captured) throw new Error("Canonical CSS.escape identity was not captured");
      expect(selector).toBe(`[data-inbox-row="${captured.escaped}"][data-inbox-item]`);
      // Chromium proof451 covers native escaped-selector parsing. HappyDOM21 misparses escaped quotes;
      // enumerate the actual rendered rows only after verifying that exact proven selector.
      const id = captured.id;
      return locate(() => [...host.querySelectorAll("[data-inbox-row][data-inbox-item]")]
        .filter((element) => element.getAttribute("data-inbox-row") === id));
    },
    async waitForFunction(fn: (id: string) => boolean, id: string) { expect(fn(id)).toBe(true); },
  };
}
beforeEach(() => { opened = []; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.each(["mobile-proposal", "same-workspace", 'proposal:["quoted"]\\part\nend'])("opens only the canonical row %s when both real rendered titles are identical", async (id) => {
  const older = item("desktop-proposal", id === "same-workspace" ? "workspace" : "other-workspace"); const target = item(id);
  await act(async () => root.render(<Harness items={[older, target]} />));
  expect(host.querySelectorAll("h3")).toHaveLength(2);
  await openInboxDocumentProposalRow(bridge(), target, "workspace");
  expect(opened).toEqual([id]);
  expect(host.querySelector('[aria-label="Current document proposal"]')?.textContent).toBe(target.id);
});

it.each(["missing", "duplicate"])("fails a %s exact ID instead of selecting another same-title row", async (mode) => {
  const target = item("target"); const older = item("other");
  await act(async () => root.render(<Harness items={mode === "missing" ? [older] : [older, target]} />));
  if (mode === "duplicate") {
    const exact = [...host.querySelectorAll("[data-inbox-row]")].filter((element) => element.getAttribute("data-inbox-row") === target.id);
    expect(exact).toHaveLength(1); exact[0]!.parentElement!.append(exact[0]!.cloneNode(true));
  }
  await expect(openInboxDocumentProposalRow(bridge(), target, "workspace")).rejects.toThrow(/Missing or ambiguous/);
  expect(opened).toEqual([]);
});

it("rejects a source/workspace mismatch before touching the rendered row", async () => {
  const target = item("target", "foreign");
  await act(async () => root.render(<Harness items={[target]} />));
  await expect(openInboxDocumentProposalRow(bridge(), target, "workspace")).rejects.toThrow(/canonical owner and workspace/);
  expect(opened).toEqual([]);
});
