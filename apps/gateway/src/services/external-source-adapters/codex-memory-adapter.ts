import type { ExternalSourceAdapter } from "./types.js";
import {
  EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION,
  EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER,
  inspectFixedExternalSourceAdapter,
  isSafePathSegment,
  isStrictRelativePath,
  normalizeFixedExternalSourceAdapter,
  parseMarkdownText,
  type ExternalSourceParseState,
} from "./internal.js";

export class CodexMemoryExternalSourceAdapter implements ExternalSourceAdapter {
  public readonly adapterId = "codex.memory-markdown.v1" as const;
  public readonly sourceKind = "codex_memory" as const;
  public readonly adapterVersion = EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION;

  public recognizes(relativePath: string): boolean {
    return recognizesCodexMemoryPath(relativePath);
  }

  public inspect(input: Parameters<ExternalSourceAdapter["inspect"]>[0]) {
    return inspectFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesCodexMemoryPath,
      parse: parseCodexMemory,
    });
  }

  public normalize(input: Parameters<ExternalSourceAdapter["normalize"]>[0]) {
    return normalizeFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesCodexMemoryPath,
      parse: parseCodexMemory,
    });
  }
}

export const codexMemoryExternalSourceAdapter = Object.freeze(new CodexMemoryExternalSourceAdapter());

export function recognizesCodexMemoryPath(relativePath: string): boolean {
  if (!isStrictRelativePath(relativePath)) return false;
  if (relativePath === "MEMORY.md" || relativePath === "memory_summary.md") return true;
  const segments = relativePath.split("/");
  return (
    segments.length === 2 &&
    segments[0] === "rollout_summaries" &&
    (segments[1] ?? "").endsWith(".md") &&
    isSafePathSegment(segments[1] ?? "")
  );
}

function parseCodexMemory(input: {
  file: Parameters<ExternalSourceAdapter["inspect"]>[0]["file"];
  signal: AbortSignal;
  state: ExternalSourceParseState;
}) {
  input.state.foreignIdentity = input.file.relativePath;
  input.state.producerVersion = EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER;
  input.state.messageCount = 1;
  input.state.lineageNodes = [{ id: input.file.relativePath }];
  const text = parseMarkdownText(input.file.bytes, input.signal);
  return {
    foreignIdentity: input.file.relativePath,
    producerVersion: EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER,
    entries: [{ kind: "markdown" as const, text }],
    messageCount: 1,
    lineageNodes: input.state.lineageNodes,
  };
}
