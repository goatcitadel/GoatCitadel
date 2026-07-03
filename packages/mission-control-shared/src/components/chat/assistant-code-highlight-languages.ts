// Lazy-loaded chunk — never import this module statically outside
// assistant-code-highlight.ts. It is the ONLY module in this package with a runtime
// import of lowlight/highlight.js; every other consumer must reach it exclusively
// through `loadAssistantCodeHighlighter()`, which dynamic-imports this file so its
// contents (lowlight + the highlight.js grammars below) ship as a separate async
// chunk rather than inflating the main bundle.
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import type { AssistantHighlighter } from "./assistant-code-highlight";

const REGISTERED_GRAMMARS = {
  typescript,
  javascript,
  json,
  bash,
  python,
  css,
  xml,
  markdown,
  yaml,
  sql,
  diff,
  go,
  rust,
  java,
  csharp,
  powershell,
};

export function createAssistantHighlighter(): AssistantHighlighter {
  const lowlight = createLowlight(REGISTERED_GRAMMARS);
  return {
    highlight: (lang, code) => lowlight.highlight(lang, code),
    listLanguages: () => lowlight.listLanguages(),
  };
}
