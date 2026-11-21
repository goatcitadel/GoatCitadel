import type { ReactNode } from "react";

const LEAD = /^([^/\n]+?): (\/.*)$/;
const COMMAND_LINE = /^(\/\S.*?) - (.+)$/;

/** Render the saved /help catalog as a list while keeping arbitrary notices readable as text. */
export function ChatCommandNotice({ content, fallback }: { content: string; fallback: ReactNode }) {
  const lines = content.split(/\r?\n/);
  const lead = LEAD.exec(lines[0] ?? "");
  const entries: { usage: string; description: string }[] = [];
  for (const line of lead ? [lead[2] ?? "", ...lines.slice(1)] : lines) {
    const match = COMMAND_LINE.exec(line.trim());
    if (!match) return fallback;
    entries.push({ usage: match[1] ?? "", description: match[2] ?? "" });
  }

  return (
    <>
      {lead?.[1] ? <span>{lead[1]}:</span> : null}
      <ul className="mt-1 space-y-1">
        {entries.map((entry, index) => (
          <li key={index}>
            <code className="font-mono text-xs text-fg">{entry.usage}</code>
            <span> - {entry.description}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
