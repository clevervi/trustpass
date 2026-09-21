/**
 * Every committed mutation set.
 *
 * Listed rather than discovered by globbing the directory: a set that is present
 * but forgotten here fails loudly the first time somebody looks for it, whereas
 * a glob would silently pick up a half-written file and run it.
 */
import cpdExclusions from "./cpd-exclusions.mjs";
import forLog from "./for-log.mjs";
import mutationRunner from "./mutation-runner.mjs";
import noSquash from "./no-squash.mjs";
import qrRoute from "./qr-route.mjs";
import readOnly from "./read-only.mjs";
import schemaDrift from "./schema-drift.mjs";
import schemaFingerprint from "./schema-fingerprint.mjs";
import writeRateLimit from "./write-rate-limit.mjs";

export const SETS = [
  writeRateLimit,
  noSquash,
  mutationRunner,
  qrRoute,
  cpdExclusions,
  forLog,
  schemaFingerprint,
  schemaDrift,
  readOnly,
];
