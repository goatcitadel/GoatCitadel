import type { ReactNode } from "react";

export type ChipTone = "safe" | "caution" | "danger" | "nuclear" | "muted" | "accent";

export type ThreePartChipProps = {
  tone: ChipTone;
  state: ReactNode;
  mid?: ReactNode;
  age?: ReactNode;
  dot?: boolean;
};

export function ThreePartChip({ tone, state, mid, age, dot = true }: ThreePartChipProps) {
  return (
    <span className="mc-next-chip-3" data-tone={tone}>
      <span className="mc-next-chip-3-state">
        {dot ? <span className="mc-next-chip-3-dot" aria-hidden="true" /> : null}
        <span>{state}</span>
      </span>
      {mid !== undefined ? <span className="mc-next-chip-3-mid">{mid}</span> : null}
      {age !== undefined ? <span className="mc-next-chip-3-age">{age}</span> : null}
    </span>
  );
}
