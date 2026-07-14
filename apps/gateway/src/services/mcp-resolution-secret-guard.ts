import { Buffer } from "node:buffer";
import { McpRequesterResolutionError, type McpEphemeralResolvedHeaderInput } from "./mcp-requester-resolution.js";

export const MCP_RESOLUTION_SECRET_GUARD_ENTRY_LIMIT = 512;
export const MCP_RESOLUTION_SECRET_GUARD_BYTE_LIMIT = 512 * 1_024;
const DIAGNOSTIC_MAX_DEPTH = 8;
const DIAGNOSTIC_MAX_NODES = 4_096;
const DIAGNOSTIC_MAX_KEYS = 128;
const SECRET_NORMALIZATION_MAX_DEPTH = 4;
const REDACTED = "[REDACTED]";

export interface McpResolutionSecretGuardInput {
  url: string;
  headers: ReadonlyArray<Readonly<McpEphemeralResolvedHeaderInput>>;
}

export interface McpResolutionSecretGuard {
  scrubText(input: string): string;
  scrubDiagnostic(input: unknown): unknown;
  dispose(): void;
  isDisposed(): boolean;
  toJSON(): never;
}

class McpResolutionSecretGuardValue implements McpResolutionSecretGuard {
  #patterns: string[];
  #disposed = false;

  public constructor(patterns: string[]) {
    this.#patterns = patterns;
    Object.freeze(this);
  }

  public scrubText(input: string): string {
    this.#assertActive();
    let output = input;
    for (const pattern of this.#patterns) {
      if (output.includes(pattern)) output = output.split(pattern).join(REDACTED);
    }
    return output;
  }

  public scrubDiagnostic(input: unknown): unknown {
    this.#assertActive();
    let nodes = 0;
    const seen = new WeakSet<object>();
    const visit = (value: unknown, depth: number): unknown => {
      nodes += 1;
      if (nodes > DIAGNOSTIC_MAX_NODES || depth > DIAGNOSTIC_MAX_DEPTH) return REDACTED;
      if (typeof value === "string") return this.scrubText(value);
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (typeof value !== "object") return REDACTED;
      if (seen.has(value)) return REDACTED;
      seen.add(value);
      let isError: boolean;
      try {
        isError = value instanceof Error;
      } catch {
        return REDACTED;
      }
      if (isError) {
        const result: Record<string, unknown> = Object.assign(Object.create(null), { name: "Error" });
        const message = readOwnDataProperty(value, "message");
        const stack = readOwnDataProperty(value, "stack");
        const cause = readOwnDataProperty(value, "cause");
        if (typeof message === "string") result.message = this.scrubText(message);
        if (typeof stack === "string") result.stack = this.scrubText(stack);
        if (cause !== undefined) result.cause = visit(cause, depth + 1);
        return result;
      }
      if (Array.isArray(value)) {
        const length = readOwnDataProperty(value, "length");
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > DIAGNOSTIC_MAX_KEYS) {
          return REDACTED;
        }
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const entry = readOwnDataProperty(value, String(index));
          result.push(entry === undefined ? REDACTED : visit(entry, depth + 1));
        }
        return result;
      }
      let keys: string[];
      try {
        keys = Object.keys(value);
      } catch {
        return REDACTED;
      }
      if (keys.length > DIAGNOSTIC_MAX_KEYS) return REDACTED;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, key);
        } catch {
          return REDACTED;
        }
        const safeKey = this.scrubText(key);
        result[safeKey] = descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : REDACTED;
      }
      return result;
    };
    return visit(input, 0);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#patterns.length = 0;
    this.#patterns = [];
  }

  public isDisposed(): boolean {
    return this.#disposed;
  }

  public toJSON(): never {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }

  #assertActive(): void {
    if (this.#disposed) throw new McpRequesterResolutionError("secret_guard_failed");
  }
}

export function createMcpResolutionSecretGuard(input: McpResolutionSecretGuardInput): McpResolutionSecretGuard {
  try {
    if (typeof input.url !== "string" || !Array.isArray(input.headers)) throw new TypeError();
    const seeds = collectSeeds(input);
    const patterns = buildDerivedPatterns(seeds);
    return new McpResolutionSecretGuardValue(patterns);
  } catch {
    throw new McpRequesterResolutionError("secret_guard_failed");
  }
}

Object.freeze(McpResolutionSecretGuardValue.prototype);

function collectSeeds(input: McpResolutionSecretGuardInput): string[] {
  const parsed = new URL(input.url);
  const seeds = new Set<string>();
  addSeed(seeds, input.url);
  addSeed(seeds, parsed.href);
  addSeed(seeds, parsed.origin);
  addSeed(seeds, parsed.host);
  addSeed(seeds, parsed.hostname);
  addSeed(seeds, parsed.pathname);
  addSeed(seeds, parsed.search);

  for (const segment of parsed.pathname.split("/")) {
    addSeed(seeds, segment);
    addSeed(seeds, safeDecodeURIComponent(segment));
  }
  const rawQuery = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
  for (const pair of rawQuery.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const rawKey = separator < 0 ? pair : pair.slice(0, separator);
    const rawValue = separator < 0 ? "" : pair.slice(separator + 1);
    addSeed(seeds, rawKey);
    addSeed(seeds, rawValue);
    addSeed(seeds, safeDecodeURIComponent(rawKey.replace(/\+/gu, " ")));
    addSeed(seeds, safeDecodeURIComponent(rawValue.replace(/\+/gu, " ")));
  }
  for (const [key, value] of parsed.searchParams.entries()) {
    addSeed(seeds, key);
    addSeed(seeds, value);
  }

  for (const header of input.headers) {
    if (!header || typeof header.name !== "string" || typeof header.value !== "string") throw new TypeError();
    addSeed(seeds, header.value);
    const schemeMatch = /^(basic|bearer|token|apikey)\s+(.+)$/iu.exec(header.value);
    if (schemeMatch) {
      addSeed(seeds, schemeMatch[2]);
    } else if (header.name.toLowerCase() === "authorization") {
      for (const scheme of ["Bearer", "Basic", "Token", "ApiKey"] as const) {
        addSeed(seeds, `${scheme} ${header.value}`);
      }
    }
  }
  return [...seeds];
}

function buildDerivedPatterns(seeds: readonly string[]): string[] {
  const patterns = new Set<string>();
  let totalBytes = 0;
  const add = (value: string | undefined): void => {
    if (!value || patterns.has(value)) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (
      patterns.size + 1 > MCP_RESOLUTION_SECRET_GUARD_ENTRY_LIMIT ||
      totalBytes + bytes > MCP_RESOLUTION_SECRET_GUARD_BYTE_LIMIT
    ) {
      throw new McpRequesterResolutionError("secret_guard_failed");
    }
    patterns.add(value);
    totalBytes += bytes;
  };

  for (const seed of seeds) {
    for (const normalized of buildNormalizationClosure(seed, add)) {
      const encoded = safeEncodeURIComponent(normalized);
      const json = safeJsonString(normalized);
      add(encoded);
      add(encoded?.replace(/%[0-9A-F]{2}/gu, (value) => value.toLowerCase()));
      add(json);
      add(json && json.length >= 2 ? json.slice(1, -1) : undefined);
      add(Buffer.from(normalized, "utf8").toString("base64"));
      add(Buffer.from(normalized, "utf8").toString("base64url"));
    }
  }
  return [...patterns].sort((left, right) => right.length - left.length || compareExact(left, right));
}

function buildNormalizationClosure(seed: string, add: (value: string | undefined) => void): readonly string[] {
  const normalized = new Set<string>();
  const queue: Array<{ value: string; depth: number }> = [{ value: seed, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || normalized.has(current.value)) continue;
    normalized.add(current.value);
    add(current.value);
    if (current.depth >= SECRET_NORMALIZATION_MAX_DEPTH) continue;
    for (const candidate of [
      current.value.trim(),
      safeDecodeURIComponent(current.value),
      safeDecodeUri(current.value),
    ]) {
      if (candidate && !normalized.has(candidate)) queue.push({ value: candidate, depth: current.depth + 1 });
    }
  }
  return [...normalized];
}

function addSeed(seeds: Set<string>, value: string | undefined): void {
  if (value) seeds.add(value);
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function safeDecodeUri(value: string): string | undefined {
  try {
    return decodeURI(value);
  } catch {
    return undefined;
  }
}

function safeEncodeURIComponent(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function safeJsonString(value: string): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function readOwnDataProperty(input: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
