#!/usr/bin/env node
/*
 * A11Y-01 contrast guard for apps/mission-control-next.
 *
 * Resolves the canonical theme token pairs (foreground-on-background) for BOTH
 * themes from the CSS source and fails CI when a semantically-required pair does
 * not clear WCAG AA. This is the static counterpart to the runtime route sweep:
 * it can't see rendered DOM, but it cannot be fooled by dynamic content and it
 * guards the token system itself so contrast regressions never reach a surface.
 *
 * Token values are read from:
 *   apps/mission-control-next/src/styles/mission-control-next-tokens.css
 *   apps/mission-control-next/src/styles/mission-control-next-theme-bridge.css
 * and resolved through var() / color-mix(in oklab, ...) / oklch() / oklab() /
 * hex / rgb() using the self-contained colour math below (no dependency, so it
 * stays a fast required check with no install surface).
 *
 * Run via:
 *   node scripts/check-mission-control-next-contrast.mjs
 * Exits 1 on any AA violation, with theme + pair + ratio evidence.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const STYLE_DIR = path.join(repoRoot, "apps", "mission-control-next", "src", "styles");

// ---------------------------------------------------------------------------
// Colour math (sRGB <-> linear <-> oklab/oklch), self-contained.
// ---------------------------------------------------------------------------
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const srgbToLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linToSrgb = (c) => { const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055; return clamp255(v * 255); };

function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return {
    r: linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}
function rgbToOklab({ r, g, b }) {
  const lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const oklchToOklab = (L, C, H) => { const h = (H * Math.PI) / 180; return [L, C * Math.cos(h), C * Math.sin(h)]; };

export function relLuminance({ r, g, b }) {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
export function contrastRatio(fg, bg) {
  const L1 = relLuminance(fg), L2 = relLuminance(bg);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// CSS value parsing / token resolution.
// ---------------------------------------------------------------------------
const NAMED = { white: { r: 255, g: 255, b: 255 }, black: { r: 0, g: 0, b: 0 } };

function splitTopLevel(s) {
  const parts = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Resolve a raw CSS value string to {r,g,b} within a token map, or null.
function resolveValue(raw, tokens, seen = new Set()) {
  if (!raw) return null;
  const v = raw.trim();
  if (NAMED[v.toLowerCase()]) return NAMED[v.toLowerCase()];

  let m = v.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (m) {
    const h = m[1];
    const hex = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const n = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
    return { r: n[0], g: n[1], b: n[2] };
  }
  m = v.match(/^oklch\(\s*([^)]+)\)$/i);
  if (m) { const n = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return oklabToRgb(...oklchToOklab(n[0], n[1], n[2])); }
  m = v.match(/^oklab\(\s*([^)]+)\)$/i);
  if (m) { const n = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return oklabToRgb(n[0], n[1], n[2]); }
  m = v.match(/^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,([\s\S]+))?\)$/);
  if (m) {
    const name = m[1];
    if (seen.has(name)) return null; // cycle
    if (tokens.has(name)) { const r = resolveValue(tokens.get(name), tokens, new Set([...seen, name])); if (r) return r; }
    return m[2] ? resolveValue(m[2], tokens, seen) : null;
  }
  m = v.match(/^color-mix\(\s*in\s+\w+\s*,([\s\S]+)\)$/i);
  if (m) {
    const args = splitTopLevel(m[1]);
    if (args.length !== 2) return null;
    const parse = (a) => { const pm = a.match(/(.*?)\s+(\d+(?:\.\d+)?)%\s*$/); return pm ? { color: pm[1].trim(), w: parseFloat(pm[2]) } : { color: a.trim(), w: null }; };
    const A = parse(args[0]), B = parse(args[1]);
    const ca = resolveValue(A.color, tokens, seen), cb = resolveValue(B.color, tokens, seen);
    if (!ca || !cb) return null;
    let wa = A.w, wb = B.w;
    if (wa == null && wb == null) { wa = 50; wb = 50; }
    else if (wa == null) wa = 100 - wb;
    else if (wb == null) wb = 100 - wa;
    const sum = wa + wb || 1;
    wa /= sum; wb /= sum;
    const oa = rgbToOklab(ca), ob = rgbToOklab(cb);
    return oklabToRgb(oa[0] * wa + ob[0] * wb, oa[1] * wa + ob[1] * wb, oa[2] * wa + ob[2] * wb);
  }
  return null;
}

// Extract `--name: value;` declarations from the blocks matching the given
// selectors, merged in file/selector order (later wins).
function extractDecls(css, selectors) {
  const out = new Map();
  // Strip CSS comments first: a comment before a block is otherwise slurped into
  // the selector capture and the block fails to match.
  css = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let bm;
  while ((bm = blockRe.exec(css)) !== null) {
    const sel = bm[1].trim();
    if (!selectors.some((s) => sel === s || sel.split(",").map((x) => x.trim()).includes(s))) continue;
    const declRe = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let dm;
    while ((dm = declRe.exec(bm[2])) !== null) out.set(dm[1], dm[2].trim());
  }
  return out;
}

export async function buildThemeTokens({ styleDir = STYLE_DIR } = {}) {
  const tokensCss = await fs.readFile(path.join(styleDir, "mission-control-next-tokens.css"), "utf8");
  const bridgeCss = await fs.readFile(path.join(styleDir, "mission-control-next-theme-bridge.css"), "utf8");
  const root = extractDecls(tokensCss, [":root"]);
  const build = (themeSel) => {
    const merged = new Map(root);
    for (const [k, v] of extractDecls(tokensCss, [themeSel])) merged.set(k, v);
    for (const [k, v] of extractDecls(bridgeCss, [themeSel])) merged.set(k, v);
    return merged;
  };
  return { dark: build(".theme-signal-noir"), light: build(".theme-citadel-light") };
}

// Areas drive --primary via --mc-area-color; check button text on every accent.
const AREAS = ["chat", "cowork", "code", "projects", "library", "ops", "settings"];
const AA_NORMAL = 4.5;

// Semantically-required pairs that MUST clear AA in both themes. Kept to
// high-confidence combinations (text tiers on the content surfaces they are
// designed for, and button text on the accent) to avoid flagging combos that
// are never composed in the UI.
const TEXT_TIERS = ["--fg-primary", "--fg-secondary", "--fg-muted"];
const CONTENT_SURFACES = ["--bg-app", "--bg-surface-1", "--bg-surface-2", "--bg-surface-3"];

// Intentional exceptions: "<theme>|<fg>|<bg>" with a reason. Keep empty unless a
// pair is deliberately decorative / never carries operator text.
const ALLOW = new Map([]);

export function collectContrastViolations(themes) {
  const violations = [];
  for (const [theme, tokens] of Object.entries(themes)) {
    const check = (fg, bg, label, fgName, bgName) => {
      if (!fg || !bg) { violations.push({ theme, label, error: `unresolved (${fgName} on ${bgName})` }); return; }
      const ratio = contrastRatio(fg, bg);
      if (ratio < AA_NORMAL && !ALLOW.has(`${theme}|${fgName}|${bgName}`)) {
        violations.push({ theme, label, fgName, bgName, ratio: Math.round(ratio * 100) / 100 });
      }
    };
    const R = (name, ctx = tokens) => resolveValue(`var(${name})`, ctx);
    for (const fg of TEXT_TIERS) for (const bg of CONTENT_SURFACES) check(R(fg), R(bg), `${fg} on ${bg}`, fg, bg);
    check(R("--muted-foreground"), R("--card"), "--muted-foreground on --card", "--muted-foreground", "--card");
    // Button text on the per-area accent.
    for (const area of AREAS) {
      const ctx = new Map(tokens); ctx.set("--mc-area-color", `var(--area-${area})`);
      check(resolveValue("var(--primary-foreground)", ctx), resolveValue("var(--primary)", ctx),
        `--primary-foreground on --primary[${area}]`, "--primary-foreground", `--primary[${area}]`);
    }
  }
  return violations;
}

async function main() {
  const themes = await buildThemeTokens();
  const violations = collectContrastViolations(themes);
  if (violations.length === 0) {
    console.log("mc-next contrast: ok (all required token pairs clear AA 4.5:1 in both themes)");
    process.exit(0);
  }
  console.error(`mc-next contrast: ${violations.length} AA violation(s).`);
  console.error("");
  for (const v of violations) {
    if (v.error) console.error(`  [${v.theme}] ${v.label}: ${v.error}`);
    else console.error(`  [${v.theme}] ${v.label}: ${v.ratio}:1 (needs ${AA_NORMAL}:1)`);
  }
  console.error("");
  console.error("Adjust the token value in mission-control-next-tokens.css / -theme-bridge.css,");
  console.error("or, if the pair is intentionally decorative, add it to ALLOW with a reason.");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error("mc-next contrast: script error", err); process.exit(2); });
}
