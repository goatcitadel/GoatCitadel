import type { DurableChildWatcherCreateRequest } from "./durable.js";
import { redactSecretText } from "./secret-redaction.js";

export const DURABLE_CHILD_WATCHER_LIMITS = {
  watcherIdBytes: 256,
  runIdBytes: 256,
  sourceBytes: 120,
  metadataBytes: 16 * 1024,
  metadataMaxDepth: 6,
  metadataMaxItems: 128,
  metadataMaxKeyBytes: 128,
} as const;

const UTF8 = new TextEncoder();

/**
 * Shared fail-closed boundary used by routes, services, and storage. Keeping
 * this outside the HTTP schema prevents internal callers from bypassing the
 * same byte/depth/item limits.
 */
export function assertDurableChildWatcherCreateRequestBounds(input: DurableChildWatcherCreateRequest): void {
  assertDurableChildWatcherRunIdBounds(input.parentRunId);
  assertDurableChildWatcherRunIdBounds(input.childRunId);
  if (input.watcherId !== undefined) {
    assertDurableChildWatcherIdBounds(input.watcherId);
  }
  if (input.source !== undefined) {
    assertBoundedText("source", input.source, DURABLE_CHILD_WATCHER_LIMITS.sourceBytes);
    assertNoSecretText("source", input.source);
  }
  if (input.metadata !== undefined) {
    assertDurableChildWatcherMetadataBounds(input.metadata);
  }
}

export function assertDurableChildWatcherIdBounds(watcherId: string): void {
  assertBoundedText("watcherId", watcherId, DURABLE_CHILD_WATCHER_LIMITS.watcherIdBytes);
  assertNoSecretText("watcherId", watcherId);
}

export function assertDurableChildWatcherRunIdBounds(runId: string): void {
  assertBoundedText("runId", runId, DURABLE_CHILD_WATCHER_LIMITS.runIdBytes);
}

export function assertDurableChildWatcherMetadataBounds(metadata: Record<string, unknown>): void {
  if (!isPlainRecord(metadata)) {
    throw new Error("Durable child watcher metadata must be a plain JSON object");
  }

  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: metadata, depth: 0 }];
  let itemCount = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    const value = current.value;
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("Durable child watcher metadata numbers must be finite");
      }
      continue;
    }
    if (typeof value !== "object") {
      throw new Error("Durable child watcher metadata must contain only JSON values");
    }
    if (current.depth > DURABLE_CHILD_WATCHER_LIMITS.metadataMaxDepth) {
      throw new Error(`Durable child watcher metadata exceeds depth ${DURABLE_CHILD_WATCHER_LIMITS.metadataMaxDepth}`);
    }
    if (seen.has(value)) {
      throw new Error("Durable child watcher metadata must not contain cycles or repeated object references");
    }
    seen.add(value);

    if (Array.isArray(value)) {
      itemCount += value.length;
      assertMetadataItemCount(itemCount);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(value)) {
      throw new Error("Durable child watcher metadata must contain only plain JSON objects and arrays");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) {
        continue;
      }
      if (descriptor.get || descriptor.set) {
        throw new Error("Durable child watcher metadata must not contain accessor properties");
      }
      if (UTF8.encode(key).byteLength > DURABLE_CHILD_WATCHER_LIMITS.metadataMaxKeyBytes) {
        throw new Error(
          `Durable child watcher metadata key exceeds ${DURABLE_CHILD_WATCHER_LIMITS.metadataMaxKeyBytes} bytes`,
        );
      }
      if (redactSecretText(key).redactionCount > 0) {
        throw new Error("Durable child watcher metadata keys must not contain secret material");
      }
      itemCount += 1;
      assertMetadataItemCount(itemCount);
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Durable child watcher metadata is not JSON serializable: ${detail}`, { cause: error });
  }
  const byteCount = UTF8.encode(serialized).byteLength;
  if (byteCount > DURABLE_CHILD_WATCHER_LIMITS.metadataBytes) {
    throw new Error(`Durable child watcher metadata exceeds ${DURABLE_CHILD_WATCHER_LIMITS.metadataBytes} bytes`);
  }
}

function assertBoundedText(label: string, value: string, maxBytes: number): void {
  if (!value || value !== value.trim() || containsAsciiControlCharacter(value)) {
    throw new Error(`Durable child watcher ${label} must be a non-empty canonical string`);
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw new Error(`Durable child watcher ${label} exceeds ${maxBytes} bytes`);
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertMetadataItemCount(itemCount: number): void {
  if (itemCount > DURABLE_CHILD_WATCHER_LIMITS.metadataMaxItems) {
    throw new Error(
      `Durable child watcher metadata exceeds ${DURABLE_CHILD_WATCHER_LIMITS.metadataMaxItems} keys/items`,
    );
  }
}

function assertNoSecretText(label: string, value: string): void {
  if (redactSecretText(value).redactionCount > 0) {
    throw new Error(`Durable child watcher ${label} must not contain secret material`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
