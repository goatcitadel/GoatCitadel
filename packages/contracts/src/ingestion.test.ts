import { describe, expectTypeOf, it } from "vitest";
import type { ContextSourceAttribution } from "./ingestion.js";
import type { DocsIngestInput } from "./knowledge.js";

describe("ingestion contracts", () => {
  it("represents internal external snapshots without widening public document ingestion", () => {
    expectTypeOf<ContextSourceAttribution["sourceType"]>().toEqualTypeOf<
      "file" | "url" | "text" | "memory" | "mcp" | "external_source_snapshot"
    >();
    expectTypeOf<DocsIngestInput["sourceType"]>().toEqualTypeOf<"file" | "url" | "text">();
  });
});
