import { decryptBytes, parseEncryptionKey } from "@nova/context-engine/secret-box";
import { Jimp, JimpMime } from "jimp";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";

/**
 * M8 legacy-media backfill behavior. Runs the real operator command
 * (`media:backfill`) as a child process against rows inserted the way
 * pre-M8 code left them, and asserts the safety policy:
 *   - state='applied' rows (masked at capture) migrate into encrypted
 *     object storage and lose their inline base64;
 *   - rows that are NOT provably redacted are QUARANTINED when OCR is off
 *     (M15B / Hermes D01): the unverified inline pixels are stripped from
 *     the stored payload — they never reach object storage AND never remain
 *     inline where an outward path could return them;
 *   - re-running is a no-op (idempotent).
 */
const databaseUrl = process.env.DATABASE_URL;

const KEY_HEX = randomBytes(32).toString("hex");
const KEY = parseEncryptionKey(KEY_HEX);

describe.skipIf(!databaseUrl)("M8: legacy media backfill", () => {
  let db: pg.Client;
  let userId: string;
  let appliedId: string;
  let legacyId: string;
  let inlinePng: string;
  const fsRoot = join(tmpdir(), `nova-backfill-test-${Date.now()}`);

  function runBackfill(): string {
    return execFileSync("pnpm", ["exec", "tsx", "src/db/backfill-media.ts"], {
      cwd: join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NOVA_ENCRYPTION_KEY: KEY_HEX,
        NOVA_MEDIA_STORE: "fs",
        NOVA_MEDIA_FS_ROOT: fsRoot,
        // OCR off: the script cannot re-redact, so unprovable rows must skip.
        NOVA_IMAGE_REDACTION: "off",
      },
    });
  }

  beforeAll(async () => {
    await migrate(databaseUrl!);
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();

    const img = new Jimp({ width: 320, height: 100, color: 0xffffffff });
    inlinePng = `data:image/png;base64,${(await img.getBuffer(JimpMime.png)).toString("base64")}`;

    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`backfill-${Date.now()}@test.local`],
    );
    userId = u.rows[0].id;

    // Pre-M8 shapes, inserted directly the way old code stored them:
    // an M7 row already masked at capture...
    const applied = await db.query<{ id: string }>(
      `INSERT INTO context_moments (user_id, source_mode, payload, extracted_text, image_redaction)
       VALUES ($1, 'instant_capture', $2, 'masked at capture', '{"state":"applied"}') RETURNING id`,
      [userId, JSON.stringify({ screenshot_data_url: inlinePng })],
    );
    appliedId = applied.rows[0].id;
    // ...and a pre-M7 row with no redaction record at all.
    const legacy = await db.query<{ id: string }>(
      `INSERT INTO context_moments (user_id, source_mode, payload, extracted_text, image_redaction)
       VALUES ($1, 'instant_capture', $2, 'never redacted', '{}') RETURNING id`,
      [userId, JSON.stringify({ screenshot_data_url: inlinePng })],
    );
    legacyId = legacy.rows[0].id;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("migrates applied rows, quarantines unprovable inline media, and is idempotent", async () => {
    const out = runBackfill();
    expect(out).toContain("migrated");

    // Applied row: inline base64 gone, media row present, blob encrypted.
    const appliedRow = await db.query(
      `SELECT payload, image_redaction FROM context_moments WHERE id = $1`,
      [appliedId],
    );
    expect(JSON.stringify(appliedRow.rows[0].payload)).not.toContain("data:image");
    expect(appliedRow.rows[0].image_redaction.state).toBe("applied");

    const mediaRows = await db.query(
      `SELECT storage_key, redaction_state, encrypted FROM moment_media WHERE moment_id = $1`,
      [appliedId],
    );
    expect(mediaRows.rows).toHaveLength(1);
    expect(mediaRows.rows[0].redaction_state).toBe("applied");
    expect(mediaRows.rows[0].encrypted).toBe(true);
    const blob = await readFile(join(fsRoot, mediaRows.rows[0].storage_key));
    expect(blob.toString("latin1")).not.toContain("IHDR");
    expect(decryptBytes(KEY, blob).subarray(1, 4).toString("latin1")).toBe("PNG");

    const audit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'media.backfill'`,
      [appliedId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain("data:image");

    // Legacy row (OCR off, not provably redacted): QUARANTINED — the inline
    // pixels are stripped from the DB payload (never stored, never leakable),
    // the row is marked, nothing lands in object storage.
    const legacyRow = await db.query(
      `SELECT payload, image_redaction FROM context_moments WHERE id = $1`,
      [legacyId],
    );
    expect(legacyRow.rows[0].payload.screenshot_data_url).toBeUndefined();
    expect(JSON.stringify(legacyRow.rows[0].payload)).not.toContain("data:image");
    expect(legacyRow.rows[0].payload.legacy_media_excluded).toBe(true);
    expect(legacyRow.rows[0].image_redaction.state).toBe("quarantined_legacy");
    const legacyMedia = await db.query(
      `SELECT 1 FROM moment_media WHERE moment_id = $1`,
      [legacyId],
    );
    expect(legacyMedia.rows).toHaveLength(0);
    const quarantineAudit = await db.query(
      `SELECT detail FROM audit_log WHERE subject_id = $1 AND event_type = 'media.backfill_quarantine'`,
      [legacyId],
    );
    expect(quarantineAudit.rows).toHaveLength(1);
    expect(JSON.stringify(quarantineAudit.rows[0].detail)).not.toContain("data:image");

    // Second run: the migrated row no longer matches; the quarantined row no
    // longer has inline media to scan — idempotent (no dup media/audit).
    runBackfill();
    const mediaAgain = await db.query(
      `SELECT 1 FROM moment_media WHERE moment_id = $1`,
      [appliedId],
    );
    expect(mediaAgain.rows).toHaveLength(1);
    const auditAgain = await db.query(
      `SELECT 1 FROM audit_log WHERE subject_id = $1 AND event_type = 'media.backfill'`,
      [appliedId],
    );
    expect(auditAgain.rows).toHaveLength(1);
    const legacyAgain = await db.query(
      `SELECT payload FROM context_moments WHERE id = $1`,
      [legacyId],
    );
    expect(JSON.stringify(legacyAgain.rows[0].payload)).not.toContain("data:image");
  });
});
