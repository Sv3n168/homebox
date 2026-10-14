#!/usr/bin/env node
// Fork only: the frontend typecheck fails on the original Homebox too (about
// 190 errors). Instead of a check that is always red, this compares the errors
// with a recorded list (.github/typecheck-baseline.txt) and fails only when new
// ones appear. Fewer errors (e.g. fixed upstream) pass and are reported.
//
//   node .github/scripts/typecheck-baseline.mjs           check (CI)
//   node .github/scripts/typecheck-baseline.mjs --update  record the current errors
//
// Errors are compared without line numbers and digits, so code moving around
// does not count as new.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baselineFile = join(root, ".github", "typecheck-baseline.txt");

const run = spawnSync("pnpm", ["run", "typecheck"], {
  cwd: join(root, "frontend"),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

// "pages/x.vue(12,3): error TS2339: Property 'a' ..." -> "pages/x.vue: TS2339: Property 'a' ..."
const errors = [];
for (const line of output.split("\n")) {
  const m = line.match(/^(\S.*?)\(\d+,\d+\): error (TS\d+): (.*)$/);
  if (m) errors.push(`${m[1]}: ${m[2]}: ${m[3].replace(/\d+/g, "N").trim()}`);
}

if (run.status !== 0 && errors.length === 0) {
  console.error(output);
  console.error("Typecheck failed without reporting TS errors (see output above).");
  process.exit(1);
}

errors.sort();

if (process.argv.includes("--update")) {
  writeFileSync(baselineFile, errors.join("\n") + "\n");
  console.log(`Recorded ${errors.length} typecheck errors in .github/typecheck-baseline.txt`);
  process.exit(0);
}

const count = list => list.reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map());
const baseline = existsSync(baselineFile) ? readFileSync(baselineFile, "utf8").split("\n").filter(Boolean) : [];
const known = count(baseline);
const now = count(errors);

const added = [];
for (const [e, n] of now) {
  const extra = n - (known.get(e) ?? 0);
  for (let i = 0; i < extra; i++) added.push(e);
}

console.log(`Typecheck: ${errors.length} errors, ${baseline.length} recorded in .github/typecheck-baseline.txt.`);
if (added.length > 0) {
  console.error(`\n${added.length} new typecheck error(s):`);
  for (const e of added) console.error(`  ${e}`);
  console.error("\nFull lines with positions:");
  for (const line of output.split("\n")) {
    if (added.some(e => line.startsWith(e.split(": ")[0] + "(")) && / error TS/.test(line)) console.error(`  ${line}`);
  }
  console.error(
    "\nFix them, or if they are the known kind (e.g. Refs in templates), record them with:" +
      "\n  node .github/scripts/typecheck-baseline.mjs --update"
  );
  process.exit(1);
}
if (errors.length < baseline.length) {
  console.log(`${baseline.length - errors.length} fewer than recorded. Run with --update to lower the baseline.`);
}
console.log("No new typecheck errors.");
