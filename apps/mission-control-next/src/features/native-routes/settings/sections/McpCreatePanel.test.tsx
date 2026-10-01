import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { McpCreatePanel } from "./McpCreatePanel";
import { createEmptyMcpCreateForm } from "./mcp-editor-drafts";

it("shows copied authentication references and policy before classic registration", () => {
  const draft = { ...createEmptyMcpCreateForm(), label: "Reviewed template", command: "node", args: ["worker.js"],
    authType: "token" as const, trustTier: "trusted" as const, costTier: "paid" as const,
    policy: { requireFirstToolApproval: true, redactionMode: "strict" as const, allowedToolPatterns: ["read.*"], blockedToolPatterns: ["write.*"], allowedEnvKeys: ["FIXTURE_KEY"], notes: "Read-only fixture" } };
  const submit = vi.fn();
  const html = renderToStaticMarkup(<McpCreatePanel createForm={draft} setCreateForm={vi.fn()} busy={false} handleCreate={submit} data={{ templates: [] }} />);
  for (const text of ["MCP registration policy review", "trusted", "paid", "Token environment references", "Required by server policy", "strict", "read.*", "write.*", "FIXTURE_KEY", "Read-only fixture", "does not connect the server"])
    expect(html).toContain(text);
  expect(submit).not.toHaveBeenCalled();
});
