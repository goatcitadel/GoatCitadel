import { createHash } from "node:crypto";
import { executeBrowserTool, loadedBrowserSessionAccessBuild } from "./browser-tools.js";
import { ToolPolicyEngine } from "./engine.js";
import { executeTool } from "./tool-executor.js";

const toolPolicyEngineSource = Function.prototype.toString.call(ToolPolicyEngine);
const toolExecutorSource = Function.prototype.toString.call(executeTool);
const browserDispatcherSource = Function.prototype.toString.call(executeBrowserTool);

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

// Identify the loaded execution entry points and the browser-session access implementation.
export const loadedPolicyEngineBuild = Object.freeze({
  executionSha256: sha256(
    JSON.stringify([
      toolPolicyEngineSource,
      toolExecutorSource,
      browserDispatcherSource,
      loadedBrowserSessionAccessBuild.sha256,
    ]),
  ),
  executionComponents: Object.freeze({
    toolPolicyEngine: sha256(toolPolicyEngineSource),
    toolExecutor: sha256(toolExecutorSource),
    browserDispatcher: sha256(browserDispatcherSource),
  }),
  browserSessionAccess: loadedBrowserSessionAccessBuild,
});
