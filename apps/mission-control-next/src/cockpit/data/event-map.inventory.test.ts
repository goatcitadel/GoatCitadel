import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IGNORED_SOURCES, MAPPED_SOURCES } from "./event-map";

const GATEWAY_SRC = fileURLToPath(new URL("../../../../gateway/src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

/** Producers whose source is not a literal at the call site (inventory 2026-10-05). */
const DYNAMIC_SOURCES = [
  "approvals", // approval-resolution-effects-service envelopes
  "chat", // approval envelopes deliver chat_thread_updated
  "capabilities", // code_mode_* producers
  "connectors", // durable-execution-service connector deliveries
  "improvement", // improvement_${signalKind}
  "tasks", // task-lifecycle-service publishTaskEvent
  "tools", // permission profiles, local operator overrides
  "evolution_control_plane", // change_plan.<status>
  "memory", // gateway-service onEvent
  "npu",
  "llamacpp",
  "curator",
  "operator_inbox", // inbox.changed, persisted by RealtimeEventService
];

describe("Gateway publish inventory", () => {
  it("maps or ignores every source the Gateway publishes", () => {
    const literal = /publishRealtime\(\s*"([^"]+)",\s*"([^"]+)"/g;
    const sources = new Set(DYNAMIC_SOURCES);
    for (const file of sourceFiles(GATEWAY_SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(literal)) sources.add(match[2]!);
    }
    expect(sources.size).toBeGreaterThan(30);
    const missing = [...sources].filter((source) => !MAPPED_SOURCES.has(source) && !IGNORED_SOURCES.has(source));
    expect(missing).toEqual([]);
  });
});
