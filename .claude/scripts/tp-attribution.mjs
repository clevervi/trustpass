#!/usr/bin/env node
/**
 * Refuses text that credits a tool for the work.
 *
 * The rule it enforces is the repository owner's, and it is not a secret: no
 * commit message, pull request, issue or release note in this repository
 * attributes itself to a model. That is a decision about how the owner presents
 * their own work, and it is theirs to make.
 *
 * This exists because a rule in a skill is a rule something has to remember,
 * and eight pull request descriptions carried the line before anybody looked.
 * The same argument the rest of this repository makes about triggers and
 * privileges: a guarantee nothing checks is a claim.
 *
 *   node .claude/scripts/tp-attribution.mjs --commit        the last commit message
 *   node .claude/scripts/tp-attribution.mjs body.md         a file
 *   … | node .claude/scripts/tp-attribution.mjs             stdin
 *
 * Exits 1 and prints the offending lines when it finds any.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Attribution, not mention.
 *
 * `.claude/` names Claude on nearly every line, `ai-policy.md` is about a
 * model, and an ADR may one day compare two of them. None of that is crediting
 * a tool for the work, and a pattern that could not tell the difference would
 * be a check nobody could keep switched on — which is worse than no check.
 *
 * So each of these matches a *credit*: a phrase asserting who or what produced
 * the artefact.
 */
const PATTERNS = [
  {
    name: "generated-with",
    re: /\bgenerated\s+(with|by)\s+(claude|chatgpt|gpt|copilot|gemini|an?\s+ai|ai\b)/i,
  },
  {
    name: "co-authored-by-model",
    re: /^\s*co-?authored-by:.*(claude|anthropic|openai|copilot|gemini|\bai\b)/im,
  },
  { name: "ai-generated", re: /\bai[-\s]generated\b/i },
  {
    name: "written-by-ai",
    re: /\b(written|authored|created)\s+by\s+(claude|chatgpt|an?\s+ai|ai)\b/i,
  },
  { name: "assisted-by", re: /\b(ai|claude|copilot)[-\s]assisted\b/i },
  { name: "robot-credit", re: /🤖\s*generated/i },
];

function read() {
  const argument = process.argv[2];

  if (argument === "--commit") {
    return execFileSync("git", ["log", "-1", "--format=%B%n%(trailers)"], { encoding: "utf8" });
  }

  if (argument && argument !== "-") {
    return readFileSync(argument, "utf8");
  }

  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const text = read();

/**
 * A line may say the forbidden phrase when the point is that it was removed.
 *
 * Found by this check failing on the commit that introduced it: a sentence
 * reporting that eight descriptions carried the attribution is a sentence about
 * deleting it, and matching that is the check being right about the letter and
 * wrong about the work.
 *
 * A marker rather than a cleverer pattern. Quoting, negation and past tense are
 * not things to ask a regular expression to understand, and an explicit opt-out
 * is a decision visible in the diff — the shape gitleaks uses.
 */
const ALLOW = /tp-attribution:allow/i;
const lines = text.split(/\r?\n/).map((line) => (ALLOW.test(line) ? "" : line));
const scanned = lines.join("\n");
const found = [];

for (const { name, re } of PATTERNS) {
  if (!re.test(scanned)) {
    continue;
  }

  // Report the line, not just the rule, so the fix is obvious.
  const line = lines.findIndex((candidate) =>
    new RegExp(re.source, re.flags.replace("m", "")).test(candidate),
  );
  found.push({ name, line: line + 1, text: (lines[line] ?? "").trim() });
}

if (found.length === 0) {
  process.exit(0);
}

process.stderr.write(
  "This text credits a tool for the work, which this repository does not do.\n\n",
);

for (const item of found) {
  process.stderr.write(`  line ${item.line}  [${item.name}]  ${item.text}\n`);
}

process.stderr.write(
  "\nRemove the attribution. Naming a model as a dependency, in documentation or\n" +
    "in a comparison, is fine and is not what these patterns match.\n",
);

process.exit(1);
