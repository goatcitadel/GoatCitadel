import type { Definition, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { healStreamingMarkdownTail } from "./streaming-markdown-heal";

// The same CommonMark + GFM parser used by ReactMarkdown. No boundary grammar of
// our own: a partial new line never establishes a completed top-level block.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();
const MAX_RETAINED_BLOCKS = 512;

export interface RetainedMarkdownBlock {
  start: number;
  end: number;
  source: string;
  tree: Root;
  references: ReadonlySet<string>;
}

export interface IncrementalSplitState {
  content: string;
  resumeIndex: number;
  lastScanStart: number;
  definitions: string[];
  definitionMap: Map<string, { node: Definition; source: string; start: number }>;
  blocks: RetainedMarkdownBlock[];
  tailTree: Root;
}

export function createIncrementalSplitState(): IncrementalSplitState {
  return {
    content: "",
    resumeIndex: 0,
    lastScanStart: 0,
    definitions: [],
    definitionMap: new Map(),
    blocks: [],
    tailTree: { type: "root", children: [] },
  };
}

export function buildDefinitionSuffix(definitions: readonly string[], chunk: string): string {
  return definitions.length && chunk.length ? `\n\n${definitions.join("\n\n")}\n` : "";
}

function walk(node: Root | RootContent, visit: (node: Root | RootContent) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child as RootContent, visit);
}

/** Source ranges of CommonMark inline code, including its backtick delimiters. */
export function readInlineCodeRanges(source: string): Array<{ start: number; end: number }> {
  if (!source.includes("`")) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  walk(parser.parse(source), (node) => {
    if (node.type !== "inlineCode") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
  });
  return ranges;
}

// These are candidate labels, not Markdown syntax decisions. The installed parser
// validates every candidate and tells us which reference identifiers this block
// really depends on (including presently unresolved, collapsed and shortcut links).
function referenceDependencies(source: string): ReadonlySet<string> {
  if (!source.includes("[")) return new Set();
  const candidates = new Set<string>();
  const openings: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "[") openings.push(i);
    if (source[i] === "]" && openings.length) {
      const start = openings.pop()!;
      const label = source.slice(start + 1, i);
      if (label.length && label.length <= 999) candidates.add(`[${label}]: https://reference.invalid/\n`);
    }
  }
  const tree = parser.parse(source + buildDefinitionSuffix([...candidates], source));
  const references = new Set<string>();
  walk(tree, (node) => {
    if (node.type === "linkReference" || node.type === "imageReference") references.add(node.identifier);
  });
  return references;
}

function definitionsTree(state: IncrementalSplitState): Definition[] {
  return [...state.definitionMap.values()].map(({ node }) => node);
}

function suppressPartialAutoLinks(tree: Root, source: string, lastLineStart: number): void {
  walk(tree, (node) => {
    if (node.type !== "link") return;
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? 0;
    // Explicit, closed inline links are settled. GFM bare-URL autolinks on the
    // still-arriving line are text until newline; never navigate to half a URL.
    if (end > lastLineStart && source[start] !== "[" && source[end - 1] !== ">") node.url = "";
  });
}

const TABLE_HEADER_LINE = /^ {0,3}\|/;
const TABLE_DELIMITER_PREFIX = /^ {0,3}\|?[\s:|-]*$/;

/** A tail paragraph that may still turn into a table: a header row, perhaps followed by part of its delimiter row. */
function mayBecomeTable(text: string): boolean {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length === 1) return TABLE_HEADER_LINE.test(lines[0]!);
  return lines.length === 2 && TABLE_HEADER_LINE.test(lines[0]!) && TABLE_DELIMITER_PREFIX.test(lines[1]!);
}

/**
 * A table at the end of the tail shows only rows that have finished their line, and only once its first body row has:
 * no raw `| a | b |` header text while the delimiter arrives, no header-only grid, and no empty row at the start of
 * each new line. Display only, and only while streaming; the finished message renders every row.
 */
function holdBackPartialTable(tree: Root, source: string): Root {
  const last = tree.children.at(-1);
  if (!last) return tree;
  const start = last.position?.start.offset ?? 0;
  const lastLineStart = source.lastIndexOf("\n") + 1;
  const without = () => ({ ...tree, children: tree.children.slice(0, -1) });
  if (last.type === "paragraph") return mayBecomeTable(source.slice(start)) ? without() : tree;
  if (last.type !== "table") return tree;
  const rows = last.children.filter((row) => (row.position?.start.offset ?? source.length) < lastLineStart);
  if (rows.length < 2) return without();
  return rows.length === last.children.length
    ? tree
    : { ...tree, children: [...tree.children.slice(0, -1), { ...last, children: rows }] };
}

function plainTailTree(
  state: IncrementalSplitState,
  pending: string,
  lastLineStart: number,
  tailNodes: RootContent[],
): Root {
  const tree: Root = {
    type: "root",
    children: [...definitionsTree(state), ...tailNodes.filter((node) => node.type !== "definition")],
  };
  suppressPartialAutoLinks(tree, pending, lastLineStart);
  return holdBackPartialTable(tree, pending);
}

/** Whether the text still being written sits in a code or raw HTML block, even one nested in a quote or list. */
function endsInsideRawBlock(node: RootContent): boolean {
  if (node.type === "code" || node.type === "html") return true;
  const children = "children" in node ? (node.children as RootContent[]) : [];
  const last = children.at(-1);
  return last ? endsInsideRawBlock(last) : false;
}

/**
 * The tail parsed from its healed source (an open **bold** closed for now, see healStreamingMarkdownTail), or
 * undefined when healing changes nothing or the tail ends inside code or raw HTML. Display only: content, stable
 * and tail keep every original byte.
 */
function healedTailTree(
  state: IncrementalSplitState,
  pending: string,
  boundary: number,
  tailEnd: number,
  tailNodes: RootContent[],
): Root | undefined {
  const last = tailNodes.filter((node) => node.type !== "definition").at(-1);
  if (!last || endsInsideRawBlock(last)) return undefined;
  const source = pending.slice(boundary, tailEnd);
  const healed = healStreamingMarkdownTail(source);
  if (healed === source) return undefined;
  const parsed = parser.parse(healed + buildDefinitionSuffix(state.definitions, healed));
  const tree: Root = {
    type: "root",
    children: [
      ...definitionsTree(state),
      ...parsed.children.filter(
        (node) => node.type !== "definition" && (node.position?.start.offset ?? healed.length) < healed.length,
      ),
    ],
  };
  suppressPartialAutoLinks(tree, healed, source.lastIndexOf("\n") + 1);
  return holdBackPartialTable(tree, healed);
}

export function splitIncremental(state: IncrementalSplitState, content: string): { stable: string; tail: string } {
  if (content === state.content)
    return { stable: content.slice(0, state.resumeIndex), tail: content.slice(state.resumeIndex) };
  if (!content.startsWith(state.content)) Object.assign(state, createIncrementalSplitState());
  const base = state.resumeIndex;
  state.lastScanStart = base;
  const pending = content.slice(base);
  const lastLineStart = pending.lastIndexOf("\n") + 1;
  let tree = parser.parse(pending + buildDefinitionSuffix(state.definitions, pending));
  let nodes = tree.children.filter((node) => (node.position?.start.offset ?? pending.length) < pending.length);
  const changedDefinitions = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "definition" || (node.position?.end.offset ?? pending.length + 1) > lastLineStart) continue;
    const previous = state.definitionMap.get(node.identifier);
    const source = pending.slice(node.position!.start.offset!, node.position!.end.offset!);
    // CommonMark's first definition wins. A definition still in the mutable tail
    // may gain its title on a later line, so update that exact definition in place.
    const start = base + node.position!.start.offset!;
    if (!previous || previous.start === start) {
      if (!previous || previous.source !== source) changedDefinitions.add(node.identifier);
      state.definitionMap.set(node.identifier, { node, source, start });
    }
  }
  state.definitions = [...state.definitionMap.values()].map(({ source }) => source);

  const partialDefinition = nodes.find(
    (node) => node.type === "definition" && (node.position?.end.offset ?? 0) > lastLineStart,
  );
  if (partialDefinition) {
    // Reference definitions are invisible Markdown. Omit an unfinished definition
    // from presentation, while keeping every original byte in content/stable/tail.
    tree = parser.parse(
      pending.slice(0, partialDefinition.position!.start.offset!) + buildDefinitionSuffix(state.definitions, pending),
    );
    nodes = tree.children.filter(
      (node) => (node.position?.start.offset ?? pending.length) < partialDefinition.position!.start.offset!,
    );
  }

  for (const block of state.blocks) {
    if (![...changedDefinitions].some((id) => block.references.has(id))) continue;
    block.tree = parser.parse(block.source + buildDefinitionSuffix(state.definitions, block.source));
  }

  // The last block with a newline-terminated opening line remains mutable. A
  // trailing "-", table delimiter, quote prefix or fence cannot commit its peer.
  let heldIndex = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    if ((nodes[i]!.position?.start.offset ?? pending.length) < lastLineStart) heldIndex = i;
  }
  let boundary = 0;
  for (let i = 0; i < heldIndex && state.blocks.length < MAX_RETAINED_BLOCKS; i += 1) {
    const nextStart = nodes[i + 1]!.position!.start.offset!;
    const end = pending.lastIndexOf("\n", nextStart - 1) + 1;
    const source = pending.slice(boundary, end);
    state.blocks.push({
      start: base + boundary,
      end: base + end,
      source,
      tree: { type: "root", children: [nodes[i]!, ...definitionsTree(state)] },
      references: referenceDependencies(source),
    });
    boundary = end;
  }
  state.resumeIndex = base + boundary;
  const tailNodes = nodes.filter((node) => (node.position?.start.offset ?? pending.length) >= boundary);
  state.tailTree =
    healedTailTree(state, pending, boundary, partialDefinition?.position?.start.offset ?? pending.length, tailNodes) ??
    plainTailTree(state, pending, lastLineStart, tailNodes);
  state.content = content;
  return { stable: content.slice(0, state.resumeIndex), tail: content.slice(state.resumeIndex) };
}

export function splitStreamingMarkdown(content: string): { stable: string; tail: string } {
  return splitIncremental(createIncrementalSplitState(), content);
}
