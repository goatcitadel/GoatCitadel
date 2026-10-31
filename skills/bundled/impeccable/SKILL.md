---
name: impeccable
description: "Use when the user wants to design, redesign, shape, critique, audit, polish, simplify, harden, animate, or otherwise improve a frontend interface: websites, landing pages, dashboards, product UI, components, forms, settings, onboarding, and empty states. Handles UX review, hierarchy, layout, typography, color, motion, UX copy, accessibility, responsive behavior, edge cases, and capturing or documenting design systems (DESIGN.md, tokens). Also for making bland UI bolder, loud UI quieter, or ambitious visual effects. Not for backend-only or non-UI tasks."
metadata:
  version: "0.1.0"
  tags:
    - design
    - frontend
    - ui
    - ux
  keywords:
    - impeccable
    - landing page
    - frontend design
    - ui polish
    - design critique
---

> Vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) at commit `4f956490f0056ae1ff5ea80372cf56e83c001d3c` under the Apache License 2.0 and modified for the GoatCitadel runtime: the launcher, hooks, live mode, doctor, pin shortcuts, and native-platform references were removed, and Setup now reads the workspace design context. See `UPSTREAM.md` and `NOTICE` in this directory.

This skill gives you the tools and permission to make design that earns the name out-of-distribution craft. Work as an award-winning design director would: production-grade code, a clear POV, a deep grasp of what the client and its users need, and exceptional craft.

Core principles:
- Finish the job. No hedging, no shortcuts: the deliverable is complete, except assets the user must provide.
- Scale ambition to the surface's mode (see Modes). Persuade and Experience get full commitment: bold, distinct work with a point of view. On Operate and Read, ambition shows as precision and restraint, and patterns the visitor already knows earn their place.
- Verify by looking at the rendered result at the sizes it ships at, and batch the checks: fix what one look shows before looking again, rather than screenshotting after every tweak.

## Setup

1. Read the project design context before any design work: the workspace `PRODUCT.md` (durable product truth) and `DESIGN.md` (the committed visual system) when the GoatCitadel runtime attaches them or the project contains them. Nothing is executed. GoatCitadel ships no impeccable launcher, binary, hook, or live mode; when a step below is impossible without one, say so once and continue with the rest. A missing DESIGN.md alone does not make a project greenfield.
2. Load the request's playbook: its Commands-table reference for an explicit or implied sub-command. Inspect target and incumbent visual truth before editing: existing tokens, components, stylesheets, and committed visual-regression baselines or screenshot fixtures, checked for freshness against the current code.
3. After resolving analysis and direction, read [reference/craft-floor.md](reference/craft-floor.md) immediately before any UI edit, including small refinements. It carries the quality floor, the absolute bans, and the reflexes no detector catches. Do not load it for planning-only work.

## How to design

- **The brief wins.** Honor pinned aesthetics, eras, materials, fonts, and palettes even when they conflict with a saturated-pattern warning. Redirecting a clear brief toward your taste is failure. <!-- rule:skill-brief-wins -->
- **Refinement preserves; redesign replaces.** Refinement keeps the incumbent identity, behavior, copy, and everything outside scope. Ask before replacing factual copy or adding claims. Redesign keeps product truth, content, function, native affordances, and constraints, but treats the old look as evidence and anti-reference; choose a replacement world with the operator and replace DESIGN.md. Never split the difference into polish on the discarded look. <!-- rule:skill-world-change-semantics -->
- **Loaded symbols stay out of the decoration.** A subject's world does not license emblems tied to militarism, supremacy, or hate movements as motifs, badges, or ornament, such as the Rising Sun flag's rays, the Confederate battle flag, or Nazi-era insignia and their stylised variants; reach for that world's neutral forms instead. Content that documents such a symbol as fact stays as it is. <!-- rule:skill-loaded-symbols -->
- **Visual authority is evidence, not a filename.** Missing DESIGN.md alone does not make a project greenfield; the evidence decides whether to preserve, expand, or replace the incumbent world. <!-- rule:skill-new-work-gate -->

## Modes

The mode names what the visitor's success looks like on this surface.

- **Persuade:** the visitor decides and acts; design is the product. Landing pages, marketing, campaigns, pricing. Earn attention and action. Ship real imagery when the brief needs it; follow the committed world, not category habit. <!-- rule:brand-register-core -->
- **Operate:** the visitor completes a task. App UI, dashboards, editors, admin, settings, tools. Scanability, consistency, native expectations, and the real usage scene outrank expression. Brand lives in precise details. <!-- rule:product-register-core -->
- **Read:** the visitor understands something. Docs, articles, guides, help, changelogs. Structure for comprehension, then make the reading experience worth staying in. <!-- rule:skill-read-register -->
- **Experience:** the visitor is inside the work itself. Portfolios, galleries, showcases. Let the artifact lead from the first viewport; the interface recedes. <!-- rule:skill-experience-register -->

Choose the mode from the requested surface, not the product, and persist it only in that surface brief. A tool's landing page is still Persuade; a fashion house's documentation is still Read; a docs index is Read, not Persuade. See new-work.md (not vendored in this GoatCitadel build) for new surfaces and [operate.md](reference/operate.md) for deeper Operate/Read guidance. <!-- rule:skill-visitor-mode -->

## Commands

| Command | Category | Description | Reference |
|---|---|---|---|
| `shape [feature]` | Build | Plan UX/UI before writing code | [reference/shape.md](reference/shape.md) |
| `init` | Build | Capture durable product context in PRODUCT.md | [reference/init.md](reference/init.md) |
| `document` | Build | Generate DESIGN.md from existing project code | [reference/document.md](reference/document.md) |
| `extract [target]` | Build | Pull reusable tokens and components into design system | [reference/extract.md](reference/extract.md) |
| `critique [target]` | Evaluate | UX design review with heuristic scoring | [reference/critique.md](reference/critique.md) |
| `audit [target]` | Evaluate | Technical quality checks (a11y, perf, responsive) | [reference/audit.md](reference/audit.md) |
| `polish [target]` | Refine | Final quality pass before shipping | [reference/polish.md](reference/polish.md) |
| `bolder [target]` | Refine | Amplify safe or bland designs | [reference/bolder.md](reference/bolder.md) |
| `quieter [target]` | Refine | Tone down aggressive or overstimulating designs | [reference/quieter.md](reference/quieter.md) |
| `distill [target]` | Refine | Strip to essence, remove complexity | [reference/distill.md](reference/distill.md) |
| `harden [target]` | Refine | Production-ready: errors, i18n, edge cases | [reference/harden.md](reference/harden.md) |
| `onboard [target]` | Refine | Design first-run flows, empty states, activation | [reference/onboard.md](reference/onboard.md) |
| `animate [target]` | Enhance | Add purposeful animations and motion | [reference/animate.md](reference/animate.md) |
| `colorize [target]` | Enhance | Add strategic color to monochromatic UIs | [reference/colorize.md](reference/colorize.md) |
| `typeset [target]` | Enhance | Improve typography hierarchy and fonts | [reference/typeset.md](reference/typeset.md) |
| `layout [target]` | Enhance | Fix spacing, rhythm, and visual hierarchy | [reference/layout.md](reference/layout.md) |
| `delight [target]` | Enhance | Add personality and memorable touches | [reference/delight.md](reference/delight.md) |
| `overdrive [target]` | Enhance | Push past conventional limits | [reference/overdrive.md](reference/overdrive.md) |
| `clarify [target]` | Fix | Improve UX copy, labels, and error messages | [reference/clarify.md](reference/clarify.md) |
| `adapt [target]` | Fix | Adapt for different devices and screen sizes | [reference/adapt.md](reference/adapt.md) |
| `optimize [target]` | Fix | Diagnose and fix UI performance | [reference/optimize.md](reference/optimize.md) |

Not available in this vendored build: `craft`, `live`, `generate`, pin shortcuts, hooks, doctor, and the native-platform references. Use `critique`, `audit`, and `polish` for review passes. `new-work` (the visual-world workshop) is not vendored either: when a step routes through it, choose and commit the visual world with the operator through user_input.request and record it in DESIGN.md.

Routing: <!-- rule:skill-routing -->

- **No argument:** present a short menu of the commands above grouped by category, recommend `init` first when no PRODUCT.md context exists, and never auto-run a command.
- **Explicit or clearly implied request to run a command:** load its reference and follow it. Ask once if two commands fit.
- **Otherwise:** treat the request as general design work. Missing PRODUCT.md routes a new surface or replacement world through init; a narrow refinement of existing code proceeds on the incumbent implementation as the project design context directs, offering init afterward rather than blocking on it.
- `teach` aliases `init`. `shape` owns task discovery and surface-concept decisions.
