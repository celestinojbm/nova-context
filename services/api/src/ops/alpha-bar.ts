import type pg from "pg";

/**
 * Horizon-2 alpha bar (docs/ROADMAP.md, "Success metrics (the alpha bar)"),
 * computed from the database the alpha already writes. Counts, ratios and
 * seconds ONLY — no captured content, no per-user rows, no ids.
 *
 * Two layers, so the verdict logic is unit-testable without Postgres:
 *   - `collectAlphaBarInputs` runs the SQL and returns raw numerators /
 *     denominators;
 *   - `evaluateAlphaBar` turns them into metrics with a target and a status
 *     (`pass` | `fail` | `insufficient_data`).
 *
 * Definitions (stated here because each one is a judgment call):
 *   - Population: non-deleted users, excluding synthetic accounts
 *     (`*@alpha.local` from ops:smoke, `*@nova-validate.invalid` from the
 *     post-deploy validation gate — normally deleted by its cleanup, but an
 *     orphan would sit in the week-4 denominator — and the `dev@nova.local`
 *     seed) unless `includeSynthetic` is set.
 *   - Window: captures (context_moments) created in the last `days` days.
 *   - Active user: ≥1 capture in the window.
 *   - Captures/user/week: window captures ÷ active users ÷ (days / 7).
 *   - Linked: the capture has a project that is NOT the signup "Inbox".
 *     Inbox is where unsorted captures land, so counting it would measure
 *     the default, not the linking behavior the metric exists to validate.
 *   - Capture-to-action: server-side seconds from the moment row's
 *     created_at to the action being confirmed (approved_at, or created_at
 *     for Tier-0 actions that auto-execute). Confirmed = the user approved
 *     (approved_at set, whatever happened next: queued, executing, done or
 *     failed) or a Tier-0 auto action. Execution outcome is not part of
 *     capture-to-confirmed. It EXCLUDES client-side time before the
 *     capture reached the API, so it is a lower bound of the roadmap's
 *     invoke-to-confirmed figure.
 *   - Week-4 retention: users who signed up ≥28 days before `now`, retained
 *     if they captured in days [21, 28) after signup. Independent of `days`.
 *   - Intent split (theory falsification test, THEORY §6): window captures
 *     with vs. without an intent utterance, and the share of each that led
 *     to a confirmed action. Retrieval is NOT instrumented yet (search does
 *     not record which moments it returned/opened), so it is reported as
 *     null rather than guessed.
 */

export const ALPHA_BAR_TARGETS = {
  active_users: 25,
  captures_per_user_per_week: 3, // strictly greater than
  linked_share: 0.4, // strictly greater than
  capture_to_action_p75_seconds: 30, // strictly less than
  week4_retention: 0.5, // strictly greater than
} as const;

/** Below this sample size a ratio/percentile is reported as insufficient. */
export const ALPHA_BAR_MIN_SAMPLE = 5;

export const INBOX_PROJECT_NAME = "Inbox";

export interface AlphaBarInputs {
  window_days: number;
  active_users: number;
  window_captures: number;
  linked_captures: number; // excluding Inbox
  linked_captures_incl_inbox: number;
  confirmed_actions: number;
  capture_to_action_p50_seconds: number | null;
  capture_to_action_p75_seconds: number | null;
  week4_eligible_users: number;
  week4_retained_users: number;
  captures_with_intent: number;
  captures_with_intent_actioned: number;
  captures_without_intent: number;
  captures_without_intent_actioned: number;
}

export type AlphaBarStatus = "pass" | "fail" | "insufficient_data";

export interface AlphaBarMetric {
  value: number | null;
  target: string;
  status: AlphaBarStatus;
  sample: number;
}

export interface IntentSplitArm {
  captures: number;
  action_rate: number | null;
  retrieval_rate: null;
}

export interface AlphaBar {
  window_days: number;
  verdict: "met" | "not_met" | "incomplete";
  metrics: {
    active_users: AlphaBarMetric;
    captures_per_user_per_week: AlphaBarMetric;
    linked_share: AlphaBarMetric;
    capture_to_action_p75_seconds: AlphaBarMetric;
    week4_retention: AlphaBarMetric;
  };
  detail: {
    window_captures: number;
    linked_share_incl_inbox: number | null;
    capture_to_action_p50_seconds: number | null;
    week4_eligible_users: number;
    week4_retained_users: number;
  };
  intent_split: {
    with_intent: IntentSplitArm;
    without_intent: IntentSplitArm;
    retrieval: "not_instrumented";
  };
}

const round = (n: number, places = 3): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const ratio = (num: number, den: number): number | null =>
  den > 0 ? round(num / den) : null;

/**
 * `raw` is judged against the target; `places` only rounds what is shown.
 * Rounding first would flip strict bars at the edge (0.4004 → 0.4 fails "> 0.4").
 */
function metric(
  raw: number | null,
  sample: number,
  target: string,
  passes: (v: number) => boolean,
  opts: { places?: number; minSample?: number } = {},
): AlphaBarMetric {
  const { places = 3, minSample = ALPHA_BAR_MIN_SAMPLE } = opts;
  const value = raw === null ? null : round(raw, places);
  if (raw === null || sample < minSample) {
    return { value, target, status: "insufficient_data", sample };
  }
  return { value, target, status: passes(raw) ? "pass" : "fail", sample };
}

const rawRatio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/** Pure: raw inputs → metrics with targets and statuses. */
export function evaluateAlphaBar(inputs: AlphaBarInputs): AlphaBar {
  const t = ALPHA_BAR_TARGETS;
  const weeks = inputs.window_days / 7;
  const perWeek =
    inputs.active_users > 0 && weeks > 0
      ? inputs.window_captures / inputs.active_users / weeks
      : null;

  const metrics = {
    // A head count, not a sample: zero users is a real (failing) answer.
    active_users: metric(
      inputs.active_users,
      inputs.active_users,
      `>= ${t.active_users}`,
      (v) => v >= t.active_users,
      { places: 0, minSample: 0 },
    ),
    captures_per_user_per_week: metric(
      perWeek,
      inputs.active_users,
      `> ${t.captures_per_user_per_week}`,
      (v) => v > t.captures_per_user_per_week,
      { places: 2 },
    ),
    linked_share: metric(
      rawRatio(inputs.linked_captures, inputs.window_captures),
      inputs.window_captures,
      `> ${t.linked_share}`,
      (v) => v > t.linked_share,
    ),
    capture_to_action_p75_seconds: metric(
      inputs.capture_to_action_p75_seconds,
      inputs.confirmed_actions,
      `< ${t.capture_to_action_p75_seconds}`,
      (v) => v < t.capture_to_action_p75_seconds,
      { places: 1 },
    ),
    week4_retention: metric(
      rawRatio(inputs.week4_retained_users, inputs.week4_eligible_users),
      inputs.week4_eligible_users,
      `> ${t.week4_retention}`,
      (v) => v > t.week4_retention,
    ),
  };

  const statuses = Object.values(metrics).map((m) => m.status);
  const verdict = statuses.includes("fail")
    ? "not_met"
    : statuses.every((s) => s === "pass")
      ? "met"
      : "incomplete";

  return {
    window_days: inputs.window_days,
    verdict,
    metrics,
    detail: {
      window_captures: inputs.window_captures,
      linked_share_incl_inbox: ratio(inputs.linked_captures_incl_inbox, inputs.window_captures),
      capture_to_action_p50_seconds:
        inputs.capture_to_action_p50_seconds === null
          ? null
          : round(inputs.capture_to_action_p50_seconds, 1),
      week4_eligible_users: inputs.week4_eligible_users,
      week4_retained_users: inputs.week4_retained_users,
    },
    intent_split: {
      with_intent: {
        captures: inputs.captures_with_intent,
        action_rate: ratio(inputs.captures_with_intent_actioned, inputs.captures_with_intent),
        retrieval_rate: null,
      },
      without_intent: {
        captures: inputs.captures_without_intent,
        action_rate: ratio(
          inputs.captures_without_intent_actioned,
          inputs.captures_without_intent,
        ),
        retrieval_rate: null,
      },
      retrieval: "not_instrumented",
    },
  };
}

export interface CollectAlphaBarOptions {
  days?: number;
  /** Reference time; defaults to the database's now(). */
  now?: Date;
  /** Include ops:smoke / dev-seed accounts (default false). */
  includeSynthetic?: boolean;
  /** Restrict the population to these users (tests, cohort slices). */
  userIds?: string[];
}

/**
 * Confirmed by the user: approve sets approved_at (status 'queued' for
 * Tier-1, 'executing' for internal; the worker may end in 'failed'), and the
 * enqueue-failure revert clears it again. Tier-0 auto actions are inserted
 * as 'done' with no approved_at.
 */
const CONFIRMED = `(a.approved_at IS NOT NULL OR a.status IN ('approved','executing','done'))`;

export async function collectAlphaBarInputs(
  db: pg.Pool | pg.Client,
  opts: CollectAlphaBarOptions = {},
): Promise<AlphaBarInputs> {
  const days = opts.days ?? 14;
  if (!Number.isInteger(days) || days < 1) throw new Error("days must be a positive integer");
  const params = [
    opts.now ?? null,
    days,
    opts.includeSynthetic ?? false,
    opts.userIds ?? null,
    INBOX_PROJECT_NAME,
  ];

  // Shared CTE prefix: reference time, population, window captures.
  const base = `
    WITH ref AS (SELECT coalesce($1::timestamptz, now()) AS now),
    pop AS (
      SELECT u.id, u.created_at FROM users u
      WHERE u.deleted_at IS NULL
        AND ($4::uuid[] IS NULL OR u.id = ANY($4::uuid[]))
        AND ($3::boolean OR (u.email NOT LIKE '%@alpha.local'
                             AND u.email NOT LIKE '%@nova-validate.invalid'
                             AND u.email <> 'dev@nova.local'))
    ),
    win AS (
      SELECT m.id, m.user_id, m.project_id, m.intent_text, m.created_at
      FROM context_moments m JOIN pop ON pop.id = m.user_id, ref
      WHERE m.created_at > ref.now - make_interval(days => $2::int)
        AND m.created_at <= ref.now
    )`;

  const captures = await db.query<{
    active_users: string;
    window_captures: string;
    linked: string;
    linked_incl_inbox: string;
    with_intent: string;
    with_intent_actioned: string;
    without_intent: string;
    without_intent_actioned: string;
  }>(
    `${base},
    flagged AS (
      SELECT win.*,
        (coalesce(btrim(win.intent_text), '') <> '') AS has_intent,
        EXISTS (SELECT 1 FROM actions a WHERE a.moment_id = win.id
                AND ${CONFIRMED}) AS actioned,
        p.name AS project_name
      FROM win LEFT JOIN projects p ON p.id = win.project_id
    )
    SELECT
      count(DISTINCT user_id) AS active_users,
      count(*) AS window_captures,
      count(*) FILTER (WHERE project_id IS NOT NULL AND project_name IS DISTINCT FROM $5) AS linked,
      count(*) FILTER (WHERE project_id IS NOT NULL) AS linked_incl_inbox,
      count(*) FILTER (WHERE has_intent) AS with_intent,
      count(*) FILTER (WHERE has_intent AND actioned) AS with_intent_actioned,
      count(*) FILTER (WHERE NOT has_intent) AS without_intent,
      count(*) FILTER (WHERE NOT has_intent AND actioned) AS without_intent_actioned
    FROM flagged`,
    params,
  );

  // Actions confirmed within the window, whatever their moment's age.
  const latency = await db.query<{ n: string; p50: number | null; p75: number | null }>(
    `${base},
    conf AS (
      SELECT greatest(0, extract(epoch FROM coalesce(a.approved_at, a.created_at) - m.created_at)) AS secs
      FROM actions a
      JOIN context_moments m ON m.id = a.moment_id
      JOIN pop ON pop.id = a.user_id, ref
      WHERE ${CONFIRMED}
        AND coalesce(a.approved_at, a.created_at) > ref.now - make_interval(days => $2::int)
        AND coalesce(a.approved_at, a.created_at) <= ref.now
    )
    SELECT count(*) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY secs) AS p75
    FROM conf`,
    params.slice(0, 4),
  );

  const retention = await db.query<{ eligible: string; retained: string }>(
    `${base},
    eligible AS (
      SELECT pop.id, pop.created_at FROM pop, ref
      WHERE pop.created_at <= ref.now - interval '28 days'
    )
    SELECT count(*) AS eligible,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM context_moments m
        WHERE m.user_id = eligible.id
          AND m.created_at >= eligible.created_at + interval '21 days'
          AND m.created_at <  eligible.created_at + interval '28 days'
      )) AS retained
    FROM eligible`,
    params.slice(0, 4),
  );

  const c = captures.rows[0]!;
  const l = latency.rows[0]!;
  const r = retention.rows[0]!;
  const num = (v: number | string | null): number | null => (v === null ? null : Number(v));
  return {
    window_days: days,
    active_users: Number(c.active_users),
    window_captures: Number(c.window_captures),
    linked_captures: Number(c.linked),
    linked_captures_incl_inbox: Number(c.linked_incl_inbox),
    confirmed_actions: Number(l.n),
    capture_to_action_p50_seconds: num(l.p50),
    capture_to_action_p75_seconds: num(l.p75),
    week4_eligible_users: Number(r.eligible),
    week4_retained_users: Number(r.retained),
    captures_with_intent: Number(c.with_intent),
    captures_with_intent_actioned: Number(c.with_intent_actioned),
    captures_without_intent: Number(c.without_intent),
    captures_without_intent_actioned: Number(c.without_intent_actioned),
  };
}

export async function computeAlphaBar(
  db: pg.Pool | pg.Client,
  opts: CollectAlphaBarOptions = {},
): Promise<AlphaBar> {
  return evaluateAlphaBar(await collectAlphaBarInputs(db, opts));
}
