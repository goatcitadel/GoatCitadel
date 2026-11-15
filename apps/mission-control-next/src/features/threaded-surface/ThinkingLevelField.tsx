import type { ChatThinkingLevel } from "@goatcitadel/contracts";
import { useRef } from "react";
import { HeldChoiceNotice, useHeldChoice } from "./use-held-choice";

const LEVELS: ReadonlyArray<{ value: ChatThinkingLevel; label: string }> = [
  { value: "off", label: "No thinking" },
  { value: "minimal", label: "Minimal" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
  { value: "deep", label: "Deep" },
  { value: "max", label: "Maximum (supported models only)" },
  { value: "ultra", label: "Ultra (supported models only)" },
];

/**
 * The dock's Thinking select. A pick is held until it is applied (Apply, focus leaving, or Escape to discard), so
 * arrowing through the levels applies none of them on the way.
 */
export function ThinkingLevelField({
  value,
  supports,
  onApply,
  scope,
}: {
  value: ChatThinkingLevel;
  supports: (level: ChatThinkingLevel) => boolean;
  onApply: (level: ChatThinkingLevel) => void;
  /** The conversation: a pick held for another one is dropped, never applied to this one. */
  scope: unknown;
}) {
  const held = useHeldChoice<{ level?: ChatThinkingLevel }, ChatThinkingLevel>({
    resolve: (draft) => (draft.level !== undefined && draft.level !== value ? draft.level : null),
    send: onApply,
    scope,
  });
  const field = useRef<HTMLSelectElement>(null);
  return (
    <div {...held.wrapperProps}>
      <label className="mc-next-context-field">
        <span>Thinking</span>
        <select
          ref={field}
          value={held.draft.level ?? value}
          onChange={(event) => {
            const level = event.target.value as ChatThinkingLevel;
            held.hold((current) => ({ ...current, level }));
          }}
          aria-label="Thinking level"
        >
          {LEVELS.map((level) => (
            <option key={level.value} value={level.value} disabled={!supports(level.value)}>
              {level.label}
            </option>
          ))}
        </select>
      </label>
      {held.dirty ? <HeldChoiceNotice onApply={held.apply} focusTarget={() => field.current} /> : null}
    </div>
  );
}
