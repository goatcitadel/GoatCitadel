import { describe, expect, it } from "vitest";
import {
  createIncrementalDisplayTextState,
  normalizeAssistantDisplayText,
  normalizeAssistantDisplayTextIncremental,
} from "./assistant-display-text";

/**
 * The incremental engine must be byte-identical to the from-scratch
 * normalizer at EVERY prefix of the stream, for every chunking of the input.
 * These corpus entries cover each construct the pipeline treats specially,
 * with a bias toward things that span lines, chunks, or region boundaries.
 */
const CORPUS: Array<{ name: string; content: string }> = [
  { name: "empty", content: "" },
  { name: "plain prose", content: "Hello there.\nThis is a plain answer with two lines.\n\nAnd a new paragraph." },
  {
    name: "fenced code with prose",
    content: "Before.\n\n```ts\nconst x = 1;\n\n\n\nconst y = 2;\n```\n\nAfter with `inline`.\n",
  },
  { name: "tilde fence, longer close", content: "a\n~~~~\ncode ~~~ not close\n~~~~~\nb\n" },
  { name: "same-line fence close", content: "x\n```inline fence```\ny\n" },
  { name: "indented fence", content: "p\n   ```\nindented code\n   ```\nq\n" },
  { name: "unterminated fence", content: "text\n```py\nstill open\nmore code" },
  { name: "fence chars inside text", content: "not `` a fence\n````\nfour\n````\ndone" },
  { name: "html comment inline", content: "keep <!-- drop this --> rest" },
  { name: "html comment spanning lines", content: "keep\n<!-- drop\nacross\nlines --> tail\nend" },
  { name: "unterminated html comment", content: "keep\n<!-- swallowed from here\nnever closed" },
  { name: "nested comment multi-pass", content: "a<!<!-- inner -->-- outer -->b\nafter" },
  { name: "comment inside fence preserved", content: "```\n<!-- kept verbatim -->\n```\n" },
  { name: "script block", content: "before\n<script>\nalert(1)\n</script>\nafter" },
  { name: "script block unclosed", content: "before\n<script>\nalert(1)\nstill inside" },
  { name: "script case-insensitive close", content: "a\n<SCRIPT foo=1>\nbody\n</ScRiPt >\nz" },
  { name: "svg block", content: 'x<svg width="1"><rect/></svg>y\nnext line' },
  { name: "block element breaks", content: "<div>para</div><p>two</p>\n<ul><li>item</li></ul>" },
  { name: "br tags", content: "one<br>two<br/>three" },
  { name: "plain tags stripped", content: 'a <span class="x">b</span> c <em>d</em>' },
  { name: "dangling tag at line end", content: "text <div unfinished\nnext line fine" },
  { name: "entities", content: "1 &lt; 2 &amp;&amp; 3 &gt; 2 &nbsp; &quot;q&quot; &#65; &#x42; &bogus;" },
  { name: "json unicode escapes", content: "alpha \\u0041\\u0042 beta \\u00e9 end" },
  { name: "escape decoding into fence chars", content: "\\u0060\\u0060\\u0060\ncode?\n\\u0060\\u0060\\u0060\n" },
  { name: "newline runs", content: "a\n\n\n\nb\n\n\n\n\n\nc\n\n\n" },
  { name: "leading and trailing whitespace", content: "\n\n  padded  \n\n" },
  { name: "indentation preserved", content: "- list\n    nested   code-ish\n\tTabbed\n  double  spaces  inside" },
  { name: "html only fallback", content: "<div><span></span></div>" },
  { name: "comment only fallback", content: "<!-- just a comment -->" },
  {
    // Entity-encoded openers only materialize after decodeBasicHtmlEntities
    // inside stripHtmlNoise; blocker detection must see the decoded line or
    // the opener's line is finalized separately from its closer.
    name: "entity-encoded script block",
    content: "before\n&lt;script&gt;\nalert(1)\n&lt;/script&gt;\nafter\n",
  },
  {
    name: "entity-encoded comment spanning lines",
    content: "keep\n&lt;!-- drop\nacross\nlines --&gt; tail\nend\n",
  },
  {
    name: "numeric-entity-encoded style opener",
    content: "a\n&#60;style&#62;\nbody { display: none }\n&#60;/style&#62;\nb\n",
  },
  {
    name: "kitchen sink",
    content:
      "Intro &amp; setup\n\n```html\n<script>kept()</script>\n<!-- kept -->\n```\n\n" +
      "Real <script>\ndropped()\n</script> prose <b>bold</b><br>break\n" +
      "<!-- gone\nacross -->\n\n\n\nTail \\u0058 done.\n",
  },
];

function chunkings(content: string): number[][] {
  const sizes: number[][] = [];
  // Char-by-char: every prefix is exercised.
  sizes.push(Array.from({ length: content.length }, () => 1));
  // Fixed chunks that split tokens at awkward places.
  for (const size of [2, 3, 7]) {
    const plan: number[] = [];
    let remaining = content.length;
    while (remaining > 0) {
      plan.push(Math.min(size, remaining));
      remaining -= Math.min(size, remaining);
    }
    sizes.push(plan);
  }
  // Deterministic pseudo-random chunking.
  let seed = 1234;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const plan: number[] = [];
  let remaining = content.length;
  while (remaining > 0) {
    const size = Math.min(remaining, 1 + Math.floor(random() * 9));
    plan.push(size);
    remaining -= size;
  }
  sizes.push(plan);
  return sizes;
}

describe("normalizeAssistantDisplayTextIncremental", () => {
  for (const sample of CORPUS) {
    it(`matches the from-scratch normalizer at every prefix: ${sample.name}`, () => {
      for (const plan of chunkings(sample.content)) {
        const state = createIncrementalDisplayTextState();
        let streamed = "";
        for (const size of plan) {
          streamed = sample.content.slice(0, streamed.length + size);
          const incremental = normalizeAssistantDisplayTextIncremental(state, streamed);
          const fromScratch = normalizeAssistantDisplayText(streamed);
          expect(incremental, `prefix length ${streamed.length}`).toBe(fromScratch);
        }
      }
    });
  }

  it("self-heals on a non-append delta (edit / retry / shrink)", () => {
    const state = createIncrementalDisplayTextState();
    normalizeAssistantDisplayTextIncremental(state, "first answer\n\nwith <b>tags</b> and more\n");
    // Divergent replacement.
    expect(normalizeAssistantDisplayTextIncremental(state, "second try &amp; body")).toBe(
      normalizeAssistantDisplayText("second try &amp; body"),
    );
    // Shrink.
    expect(normalizeAssistantDisplayTextIncremental(state, "sec")).toBe(normalizeAssistantDisplayText("sec"));
  });

  it("does not rescan finalized prose on append", () => {
    const state = createIncrementalDisplayTextState();
    const first = "para one line one\npara one line two\n\npara two\n";
    normalizeAssistantDisplayTextIncremental(state, first);
    normalizeAssistantDisplayTextIncremental(state, `${first}tail grows`);
    // The second walk resumed at the end of the previously scanned lines,
    // not from index 0.
    expect(state.lastWalkStart).toBe(first.length);
    // And the finalized prefix was consumed, so the recomputed tail excludes it.
    expect(state.consumedEnd).toBe(first.length);
  });

  it("detects a JSON escape split across pushes via the boundary window", () => {
    const state = createIncrementalDisplayTextState();
    // Escape-free stream keeps the fast path (no full-string rescan).
    normalizeAssistantDisplayTextIncremental(state, "plain ");
    expect(state.rawEscapeFree).toBe(true);
    // The escape token arrives split across two pushes: "\\u00" then "41".
    normalizeAssistantDisplayTextIncremental(state, "plain \\u00");
    expect(state.rawEscapeFree).toBe(true);
    const decodedResult = normalizeAssistantDisplayTextIncremental(state, "plain \\u0041 end");
    expect(state.rawEscapeFree).toBe(false);
    expect(decodedResult).toBe(normalizeAssistantDisplayText("plain \\u0041 end"));
    expect(decodedResult).toContain("plain A end");
  });

  it("keeps equivalence while finalization is blocked by an unclosed block element", () => {
    const state = createIncrementalDisplayTextState();
    const parts = ["safe intro\n", "<script>\n", "inside\n", "</script>\n", "outro line\n", "more after\n"];
    let streamed = "";
    for (const part of parts) {
      streamed += part;
      expect(normalizeAssistantDisplayTextIncremental(state, streamed)).toBe(normalizeAssistantDisplayText(streamed));
    }
    // The safe intro was finalized before the blocker arrived.
    expect(state.consumedEnd).toBeGreaterThanOrEqual("safe intro\n".length);
  });

  it.each([
    ["raw script block", "intro\n<script>\nbody()\n</script>\n"],
    ["raw comment block", "intro\n<!-- note\nspanning -->\n"],
    ["entity-encoded script block", "intro\n&lt;script&gt;\nbody()\n&lt;/script&gt;\n"],
    ["entity-encoded comment block", "intro\n&lt;!-- note\nspanning --&gt;\n"],
    ["inline open+close on one line", "intro\n<script>x()</script> same line\n"],
    ["nested multi-pass comment", "intro\na<!<!-- inner -->-- outer -->b\n"],
  ])("resumes prefix finalization after a closed blocker: %s", (_name, blocked) => {
    const state = createIncrementalDisplayTextState();
    const followUp = "later prose line one\nlater prose line two\n";
    const full = blocked + followUp;
    // Stream in small chunks; equivalence must hold throughout.
    let streamed = "";
    while (streamed.length < full.length) {
      streamed = full.slice(0, streamed.length + 3);
      expect(normalizeAssistantDisplayTextIncremental(state, streamed)).toBe(normalizeAssistantDisplayText(streamed));
    }
    // The blocked region closed, so finalization resumed: the consumed prefix
    // advanced past the whole blocked construct instead of anchoring the
    // mutable tail at the opener for the rest of the stream.
    expect(state.textBlocked).toBe(false);
    expect(state.consumedEnd).toBe(full.length);
  });

  it("stays blocked (and correct) while a block element never closes", () => {
    const state = createIncrementalDisplayTextState();
    const full = "intro\n<script>\nnever closes\nmore inside\n";
    let streamed = "";
    while (streamed.length < full.length) {
      streamed = full.slice(0, streamed.length + 4);
      expect(normalizeAssistantDisplayTextIncremental(state, streamed)).toBe(normalizeAssistantDisplayText(streamed));
    }
    expect(state.textBlocked).toBe(true);
    // Only the pre-blocker prefix was consumed.
    expect(state.consumedEnd).toBe("intro\n".length);
  });
});
