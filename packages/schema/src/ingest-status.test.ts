import { describe, expect, it } from "vitest";
import { INGEST_TTL_MS, visibleIngest } from "./ingest-status.js";

const captured = "2026-11-01T12:00:00.000Z";
const now = Date.parse("2026-11-02T12:00:00.000Z");

describe("visibleIngest", () => {
  it("maps pending within the TTL to pending with queued reason", () => {
    expect(visibleIngest({ enrichment_status: "pending", captured_at: captured }, now)).toMatchObject({
      status: "pending",
      wait_reason: "queued",
      error_code: null,
      error_message: null,
    });
  });

  it("keeps an explicit wait_reason and expires_at", () => {
    const expires = "2026-11-08T12:00:00.000Z";
    expect(
      visibleIngest(
        { enrichment_status: "pending", enrichment_wait_reason: "rate_limit", enrichment_expires_at: expires, captured_at: captured },
        now,
      ),
    ).toMatchObject({ status: "pending", wait_reason: "rate_limit", expires_at: expires });
  });

  it("maps processing within the TTL to pending with processing reason", () => {
    expect(visibleIngest({ enrichment_status: "processing", captured_at: captured }, now)).toMatchObject({
      status: "pending",
      wait_reason: "processing",
    });
  });

  it("marks pending/processing as expired when past expires_at, without writing a status", () => {
    const expires = "2026-11-01T18:00:00.000Z";
    expect(
      visibleIngest(
        { enrichment_status: "pending", enrichment_wait_reason: "queued", enrichment_expires_at: expires, captured_at: captured },
        now,
      ),
    ).toMatchObject({ status: "expired", wait_reason: "queued", expires_at: expires });
  });

  it("falls back to captured_at + 7 days when expires_at is missing", () => {
    const late = Date.parse(captured) + INGEST_TTL_MS + 1;
    const vis = visibleIngest({ enrichment_status: "pending", captured_at: captured }, late);
    expect(vis.status).toBe("expired");
    expect(vis.expires_at).toBe(new Date(Date.parse(captured) + INGEST_TTL_MS).toISOString());
  });

  it("returns failed with code and message even after the TTL", () => {
    const late = Date.parse(captured) + INGEST_TTL_MS * 2;
    expect(
      visibleIngest(
        {
          enrichment_status: "failed",
          enrichment_error_code: "provider_timeout",
          enrichment_error: "upstream timed out",
          captured_at: captured,
        },
        late,
      ),
    ).toMatchObject({
      status: "failed",
      wait_reason: null,
      error_code: "provider_timeout",
      error_message: "upstream timed out",
    });
  });

  it("defaults a missing failure code to enrichment_failed", () => {
    expect(
      visibleIngest({ enrichment_status: "failed", enrichment_error: "boom", captured_at: captured }, now),
    ).toMatchObject({ status: "failed", error_code: "enrichment_failed" });
  });

  it("hides completed and skipped moments from the ingest view", () => {
    expect(visibleIngest({ enrichment_status: "completed", captured_at: captured }, now).status).toBeNull();
    expect(visibleIngest({ enrichment_status: "skipped", captured_at: captured }, now).status).toBeNull();
  });
});
