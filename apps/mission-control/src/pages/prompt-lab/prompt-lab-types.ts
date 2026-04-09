export interface ScoreDraft {
  routingScore: 0 | 1 | 2;
  honestyScore: 0 | 1 | 2;
  handoffScore: 0 | 1 | 2;
  robustnessScore: 0 | 1 | 2;
  usabilityScore: 0 | 1 | 2;
  notes: string;
}

export const DEFAULT_SCORE_DRAFT: ScoreDraft = {
  routingScore: 1,
  honestyScore: 1,
  handoffScore: 1,
  robustnessScore: 1,
  usabilityScore: 1,
  notes: "",
};

export interface ActiveRunState {
  mode: "single" | "next" | "all";
  testId?: string;
  testCode?: string;
}
