import { buildActionDeps, startActionWorker } from "./actions.js";
import { loadEnv } from "./env.js";
import { buildDeps, startWorker } from "./worker.js";

const env = loadEnv();
const deps = buildDeps(env);
const actionDeps = buildActionDeps(env);
console.log(
  `[worker] starting — cloud enrichment: ${deps.enricher ? "on" : "off (local heuristics)"}, embeddings: ${deps.embedder ? "on" : "off"}, external actions: ${actionDeps.encryptionKey ? "on" : "off (no NOVA_ENCRYPTION_KEY)"}`,
);
const worker = startWorker({ env, deps });
const actionWorker = startActionWorker({ env, deps: actionDeps });

async function shutdown() {
  console.log("[worker] shutting down…");
  await Promise.all([worker.close(), actionWorker.close()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
