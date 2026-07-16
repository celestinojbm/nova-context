import type { RunReport } from "../types.js";

/** JSON report (schema_version 1). The report object is already sanitized
 * field-by-field by the runner; this is a plain stable serialization. */
export function toJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
