import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one Postgres dev user; run files serially so
    // count/recency assertions aren't polluted by concurrent suites.
    fileParallelism: false,
  },
});
