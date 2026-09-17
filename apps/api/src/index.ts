import { serve } from "@hono/node-server";
import { createDatabase, isDatabaseReachable } from "@trustpass/db";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { version } from "./version.js";

// Configuration arrives from the environment. The dev and start scripts point
// Node's --env-file-if-exists at the repository root .env; production injects
// the variables directly and no file is needed.
const env = loadEnv();
const db = createDatabase(env.DATABASE_URL);

const app = createApp({
  version,
  checkDatabase: () => isDatabaseReachable(db),
});

serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  logger.info("api.started", {
    port: info.port,
    environment: env.NODE_ENV,
    version,
  });
});
