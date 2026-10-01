import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEXT_DIRECT_COMPATIBILITY_MANIFEST,
  NEXT_LEGACY_REDIRECT_MANIFEST,
  NEXT_RELEASE_SURFACE_MANIFEST,
  NEXT_VISUAL_SCENARIO_MANIFEST,
  NEXT_VISUAL_REGRESSION_MANIFEST,
  RELEASE_SURFACE_VARIANTS,
  resolveDirectCompatibilityManifest,
  resolveReleaseSurfaceHref,
} from "./release-surface-manifest.mjs";
import { COCKPIT_VISUAL_MANIFEST } from "./cockpit-visual-manifest.mjs";

test("cockpit captures are additive and preserve all classic PNG identities with explicit shell selection", () => {
  const classic = NEXT_VISUAL_REGRESSION_MANIFEST.filter(route => route.shell === "classic");
  assert.equal(classic.length, 52);
  assert.deepEqual(classic.map(({ shell: _shell, ...route }) => route), [
    ...NEXT_RELEASE_SURFACE_MANIFEST, ...NEXT_VISUAL_SCENARIO_MANIFEST,
  ]);
  for (const route of classic) {
    const href = new URL(resolveReleaseSurfaceHref(route), "http://test.invalid");
    assert.equal(href.searchParams.get("shell"), "classic");
  }
  assert.equal(classic.length * RELEASE_SURFACE_VARIANTS.length, 416);
  const slugs = NEXT_VISUAL_REGRESSION_MANIFEST.map(route => route.slug);
  assert.equal(new Set(slugs).size, slugs.length, "Two shells must never share a baseline filename.");
});

test("native manifest covers cockpit destinations and binds fixture, theme and explicit shell independently", () => {
  assert.deepEqual(COCKPIT_VISUAL_MANIFEST.map(route => route.slug), [
    "cockpit-chat", "cockpit-inbox", "cockpit-work-board", "cockpit-work-history", "cockpit-work-schedules",
    "cockpit-library-capabilities", "cockpit-library-memory", "cockpit-library-notes", "cockpit-library-files", "cockpit-library-artifacts",
    "cockpit-system-health", "cockpit-system-spend", "cockpit-system-quality", "cockpit-system-diagnostics", "cockpit-system-activity", "cockpit-system-dashboards",
    "cockpit-settings-general", "cockpit-settings-models", "cockpit-settings-connections", "cockpit-settings-safety", "cockpit-settings-citadel", "cockpit-settings-access", "cockpit-settings-advanced",
    "cockpit-first-run", "cockpit-gallery",
  ]);
  for (const route of COCKPIT_VISUAL_MANIFEST) {
    assert.equal(route.shell, "cockpit");
    assert.ok(route.readySelector || route.readyText);
    assert.equal(route.interaction, undefined, "Native routes do not use the classic inspector.");
  }
  const chat = new URL(resolveReleaseSurfaceHref(COCKPIT_VISUAL_MANIFEST[0], { themeQuery: "theme=light" }, {
    sessions: { approval: "reviewed/session?1" },
  }), "http://test.invalid");
  assert.equal(chat.pathname, "/chat");
  assert.equal(chat.searchParams.get("sessionId"), "reviewed/session?1");
  assert.equal(chat.searchParams.get("shell"), "cockpit");
  assert.equal(chat.searchParams.get("theme"), "light");
  const gallery = COCKPIT_VISUAL_MANIFEST.find(route => route.slug === "cockpit-gallery");
  assert.equal(gallery.href, "/__gallery");
  assert.equal(gallery.readySelector, '[data-cockpit-gallery="true"]');
  assert.equal(gallery.readyText, "Cockpit components");
  assert.equal(COCKPIT_VISUAL_MANIFEST.length * RELEASE_SURFACE_VARIANTS.length, 200);
  assert.equal(NEXT_VISUAL_REGRESSION_MANIFEST.length * RELEASE_SURFACE_VARIANTS.length, 616);
});

test("desktop-narrow visual proof renders inside the less-than-1180 compact boundary", () => {
  const dark = RELEASE_SURFACE_VARIANTS.find((variant) => variant.slug === "desktop-narrow-dark");
  const light = RELEASE_SURFACE_VARIANTS.find((variant) => variant.slug === "desktop-narrow-light");

  assert.equal(dark?.viewport.width, 1179);
  assert.equal(light?.viewport.width, 1179);
  assert.ok(dark.viewport.width < 1180);
  assert.ok(light.viewport.width < 1180);
});

test("memory visual proof waits for the browsable item directory", () => {
  const memoryRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "library-memory");

  assert.equal(memoryRoute?.readyText, "Memory items");
});

test("Ops Boards visual proof waits for the deterministic populated board", () => {
  const boardsRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "ops-boards");

  assert.equal(boardsRoute?.readyText, "Verification command board");
});

test("Ops Runtime visual proof waits for the Services directory", () => {
  const runtimeRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "ops-runtime");

  assert.equal(runtimeRoute?.readyText, "Services");
});

test("Projects and Approvals visual proof target populated fixture records", () => {
  const projectsRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "projects");
  const approvalsRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "ops-approvals");
  const fixture = {
    sessions: { approval: "session 1" },
    projects: { primary: "project/1" },
    approvals: { primary: "approval?1" },
  };

  assert.equal(projectsRoute?.readySelector, ".mc-next-project-thread-groups");
  assert.equal(projectsRoute?.fixtureProjectKey, "primary");
  assert.equal(
    resolveReleaseSurfaceHref(projectsRoute, { themeQuery: "theme=light" }, fixture),
    "/projects?theme=light&projectId=project%2F1",
  );
  assert.equal(approvalsRoute?.readySelector, ".mc-next-approvals-inspector");
  assert.equal(approvalsRoute?.fixtureApprovalKey, "primary");
  assert.equal(
    resolveReleaseSurfaceHref(approvalsRoute, { themeQuery: "" }, fixture),
    "/ops/approvals?approvalId=approval%3F1",
  );
  assert.equal(
    resolveReleaseSurfaceHref({ href: "/chat", fixtureSessionKey: "approval" }, { themeQuery: "theme=light" }, fixture),
    "/chat?theme=light&sessionId=session%201",
  );
});

test("Chat blocker visual proof waits for the inline decision beside the turn", () => {
  const approval = NEXT_VISUAL_SCENARIO_MANIFEST.find((route) => route.slug === "chat-pending-approval");
  const question = NEXT_VISUAL_SCENARIO_MANIFEST.find((route) => route.slug === "chat-pending-user-input");
  assert.equal(approval?.readySelector, '.mc-next-thread-blocking-prompt[data-blocker-kind="approval"]');
  assert.equal(question?.readySelector, '.mc-next-thread-blocking-prompt[data-blocker-kind="user-input"]');
});

test("Chat owns threaded Activity while non-Chat routes retain the shell inspector interaction", () => {
  const chatRoute = NEXT_RELEASE_SURFACE_MANIFEST.find((route) => route.slug === "chat");
  assert.equal(chatRoute?.interaction, undefined);
  assert.equal(chatRoute?.fixtureSessionKey, "approval");

  const nonChatRoutes = NEXT_RELEASE_SURFACE_MANIFEST.filter((route) => route.slug !== "chat");
  assert.ok(nonChatRoutes.length > 0);
  for (const route of nonChatRoutes) {
    assert.equal(route.interaction, "open-inspector", `${route.slug} should exercise Route details`);
  }
});

test("legacy redirects landing on Chat never request the generic Route details inspector", () => {
  assert.equal(NEXT_LEGACY_REDIRECT_MANIFEST.length, 20, "legacy query-input count must remain independently frozen");
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

test("direct compatibility paths remain separate from the legacy query-input manifest", () => {
  assert.deepEqual(
    NEXT_DIRECT_COMPATIBILITY_MANIFEST.map(({ slug, href, expectedPath }) => ({ slug, href, expectedPath })),
    [
      { slug: "direct-cowork", href: "/cowork", expectedPath: "/chat" },
      { slug: "direct-code", href: "/code", expectedPath: "/chat" },
      {
        slug: "direct-settings-safety",
        href: "/settings/safety",
        expectedPath: "/settings/permissions",
      },
    ],
  );
  assert.equal(NEXT_DIRECT_COMPATIBILITY_MANIFEST.length, 3);
  assert.ok(NEXT_LEGACY_REDIRECT_MANIFEST.every((route) => route.href.includes("?")));
  assert.ok(NEXT_DIRECT_COMPATIBILITY_MANIFEST.every((route) => !route.href.includes("?")));
  assert.equal(resolveDirectCompatibilityManifest("@goatcitadel/mission-control-next").length, 3);
  assert.deepEqual(resolveDirectCompatibilityManifest("@goatcitadel/mission-control"), []);
});
