import { describe, expect, it } from "vitest";
import type { DecisionReplayCandidate } from "./improvement-replay.js";
import {
  compareDecisionCauseCounts,
  computeDecisionWrongnessProbability,
  evaluateDecisionReplayRuleScores,
  inferDecisionReplayCauseClass,
  mapDecisionAutoTuneRow,
  mapImprovementReportRow,
  sampleDecisionReplayCandidates,
} from "./improvement-replay.js";

describe("improvement replay helpers", () => {
  it("samples critical decisions first and preserves the requested cap", () => {
    const candidates: DecisionReplayCandidate[] = [
      replayCandidate("normal-1", "completed"),
      replayCandidate("failed-1", "failed"),
      replayCandidate("normal-2", "completed"),
      replayCandidate("blocked-1", "blocked"),
      replayCandidate("approval-1", "approval_required"),
    ];

    const sample = sampleDecisionReplayCandidates(candidates, 3);

    expect(sample).toHaveLength(3);
    expect(sample[0]?.turnId).toBe("failed-1");
    expect(sample.map((item) => item.turnId)).toEqual(["failed-1", "normal-1", "normal-2"]);
  });

  it("scores replay candidates and infers the same cause class used by weekly findings", () => {
    const candidate: DecisionReplayCandidate = {
      ...replayCandidate("turn-live-failed", "failed"),
      routing: { liveDataIntent: true },
      retrieval: { l2Used: false },
      reflection: { attemptCount: 0 },
      webMode: "deep",
    };
    const failedTool: DecisionReplayCandidate = {
      decisionType: "tool_run",
      status: "failed",
      occurredAt: "2026-05-07T00:01:00.000Z",
      turnId: "turn-live-failed",
      toolRunId: "tool-1",
      toolName: "web.search",
      error: "network timeout",
    };

    const { scores, signals } = evaluateDecisionReplayRuleScores(candidate, [failedTool]);
    const wrongness = computeDecisionWrongnessProbability(candidate, scores);

    expect(signals).toEqual(
      expect.arrayContaining(["chat_turn_failed", "failed_tools_present", "live_data_without_l2"]),
    );
    expect(wrongness).toBeGreaterThan(0.45);
    expect(inferDecisionReplayCauseClass(candidate, scores, wrongness)).toBe("retrieval_miss");
  });

  it("maps auto-tunes and weekly reports without losing parsed payloads", () => {
    const tune = mapDecisionAutoTuneRow({
      tune_id: "tune-1",
      run_id: "run-1",
      finding_id: "finding-1",
      tune_class: "threshold_adjustment",
      risk_level: "low",
      status: "queued",
      description: "Raise retry threshold",
      patch_json: '{"settingKey":"retry","nextValue":0.7}',
      snapshot_json: '{"settingKey":"retry","previousValue":0.5}',
      result_json: null,
      created_at: "2026-05-07T00:00:00.000Z",
      applied_at: null,
      reverted_at: null,
    });
    const report = mapImprovementReportRow({
      report_id: "report-1",
      run_id: "run-1",
      week_start: "2026-05-03T00:00:00.000Z",
      week_end: "2026-05-10T00:00:00.000Z",
      summary_json:
        '{"sampledDecisions":3,"likelyWrongCount":1,"wrongnessRate":0.33,"topCauseClasses":[],"duplicateSuppressedCount":0,"improvedCount":1,"regressedCount":0}',
      top_findings_json: "[]",
      applied_tunes_json: "[]",
      queued_tunes_json: `[${JSON.stringify(tune)}]`,
      week_over_week_json: '{"improved":["retrieval_miss: 2 -> 1"],"regressed":[],"unchanged":[]}',
      previous_report_id: null,
      created_at: "2026-05-07T00:00:00.000Z",
    });

    expect(tune.patch).toMatchObject({ settingKey: "retry", nextValue: 0.7 });
    expect(tune.snapshot).toMatchObject({ previousValue: 0.5 });
    expect(report.summary.sampledDecisions).toBe(3);
    expect(report.queuedRecommendations[0]?.tuneId).toBe("tune-1");
    expect(report.weekOverWeek.improved).toEqual(["retrieval_miss: 2 -> 1"]);
  });

  it("compares replay cause counts for weekly report deltas", () => {
    const deltas = compareDecisionCauseCounts(
      new Map([
        ["retrieval_miss", 1],
        ["tool_mismatch", 3],
      ]),
      new Map([
        ["retrieval_miss", 2],
        ["tool_mismatch", 1],
        ["weak_blocker_explanation", 1],
      ]),
    );

    expect(deltas.improved).toEqual(
      expect.arrayContaining(["retrieval_miss: 2 -> 1", "weak_blocker_explanation: 1 -> 0"]),
    );
    expect(deltas.regressed).toEqual(["tool_mismatch: 1 -> 3"]);
  });
});

function replayCandidate(turnId: string, status: string): DecisionReplayCandidate {
  return {
    decisionType: "chat_turn",
    turnId,
    sessionId: `sess-${turnId}`,
    status,
    occurredAt: "2026-05-07T00:00:00.000Z",
  };
}
