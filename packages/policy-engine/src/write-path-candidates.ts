import type { ToolAccessEvaluateRequest } from "@goatcitadel/contracts";
import type { ToolWriteIntent } from "./sandbox/tool-write-gate.js";
import { resolveDocumentOutputPath, resolvePresentationOutputPath } from "./tool-executor/artifact-executor.js";

/** A filesystem target a write-capable tool will create, change, or remove. */
export interface WritePathCandidate {
  path: string;
  intent: ToolWriteIntent;
}

/**
 * The write targets of a tool request, shared by the policy engine (structural
 * check, outside-root approvals) and the executor (admission re-check) so both
 * see exactly the path the tool will write. Document and presentation paths get
 * the same extension the artifact executor applies.
 */
export function extractWritePathCandidates(
  request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">,
): WritePathCandidate[] {
  const args = request.args;
  if (!args) {
    return [];
  }
  const readString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const candidates = (intent: ToolWriteIntent, ...values: unknown[]): WritePathCandidate[] =>
    values
      .map(readString)
      .filter((value): value is string => Boolean(value))
      .map((value) => ({ path: value, intent }));
  switch (request.toolName) {
    case "fs.write":
    case "fs.patch":
    case "artifacts.create":
      return candidates("write", args.path);
    case "documents.create":
      return candidates("write", resolveDocumentOutputPath(args));
    case "presentations.create":
      return candidates("write", resolvePresentationOutputPath(args));
    case "fs.delete":
      return candidates("delete", args.path, args.from);
    case "fs.copy":
      return candidates("write", args.to);
    case "fs.move":
      return [...candidates("delete", args.from), ...candidates("write", args.to)];
    case "browser.screenshot":
    case "browser.interact":
      return candidates("write", args.outputPath, args.path);
    default:
      return [];
  }
}
