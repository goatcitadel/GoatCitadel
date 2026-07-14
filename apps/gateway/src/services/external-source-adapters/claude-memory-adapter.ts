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

export class ClaudeMemoryExternalSourceAdapter implements ExternalSourceAdapter {
  public readonly adapterId = "claude.memory-markdown.v1" as const;
  public readonly sourceKind = "claude_memory" as const;
  public readonly adapterVersion = EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION;

  public recognizes(relativePath: string): boolean {
    return recognizesClaudeMemoryPath(relativePath);
  }

  public inspect(input: Parameters<ExternalSourceAdapter["inspect"]>[0]) {
    return inspectFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesClaudeMemoryPath,
      parse: parseClaudeMemory,
    });
  }

  public normalize(input: Parameters<ExternalSourceAdapter["normalize"]>[0]) {
    return normalizeFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesClaudeMemoryPath,
      parse: parseClaudeMemory,
    });
  }
}

export const claudeMemoryExternalSourceAdapter = Object.freeze(new ClaudeMemoryExternalSourceAdapter());

export function recognizesClaudeMemoryPath(relativePath: string): boolean {
  if (!isStrictRelativePath(relativePath)) return false;
  const segments = relativePath.split("/");
  if (isClaudeInstructionPath(segments)) return true;
  if (segments[0] !== "projects" || !isSafePathSegment(segments[1] ?? "")) return false;
  return isClaudeInstructionPath(segments.slice(2));
}

function isClaudeInstructionPath(segments: readonly string[]): boolean {
  if (segments.length === 1) return segments[0] === "CLAUDE.md" || segments[0] === "CLAUDE.local.md";
  if (
    segments.length === 2 &&
    segments[0] === "memory" &&
    (segments[1] ?? "").endsWith(".md") &&
    isSafePathSegment(segments[1] ?? "")
  ) {
    return true;
  }
  return (
    segments.length >= 3 &&
    segments[0] === ".claude" &&
    segments[1] === "rules" &&
    segments.slice(2).every((segment, index, all) => {
      if (!isSafePathSegment(segment)) return false;
      return index < all.length - 1 || segment.endsWith(".md");
    })
  );
}

function parseClaudeMemory(input: {
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
