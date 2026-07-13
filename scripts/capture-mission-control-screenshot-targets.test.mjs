import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PUBLIC_SCREENSHOT_TARGETS,
  resolvePublicScreenshotTargets,
} from "../packages/policy-engine/scripts/mission-control-screenshot-targets.mjs";

const seed = {
  sessionId: "chat-session",
  coworkSessionId: "agentic-session",
  codeSessionId: "code-session",
};

test("public screenshot targets resolve retired gallery filenames through canonical Chat sessions", () => {
  const targets = resolvePublicScreenshotTargets(seed);
  const bySlug = new Map(targets.map((target) => [target.slug, target]));

  assert.equal(targets.length, PUBLIC_SCREENSHOT_TARGETS.length);
  assert.equal(bySlug.get("chat")?.href, "/chat?sessionId=chat-session");
  assert.equal(bySlug.get("chat")?.readyText, "1.0 release prep");
  assert.equal(bySlug.get("cowork")?.href, "/chat?sessionId=agentic-session");
  assert.equal(bySlug.get("cowork")?.readyText, "Launch supervision plan");
  assert.equal(bySlug.get("code")?.href, "/chat?sessionId=code-session");
  assert.equal(bySlug.get("code")?.readyText, "Installer proof checklist");
  assert.equal(bySlug.get("cowork")?.title, "Chat · Agentic work");
  assert.equal(bySlug.get("code")?.title, "Chat · Code capability");
  assert.equal(bySlug.get("projects")?.href, "/projects");
});

test("public screenshot target resolution fails closed on missing routes and seeded sessions", () => {
  assert.throws(
    () => resolvePublicScreenshotTargets({}, [{ slug: "chat", routeSlug: "chat", sessionKey: "sessionId" }]),
    /Missing seeded sessionId/,
  );
  assert.throws(
    () => resolvePublicScreenshotTargets(seed, [{ slug: "retired", routeSlug: "retired" }]),
    /Missing Mission Control Next route manifest entry/,
  );
});
