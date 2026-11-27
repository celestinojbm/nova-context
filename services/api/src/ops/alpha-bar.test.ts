import { describe, expect, it } from "vitest";
import { ALPHA_BAR_MIN_SAMPLE, evaluateAlphaBar, type AlphaBarInputs } from "./alpha-bar.js";

/** A cohort that clears every Horizon-2 bar (docs/ROADMAP.md). */
const passing: AlphaBarInputs = {
  window_days: 14,
  active_users: 25,
  window_captures: 200, // 200 / 25 / 2 weeks = 4 per user per week
  linked_captures: 100, // 0.5
  linked_captures_incl_inbox: 150,
  confirmed_actions: 40,
  capture_to_action_p50_seconds: 8,
  capture_to_action_p75_seconds: 21.34,
  week4_eligible_users: 10,
  week4_retained_users: 6,
  captures_with_intent: 120,
  captures_with_intent_actioned: 60,
  captures_without_intent: 80,
  captures_without_intent_actioned: 8,
};

describe("evaluateAlphaBar", () => {
  it("passes every metric and reports `met` for a cohort above the bar", () => {
    const bar = evaluateAlphaBar(passing);
    expect(bar.verdict).toBe("met");
    expect(bar.metrics.active_users).toMatchObject({ value: 25, status: "pass" });
    expect(bar.metrics.captures_per_user_per_week).toMatchObject({ value: 4, status: "pass" });
    expect(bar.metrics.linked_share).toMatchObject({ value: 0.5, status: "pass" });
    expect(bar.metrics.capture_to_action_p75_seconds).toMatchObject({ value: 21.3, status: "pass" });
    expect(bar.metrics.week4_retention).toMatchObject({ value: 0.6, status: "pass" });
    expect(bar.detail.linked_share_incl_inbox).toBe(0.75);
  });

  it("uses the roadmap's strict inequalities at the exact thresholds", () => {
    const bar = evaluateAlphaBar({
      ...passing,
      window_captures: 150, // exactly 3/user/week → not "> 3"
      linked_captures: 60, // exactly 0.4 → not "> 40%"
      capture_to_action_p75_seconds: 30, // not "< 30s"
      week4_retained_users: 5, // exactly 0.5 → not "> 50%"
    });
    expect(bar.metrics.captures_per_user_per_week.status).toBe("fail");
    expect(bar.metrics.linked_share.status).toBe("fail");
    expect(bar.metrics.capture_to_action_p75_seconds.status).toBe("fail");
    expect(bar.metrics.week4_retention.status).toBe("fail");
    // 25 active users is ">= 25": the one inclusive target.
    expect(bar.metrics.active_users.status).toBe("pass");
    expect(bar.verdict).toBe("not_met");
  });

  it("reports insufficient_data instead of a verdict on tiny samples", () => {
    const bar = evaluateAlphaBar({
      ...passing,
      confirmed_actions: ALPHA_BAR_MIN_SAMPLE - 1,
      week4_eligible_users: 0,
      week4_retained_users: 0,
    });
    expect(bar.metrics.capture_to_action_p75_seconds.status).toBe("insufficient_data");
    expect(bar.metrics.week4_retention).toMatchObject({ value: null, status: "insufficient_data" });
    // No failure, but not everything passed → incomplete, never "met".
    expect(bar.verdict).toBe("incomplete");
  });

  it("an empty alpha fails the head count but makes no claim about ratios", () => {
    const bar = evaluateAlphaBar({
      window_days: 14,
      active_users: 0,
      window_captures: 0,
      linked_captures: 0,
      linked_captures_incl_inbox: 0,
      confirmed_actions: 0,
      capture_to_action_p50_seconds: null,
      capture_to_action_p75_seconds: null,
      week4_eligible_users: 0,
      week4_retained_users: 0,
      captures_with_intent: 0,
      captures_with_intent_actioned: 0,
      captures_without_intent: 0,
      captures_without_intent_actioned: 0,
    });
    expect(bar.metrics.active_users).toMatchObject({ value: 0, status: "fail" });
    for (const key of [
      "captures_per_user_per_week",
      "linked_share",
      "capture_to_action_p75_seconds",
      "week4_retention",
    ] as const) {
      expect(bar.metrics[key]).toMatchObject({ value: null, status: "insufficient_data" });
    }
    expect(bar.verdict).toBe("not_met");
    expect(bar.intent_split.with_intent.action_rate).toBeNull();
  });

  it("splits action rate by intent utterance and never invents retrieval", () => {
    const bar = evaluateAlphaBar(passing);
    expect(bar.intent_split.with_intent).toEqual({
      captures: 120,
      action_rate: 0.5,
      retrieval_rate: null,
    });
    expect(bar.intent_split.without_intent).toEqual({
      captures: 80,
      action_rate: 0.1,
      retrieval_rate: null,
    });
    expect(bar.intent_split.retrieval).toBe("not_instrumented");
  });

  it("normalizes captures/user/week by the window length", () => {
    const bar = evaluateAlphaBar({ ...passing, window_days: 7, window_captures: 100 });
    expect(bar.metrics.captures_per_user_per_week.value).toBe(4); // 100 / 25 / 1
  });
});
