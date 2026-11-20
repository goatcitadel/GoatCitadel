/* global AbortController, Element, HTMLTextAreaElement, InputEvent, MutationObserver, cancelAnimationFrame,
          clearTimeout, document, innerHeight, innerWidth, matchMedia, requestAnimationFrame, setTimeout, window */

export function mountTutorialGuide(practice, navigateTo, leave) {
  const lifetime = new AbortController();
  const dock = document.createElement("header");
  const card = document.createElement("aside");
  const focusRing = document.createElement("div");
  const hint = document.createElement("aside");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const anchorHelp = "Allow this tool in this Chat";
  const letters = {
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${letters[name]}</svg>`;

  const steps = [
    {
      area: "Chat",
      route: "/chat?sessionId=" + practice.sessionId,
      title: "Send a practice message",
      paragraphs: [
        "Chat is where you ask questions and start work. This message asks for a checklist based on the sample offsite guide.",
        "Press <strong>Send</strong>. Watch the assistant pause and ask before searching the documents.",
      ],
    },
    {
      area: "Inbox",
      route: "/inbox",
      title: "Decide what the assistant can do",
      paragraphs: [
        "Inbox brings pending decisions together. Select <strong>Review request</strong> to see what the tool will search and which workspace it can read.",
        "This is the same request you saw in Chat. A decision from either place applies to that request.",
      ],
    },
    {
      area: "Work",
      route: "/work",
      title: "Check how the task ended",
      paragraphs: [
        "Work brings together tasks and recent runs across your workspace. Open <strong>Plan a team offsite</strong> to see the task’s status.",
        "An approved search lets the task finish. A denied search leaves it blocked so you can see where work stopped.",
      ],
    },
    {
      area: "Library",
      route: "/library/artifacts",
      title: "Find what the assistant made",
      paragraphs: [
        "Library keeps workspace files, notes, memory, and generated outputs. The <strong>Artifacts</strong> tab shows what the assistant made.",
        "Select <strong>Inspect</strong> on <strong>Offsite checklist</strong> to read it and find its source Chat. Close the preview when you’re ready to continue.",
      ],
    },
    {
      area: "Capabilities",
      route: "/capabilities/tools",
      title: "See what the assistant can use",
      paragraphs: [
        "<strong>Tools</strong> shows what the assistant can do and what may require approval. Find document search under <strong>Memory and knowledge</strong>.",
        "Visit <strong>Connectors</strong> to link services, <strong>Skills</strong> to see repeatable workflows, or <strong>Plugins</strong> to review bundles.",
      ],
    },
    {
      area: "Scripts",
      route: "/scripts",
      title: "Trace saved files back to a run",
      paragraphs: [
        "Scripts lists files and artifacts saved by Chat and agent runs. Open an item to inspect it and follow its link back to the run that produced it.",
        "This exercise saved its checklist in <strong>Library › Artifacts</strong>.",
      ],
    },
    {
      area: "System",
      route: "/system",
      title: "Find out what needs attention",
      paragraphs: [
        "Use <strong>Health</strong> to see which checks passed and which need attention.",
        "If a run stalls, check <strong>Activity</strong> for recent events or <strong>Diagnostics</strong> for errors. <strong>Spend</strong> shows model usage and cost.",
      ],
    },
    {
      area: "Settings",
      route: "/settings/models",
      title: "Choose how future Chats run",
      paragraphs: [
        "<strong>Models</strong> is where you switch providers and choose the default model for new Chats. <strong>Safety</strong> controls when tools ask for approval.",
        "Select <strong>Finish tutorial</strong> to clear the sample data and open a fresh Chat.",
      ],
    },
  ];

  for (const [node, name] of [
    [dock, "toolbar"],
    [card, "card"],
    [focusRing, "spotlight"],
    [hint, "allowance-help"],
  ]) {
    node.className = "tutorial-" + name;
    node.dataset.tutorialUi = "";
  }
  card.setAttribute("aria-labelledby", "tutorial-card-title");
  focusRing.setAttribute("aria-hidden", "true");
  hint.id = "tutorial-allowance-help";
  hint.setAttribute("role", "tooltip");
  hint.innerHTML = `<h3>Allow this tool for a set time</h3>
  <p>In a regular Chat, this would approve the current search and let the same Chat use document search again for <strong>15 minutes</strong>, <strong>1 hour</strong>, or <strong>8 hours</strong>. GoatCitadel still applies your safety rules.</p>
  <p>You can try the duration picker here. Select <strong>Approve once</strong> or <strong>Deny</strong> to make the practice decision.</p>`;
  hint.hidden = true;
  card.hidden = true;
  focusRing.hidden = true;
  document.body.prepend(dock);
  document.body.append(focusRing, card, hint);

  let sheet;
  let currentAnchor;
  let scheduled = 0;
  let animationPending = true;
  let cueHeading = true;
  let prompted = false;
  let lastCard = "";
  let lastDock = "";
  let hintAnchor;
  let hideTimer = 0;
  let lastAllowancePanel;
  let wave;
  let waveLoad;

  function stage() {
    return practice.sample.stage ?? 0;
  }
  function root() {
    return document.getElementById("root");
  }
  function isVisible(element) {
    return Boolean(element?.getClientRects().length && element.getBoundingClientRect().height > 0);
  }
  function exact(tag, label, within = root()) {
    return Array.from(within?.querySelectorAll(tag) ?? []).find(
      (element) => element.textContent.trim() === label && isVisible(element),
    );
  }
  function getInspector() {
    return [...document.querySelectorAll('[data-inspector-body="true"]')].find(isVisible);
  }
  const action = (type, label, extra = "") =>
    `<button type="button" class="tutorial-button" data-tutorial-action="${type}" ${extra}>${label}</button>`;

  function renderDock() {
    if (lastDock) return;
    lastDock = "ready";
    dock.textContent = "Practice session · Sample data";
    dock.setAttribute("aria-label", "Tutorial practice session");
  }

  function draft() {
    const field = document.getElementById("cockpit-chat-draft");
    if (!isVisible(field)) return;
    if (!prompted && !practice.sample.sent && !field.value) {
      prompted = true;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, practice.prompt);
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: practice.prompt }));
    }
    return field.parentElement?.closest("div.rounded-md") ?? field.parentElement;
  }

  function stepTarget(index, inspector) {
    switch (index) {
      case 0:
        return practice.sample.sent ? document.querySelector('[aria-label="Pending approval"]') || draft() : draft();
      case 1:
        return (
          inspector?.querySelector('[aria-label="Current approval"], [aria-label="Action preview"]') ||
          exact("button", "Review request")?.closest("article, li") ||
          exact("button", "Review request")?.parentElement ||
          exact("h1", "Inbox")?.parentElement
        );
      case 2: {
        const task = exact("a,button,h1,h2,h3,strong,span", "Plan a team offsite");
        return task?.closest("article, section, li") || task?.parentElement || exact("h1", "Board")?.parentElement;
      }
      case 3: {
        const artifact = exact(
          "a,button,h2,h3,strong,span",
          practice.sample.decision === "rejected" ? "Example offsite checklist" : "Offsite checklist",
        );
        return artifact?.closest("article, li") || artifact?.parentElement || exact("h1", "Artifacts")?.parentElement;
      }
      case 4:
        return (
          exact("h2,h3", "Memory and knowledge")?.closest("section, article") || exact("h1", "Tools")?.parentElement
        );
      case 5:
        return exact("h2,h3", "No scripts yet")?.closest("section") || exact("h1", "Scripts")?.parentElement;
      case 6:
        return exact("h2,h3", "Checks")?.parentElement || exact("h1", "Health")?.parentElement;
      case 7:
        return exact("h2,h3", "Providers & models")?.parentElement || exact("h1", "Models")?.parentElement;
    }
  }

  function paragraphs(index, inspector) {
    const { sent, decision } = practice.sample;
    if (index === 0 && sent) {
      return [
        "The assistant is waiting for a decision before searching. You can approve a request right here in Chat or find it in Inbox.",
        "Select <strong>Next</strong> to open Inbox and review the same request there.",
      ];
    }
    if (index === 1 && decision) {
      return [
        decision === "approved"
          ? "You approved the search once. The assistant used the sample guide and drafted a checklist."
          : "You denied the search. The assistant stopped before reading the guide.",
        "Select <strong>Next</strong> to see how Work records what happened.",
      ];
    }
    if (index === 1 && inspector) {
      return [
        "Check what the request will search and where. <strong>Approve once</strong> runs this search. <strong>Deny</strong> stops it.",
        "Open <strong>Allow this tool in this Chat</strong> to see the timed choices you may get with eligible tools.",
      ];
    }
    if (index === 3 && decision === "rejected") {
      return [
        "Your denied search stayed blocked. Artifacts shows outputs the assistant generated in this workspace.",
        "Select <strong>Inspect</strong> on <strong>Example offsite checklist</strong> to see a finished output. Close the preview when you’re ready to continue.",
      ];
    }
    if (index === 5 && decision === "rejected") {
      return [
        steps[index].paragraphs[0],
        "The example checklist you inspected is in <strong>Library › Artifacts</strong>.",
      ];
    }
    return steps[index].paragraphs;
  }

  function renderCard(index, inspector) {
    const step = steps[index];
    const last = index === steps.length - 1;
    const ready = index === 0 ? practice.sample.sent : index === 1 ? Boolean(practice.sample.decision) : true;
    const content = `<div class="tutorial-card-wave"></div>
      <div class="tutorial-card-top"><span>${step.area} · ${index + 1} of ${steps.length}</span>
        ${action("exit", "Exit tutorial", "data-quiet")}</div>
      <h2 id="tutorial-card-title" tabindex="-1">${step.title}</h2>
      ${paragraphs(index, inspector)
        .map((paragraph) => `<p>${paragraph}</p>`)
        .join("")}
      <div class="tutorial-card-actions">
        ${action("back", icon("left") + " Back", index === 0 ? "disabled" : "")}
        ${action("next", last ? "Finish tutorial" + icon("check") : "Next " + icon("right"), "data-primary" + (ready ? "" : " disabled"))}
      </div>`;
    if (lastCard !== content) {
      const priorFocus = document.activeElement?.dataset.tutorialAction;
      card.innerHTML = content;
      lastCard = content;
      if (priorFocus && !cueHeading)
        card.querySelector('[data-tutorial-action="' + priorFocus + '"]')?.focus({ preventScroll: true });
    }
  }

  function bound(value, min, max) {
    return Math.max(min, Math.min(Math.max(min, max), value));
  }
  function setGeometry(node, box) {
    for (const key of ["left", "top", "width", "height"]) {
      if (box[key] !== undefined) node.style[key] = box[key] + "px";
    }
  }
  function placeCard(target, anchorControl) {
    const viewport = { width: innerWidth, height: innerHeight };
    const rect = target?.getBoundingClientRect();
    if (!rect) {
      focusRing.hidden = true;
      const x = Math.max(10, (viewport.width - card.offsetWidth) / 2);
      setGeometry(card, { left: x, top: Math.max(48, (viewport.height - card.offsetHeight) / 2) });
      return;
    }
    const edge = 5;
    const left = bound(rect.left - edge, 3, viewport.width - 3);
    const top = bound(rect.top - edge, 45, viewport.height - 3);
    const right = bound(rect.right + edge, left, viewport.width - 3);
    const bottom = bound(rect.bottom + edge, top, viewport.height - 3);
    focusRing.hidden = bottom <= top || !isVisible(target);
    if (!focusRing.hidden) setGeometry(focusRing, { left, top, width: right - left, height: bottom - top });

    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const gap = 12;
    const control = anchorControl?.getBoundingClientRect();
    const point = control ? control.left + control.width / 2 : left + Math.min(150, (right - left) / 2);
    let x = bound(point - w / 2, 8, viewport.width - w - 8);
    let y = bottom + gap;
    if (y + h > viewport.height - 9) y = top - h - gap;
    if (y < 48) {
      if (left >= w + gap + 8) x = left - w - gap;
      else if (right + w + gap < viewport.width) x = right + gap;
      else if (top > viewport.height / 2) y = Math.max(48, top - h - gap);
      y = bound(y < 48 ? top : y, 48, viewport.height - h - 9);
    }
    setGeometry(card, { left: x, top: y });
  }

  function waveOnce() {
    if (reducedMotion.matches || card.hidden) return;
    focusRing.removeAttribute("data-move");
    void focusRing.offsetWidth;
    focusRing.dataset.move = "";
    const bar = card.querySelector(".tutorial-card-wave");
    const source = card.querySelector('[data-tutorial-action="next"]');
    if (!bar || !source) return;
    wave?.skip();
    waveLoad ??= import("distortion-wave").catch(() => null);
    void waveLoad.then((kit) => {
      if (!kit || reducedMotion.matches || !bar.isConnected || !source.isConnected || !kit.warmupWave()) return;
      try {
        wave = kit.distortionWave(bar, undefined, {
          source,
          preserveFocus: false,
          intensity: 0,
          blur: 0,
          blurNear: 0,
          blurAhead: 0,
          blurBehind: 0,
        });
        void Promise.allSettled([wave.ready, wave.covered, wave.finished, wave.updateCallbackDone]);
      } catch {
        // The spotlight and tour card still work without the transition.
      }
    });
  }

  function applyAllowance() {
    for (const button of document.querySelectorAll("#root button, [data-inspector-body] button")) {
      const label = button.textContent.trim();
      if (label === anchorHelp || label === "Approve and allow") {
        if (button.getAttribute("aria-describedby") !== hint.id) button.setAttribute("aria-describedby", hint.id);
        if (label === "Approve and allow") {
          if (button.getAttribute("aria-disabled") !== "true") button.setAttribute("aria-disabled", "true");
          if (button.dataset.tutorialDisabled !== "true") button.dataset.tutorialDisabled = "true";
        }
      }
    }
    const panel = document.querySelector('[aria-label="Temporary tool allowance"]');
    if (panel !== lastAllowancePanel) {
      lastAllowancePanel = panel;
      panel?.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }
  function positionHint() {
    if (!hintAnchor || hint.hidden) return;
    if (!isVisible(hintAnchor)) return hideHint();
    const button = hintAnchor.getBoundingClientRect();
    const w = hint.offsetWidth;
    const h = hint.offsetHeight;
    const inspectorLeft = hintAnchor.closest("[data-inspector-mode]")?.getBoundingClientRect().left;
    const hasGutter = typeof inspectorLeft === "number" && inspectorLeft >= w + 24;
    const x = hasGutter ? inspectorLeft - w - 12 : bound(button.left + button.width / 2 - w / 2, 8, innerWidth - w - 8);
    const y = hasGutter
      ? bound(button.top - h / 2, 46, innerHeight - h - 9)
      : button.top - h - 10 >= 46
        ? button.top - h - 10
        : Math.min(innerHeight - h - 8, button.bottom + 9);
    setGeometry(hint, { left: x, top: y });
  }

  function refresh() {
    renderDock();
    const index = stage();
    const inspector = getInspector();
    const modal = inspector?.closest('[role="dialog"][data-state="open"]');
    const inSheet = Boolean(modal);
    if (inSheet && sheet !== modal) {
      sheet = modal;
      sheet.append(card, hint);
      card.style.left = "";
      card.style.top = "";
      for (const node of [card, hint]) {
        node.removeAttribute("aria-hidden");
        node.removeAttribute("data-aria-hidden");
      }
      card.dataset.docked = "";
      hint.dataset.docked = "";
    } else if (!inSheet && sheet) {
      sheet = undefined;
      document.body.append(card, hint);
      delete card.dataset.docked;
      delete hint.dataset.docked;
    }
    renderCard(index, inspector);
    const target = stepTarget(index, inspector);
    const targetVisible = isVisible(target);
    card.hidden = false;
    if (!targetVisible) focusRing.hidden = true;
    const trigger = exact("button", anchorHelp, inspector || root());
    const control =
      index === 0 && !practice.sample.sent
        ? exact("button", "Send")
        : index === 1
          ? trigger || exact("button", "Review request")
          : undefined;
    if (currentAnchor !== target) {
      currentAnchor?.removeAttribute("data-tutorial-highlighted");
      currentAnchor = target;
    }
    if (inSheet) {
      if (target?.dataset.tutorialHighlighted !== "true") target?.setAttribute("data-tutorial-highlighted", "true");
      focusRing.hidden = true;
    } else {
      currentAnchor?.removeAttribute("data-tutorial-highlighted");
      placeCard(target, control);
    }
    applyAllowance();
    positionHint();
    if (targetVisible && animationPending) {
      animationPending = false;
      waveOnce();
    }
    if (targetVisible && cueHeading && !inSheet) {
      cueHeading = false;
      card.querySelector("h2").focus({ preventScroll: true });
    }
  }
  function requestLayout() {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      refresh();
    });
  }
  function showHint(button) {
    clearTimeout(hideTimer);
    hintAnchor = button;
    hint.hidden = false;
    positionHint();
  }
  function hideHint() {
    clearTimeout(hideTimer);
    hintAnchor = undefined;
    hint.hidden = true;
  }
  function postponeHintHide(next) {
    if (next && (hint.contains(next) || hintAnchor?.contains(next))) return;
    hideTimer = setTimeout(hideHint, 150);
  }
  function eventButton(target) {
    return target instanceof Element ? target.closest("button") : null;
  }
  function isTimed(button) {
    return [anchorHelp, "Approve and allow"].includes(button?.textContent.trim());
  }
  function navigate(index) {
    const step = steps[index];
    if (!step) return;
    hideHint();
    practice.update({ stage: index });
    animationPending = true;
    cueHeading = true;
    navigateTo(step.route);
    requestLayout();
  }

  document.addEventListener(
    "click",
    (event) => {
      const button = eventButton(event.target);
      const which = button?.dataset.tutorialAction;
      if (button?.dataset.tutorialDisabled === "true") {
        event.preventDefault();
        event.stopImmediatePropagation();
        showHint(button);
        return;
      }
      if (isTimed(button) && event.pointerType === "touch") showHint(button);
      if (!isTimed(button) && !hint.contains(event.target) && !hint.hidden) hideHint();
      if (which === "exit") leave("exited");
      if (which === "back" && stage() > 0) navigate(stage() - 1);
      if (which === "next") {
        if (button.disabled) return;
        if (stage() === steps.length - 1) leave("finished");
        else navigate(stage() + 1);
      }
    },
    { capture: true, signal: lifetime.signal },
  );
  document.addEventListener(
    "pointerover",
    (event) => {
      if (hint.contains(event.target)) clearTimeout(hideTimer);
      const button = eventButton(event.target);
      if (event.pointerType !== "touch" && isTimed(button)) showHint(button);
    },
    { signal: lifetime.signal },
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      if (isTimed(eventButton(event.target)) || hint.contains(event.target)) postponeHintHide(event.relatedTarget);
    },
    { signal: lifetime.signal },
  );
  document.addEventListener(
    "focusin",
    (event) => {
      const button = eventButton(event.target);
      if (isTimed(button)) showHint(button);
      else if (!hint.contains(event.target)) hideHint();
    },
    { signal: lifetime.signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !hint.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        hideHint();
      }
    },
    { capture: true, signal: lifetime.signal },
  );
  practice.changes.addEventListener("change", requestLayout, { signal: lifetime.signal });
  window.addEventListener("resize", requestLayout, { signal: lifetime.signal });
  document.addEventListener("scroll", requestLayout, { capture: true, signal: lifetime.signal });
  window.addEventListener("popstate", requestLayout, { signal: lifetime.signal });
  window.addEventListener("goatcitadel:cockpit-location", requestLayout, { signal: lifetime.signal });
  reducedMotion.addEventListener(
    "change",
    () => {
      wave?.skip();
      focusRing.removeAttribute("data-move");
    },
    { signal: lifetime.signal },
  );
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !(record.target instanceof Element) || !record.target.closest("[data-tutorial-ui]")))
      requestLayout();
  });
  observer.observe(document.body, { subtree: true, childList: true });
  void document.fonts.ready.then(() => {
    if (!lifetime.signal.aborted) requestLayout();
  });
  requestLayout();

  return () => {
    lifetime.abort();
    observer.disconnect();
    cancelAnimationFrame(scheduled);
    clearTimeout(hideTimer);
    wave?.skip();
    for (const node of [dock, card, hint, focusRing]) node.remove();
  };
}
