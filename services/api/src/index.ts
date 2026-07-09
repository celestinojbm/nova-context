import { buildApp } from "./app.js";
import { loadEnv, securitySummary } from "./env.js";

const env = loadEnv();
const app = await buildApp({ env });
app.log.info(`[security] ${securitySummary(env)}`);

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
