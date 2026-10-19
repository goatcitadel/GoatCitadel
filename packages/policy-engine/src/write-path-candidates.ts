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
      return candidates("write", outputPathOrRaw(() => resolveDocumentOutputPath(args), args.path));
    case "presentations.create":
      return candidates("write", outputPathOrRaw(() => resolvePresentationOutputPath(args), args.path));
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

/**
 * Model-supplied arguments may carry an unsupported format. Extraction must
 * never throw before policy runs, so fall back to the raw path; the executor
 * still rejects the format and records the failure.
 */
function outputPathOrRaw(resolve: () => string | undefined, rawPath: unknown): unknown {
  try {
    return resolve() ?? rawPath;
  } catch {
    return rawPath;
  }
}
