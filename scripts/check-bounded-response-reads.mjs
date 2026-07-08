import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const servicesRoot = path.join(repoRoot, "apps", "gateway", "src", "services");
const policyEngineRoot = path.join(repoRoot, "packages", "policy-engine", "src");
const scanRoots = [servicesRoot, policyEngineRoot];

export const approvedRawResponseReads = new Map(
  Object.entries({
    "apps/gateway/src/services/bounded-response-reader.ts": new Set(["text", "arrayBuffer", "body.getReader"]),
    "apps/gateway/src/services/llama-cpp-runtime-service.ts": new Set(["body.getReader"]),
    "apps/gateway/src/services/llm-provider-anthropic.ts": new Set(["body.getReader"]),
    "apps/gateway/src/services/llm-service.ts": new Set(["body.getReader"]),
    "apps/gateway/src/services/mcp-runtime.ts": new Set(["body.getReader"]),
    // policy-engine's own bounded reader (the analogue of bounded-response-reader.ts).
    // The `body.getReader()` call there is split across statements
    // (`const body = response.body;` then `body.getReader()`), which the two-dot
    // `X.body.getReader(` pattern below does not match anyway — this entry is
    // defensive/documentation in case that ever changes to a single expression.
    "packages/policy-engine/src/sandbox/network-guard.ts": new Set(["body.getReader"]),
  }),
);

// Files whose every Response comes from fetchAllowlisted/fetchAllowlistedOnce, whose
// Proxy/wrapper bounds .text()/.json()/.arrayBuffer(). Enforced invariant: these files
// must not contain a bare `fetch(` call. The wrapper does NOT bound
// .blob()/.formData()/.body.getReader() — those stay flagged even here.
export const boundedByConstructionFiles = new Set([
  "packages/policy-engine/src/tool-executor.ts",
  "packages/policy-engine/src/browser-tools.ts",
  "packages/policy-engine/src/ingestion-backends.ts",
]);
const BOUNDED_BY_CONSTRUCTION_METHODS = new Set(["text", "json", "arrayBuffer"]);
// Matches `fetch(` / `globalThis.fetch(`; does NOT match `fetchAllowlisted(`
// because the `(` is not immediately (modulo whitespace) after `fetch`.
const bareFetchPattern = /\bfetch\s*\(/g;

const bodyReadPatterns = [
  { method: "text", display: ".text()", regex: /\b[$A-Z_a-z][$\w]*\s*\.\s*text\s*\(/g },
  { method: "json", display: ".json()", regex: /\b[$A-Z_a-z][$\w]*\s*\.\s*json\s*\(/g },
  { method: "arrayBuffer", display: ".arrayBuffer()", regex: /\b[$A-Z_a-z][$\w]*\s*\.\s*arrayBuffer\s*\(/g },
  { method: "blob", display: ".blob()", regex: /\b[$A-Z_a-z][$\w]*\s*\.\s*blob\s*\(/g },
  { method: "formData", display: ".formData()", regex: /\b[$A-Z_a-z][$\w]*\s*\.\s*formData\s*\(/g },
  {
    method: "body.getReader",
    display: ".body.getReader()",
    regex: /\b[$A-Z_a-z][$\w]*\s*\.\s*body\s*\.\s*getReader\s*\(/g,
  },
];

export async function collectProductionServiceFiles(root = servicesRoot) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectProductionServiceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

export function collectRawResponseReadViolations(
  relativePath,
  source,
  allowedReads = approvedRawResponseReads,
  boundedFiles = boundedByConstructionFiles,
) {
  const normalizedPath = normalizeRelPath(relativePath);
  const isBoundedByConstruction = boundedFiles.has(normalizedPath);
  const allowedMethods = allowedReads.get(normalizedPath) ?? new Set();

  const bodyReadViolations = collectRawResponseReadReferences(source).filter((reference) => {
    if (isBoundedByConstruction && BOUNDED_BY_CONSTRUCTION_METHODS.has(reference.method)) {
      return false;
    }
    return !allowedMethods.has(reference.method);
  });

  const bareFetchViolations = isBoundedByConstruction ? collectBareFetchReferences(source) : [];

  return [...bodyReadViolations, ...bareFetchViolations]
    .map((reference) => ({ file: normalizedPath, ...reference }))
    .sort((left, right) => left.line - right.line || left.display.localeCompare(right.display));
}

function collectBareFetchReferences(source) {
  const searchable = maskCommentsAndStrings(source);
  const references = [];
  bareFetchPattern.lastIndex = 0;
  for (const match of searchable.matchAll(bareFetchPattern)) {
    const index = match.index ?? 0;
    references.push({
      method: "fetch",
      display: "fetch(...)",
      line: lineNumberAt(searchable, index),
      snippet: lineAt(source, index).trim(),
    });
  }
  return references;
}

export function collectRawResponseReadReferences(source) {
  const searchable = maskCommentsAndStrings(source);
  const references = [];
  for (const pattern of bodyReadPatterns) {
    pattern.regex.lastIndex = 0;
    for (const match of searchable.matchAll(pattern.regex)) {
      const index = match.index ?? 0;
      references.push({
        method: pattern.method,
        display: pattern.display,
        line: lineNumberAt(searchable, index),
        snippet: lineAt(source, index).trim(),
      });
    }
  }
  return references.sort((left, right) => left.line - right.line || left.display.localeCompare(right.display));
}

async function main() {
  const fileLists = await Promise.all(scanRoots.map((root) => collectProductionServiceFiles(root)));
  const files = fileLists.flat();
  const violations = [];
  let approvedReadCount = 0;

  for (const filePath of files) {
    const relativePath = normalizeRelPath(path.relative(repoRoot, filePath));
    const source = await fs.readFile(filePath, "utf8");
    const references = collectRawResponseReadReferences(source);
    const allowedMethods = approvedRawResponseReads.get(relativePath) ?? new Set();
    const isBoundedByConstruction = boundedByConstructionFiles.has(relativePath);
    approvedReadCount += references.filter(
      (reference) =>
        allowedMethods.has(reference.method) ||
        (isBoundedByConstruction && BOUNDED_BY_CONSTRUCTION_METHODS.has(reference.method)),
    ).length;
    violations.push(...collectRawResponseReadViolations(relativePath, source));
  }

  if (violations.length > 0) {
    console.error(
      "[check:bounded-response-reads] raw Response body reads must use bounded-response-reader helpers (gateway) or fetchAllowlisted/readBoundedResponseJson (policy-engine).",
    );
    console.error(
      "Approved streaming exceptions should be added deliberately to scripts/check-bounded-response-reads.mjs; " +
        "if every response in a file comes from fetchAllowlisted, add the file to boundedByConstructionFiles instead.",
    );
    for (const violation of violations) {
      console.error(`  - ${violation.file}:${violation.line} ${violation.display} ${violation.snippet}`);
    }
    process.exit(1);
  }

  console.log(
    `[check:bounded-response-reads] passed: ${approvedReadCount} approved helper/streaming reads across ${files.length} source files.`,
  );
}

function maskCommentsAndStrings(source) {
  const chars = source.split("");
  let state = "code";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    const previous = chars[index - 1];

    if (state === "lineComment") {
      if (char === "\n") {
        state = "code";
      } else {
        chars[index] = " ";
      }
      continue;
    }

    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (char !== "\n" && char !== "\r") {
        chars[index] = " ";
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === quote && previous !== "\\") {
        chars[index] = " ";
        state = "code";
      } else if (char !== "\n" && char !== "\r") {
        chars[index] = " ";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "lineComment";
      continue;
    }

    if (char === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "blockComment";
      continue;
    }

    if (char === "'") {
      chars[index] = " ";
      state = "single";
      continue;
    }

    if (char === '"') {
      chars[index] = " ";
      state = "double";
      continue;
    }

    if (char === "`") {
      chars[index] = " ";
      state = "template";
    }
  }
  return chars.join("");
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function lineAt(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const lineEnd = source.indexOf("\n", index);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
}

function normalizeRelPath(value) {
  return value.replaceAll("\\", "/");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
