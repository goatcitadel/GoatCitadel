import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

describe("extensions sdk barrel", () => {
  it("exports only the tool directory helpers", () => {
    expect(Object.keys(sdk).sort()).toEqual([
      "buildToolSchemaRefIndex",
      "dereferenceEffectiveToolSchema",
      "findEffectiveToolByName",
      "listEffectiveCallableTools",
      "validateCompactToolDirectorySnapshot",
    ]);
  });
});
