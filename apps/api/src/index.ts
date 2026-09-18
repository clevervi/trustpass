import { serve } from "@hono/node-server";
import { assertConnectionIsUnprivileged, createDatabase, isDatabaseReachable } from "@trustpass/db";
import { createApp } from "./app.js";
import { enrolProduct } from "./enrolments/enrol-product.js";
import { loadEnv } from "./env.js";
import {
  ALLOWED_ORIGINS_VARIABLE,
  describeCorsPolicy,
  readCorsPolicy,
} from "./http/cors-policy.js";
import { logger } from "./logger.js";
import { readPassport } from "./passports/read-passport.js";
import { registerProduct } from "./products/register-product.js";
import { version } from "./version.js";

// Configuration arrives from the environment. The dev and start scripts point
// Node's --env-file-if-exists at the repository root .env; production injects
// the variables directly and no file is needed.
const env = loadEnv();
const db = createDatabase(env.DATABASE_URL);

// Before anything is served. #119 moved every guarantee behind a role that
// cannot remove it, and could not finish the job: a migration cannot edit an
// environment file, so until this line existed the whole thing rested on a
// deploy remembering to point DATABASE_URL somewhere. Forget it and the API
// came up as a superuser owning every table, with no signal of any kind —
// health green, passports resolving, and the append-only history one statement
// from editable.
//
// Throws rather than warns, and the throw is unhandled on purpose: the process
// exits non-zero and the deploy fails, which is the only outcome anybody acts
// on. A warning in a log is a warning somebody reads after the incident.
const privileges = await assertConnectionIsUnprivileged(db, {
  allowPrivileged: env.TRUSTPASS_ALLOW_PRIVILEGED_DATABASE,
  warn: (message) => logger.warn("api.database.privileged", { message }),
});

// Which browser origins may write, decided before anything is served.
//
// An absent variable is not a permissive default. It is a question nobody
// answered, and the same refusal `passport-origin.ts` makes about an unset
// site URL: guessing produces something that works locally and is wrong
// everywhere else.
const corsPolicy = readCorsPolicy(process.env[ALLOWED_ORIGINS_VARIABLE]);

if (corsPolicy.kind === "unset" || corsPolicy.kind === "refused") {
  logger.error("api.cors.undecided", {
    message: `${describeCorsPolicy(corsPolicy).replace(/\.$/, "")}. Refusing to start.`,
    hint:
      `Set ${ALLOWED_ORIGINS_VARIABLE} to a comma-separated list of origins that may write, ` +
      "or to an empty string to accept none.",
  });
  process.exit(1);
}

const app = createApp(
  {
    version,
    checkDatabase: () => isDatabaseReachable(db),
    registerProduct: (input) => registerProduct(db, input),
    enrolProduct: (input) => enrolProduct(db, input),
    readPassport: (trustpassId) => readPassport(db, trustpassId),
  },
  corsPolicy,
);

serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  logger.info("api.started", {
    port: info.port,
    environment: env.NODE_ENV,
    version,
    // Which role actually got through, so a log answers the question without
    // anyone having to reason about which DATABASE_URL was deployed.
    databaseRole: privileges.role,
    cors: describeCorsPolicy(corsPolicy),
  });
});
