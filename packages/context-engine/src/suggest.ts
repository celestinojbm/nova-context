import type { ProjectSuggestion } from "@nova/schema";
import type pg from "pg";

/**
 * Rule-based project suggestion v0 (M1). Deliberately simple and
 * deterministic — no embeddings yet (BUILD_PLAN defers similarity ranking):
 *   1. project_hint name match (exact > substring > token overlap)
 *   2. URL host previously captured into that project
 *   3. small recency boost for the most recently used project
 * The same function runs for the UI preview (POST /v1/projects/suggest) and
 * at capture time, so override logging compares like with like.
 */

interface ProjectRow {
  id: string;
  name: string;
  last_used: Date | null;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function nameMatchScore(hint: string, projectName: string): number {
  const h = hint.trim().toLowerCase();
  const n = projectName.trim().toLowerCase();
  if (!h || !n) return 0;
  if (h === n) return 0.9;
  if (n.includes(h) || h.includes(n)) return 0.7;
  const hTokens = new Set(tokenize(h));
  const nTokens = tokenize(n);
  const overlap = nTokens.filter((t) => hTokens.has(t)).length;
  if (!overlap) return 0;
  return 0.4 * (overlap / Math.max(nTokens.length, hTokens.size));
}

export async function suggestProjects(
  db: pg.Pool,
  userId: string,
  input: { projectHint: string | null; url: string | null },
  limit = 3,
): Promise<ProjectSuggestion[]> {
  const { rows: projects } = await db.query<ProjectRow>(
    `SELECT p.id, p.name, max(m.captured_at) AS last_used
     FROM projects p
     LEFT JOIN context_moments m ON m.project_id = p.id
     WHERE p.user_id = $1 AND p.archived = false
     GROUP BY p.id, p.name`,
    [userId],
  );
  if (!projects.length) return [];

  let host: string | null = null;
  if (input.url) {
    try {
      host = new URL(input.url).host;
    } catch {
      host = null;
    }
  }

  const hostCounts = new Map<string, number>();
  if (host) {
    const { rows } = await db.query<{ project_id: string; n: string }>(
      `SELECT project_id, count(*) AS n
       FROM context_moments
       WHERE user_id = $1 AND project_id IS NOT NULL
         AND source_meta->>'url' LIKE $2
       GROUP BY project_id`,
      [userId, `%://${host}%`],
    );
    for (const row of rows) hostCounts.set(row.project_id, Number(row.n));
  }

  const mostRecent = [...projects]
    .filter((p) => p.last_used)
    .sort((a, b) => b.last_used!.getTime() - a.last_used!.getTime())[0];

  const scored = projects.map((p) => {
    const reasons: string[] = [];
    let score = 0;
    if (input.projectHint) {
      const nameScore = nameMatchScore(input.projectHint, p.name);
      if (nameScore > 0) {
        score += nameScore;
        reasons.push(`name matches "${input.projectHint}"`);
      }
    }
    const hostCount = hostCounts.get(p.id) ?? 0;
    if (hostCount > 0) {
      score += Math.min(0.5, 0.2 + 0.1 * hostCount);
      reasons.push(`${hostCount} previous capture(s) from ${host}`);
    }
    if (mostRecent && p.id === mostRecent.id) {
      score += 0.1;
      reasons.push("most recently used");
    }
    return {
      id: p.id,
      name: p.name,
      confidence: Math.min(1, Number(score.toFixed(2))),
      reason: reasons.join("; ") || "no signal",
    };
  });

  return scored
    .filter((s) => s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}
