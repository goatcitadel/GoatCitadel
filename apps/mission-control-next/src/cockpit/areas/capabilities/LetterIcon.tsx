import { cn } from "../../lib/cn";
import { letterIconTone } from "./letter-icon-tone";

/*
 * Each look pairs a surface with the text colour made for it, and every pair is 4.5:1 or better in both themes
 * (light / dark): accent-ink on accent 5.6 / 11.0, accent on sunken 4.9 / 11.8, canvas on fg 14.5 / 15.4 and fg on
 * sunken 13.2 / 16.3. None of them uses a status colour, so an icon never reads as a state.
 */
const TONE_CLASSES: readonly string[] = [
  "bg-accent text-accent-ink",
  "bg-sunken text-accent",
  "bg-fg text-canvas",
  "bg-sunken text-fg",
];

/** The first letter or digit of a name, upper-cased. */
function initial(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}

/** A square with the app's first letter, for apps that have no logo of their own. The name beside it carries the meaning. */
export function LetterIcon({ name, className }: { name: string; className?: string }) {
  const tone = TONE_CLASSES[letterIconTone(name) % TONE_CLASSES.length];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-md font-display text-lg font-semibold",
        tone,
        className,
      )}
    >
      {initial(name)}
    </span>
  );
}
