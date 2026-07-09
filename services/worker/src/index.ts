import { loadEnv } from "./env.js";
import { buildDeps, startWorker } from "./worker.js";

const env = loadEnv();
const deps = buildDeps(env);
console.log(
  `[worker] starting — cloud enrichment: ${deps.enricher ? "on" : "off (local heuristics)"}, embeddings: ${deps.embedder ? "on" : "off"}`,
);
const worker = startWorker({ env, deps });

async function shutdown() {
  console.log("[worker] shutting down…");
  await worker.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
