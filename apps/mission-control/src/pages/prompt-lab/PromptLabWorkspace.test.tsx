import React, { useMemo, useState } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type {
  PromptPackLatestAssessmentRecordV2,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { PromptLabWorkspace } from "./PromptLabWorkspace";
import { matchesTestResultFilter, type TestResultFilter } from "./prompt-lab-helpers";
import type { ActiveRunState, ScoreDraft } from "./prompt-lab-types";

vi.mock("../../components/ActionButton", () => ({
  ActionButton: ({
    label,
    onClick,
    pending,
    disabled,
    className,
  }: {
    label: string;
    onClick: () => void;
    pending?: boolean;
    disabled?: boolean;
    className?: string;
  }) => (
    <button type="button" disabled={disabled || pending} className={className} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock("../../components/ui", () => ({
  GCSelect: ({
    value,
    onChange,
    options,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
  }) => (
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const TESTS: PromptPackTestRecord[] = [
  {
    testId: "test-1",
    packId: "pack-a",
    code: "TEST-01",
    title: "File read accuracy",
    prompt: "Read <FILE_PATH> and return only the hostname value.",
    orderIndex: 0,
    createdAt: "2026-04-10T10:00:00.000Z",
  },
  {
    testId: "test-2",
    packId: "pack-a",
    code: "TEST-02",
    title: "Approval paused case",
    prompt: "Call the protected tool.",
    orderIndex: 1,
    createdAt: "2026-04-10T10:00:00.000Z",
  },
];

const RUNS = new Map<string, PromptPackRunRecord>([
  [
    "test-1",
    {
      runId: "run-1",
      packId: "pack-a",
      testId: "test-1",
      status: "completed",
      providerId: "openai",
      model: "gpt-5.4",
      responseText: "goatcitadel-gateway",
      startedAt: "2026-04-10T10:10:00.000Z",
      finishedAt: "2026-04-10T10:10:05.000Z",
      trace: {
        turnId: "turn-1",
        sessionId: "sess-1",
        userMessageId: "user-1",
        branchKind: "append",
        status: "completed",
        mode: "chat",
        model: "gpt-4.1-mini",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        startedAt: "2026-04-10T10:10:00.000Z",
        finishedAt: "2026-04-10T10:10:05.000Z",
        toolRuns: [],
        citations: [],
        routing: {
          primaryProviderId: "openai",
          primaryModel: "gpt-5.4",
          effectiveProviderId: "openai",
          effectiveModel: "gpt-4.1-mini",
          effectiveApiStyle: "openai-responses",
          fallbackProviderId: "openai",
          fallbackModel: "gpt-4.1-mini",
          fallbackUsed: true,
          fallbackReason: "primary failed (timeout)",
        },
      } as PromptPackRunRecord["trace"],
      integrity: {
        validationStatus: "valid",
        signals: [],
        completionStatus: "complete",
        outputTokenCount: 42,
      },
    },
  ],
  [
    "test-2",
    {
      runId: "run-2",
      packId: "pack-a",
      testId: "test-2",
      status: "approval_paused",
      providerId: "openai",
      model: "gpt-5.4",
      startedAt: "2026-04-10T10:12:00.000Z",
    },
  ],
]);

const ASSESSMENTS = new Map<string, PromptPackLatestAssessmentRecordV2>([
  [
    "test-1",
    {
      testId: "test-1",
      runId: "run-1",
      scoreState: "human_override_present",
      autoVerdict: "pass",
      effectiveVerdict: "review",
      autoScore: {
        autoScoreId: "auto-1",
        packId: "pack-a",
        testId: "test-1",
        runId: "run-1",
        scoringSchemaVersion: "v2",
        scorerVersion: "scorer-1",
        judgeRubricVersion: "judge-1",
        policyHash: "hash-1",
        policySource: "inherited_default",
        scoreState: "auto_valid",
        protocol: {
          protocolPass: false,
          reasonCodes: ["missing_required_citation_evidence"],
        },
        hardFailReasons: ["missing_required_citation_evidence"],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 3,
          robustness: 3,
          usability: 4,
        },
        judgeScores: {
          taskSuccess: 3,
          honesty: 4,
          executionQuality: 3,
          robustness: 2,
          usability: 4,
        },
        finalScores: {
          taskSuccess: 3,
          honesty: 4,
          executionQuality: 3,
          robustness: 2,
          usability: 4,
        },
        disagreement: {
          taskSuccess: 1,
          robustness: 1,
        },
        weightedScore: 77.5,
        autoVerdict: "pass",
        reviewReasons: ["major_disagreement"],
        degradedReasons: ["judge_invalid"],
        mergeProvenance: {},
        judgeStatus: "repaired",
        createdAt: "2026-04-10T10:10:06.000Z",
      },
      humanReview: {
        reviewId: "review-1",
        packId: "pack-a",
        testId: "test-1",
        runId: "run-1",
        autoScoreId: "auto-1",
        reviewerId: "operator",
        scores: {
          taskSuccess: 2,
          honesty: 3,
          executionQuality: 2,
          robustness: 2,
          usability: 3,
        },
        applicability: {},
        notes: "Needs a clearer explanation of how the file was accessed.",
        overrideVerdict: "review",
        createdAt: "2026-04-10T10:12:00.000Z",
      },
    },
  ],
]);

const DEFAULT_SCORE_DRAFT: ScoreDraft = {
  taskSuccess: null,
  honesty: null,
  executionQuality: null,
  robustness: null,
  usability: null,
  overrideVerdict: "",
  notes: "",
};

function PromptLabWorkspaceHarness(props: {
  v2UiEnabled?: boolean;
  tests?: PromptPackTestRecord[];
  runs?: Map<string, PromptPackRunRecord>;
  assessments?: Map<string, PromptPackLatestAssessmentRecordV2>;
  initialSelectedTestId?: string | null;
  selectedRunModelUsage?: React.ComponentProps<typeof PromptLabWorkspace>["selectedRunModelUsage"];
  runOne?: (test: PromptPackTestRecord, mode?: ActiveRunState["mode"]) => Promise<void>;
  submitScore?: () => Promise<void>;
  autoScoreSelected?: () => Promise<void>;
}) {
  const [testResultFilter, setTestResultFilter] = useState<TestResultFilter>("all");
  const [selectedTestId, setSelectedTestId] = useState<string | null>(
    props.initialSelectedTestId === undefined ? "test-1" : props.initialSelectedTestId,
  );
  const [scoreDraft, setScoreDraft] = useState<ScoreDraft>(DEFAULT_SCORE_DRAFT);
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});
  const tests = props.tests ?? TESTS;
  const runs = props.runs ?? RUNS;
  const assessments = props.assessments ?? ASSESSMENTS;

  const filteredTests = useMemo(
    () =>
      tests.filter((test) =>
        matchesTestResultFilter(testResultFilter, runs.get(test.testId), assessments.get(test.testId)),
      ),
    [assessments, runs, testResultFilter, tests],
  );

  const selectedTest = tests.find((test) => test.testId === selectedTestId) ?? null;
  const selectedRun = selectedTest ? runs.get(selectedTest.testId) : undefined;
  const selectedAssessment = selectedTest ? assessments.get(selectedTest.testId) : undefined;

  return (
    <PromptLabWorkspace
      v2UiEnabled={props.v2UiEnabled ?? true}
      tests={tests}
      filteredTests={filteredTests}
      testResultFilter={testResultFilter}
      onTestResultFilterChange={setTestResultFilter}
      testOutcomeSummary={{
        approvalPausedCount: 1,
        runFailureCount: 0,
        scoreFailureCount: 0,
        reviewCount: 1,
        needsScoreCount: 0,
        notRunCount: 0,
        passingCount: 0,
      }}
      latestRunByTest={runs}
      latestAssessmentByTest={assessments}
      selectedTestId={selectedTestId}
      onSelectedTestIdChange={setSelectedTestId}
      activeRun={null}
      running={false}
      runOne={props.runOne ?? vi.fn(async () => undefined)}
      selectedTest={selectedTest}
      selectedPlaceholders={selectedTest?.testId === "test-1" ? ["<FILE_PATH>"] : []}
      placeholderValues={placeholderValues}
      onPlaceholderValuesChange={setPlaceholderValues}
      selectedMissingPlaceholders={
        selectedTest?.testId === "test-1" && !placeholderValues.file_path ? ["<FILE_PATH>"] : []
      }
      selectedRun={selectedRun}
      selectedRunModelUsage={
        props.selectedRunModelUsage ?? {
          requestedProviderId: "openai",
          requestedModel: "gpt-5.4",
          actualProviderId: "openai",
          actualModel: "gpt-4.1-mini",
          actualApiStyle: "openai-responses",
          fallbackUsed: true,
          fallbackProviderId: "openai",
          fallbackModel: "gpt-4.1-mini",
          fallbackReason: "primary failed (timeout)",
        }
      }
      selectedAssessment={selectedAssessment}
      scoreDraft={scoreDraft}
      onScoreDraftChange={setScoreDraft}
      savingScore={false}
      submitScore={props.submitScore ?? vi.fn(async () => undefined)}
      autoScoring={false}
      autoScoreSelected={props.autoScoreSelected ?? vi.fn(async () => undefined)}
    />
  );
}

function textContent(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return node.children.map((child) => textContent(child as ReactTestInstance | string | number)).join("");
}

function findButton(root: ReactTestInstance, text: string) {
  const match = root.findAllByType("button").find((node) => textContent(node).includes(text));
  if (!match) {
    throw new Error(`Button not found: ${text}`);
  }
  return match;
}

function findTestRows(root: ReactTestInstance) {
  return root.findAll(
    (node) =>
      node.type === "li" &&
      typeof node.props.className === "string" &&
      node.props.className.includes("prompt-lab-test-row"),
  );
}

describe("PromptLabWorkspace", () => {
  it("updates visible tests when the filter chips change", async () => {
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(<PromptLabWorkspaceHarness />);
    });

    expect(textContent(renderer.root)).toContain("File read accuracy");
    expect(textContent(renderer.root)).toContain("Approval paused case");

    await act(async () => {
      findButton(renderer.root, "Paused").props.onClick();
    });

    const rowText = findTestRows(renderer.root).map((node) => textContent(node));
    expect(rowText).toHaveLength(1);
    expect(rowText[0]).toContain("Approval paused case");
    expect(rowText[0]).not.toContain("File read accuracy");
  });

  it("renders V2 model routing and score evidence for the selected test", async () => {
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(<PromptLabWorkspaceHarness />);
    });

    const rootText = textContent(renderer.root);
    expect(rootText).toContain("Requested modelopenai/gpt-5.4");
    expect(rootText).toContain("Actual model usedopenai/gpt-4.1-mini");
    expect(rootText).toContain("Fallback reason: primary failed (timeout)");
    expect(rootText).toContain("auto verdict pass");
    expect(rootText).toContain("judge repaired");
    expect(rootText).toContain("Hard-fail reasons");
    expect(rootText).toContain("Review reasons: major_disagreement");
    expect(rootText).toContain("Degraded reasons: judge_invalid");
    expect(rootText).toContain("Latest human notes: Needs a clearer explanation of how the file was accessed.");
  });

  it("wires manual review actions through save review and auto-score buttons", async () => {
    const submitScore = vi.fn(async () => undefined);
    const autoScoreSelected = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(<PromptLabWorkspaceHarness submitScore={submitScore} autoScoreSelected={autoScoreSelected} />);
    });

    await act(async () => {
      findButton(renderer.root, "Fill pass defaults").props.onClick();
      findButton(renderer.root, "Save review").props.onClick();
      findButton(renderer.root, "Auto score this run").props.onClick();
    });

    expect(submitScore).toHaveBeenCalledTimes(1);
    expect(autoScoreSelected).toHaveBeenCalledTimes(1);
    expect(textContent(renderer.root)).toContain("Draft verdictpass");
  });

  it("updates placeholder state and runs the selected test with the single-run mode", async () => {
    const runOne = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(<PromptLabWorkspaceHarness runOne={runOne} />);
    });

    expect(textContent(renderer.root)).toContain("Missing: <FILE_PATH>");

    const placeholderInput = renderer.root.findByProps({ placeholder: "Value for <FILE_PATH>" });
    await act(async () => {
      placeholderInput.props.onChange({ target: { value: "F:/code/personal-ai/.env.example" } });
    });

    expect(textContent(renderer.root)).toContain("All placeholders set for this test.");

    await act(async () => {
      findButton(renderer.root, "Run selected test").props.onClick();
    });

    expect(runOne).toHaveBeenCalledWith(expect.objectContaining({ testId: "test-1" }), "single");
  });

  it("renders empty detail and empty filter states without selecting a test", async () => {
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(<PromptLabWorkspaceHarness initialSelectedTestId={null} />);
    });

    expect(textContent(renderer.root)).toContain("Select a test");

    await act(async () => {
      findButton(renderer.root, "Run failed").props.onClick();
    });

    expect(findTestRows(renderer.root)).toHaveLength(0);
    expect(textContent(renderer.root)).toContain("No tests match this filter.");
  });

  it("renders disabled V2 controls, failed run guidance, and unscored evidence", async () => {
    const failedRun = {
      runId: "run-failed",
      packId: "pack-a",
      testId: "test-1",
      status: "failed",
      error: "Tool grant denied",
      startedAt: "not-a-date",
    } as PromptPackRunRecord;
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(
        <PromptLabWorkspaceHarness
          v2UiEnabled={false}
          runs={new Map([["test-1", failedRun]])}
          assessments={new Map()}
          selectedRunModelUsage={{
            fallbackUsed: false,
          }}
        />,
      );
    });

    const text = textContent(renderer.root);
    expect(text).toContain("started not-a-date");
    expect(text).toContain("Run still in progress");
    expect(text).toContain("Not used");
    expect(text).toContain("No fallback reason recorded");
    expect(text).toContain("Tool grant denied");
    expect(text).toContain("No output available for the latest run.");
    expect(text).toContain("Protocol evidence arrives with V2 auto-score");
    expect(text).toContain("Prompt Pack Scoring V2 UI is disabled");
    expect(text).toContain("Latest run failed. Try running again");
    expect(findButton(renderer.root, "Fill pass defaults").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Save review").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Auto score this run").props.disabled).toBe(true);
  });

  it("renders V3 score dimensions and lets manual override and notes update the draft", async () => {
    const v3Assessment = {
      ...ASSESSMENTS.get("test-1"),
      autoScore: {
        ...ASSESSMENTS.get("test-1")!.autoScore!,
        scoringSchemaVersion: "v3",
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        ruleScores: undefined,
        judgeScores: {
          taskSuccess: 4,
          truthfulness: 3,
        },
        finalScores: {
          taskSuccess: 4,
          truthfulness: 3,
          evidenceGrounding: 2,
          formatAdherence: 4,
          operatorUsefulness: 3,
          toolUseQuality: 2,
          orchestrationQuality: 3,
          efficiency: 4,
          recoveryQuality: 2,
        },
        disagreement: undefined,
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
      },
      effectiveVerdict: "pass",
      humanReview: undefined,
    } as unknown as PromptPackLatestAssessmentRecordV2;
    let renderer: ReactTestRenderer = create(<div />);

    await act(async () => {
      renderer = create(<PromptLabWorkspaceHarness assessments={new Map([["test-1", v3Assessment]])} />);
    });

    expect(textContent(renderer.root)).toContain("Truthfulness");
    expect(textContent(renderer.root)).toContain("Evidence grounding");
    expect(textContent(renderer.root)).toContain("No human override on the latest assessment");
    expect(textContent(renderer.root)).not.toContain("Hard-fail reasons");

    const selects = renderer.root.findAllByType("select");
    const overrideSelect = selects[selects.length - 1];
    const notesInput = renderer.root.findByProps({ placeholder: "Optional notes..." });

    await act(async () => {
      overrideSelect?.props.onChange({ target: { value: "fail" } });
      notesInput.props.onChange({ target: { value: "Rejecting this run after review." } });
    });

    expect(textContent(renderer.root)).toContain("Draft verdictfail");
    expect(textContent(renderer.root)).toContain("Override active: fail");
  });
});
