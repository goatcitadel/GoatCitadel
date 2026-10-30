// Lazy KaTeX for math in Chat replies. Like the code highlighter, KaTeX and its stylesheet are fetched as an async
// chunk the first time a reply holds math, so conversations without math never load them.
import type katexModule from "katex";

export type Katex = typeof katexModule;

/** Longer formulas show as their TeX source: typesetting them would stall the page for little gain. */
export const MATH_MAX_TEX_CHARS = 5_000;

let katexPromise: Promise<Katex | null> | null = null;
let loadedKatex: Katex | null = null;

/** KaTeX once it has loaded, so later formulas render on their first paint instead of flashing their source. */
export function getLoadedKatex(): Katex | null {
  return loadedKatex;
}

/** Resolves null when KaTeX cannot load; a later call tries again. Never rejects. */
export function loadKatex(): Promise<Katex | null> {
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([module]) => {
      loadedKatex = module.default;
      return loadedKatex;
    })
    .catch(() => {
      katexPromise = null;
      return null;
    });
  return katexPromise;
}

/** Markup KaTeX never produces with `trust` off; seeing any of it means the output is not shown. */
const UNSAFE_MARKUP = /<(?:script|a|iframe|object|embed|img|foreignobject)\b|\son[a-z]+\s*=|\b(?:href|src)\s*=/iu;

/**
 * The formula as KaTeX markup (HTML for the eye, MathML for screen readers), or null when it does not parse, for
 * example a formula still arriving. `trust` stays off, so commands such as `\href` and `\includegraphics` never
 * become links or images, and expansion is capped so a hostile macro cannot hang the page.
 */
export function renderMathToHtml(katex: Katex, tex: string, display: boolean): string | null {
  if (!tex.trim() || tex.length > MATH_MAX_TEX_CHARS) return null;
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 500,
    });
    return UNSAFE_MARKUP.test(html) ? null : html;
  } catch {
    return null;
  }
}
