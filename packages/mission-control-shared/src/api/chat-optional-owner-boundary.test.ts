import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const chatSource = source("./chat.ts");
const workbenchNames = ["fetchChatSessionWorkbench", "fetchChatSessionWorkbenchTree", "fetchChatSessionWorkbenchFile", "fetchChatSessionWorkbenchFileDiff", "fetchChatSessionWorkbenchDiff", "fetchChatSessionWorkbenchOutput"] as const;
const optionalNames = ["runChatDelegation", "runChatResearch", "streamChatDelegation", "suggestChatDelegation", "triggerChatProactive"] as const;

describe("optional API implementation ownership", () => {
  it.each([...workbenchNames, ...optionalNames])("forwards %s instead of retaining its implementation in mandatory chat", name => {
    expect(chatSource).not.toContain("export async function " + name + "(");
    const leaf = workbenchNames.includes(name as typeof workbenchNames[number]) ? "chat-workbench-operations" : "chat-optional-actions";
    const exports = [...chatSource.matchAll(/export\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g)];
    expect(exports.some(match => match[2] === leaf + ".js" && match[1]!.split(",").map(item => item.trim()).includes(name))).toBe(true);
  });
  it.each(["fetchChatDelegationRun", "fetchLatestChatWorkspaceExplorer", "fetchChatProactiveStatus"])("retains mandatory %s implementation", name => {
    expect(chatSource).toContain("export async function " + name + "(");
  });
  it.each(["../../../../packages/threaded-surface-core/src/chat/workbench-read-code.ts", "../../../../packages/threaded-surface-core/src/chat/workbench-action-code.ts", "../../../../apps/mission-control-next/src/cockpit/areas/work/run-workspace-context.ts"])("binds demanded workbench reads directly in %s", path => {
    const consumer = source(path);
    const imports = [...consumer.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)];
    for (const name of workbenchNames) {
      const matching = imports.find(match => match[1]!.split(",").some(item => item.trim().split(/\s+as\s+/)[0] === name));
      if (matching) expect(matching[2]).toBe("@goatcitadel/mission-control-shared/api/chat-workbench-operations");
    }
  });
  it("binds only the five proven optional delegation commands to their leaf", () => {
    const consumer = source("../../../../packages/threaded-surface-core/src/chat/delegation-action-code.ts");
    const imports = [...consumer.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)];
    for (const name of optionalNames) {
      const matching = imports.find(match => match[1]!.split(",").some(item => item.trim().split(/\s+as\s+/)[0] === name));
      expect(matching?.[2]).toBe("@goatcitadel/mission-control-shared/api/chat-optional-actions");
    }
    expect(consumer).toMatch(/fetchChatProactiveStatus/);
    expect(consumer).toMatch(/updateChatProactivePolicy/);
  });
});
