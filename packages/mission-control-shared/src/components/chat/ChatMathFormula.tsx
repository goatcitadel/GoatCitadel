import { useEffect, useMemo, useState } from "react";
import { getLoadedKatex, loadKatex, renderMathToHtml } from "./assistant-math";

/**
 * A formula from a Chat reply, typeset by KaTeX. Until KaTeX loads, and whenever the TeX does not parse (a formula
 * still arriving, or one KaTeX cannot read), the TeX source shows instead, so nothing is ever lost.
 */
export function ChatMathFormula({ tex, display }: { tex: string; display: boolean }) {
  const [katex, setKatex] = useState(getLoadedKatex);
  useEffect(() => {
    if (katex) return;
    let cancelled = false;
    void loadKatex().then((loaded) => {
      if (!cancelled && loaded) setKatex(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [katex]);
  const html = useMemo(() => (katex ? renderMathToHtml(katex, tex, display) : null), [katex, tex, display]);

  if (html === null) {
    return display ? (
      <pre className="mc-assistant-math-source" data-math-source="">
        <code>{tex}</code>
      </pre>
    ) : (
      <code className="mc-assistant-inline-code" data-math-source="">
        {tex}
      </code>
    );
  }
  // KaTeX markup with `trust` off and an unsafe-markup check (see renderMathToHtml).
  return display ? (
    <div className="mc-assistant-math mc-assistant-math-display" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="mc-assistant-math" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
