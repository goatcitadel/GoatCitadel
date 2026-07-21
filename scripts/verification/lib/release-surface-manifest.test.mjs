import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEXT_LEGACY_REDIRECT_MANIFEST,
  NEXT_RELEASE_SURFACE_MANIFEST,
  RELEASE_SURFACE_VARIANTS,
} from "./release-surface-manifest.mjs";

test("desktop-narrow visual proof renders inside the less-than-1180 compact boundary", () => {
  const dark = RELEASE_SURFACE_VARIANTS.find((variant) => variant.slug === "desktop-narrow-dark");
  const light = RELEASE_SURFACE_VARIANTS.find((variant) => variant.slug === "desktop-narrow-light");

  assert.equal(dark?.viewport.width, 1179);
  assert.equal(light?.viewport.width, 1179);
  assert.ok(dark.viewport.width < 1180);
  assert.ok(light.viewport.width < 1180);
});

test("memory visual proof waits for the operator-visible seeded item", () => {
  const memoryRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "library-memory");

  assert.equal(memoryRoute?.readyText, "Mission Control Next shell posture");
});

test("Ops Boards visual proof waits for the deterministic populated board", () => {
  const boardsRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "ops-boards");

  assert.equal(boardsRoute?.readyText, "Verification command board");
});

test("Ops Runtime visual proof waits for the seeded authority projection", () => {
  const runtimeRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "ops-runtime");

  assert.equal(runtimeRoute?.readyText, "approval.wait run");
});

test("Chat owns threaded Working Context while non-Chat routes retain the shell inspector interaction", () => {
  const chatRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "chat");
  assert.equal(chatRoute?.interaction, undefined);

  const nonChatRoutes = NEXT_RELEASE_SURFACE_MANIFEST.filter((route) => route.slug !== "chat");
  assert.ok(nonChatRoutes.length > 0);
  for (const route of nonChatRoutes) {
    assert.equal(route.interaction, "open-inspector", `${route.slug} should exercise Route details`);
  }
});

test("legacy redirects landing on Chat never request the generic Route details inspector", () => {
  const chatRedirects = NEXT_LEGACY_REDIRECT_MANIFEST.filter((route) => route.expectedPath === "/chat");
  assert.deepEqual(chatRedirects.map((route) => route.slug).sort(), [
    "legacy-space-code",
    "legacy-surface-chat",
    "legacy-surface-code",
    "legacy-surface-cowork",
    "legacy-tab-assembly",
    "legacy-tab-chat",
  ]);
  for (const route of chatRedirects) {
    assert.equal(route.interaction, undefined, `${route.slug} must leave context ownership with the threaded surface`);
  }

  const nonChatRedirects = NEXT_LEGACY_REDIRECT_MANIFEST.filter((route) => route.expectedPath !== "/chat");
  assert.ok(nonChatRedirects.length > 0);
  for (const route of nonChatRedirects) {
    assert.equal(route.interaction, "open-inspector", `${route.slug} should exercise Route details`);
  }
});
