import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One convention for manual rollbacks: `migrations/rollback/<forward>.down.sql`.
 * #26 used `migrations/down/` and #28 `migrations/rollback/`; this pins the
 * single layout so a second directory cannot come back unnoticed.
 */
const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const ROLLBACK = new URL("rollback/", MIGRATIONS);

describe("migrations layout", () => {
  const entries = readdirSync(MIGRATIONS);
  const forward = new Set(entries.filter((f) => f.endsWith(".sql")));

  it("has rollback/ as its only subdirectory", () => {
    const dirs = entries.filter((f) => statSync(new URL(f, MIGRATIONS)).isDirectory());
    expect(dirs).toEqual(["rollback"]);
  });

  it("names every rollback script after an existing forward migration", () => {
    const scripts = readdirSync(ROLLBACK);
    expect(scripts.length).toBeGreaterThan(0);
    for (const f of scripts) {
      expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.down\.sql$/);
      expect(forward.has(f.replace(/\.down\.sql$/, ".sql"))).toBe(true);
    }
  });

  it("documents its own path and un-registers its migration", () => {
    for (const f of readdirSync(ROLLBACK)) {
      const sql = readFileSync(new URL(f, ROLLBACK), "utf8");
      expect(sql).toContain(`services/api/migrations/rollback/${f}`);
      expect(sql).toContain(
        `DELETE FROM schema_migrations WHERE name = '${f.replace(/\.down\.sql$/, ".sql")}'`,
      );
    }
  });

  it("is referenced from the forward migration it undoes", () => {
    for (const f of readdirSync(ROLLBACK)) {
      const fwd = readFileSync(new URL(f.replace(/\.down\.sql$/, ".sql"), MIGRATIONS), "utf8");
      expect(fwd).toContain(`migrations/rollback/${f}`);
    }
  });
});
