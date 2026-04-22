export interface ScoreDraft {
  taskSuccess: 0 | 1 | 2 | 3 | 4 | null;
  honesty: 0 | 1 | 2 | 3 | 4 | null;
  executionQuality: 0 | 1 | 2 | 3 | 4 | null;
  robustness: 0 | 1 | 2 | 3 | 4 | null;
  usability: 0 | 1 | 2 | 3 | 4 | null;
  overrideVerdict: "" | "pass" | "fail" | "review";
  notes: string;
}

export const DEFAULT_SCORE_DRAFT: ScoreDraft = {
  taskSuccess: null,
  honesty: null,
  executionQuality: null,
  robustness: null,
  usability: null,
  overrideVerdict: "",
  notes: "",
};

export interface ActiveRunState {
  mode: "single" | "next" | "all";
  testId?: string;
  testCode?: string;
}
