import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { assertProjectConversationScope, assertProjectReadRequests } from "./cockpit-chat-project-proof.mjs";
import { revealConversationRun, assertRenderingArtifact, assertRenderingRunLink, assertSourceLinks, clipboardText, RENDER_BAD_MERMAID, RENDER_MARKDOWN, RENDER_MERMAID, renderingReplyRules } from "./cockpit-chat-rendering-proof.mjs";

const sessions = [
  { sessionId: "a1", workspaceId: "workspace-a", projectId: "project-a", folderId: "folder-one" },
  { sessionId: "a2", workspaceId: "workspace-a", projectId: "project-a", folderId: "folder-two" },
  { sessionId: "b1", workspaceId: "workspace-a", projectId: "project-b", folderId: "folder-one" },
];
it("normalizes only clipboard line endings, preserving code and Markdown content", () => {
  assert.equal(clipboardText("one\r\ntwo\nthree"), "one\ntwo\nthree");
  assert.notEqual(clipboardText("one\r\nwrong"), "one\ntwo");
  assert.equal(clipboardText("  indented\r\n\r\n"), "  indented\n\n");
});
const project = { ownerItems: sessions, workspaceId: "workspace-a", projectId: "project-a", visibleIds: ["a1", "a2"] };
it("recognizes only exact unchanged-session routing inspections while rejecting actual writes and content capture", () => {
  const prefs = { a1: { mode: "chat", webMode: "auto", thinkingLevel: "standard" } };
  const inspection = { method: "POST", path: "/api/v1/chat/sessions/a1/route-preflight", body: { action: "send", prefsOverride: prefs.a1 } };
  assert.equal(assertProjectReadRequests([inspection], prefs), 1);
  for (const changed of [{ method: "PATCH" }, { path: "/api/v1/chat/sessions/a1/prefs" },
    { path: "/api/v1/chat/sessions/foreign/route-preflight" }, { body: { action: "send", content: "Unreviewed content" } },
    { body: { action: "retry" } }, { body: { action: "send", prefsOverride: { ...prefs.a1, thinkingLevel: "deep" } } }])
    assert.throws(() => assertProjectReadRequests([{ ...inspection, ...changed }], prefs));
});
it("compares visible project and folder choices with exact scoped owner records", () => {
  assert.doesNotThrow(() => assertProjectConversationScope(project));
  assert.doesNotThrow(() => assertProjectConversationScope({ ...project, folderId: "folder-two", visibleIds: ["a2"] }));
  assert.doesNotThrow(() => assertProjectConversationScope({ ...project, projectId: "all", visibleIds: ["a1", "a2", "b1"] }));
});
it("rejects foreign-project leakage, missing records and duplicated UI identity", () => {
  for (const visibleIds of [["a1", "a2", "b1"], ["a1"], ["a1", "a1"], []]) {
    assert.throws(() => assertProjectConversationScope({ ...project, visibleIds }));
  }
});
it("rejects foreign workspace owner results even when the project filter hides them", () => {
  assert.throws(() => assertProjectConversationScope({ ...project,
    ownerItems: [...sessions, { ...sessions[2], sessionId: "foreign", workspaceId: "foreign" }] }));
});
it("compares only owner search matches when the search result omits another same-project session", () => {
  assert.doesNotThrow(() => assertProjectConversationScope({ ...project, ownerItems: [sessions[0], sessions[2]], visibleIds: ["a1"] }));
  assert.throws(() => assertProjectConversationScope({ ...project, ownerItems: [sessions[0], sessions[2]] }));
});

const artifact = { artifactId: "artifact-a", sessionId: "session-a", workspaceId: "workspace-a", turnId: "turn-a",
  kind: "mermaid", content: RENDER_MERMAID, contentHash: createHash("sha256").update(RENDER_MERMAID).digest("hex"), version: 1 };
const artifactInput = { artifact, sessionId: artifact.sessionId, workspaceId: artifact.workspaceId, turnId: artifact.turnId, content: RENDER_MERMAID };
it("requires the exact encoded canonical run destination and explicit cockpit shell", () => {
  const input = { sessionId: "session-a", turn: { trace: { sessionId: "session-a", durable: { runId: "run/one?detail#part" } } },
    href: "/work/runs/run%2Fone%3Fdetail%23part?shell=cockpit" };
  assert.doesNotThrow(() => assertRenderingRunLink(input));
  for (const href of ["/work/runs/run%2Fone%3Fdetail%23part", "/work/runs/run%2Fone%3Fdetail%23part?shell=classic",
    "/work/runs/run/one?detail#part&shell=cockpit", "/work/runs/foreign?shell=cockpit", `${input.href}&workspaceId=foreign`]) {
    assert.throws(() => assertRenderingRunLink({ ...input, href }));
  }
  assert.throws(() => assertRenderingRunLink({ ...input, sessionId: "foreign" }));
  assert.throws(() => assertRenderingRunLink({ ...input, turn: { trace: { sessionId: input.sessionId } } }));
});
it("requires canonical Mermaid content/hash, version and exact session/turn scope", () => {
  assert.doesNotThrow(() => assertRenderingArtifact(artifactInput));
  for (const change of [{ artifactId: "" }, { sessionId: "foreign" }, { workspaceId: "foreign" }, { turnId: "foreign" },
    { content: "different" }, { contentHash: "f".repeat(64) }, { kind: "text" }, { version: 0 }]) {
    assert.throws(() => assertRenderingArtifact({ ...artifactInput, artifact: { ...artifact, ...change } }));
  }
});
const citations = [{ citationId: "citation-a", title: "Recorded source", url: "https://fixture.example.invalid/source" }];
const sourceInput = { citations, rendered: [{ title: citations[0].title, href: citations[0].url }],
  sessionId: "session-a", turn: { trace: { sessionId: "session-a" }, citations } };
it("requires Sources links to equal recorded turn evidence", () => {
  assert.doesNotThrow(() => assertSourceLinks(sourceInput));
  for (const rendered of [[], [{ title: "Incorrect label", href: citations[0].url }],
    [{ title: citations[0].title, href: "https://other.example.invalid/" }]]) {
    assert.throws(() => assertSourceLinks({ ...sourceInput, rendered }));
  }
  assert.throws(() => assertSourceLinks({ ...sourceInput, turn: { ...sourceInput.turn, trace: { sessionId: "foreign" } } }));
  assert.throws(() => assertSourceLinks({ ...sourceInput, turn: { ...sourceInput.turn, citations: [] } }));
});
it("withholds unsafe or malformed citation links and uses owner fallback labels", () => {
  const records = [{ url: "javascript:alert(1)", title: "Unsafe" }, { url: "data:text/html,x" },
    { url: "not-a-url" }, { url: "https://fixture.example.invalid" }];
  const input = { citations: records, turn: { trace: { sessionId: "session-a" }, citations: records }, sessionId: "session-a",
    rendered: [{ title: "Open source", href: "https://fixture.example.invalid/" }] };
  assert.doesNotThrow(() => assertSourceLinks(input));
  assert.throws(() => assertSourceLinks({ ...input, rendered: [...input.rendered, { title: "Unsafe", href: records[0].url }] }));
});
it("keeps deterministic reply rules correct when earlier prompts remain in conversation history", () => {
  const rules = renderingReplyRules();
  const prompts = ["COCKPIT_RENDER_MARKDOWN", "COCKPIT_MERMAID_VALID", "COCKPIT_MERMAID_INVALID"];
  const expected = [RENDER_MARKDOWN, `\`\`\`mermaid\n${RENDER_MERMAID}\n\`\`\``, `\`\`\`mermaid\n${RENDER_BAD_MERMAID}\n\`\`\``];
  for (let index = 0; index < prompts.length; index += 1) {
    const history = prompts.slice(0, index + 1).join("\n");
    assert.equal(rules.find((rule) => history.includes(rule.userContentIncludes)).replyText, expected[index]);
  }
});


it("reveals the virtual footer's actual named disclosure without changing its expanded state", async () => {
  const calls = [];
  const disclosure = { waitFor: async (options) => calls.push(["wait-disclosure", options]), scrollIntoViewIfNeeded: async () => calls.push(["reveal-disclosure"]) };
  const messages = {
    waitFor: async () => calls.push(["wait-messages"]),
    locator: (selector) => { assert.equal(selector, '[data-testid="virtuoso-scroller"]'); return { evaluate: async (fn) => {
      const element = { scrollTop: 0, scrollHeight: 2500 }; fn(element); assert.equal(element.scrollTop, 2500); calls.push(["latest"]);
    } }; },
    getByRole: (role, options) => { calls.push([role, options]); return disclosure; },
  };
  const page = { getByRole: (role, options) => { calls.push([role, options]); return messages; } };
  assert.equal(await revealConversationRun(page), disclosure);
  assert.deepEqual(calls, [["region", { name: "Messages", exact: true }], ["wait-messages"], ["latest"],
    ["group", { name: "Conversation run", exact: true }], ["wait-disclosure", { state: "attached", timeout: 15000 }], ["reveal-disclosure"]]);
});
