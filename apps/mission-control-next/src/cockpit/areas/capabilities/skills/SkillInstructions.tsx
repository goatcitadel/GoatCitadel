import { useId, useState } from "react";
import { Button } from "../../../ui/Button";
import { NativeMessageRenderer } from "../../chat/NativeMessageRenderer";

/** How many lines of a skill's instructions show before "Show all". */
const FIRST_LINES = 12;

/**
 * A skill's `SKILL.md` body as safe markdown, through Chat's renderer: no raw HTML and only safe links. The container
 * carries the class that scopes the markdown styles outside Chat. The first 12 lines show, then "Show all" shows the
 * rest; the button stays (as "Show less"), so focus stays on it.
 *
 * Chat's renderer leaves HTML out, comments and `<script>` blocks included, but the AI reads the file as written. So
 * "Show as written" shows the same lines as plain text, every character of them, a `<script>` tag as text.
 */
export function SkillInstructions({ body }: { body: string }) {
  const [all, setAll] = useState(false);
  const [written, setWritten] = useState(false);
  const textId = useId();
  if (!body.trim()) return <p className="text-sm text-fg-muted">This skill has no instructions.</p>;
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const long = lines.length > FIRST_LINES;
  const shown = long && !all ? lines.slice(0, FIRST_LINES).join("\n") : body;
  return (
    <div className="space-y-2">
      <div id={textId} className="min-w-0">
        {written ? (
          <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-xs text-fg-secondary">{shown}</pre>
        ) : (
          <div className="cockpit-chat-documents min-w-0 text-sm">
            <NativeMessageRenderer role="assistant" content={shown} running={false} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {long ? (
          <Button size="sm" variant="ghost" aria-expanded={all} aria-controls={textId} onClick={() => setAll(!all)}>
            {all ? "Show less" : "Show all"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" aria-controls={textId} onClick={() => setWritten(!written)}>
          {written ? "Show formatted" : "Show as written"}
        </Button>
      </div>
    </div>
  );
}
