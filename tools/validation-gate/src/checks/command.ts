import { spawn } from "node:child_process";
import { excerpt, sanitize } from "../sanitization.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../types.js";

/**
 * Safe child-process runner (M17B §6).
 *
 * - no shell (argv only — nothing to inject into);
 * - hard timeout: SIGTERM, then SIGKILL after a 5s grace period;
 * - output is capped to excerpts and SANITIZED before it is stored anywhere;
 * - full raw output is never retained by default (a local, non-CI debug flag
 *   may echo more to the terminal — still sanitized — see cli.ts).
 */
export const runCommand: CommandRunner = (spec: CommandSpec, opts) =>
  new Promise<CommandResult>((resolve) => {
    const started = Date.now();
    const child = spawn(spec.cmd, spec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...spec.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const CAP = 64_000; // accumulate at most 64KB per stream pre-excerpt
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString("utf8");
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    }, opts.timeoutMs);

    const finish = (code: number | null) => {
      clearTimeout(killTimer);
      const extra = spec.env ? Object.values(spec.env) : [];
      resolve({
        code,
        timedOut,
        durationMs: Date.now() - started,
        stdoutExcerpt: sanitize(excerpt(stdout), { extraSecrets: extra }),
        stderrExcerpt: sanitize(excerpt(stderr), { extraSecrets: extra }),
      });
    };
    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

/** Sanitized one-line description of a command for reports. */
export function describeCommand(spec: CommandSpec): string {
  return sanitize([spec.cmd, ...spec.args].join(" "), {
    extraSecrets: spec.env ? Object.values(spec.env) : [],
  });
}
