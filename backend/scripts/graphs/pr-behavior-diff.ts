/* eslint-disable */
/**
 * Pull Request Behavior Diff
 * ==========================
 * Resolves a pull request (or any two git revisions), signs every changed route file on both
 * sides with ./signature-builder.ts, and reports which route hashes moved.
 *
 * Nothing is checked out. `git show <rev>:<path>` reads file contents straight from the object
 * store, so the working tree, the current branch, and the index are all left alone; the only
 * write is the fetch into .git. That works because the signature is computed from a file's text
 * alone - no Graphify graph and no installed dependencies for the revision under test.
 *
 * Only *changed* route files are signed, which is what keeps this fast. The flip side is the
 * same limitation the signature itself has: a change inside a service does not alter a route
 * file's text, so it will not appear here.
 *
 * Usage:
 *     npm run behavior:pr -- --url https://github.com/Infisical/infisical/pull/7638
 *     npm run behavior:pr -- --url 7638 --ci
 *     npm run behavior:diff-refs -- --base origin/main --head my-branch
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";

import { LineRange } from "./method-index";
import {
  assemble,
  BACKEND_PREFIX,
  BehaviorConfig,
  BehavioralSignature,
  collectWarnings,
  DEFAULT_CONFIG,
  diffManifests,
  fail,
  finishDiff,
  isExcludedPath,
  loadConfig,
  printWarnings,
  REPO_ROOT,
  signaturesForFile
} from "./signature-builder";

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }).trim();

const gitShow = (rev: string, backendRelPath: string): string | null => {
  try {
    return execFileSync("git", ["show", `${rev}:${BACKEND_PREFIX}${backendRelPath}`], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    // Absent on this side of the diff: added on head, or deleted on head.
    return null;
  }
};

const originSlug = (): string | null => {
  try {
    const url = git(["remote", "get-url", "origin"]);
    // Handles https://github.com/o/r.git, git@github.com:o/r.git, and SSH aliases such as
    // org-107880645@github.com:Infisical/infisical.git
    const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
};

const parsePrRef = (input: string): { slug: string | null; number: number } => {
  const bare = input.match(/^#?(\d+)$/);
  if (bare) return { slug: null, number: Number(bare[1]) };
  const url = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) return { slug: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  fail(
    `Could not read a pull request from '${input}'.\n` +
      `Expected https://github.com/<owner>/<repo>/pull/<number>, or a bare number such as 7638.`
  );
};

// Finds the merge commit on the base branch whose second parent is `head`. Only merge commits
// are scanned, and the walk is capped so this stays fast on a long history.
const mergeCommitFor = (head: string, baseBranch: string): string | null => {
  const log = git(["log", "--merges", "--format=%H %P", "--max-count=5000", baseBranch]);
  for (const line of log.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[2] === head) return parts[0];
  }
  return null;
};

// The base we want is the point the PR branched from, so that the diff shows only the PR's own
// changes. While a PR is open that is just merge-base(head, main). Once it has been merged with
// a merge commit, head is an ancestor of main and merge-base returns head itself - an empty
// diff - so the branch point has to be recovered from the merge commit's first parent.
const resolveBase = (head: string, baseBranch: string): string => {
  const mergeBase = git(["merge-base", head, baseBranch]);
  if (mergeBase !== head) return mergeBase;

  const mergeCommit = mergeCommitFor(head, baseBranch);
  if (!mergeCommit) {
    fail(
      `This pull request is already merged into ${baseBranch} and its merge commit was not found ` +
        `in the last 5000 merges, so the branch point cannot be inferred.\n` +
        `Pass --base <ref> explicitly.`
    );
  }
  console.log(`  already merged ....... ${mergeCommit.slice(0, 12)} (recovering the branch point from it)`);
  return git(["merge-base", head, `${mergeCommit}^1`]);
};

const changedBackendFiles = (base: string, head: string): string[] =>
  git(["diff", "--name-only", base, head, "--", `${BACKEND_PREFIX}src`])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(BACKEND_PREFIX.length));

// Head-side line ranges per changed file, which is what turns "this module moved" into "this
// method moved" in ./project-analyzer.ts. -U0 so a hunk covers only the lines that actually
// changed; with context lines a one-line edit would span three functions at a boundary.
const changedHunks = (base: string, head: string): Record<string, LineRange[]> => {
  const diff = git(["diff", "-U0", "--no-color", base, head, "--", `${BACKEND_PREFIX}src`]);
  const hunks: Record<string, LineRange[]> = {};
  let file: string | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      // /dev/null on a deletion: the file has no head-side lines to attribute a change to.
      file = target === "/dev/null" ? null : target.replace(/^b\//, "").slice(BACKEND_PREFIX.length);
      continue;
    }
    if (!file || !line.startsWith("@@")) continue;

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // A pure deletion has no head-side lines. Git reports the line it was removed after, so the
    // surrounding pair is what identifies the enclosing function.
    const range = count === 0 ? { start: Math.max(1, start), end: start + 1 } : { start, end: start + count - 1 };

    const bucket = hunks[file];
    if (bucket) bucket.push(range);
    else hunks[file] = [range];
  }

  return hunks;
};

const signaturesAtRev = (
  rev: string,
  files: string[],
  config: BehaviorConfig,
  warn: (message: string) => void
): BehavioralSignature[] => {
  const entries: BehavioralSignature[] = [];
  for (const relPath of files) {
    const text = gitShow(rev, relPath);
    if (text === null) continue;
    entries.push(...signaturesForFile(relPath, text, config, warn));
  }
  return entries;
};

const runRefs = (
  configPath: string,
  base: string,
  head: string,
  reportPath: string | undefined,
  ci: boolean,
  pr?: { slug: string; number: number }
): void => {
  const config = loadConfig(configPath);
  const { warn, flush } = collectWarnings();

  const changed = changedBackendFiles(base, head);
  const inScope = changed.filter((file) => !isExcludedPath(file, config));

  console.log(`  base ................. ${base}`);
  console.log(`  head ................. ${head}`);
  console.log(`  changed backend files  ${changed.length}${changed.length !== inScope.length ? ` (${inScope.length} in scope)` : ""}`);

  const beforeEntries = signaturesAtRev(base, inScope, config, warn);
  const afterEntries = signaturesAtRev(head, inScope, config, warn);
  printWarnings(flush());

  const routeFiles = new Set([...beforeEntries, ...afterEntries].map((entry) => entry.file));
  console.log(`  changed route files .. ${routeFiles.size}`);
  for (const file of [...routeFiles].sort()) console.log(`     ${file}`);

  const scope = routeFiles.size ? `${routeFiles.size} changed route file(s)` : "no changed route files";
  const noop = (_: string) => {};
  const before = assemble(beforeEntries, { revision: base, scope, route_count: 0, file_count: 0 }, noop);
  const after = assemble(afterEntries, { revision: head, scope, route_count: 0, file_count: 0 }, noop);

  const report = diffManifests(before, after, scope);
  // The full changed list, not the route-file subset: ./project-analyzer.ts needs the service and
  // library files precisely because they cannot move a hash.
  report.meta = {
    base,
    head,
    pr,
    changed_files: changed,
    changed_hunks: changedHunks(base, head),
    generated_at: new Date().toISOString()
  };
  finishDiff(report, reportPath, ci);
};

const runPr = (
  configPath: string,
  ref: string,
  baseOverride: string | undefined,
  reportPath: string | undefined,
  ci: boolean
): void => {
  const { slug, number } = parsePrRef(ref);
  const origin = originSlug();
  if (slug && origin && slug.toLowerCase() !== origin.toLowerCase()) {
    fail(`Pull request ${slug}#${number} does not belong to this checkout's origin (${origin}).`);
  }

  console.log(`  pull request ......... ${slug ?? origin ?? "origin"}#${number}`);
  try {
    git(["fetch", "origin", `pull/${number}/head`]);
  } catch {
    fail(
      `Could not fetch pull/${number}/head from origin.\n` +
        `Check that the pull request number is right and that you can reach the remote.`
    );
  }
  const head = git(["rev-parse", "FETCH_HEAD"]);

  let base = baseOverride;
  if (base) {
    console.log(`  base ................. ${base} (from --base)`);
  } else {
    try {
      git(["fetch", "origin", "main"]);
    } catch {
      /* fall through to whatever origin/main is already known locally */
    }
    base = resolveBase(head, "origin/main");
    console.log(`  branch point ......... ${base.slice(0, 12)} (against origin/main; pass --base to override)`);
  }

  runRefs(configPath, base, head, reportPath, ci, { slug: slug ?? origin ?? "", number });
};

const USAGE = `Usage: tsx ./scripts/graphs/pr-behavior-diff.ts [options]

Options:
  --url LINK|NUMBER   pull request to diff (url or bare number)
  --base REF          base revision (overrides the inferred merge-base)
  --head REF          head revision; with --base this skips GitHub entirely
  --config PATH       behavior config (default: backend/.behavior-config.json)
  --report PATH       also write the diff report as JSON
  --ci                exit 1 when behavior changed
  -h, --help          show this message

Examples:
  --url https://github.com/Infisical/infisical/pull/7638
  --url 7638 --ci
  --base origin/main --head my-branch
`;

const main = (): void => {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      config: { type: "string" },
      report: { type: "string" },
      ci: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const configPath = path.resolve(values.config ?? DEFAULT_CONFIG);
  const ci = values.ci ?? false;

  if (values.url) {
    runPr(configPath, values.url, values.base, values.report, ci);
    return;
  }
  if (values.base && values.head) {
    runRefs(configPath, values.base, values.head, values.report, ci);
    return;
  }
  fail(`Pass --url <pull request>, or --base <ref> together with --head <ref>.\n${USAGE}`);
};

main();
