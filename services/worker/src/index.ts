import { buildActionDeps, startActionWorker } from "./actions.js";
import { startHeartbeat } from "./heartbeat.js";
import { loadEnv } from "./env.js";
import { log } from "./log.js";
import { buildDeps, startWorker } from "./worker.js";

const env = loadEnv();
const deps = buildDeps(env);
const actionDeps = buildActionDeps(env);
// M11: startup configuration summary — capability booleans only, no secrets.
log.info(
  {
    cloud_enrichment: Boolean(deps.enricher),
    embeddings: Boolean(deps.embedder),
    external_actions: Boolean(actionDeps.keys?.length),
    read_keys: actionDeps.keys?.length ?? 0,
    media_store: actionDeps.mediaStore?.name ?? "none",
  },
  "worker starting",
);
const heartbeat = startHeartbeat(env.REDIS_URL);
const worker = startWorker({ env, deps });
const actionWorker = startActionWorker({ env, deps: actionDeps });

async function shutdown() {
  log.info("worker shutting down");
  await Promise.all([worker.close(), actionWorker.close(), heartbeat.stop()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
