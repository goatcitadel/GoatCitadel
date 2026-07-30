const STANDARD_STAGE_SELECTOR = ".mc-next-stage:not(.mc-next-stage-work) .mc-next-stage-scroll";
const NESTED_SCROLL_SELECTOR = "[data-native-scroll='true']";
const STATUS_STRIP_SELECTOR = ".mc-next-status-strip";
const STABLE_BOTTOM_TIMEOUT_MS = 5_000;
const STABLE_BOTTOM_MINIMUM_OBSERVATION_MS = 1_000;
const STABLE_BOTTOM_POLL_INTERVAL_MS = 50;
const STABLE_BOTTOM_REQUIRED_SAMPLES = 6;

export const NATIVE_SCROLL_HANDOFF_ROUTE_SLUGS = new Set([
  "projects",
  "library-skills",
  "library-memory",
  "ops-runtime",
  "settings-providers",
  "settings-integrations",
  "settings-channels",
]);

export function validateNativeStageSnapshot(snapshot, label) {
  if (!snapshot?.found) {
    throw new Error(`${label}: standard route stage scroller was not found`);
  }
  if (!["auto", "scroll"].includes(snapshot.overflowY)) {
    throw new Error(`${label}: stage overflow-y was ${snapshot.overflowY || "unset"}`);
  }
  if (snapshot.clientHeight <= 0) {
    throw new Error(`${label}: stage scroller had no visible height`);
  }
  if (Math.abs(snapshot.documentScrollTop) > 1) {
    throw new Error(`${label}: document scrolled instead of the bounded stage`);
  }
  if (snapshot.atBottom && snapshot.contentBottom > snapshot.visibleBottom + 2) {
    throw new Error(`${label}: final route content remained below the visible stage boundary`);
  }
}

export function validateNativeNestedScrollerSnapshot(snapshot, label) {
  if (!snapshot?.found) {
    throw new Error(`${label}: no native in-page scroll collection was found`);
  }
  if (snapshot.overscrollBehaviorY !== "auto") {
    throw new Error(
      `${label}: nested scroller blocked vertical handoff with overscroll-behavior-y=${snapshot.overscrollBehaviorY}`,
    );
  }
}

export async function assertNativeStageScrollContract(page, { label, probeNestedBoundary = false } = {}) {
  const routeLabel = label || "native route";
  // Route owners use both the shared "Loading current route data" label and
  // owner-specific labels such as "Loading Workspaces". Measure geometry only
  // after the shared loader component has left the page, regardless of copy.
  await page.locator(".mc-next-blocks-loader").first().waitFor({ state: "hidden", timeout: 15000 });
  const initial = await readStageSnapshot(page, false);
  validateNativeStageSnapshot(initial, routeLabel);

  // A route's primary loader can leave before route-owned secondary reads
  // (for example a file preview or project recents) finish rendering. Keep
  // following bounded layout growth to the current bottom, then require a
  // short stable window so a one-shot scroll cannot certify an obsolete max.
  const bottomSnapshot = await driveNativeStageToStableBottom(page, { label: routeLabel });
  validateNativeStageSnapshot(bottomSnapshot, routeLabel);

  let nestedHandoff = "not_requested";
  if (probeNestedBoundary) {
    nestedHandoff = await assertNestedScrollHandoff(page, routeLabel);
  }

  await page.evaluate((selector) => {
    const stage = document.querySelector(selector);
    if (stage instanceof HTMLElement) {
      stage.scrollTop = 0;
    }
  }, STANDARD_STAGE_SELECTOR);

  return {
    overflowed: bottomSnapshot.maxScrollTop > 1,
    maxScrollTop: Math.round(bottomSnapshot.maxScrollTop),
    reachedBottom: bottomSnapshot.atBottom,
    nestedHandoff,
  };
}

export async function driveNativeStageToStableBottom(
  page,
  {
    label = "native route",
    timeoutMs = STABLE_BOTTOM_TIMEOUT_MS,
    minimumObservationMs = STABLE_BOTTOM_MINIMUM_OBSERVATION_MS,
    pollIntervalMs = STABLE_BOTTOM_POLL_INTERVAL_MS,
    requiredStableSamples = STABLE_BOTTOM_REQUIRED_SAMPLES,
    now = monotonicNow,
  } = {},
) {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  const boundedMinimumObservationMs = Math.max(0, minimumObservationMs);
  const boundedPollIntervalMs = Math.max(1, Math.floor(pollIntervalMs));
  const boundedRequiredSamples = Math.max(1, Math.floor(requiredStableSamples));
  const startedAt = now();
  const deadline = startedAt + boundedTimeoutMs;
  let previousGeometry = null;
  let stableSamples = 0;
  let lastSnapshot = null;
  let sampleCount = 0;

  while (now() < deadline) {
    // Sampling and actuation must remain separate: only a later observation
    // that is already at the current bottom can contribute to stability.
    const snapshot = await readStageSnapshot(page, true);
    sampleCount += 1;
    lastSnapshot = snapshot;
    const sampledAt = now();
    if (!snapshot.found) {
      throw new Error(`${label}: standard route stage scroller disappeared while proving its bottom`);
    }
    if (sampledAt >= deadline) {
      break;
    }

    const geometry = `${snapshot.clientHeight}:${snapshot.scrollHeight}:${snapshot.maxScrollTop}`;
    if (snapshot.atBottom) {
      stableSamples = geometry === previousGeometry ? stableSamples + 1 : 1;
      previousGeometry = geometry;
    } else {
      stableSamples = 0;
      previousGeometry = null;
      await driveStageToCurrentBottom(page);
      if (now() >= deadline) {
        break;
      }
    }

    if (stableSamples >= boundedRequiredSamples && sampledAt - startedAt >= boundedMinimumObservationMs) {
      return snapshot;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await page.waitForTimeout(Math.min(boundedPollIntervalMs, remainingMs));
  }

  const numericSnapshot = lastSnapshot
    ? `samples=${sampleCount},elapsedMs=${boundedNumber(now() - startedAt)},clientHeight=${boundedNumber(lastSnapshot.clientHeight)},scrollHeight=${boundedNumber(lastSnapshot.scrollHeight)},scrollTop=${boundedNumber(lastSnapshot.scrollTop)},maxScrollTop=${boundedNumber(lastSnapshot.maxScrollTop)},stableSamples=${stableSamples}`
    : `clientHeight=0,scrollHeight=0,scrollTop=0,maxScrollTop=0,stableSamples=${stableSamples}`;
  throw new Error(
    `${label}: stage bottom did not stabilize within ${boundedNumber(boundedTimeoutMs)} ms (${numericSnapshot})`,
  );
}

export async function assertProviderAnchorAndAdviceContract(page) {
  await page.waitForFunction(
    (stageSelector) => {
      const stage = document.querySelector(stageSelector);
      const target = document.getElementById("providers-routing");
      if (!(stage instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        return false;
      }
      const stageRect = stage.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return targetRect.top >= stageRect.top - 2 && targetRect.top < stageRect.bottom - 2;
    },
    STANDARD_STAGE_SELECTOR,
    { timeout: 5000 },
  );

  const advice = page.locator("#providers-advice").first();
  const summary = advice.locator("summary").first();
  if (!(await advice.evaluate((element) => element.open))) {
    await summary.click();
  }
  await page.waitForFunction(
    (stageSelector) => {
      const stage = document.querySelector(stageSelector);
      const details = document.getElementById("providers-advice");
      if (!(stage instanceof HTMLElement) || !(details instanceof globalThis.HTMLDetailsElement) || !details.open) {
        return false;
      }
      const body = details.querySelector(".mc-next-disclosure-card-body");
      const footer = document.querySelector(".mc-next-status-strip");
      if (!(body instanceof HTMLElement)) {
        return false;
      }
      const stageBottom = stage.getBoundingClientRect().bottom;
      const footerTop = footer instanceof HTMLElement ? footer.getBoundingClientRect().top : stageBottom;
      return body.getBoundingClientRect().bottom <= Math.min(stageBottom, footerTop) + 2;
    },
    STANDARD_STAGE_SELECTOR,
    { timeout: 5000 },
  );

  // A short stability window proves live shell updates do not reset the
  // controlled disclosure or hide its body behind the fixed status strip.
  await page.waitForTimeout(750);
  const snapshot = await advice.evaluate(
    (details, { stageSelector, statusSelector }) => {
      const stage = document.querySelector(stageSelector);
      const footer = document.querySelector(statusSelector);
      const body = details.querySelector(".mc-next-disclosure-card-body");
      const stageBottom = stage instanceof HTMLElement ? stage.getBoundingClientRect().bottom : 0;
      const footerTop = footer instanceof HTMLElement ? footer.getBoundingClientRect().top : stageBottom;
      return {
        open: details.open,
        bodyBottom: body instanceof HTMLElement ? body.getBoundingClientRect().bottom : Number.POSITIVE_INFINITY,
        visibleBottom: Math.min(stageBottom, footerTop),
      };
    },
    { stageSelector: STANDARD_STAGE_SELECTOR, statusSelector: STATUS_STRIP_SELECTOR },
  );
  if (!snapshot.open) {
    throw new Error("settings-providers: Provider advice closed after live shell updates");
  }
  if (snapshot.bodyBottom > snapshot.visibleBottom + 2) {
    throw new Error("settings-providers: Provider advice body was obscured by the stage or status strip");
  }
}

async function readStageSnapshot(page, atBottom) {
  return await page.evaluate(
    ({ stageSelector, statusSelector, atBottom: expectedAtBottom }) => {
      const stage = document.querySelector(stageSelector);
      if (!(stage instanceof HTMLElement)) {
        return { found: false };
      }
      const stageRect = stage.getBoundingClientRect();
      const footer = document.querySelector(statusSelector);
      const footerTop = footer instanceof HTMLElement ? footer.getBoundingClientRect().top : stageRect.bottom;
      const content = stage.lastElementChild;
      const maxScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
      return {
        found: true,
        overflowY: getComputedStyle(stage).overflowY,
        clientHeight: stage.clientHeight,
        scrollHeight: stage.scrollHeight,
        scrollTop: stage.scrollTop,
        maxScrollTop,
        documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
        atBottom: expectedAtBottom && Math.abs(stage.scrollTop - maxScrollTop) <= 2,
        contentBottom: content instanceof HTMLElement ? content.getBoundingClientRect().bottom : stageRect.bottom,
        visibleBottom: Math.min(stageRect.bottom, footerTop),
      };
    },
    { stageSelector: STANDARD_STAGE_SELECTOR, statusSelector: STATUS_STRIP_SELECTOR, atBottom },
  );
}

async function driveStageToCurrentBottom(page) {
  await page.evaluate((selector) => {
    const stage = document.querySelector(selector);
    if (stage instanceof HTMLElement) {
      stage.scrollTop = stage.scrollHeight;
    }
  }, STANDARD_STAGE_SELECTOR);
}

function monotonicNow() {
  return globalThis.performance?.now() ?? Date.now();
}

function boundedNumber(value) {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.round(Math.max(-1_000_000_000, Math.min(1_000_000_000, finite)));
}

async function assertNestedScrollHandoff(page, label) {
  const setup = await page.evaluate(
    ({ stageSelector, nestedSelector }) => {
      const stage = document.querySelector(stageSelector);
      if (!(stage instanceof HTMLElement)) {
        return { found: false };
      }
      document.querySelectorAll("[data-native-scroll-probe]").forEach((element) => {
        element.removeAttribute("data-native-scroll-probe");
      });
      const candidates = [...document.querySelectorAll(nestedSelector)].filter((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.clientHeight > 0;
      });
      const overflowing = candidates.filter((element) => element.scrollHeight > element.clientHeight + 1);
      const nested = overflowing[0];
      if (!(nested instanceof HTMLElement)) {
        return { found: false, candidateCount: candidates.length };
      }
      nested.setAttribute("data-native-scroll-probe", "true");
      nested.scrollIntoView({ block: "center" });
      const maxStageScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
      if (maxStageScrollTop > 1 && stage.scrollTop >= maxStageScrollTop - 2) {
        stage.scrollTop = Math.max(0, maxStageScrollTop - Math.min(240, maxStageScrollTop));
      }
      nested.scrollTop = nested.scrollHeight;
      const nestedRect = nested.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const top = Math.max(nestedRect.top, stageRect.top);
      const bottom = Math.min(nestedRect.bottom, stageRect.bottom);
      return {
        found: true,
        overscrollBehaviorY: getComputedStyle(nested).overscrollBehaviorY,
        stageScrollTop: stage.scrollTop,
        maxStageScrollTop,
        x: Math.max(stageRect.left + 2, Math.min(nestedRect.left + nestedRect.width / 2, stageRect.right - 2)),
        y: top < bottom ? top + (bottom - top) / 2 : stageRect.top + stageRect.height / 2,
      };
    },
    { stageSelector: STANDARD_STAGE_SELECTOR, nestedSelector: NESTED_SCROLL_SELECTOR },
  );
  if (!setup.found) {
    return setup.candidateCount > 0 ? "not_applicable_no_nested_overflow" : "not_applicable_no_nested_scroller";
  }
  validateNativeNestedScrollerSnapshot(setup, label);
  if (setup.maxStageScrollTop <= setup.stageScrollTop + 2) {
    return "not_applicable_no_stage_room";
  }

  // Allow compositor-backed scrolling to observe the programmatic boundary,
  // then refresh both scroll positions immediately before the real wheel input.
  await page.waitForTimeout(100);
  const ready = await page.evaluate(
    ({ stageSelector, probeSelector }) => {
      const stage = document.querySelector(stageSelector);
      const nested = document.querySelector(probeSelector);
      if (!(stage instanceof HTMLElement) || !(nested instanceof HTMLElement)) {
        return { found: false };
      }
      nested.scrollTop = nested.scrollHeight;
      const nestedRect = nested.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const top = Math.max(nestedRect.top, stageRect.top);
      const bottom = Math.min(nestedRect.bottom, stageRect.bottom);
      return {
        found: true,
        stageScrollTop: stage.scrollTop,
        nestedAtBottom: nested.scrollTop >= nested.scrollHeight - nested.clientHeight - 1,
        x: Math.max(stageRect.left + 2, Math.min(nestedRect.left + nestedRect.width / 2, stageRect.right - 2)),
        y: top < bottom ? top + (bottom - top) / 2 : stageRect.top + stageRect.height / 2,
      };
    },
    { stageSelector: STANDARD_STAGE_SELECTOR, probeSelector: "[data-native-scroll-probe='true']" },
  );
  if (!ready.found || !ready.nestedAtBottom) {
    throw new Error(`${label}: nested scroll collection did not remain available at its bottom boundary`);
  }

  await page.mouse.move(ready.x, ready.y);
  let stageScrollTop = ready.stageScrollTop;
  for (let attempt = 0; attempt < 3 && stageScrollTop <= ready.stageScrollTop + 1; attempt += 1) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(120);
    stageScrollTop = await page.evaluate((selector) => {
      const stage = document.querySelector(selector);
      return stage instanceof HTMLElement ? stage.scrollTop : 0;
    }, STANDARD_STAGE_SELECTOR);
  }
  await page.evaluate(() => {
    document.querySelectorAll("[data-native-scroll-probe]").forEach((element) => {
      element.removeAttribute("data-native-scroll-probe");
    });
  });
  if (stageScrollTop <= ready.stageScrollTop + 1) {
    throw new Error(`${label}: wheel input at a nested bottom boundary did not advance the native stage`);
  }
  const documentScrollTop = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
  if (Math.abs(documentScrollTop) > 1) {
    throw new Error(`${label}: nested wheel handoff scrolled the document instead of the stage`);
  }
  return "passed";
}
