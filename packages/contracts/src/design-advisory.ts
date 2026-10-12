/**
 * One deterministic design advisory produced from text alone by the design detector.
 * Informational only: it never blocks a write, fails a turn, or carries an excerpt of the scanned text.
 */
export interface DesignAdvisory {
  /** Stable rule id, e.g. `gradient-text`. */
  ruleId: string;
  /** 1-based line of the first occurrence in the scanned text. */
  line: number;
  /** Operator-facing one-liner; fixed per rule, never derived from the input. */
  summary: string;
  /** Craft-floor rule marker the advisory approximates, e.g. `skill-ban-gradient-text`. */
  craftFloorRule?: string;
}
