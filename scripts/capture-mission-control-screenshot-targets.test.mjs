import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PUBLIC_SCREENSHOT_TARGETS,
  resolvePublicScreenshotTargets,
} from "../packages/policy-engine/scripts/mission-control-screenshot-targets.mjs";

const seed = {
  sessionId: "chat-session",
};

test("public screenshot targets resolve Cockpit routes with the cockpit shell override", () => {
  const targets = resolvePublicScreenshotTargets(seed);
  const bySlug = new Map(targets.map((target) => [target.slug, target]));

  assert.equal(targets.length, PUBLIC_SCREENSHOT_TARGETS.length);
  assert.equal(bySlug.get("chat")?.href, "/chat?shell=cockpit&sessionId=chat-session");
  assert.equal(bySlug.get("chat")?.readyText, "Lumen Notes 2.0 launch plan");
  assert.equal(bySlug.get("chat")?.theme, "dark");
  assert.equal(bySlug.get("chat-light")?.theme, "light");
  assert.equal(bySlug.get("inbox")?.href, "/inbox?shell=cockpit");
  assert.equal(bySlug.get("work-board")?.href, "/work?shell=cockpit");
  assert.equal(bySlug.get("settings-citadel")?.href, "/settings/citadel?shell=cockpit#citadel-overview");
  assert.equal(bySlug.get("first-run")?.fullscreen, true);
  for (const target of targets) {
    assert.match(target.href, /[?&]shell=cockpit\b/u, `${target.slug} must request the cockpit shell`);
    assert.ok(target.readySelector || target.readyText, `${target.slug} needs a readiness signal`);
  }
});

test("public screenshot target resolution fails closed on missing routes and seeded sessions", () => {
  assert.throws(
    () => resolvePublicScreenshotTargets({}, [{ slug: "chat", routeSlug: "cockpit-chat", sessionKey: "sessionId" }]),
    /Missing seeded sessionId/,
  );
  assert.throws(
    () => resolvePublicScreenshotTargets(seed, [{ slug: "retired", routeSlug: "ops-runtime" }]),
    /Missing Mission Control Cockpit route manifest entry/,
  );
});
