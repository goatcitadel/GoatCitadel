import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_READER_KEYS } from "./query-keys";

const COCKPIT_SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The `useQuery(...)` call blocks in a source, by bracket matching from each call. */
function queryCallBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (const match of source.matchAll(/\buseQuery\(/g)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index]!;
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    blocks.push(source.slice(start, index - 1));
  }
  return blocks;
}

/** The leading string literals of a block's `queryKey: [...]`, or null when the key is not a literal array. */
function literalKeyPrefix(block: string): string[] | null {
  const key = /queryKey:\s*\[([^\]]*)\]/.exec(block);
  if (!key) return null;
  const prefix: string[] = [];
  for (const part of key[1]!.split(",")) {
    const literal = /^\s*"([^"]*)"\s*$/.exec(part);
    if (!literal) break;
    prefix.push(literal[1]!);
  }
  return prefix;
}

function covered(prefix: readonly string[]): boolean {
  return SETTINGS_READER_KEYS.some(
    (key) => key.length <= prefix.length && key.every((part, index) => part === prefix[index]),
  );
}

describe("settings reader inventory", () => {
  it("finds blocks and literal keys", () => {
    const [block] = queryCallBlocks('useQuery({ queryKey: ["system", "x", id], queryFn: () => fetchSettings() })');
    expect(block).toContain("fetchSettings");
    expect(literalKeyPrefix(block!)).toEqual(["system", "x"]);
    expect(literalKeyPrefix("useQuery({ queryKey: queryKeys.health(id) })")).toBeNull();
  });

  it("every cockpit query that reads settings is refreshed by a settings change", () => {
    const readers: string[] = [];
    const uncovered: string[] = [];
    for (const file of sourceFiles(COCKPIT_SRC)) {
      for (const block of queryCallBlocks(readFileSync(file, "utf8"))) {
        if (!/\bfetchSettings\b/.test(block)) continue;
        const prefix = literalKeyPrefix(block);
        const where = `${relative(COCKPIT_SRC, file)}: ${JSON.stringify(prefix)}`;
        readers.push(where);
        if (!prefix || !covered(prefix)) uncovered.push(where);
      }
    }
    expect(readers.length).toBeGreaterThanOrEqual(7);
    expect(uncovered).toEqual([]);
  });
});
