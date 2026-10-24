const LEAD = /^([^/\n]+?): (\/.*)$/;
const COMMAND_LINE = /^(\/\S.*?) - (.+)$/;

type CommandEntry = { usage: string; description: string };

/** A "/usage - description" line per command, as the gateway's /help catalog sends it, after an optional lead. */
function parseCommandList(lines: readonly string[]): { lead: string | null; entries: CommandEntry[] } | null {
  if (lines.length < 2) return null;
  const lead = LEAD.exec(lines[0] ?? "");
  const entries: CommandEntry[] = [];
  for (const line of lead ? [lead[2] ?? "", ...lines.slice(1)] : lines) {
    const match = COMMAND_LINE.exec(line.trim());
    if (!match) return null;
    entries.push({ usage: match[1] ?? "", description: match[2] ?? "" });
  }
  return { lead: lead?.[1] ?? null, entries };
}

/**
 * A notice's text. #498: a command catalog renders one command per line instead of one run-on paragraph, and any
 * other multi-line notice keeps its line breaks.
 */
export function ChatNoticeText({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return <>{content}</>;
  const commands = parseCommandList(lines);
  if (!commands)
    return (
      <>
        {lines.map((line, index) => (
          <span key={index}>
            {index > 0 ? <br /> : null}
            {line}
          </span>
        ))}
      </>
    );
  return (
    <>
      {commands.lead ? <span>{commands.lead}:</span> : null}
      <ul className="mt-1 space-y-1">
        {commands.entries.map((entry, index) => (
          <li key={index}>
            <code className="font-mono text-xs text-fg">{entry.usage}</code>
            <span> - {entry.description}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
