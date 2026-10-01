import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapMaxWidth,
  mapMinWidth,
  normalizeCssMediaQueries,
  normalizeMediaPrelude,
} from "./normalize-mission-control-next-breakpoints.mjs";

describe("breakpoint normalization", () => {
  it("maps width values to the nearest canonical endpoint", () => {
    assert.deepEqual([520, 767, 820, 840, 1100, 1179, 1439, 1680].map(mapMaxWidth),
      [639, 639, 639, 1023, 1023, 1279, 1279, 1599]);
    assert.deepEqual([560, 900, 1200, 1680].map(mapMinWidth), [640, 1024, 1280, 1600]);
  });

  it("keeps non-width and container queries unchanged", () => {
    assert.equal(normalizeMediaPrelude(" (max-height: 699px), (width < 1180px) "),
      " (max-height: 699px), (width < 1280px) ");
    assert.equal(normalizeCssMediaQueries("@container (min-width: 44rem) { a {} }"),
      "@container (min-width: 44rem) { a {} }");
  });

  it("preserves narrow desktop bands when rounded endpoints would overlap", () => {
    assert.equal(normalizeMediaPrelude("(min-width: 1180px) and (max-width: 1279px)"),
      "(min-width: 1024px) and (max-width: 1279px)");
    assert.equal(normalizeMediaPrelude("(min-width: 1180px) and (max-width: 1360px)"),
      "(min-width: 1024px) and (max-width: 1279px)");
  });

  it("rewrites only media preludes and is idempotent", () => {
    const source = "@media (max-width: 767px) { a { max-width: 767px; } }";
    const expected = "@media (max-width: 639px) { a { max-width: 767px; } }";
    assert.equal(normalizeCssMediaQueries(source), expected);
    assert.equal(normalizeCssMediaQueries(expected), expected);
  });
});
