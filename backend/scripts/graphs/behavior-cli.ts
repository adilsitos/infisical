/* eslint-disable */
/**
 * Behavior Review CLI
 * ===================
 * One command for the whole behavior pipeline. Takes a pull request (link or number) and runs,
 * in order:
 *
 *     1. ./signature-builder.ts build   route manifest for the working tree
 *     2. ./pr-behavior-diff.ts          signature diff for the pull request
 *     3. ./project-analyzer.ts analyze  graph + manifest join, per-project impact
 *
 * Each step is spawned rather than imported: they are independent CLIs that own their own
 * output, and ./pr-behavior-diff.ts runs its main() on import.
 *
 * Step 2 is deliberately run without --ci. On its own it exits 1 whenever any route hash moved,
 * which is the normal case here and would stop the pipeline before the analysis that explains
 * the change. --ci on this CLI gates on the analyzer's risk verdict instead.
 *
 * Artifacts land in a run directory under the system temp dir unless --out is given, so a review
 * leaves the checkout untouched.
 *
 * Usage:
 *     npm run behavior:review -- 7589
 *     npm run behavior:review -- --url https://github.com/Infisical/infisical/pull/7589 --print
 *     npm run behavior:review -- --base origin/main --head my-branch --out ./impact
 *     npm run behavior:review -- 7589 --ci --skip-build
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { BACKEND_ROOT, DEFAULT_CONFIG, DEFAULT_MANIFEST, fail } from "./signature-builder";

const SCRIPT_DIR = __dirname;
const DEFAULT_GRAPH = path.resolve(BACKEND_ROOT, "..", "graphify-out", "graph.json");
const DEFAULT_REGISTRY = path.join(BACKEND_ROOT, ".behavior-projects.json");

const tsxBin = (): string => {
  const bin = path.join(BACKEND_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (!existsSync(bin)) fail(`tsx was not found at '${bin}'. Run \`npm install\` in backend/ first.`);
  return bin;
};

const rule = (): void => console.log(`  ${"-".repeat(76)}`);

const step = (index: number, total: number, label: string, script: string, args: string[]): number => {
  console.log(`\n  [${index}/${total}] ${label}`);
  rule();

  const started = Date.now();
  const result = spawnSync(tsxBin(), [path.join(SCRIPT_DIR, script), ...args], {
    cwd: BACKEND_ROOT,
    stdio: "inherit",
    encoding: "utf-8"
  });

  if (result.error) fail(`Could not run ${script}: ${result.error.message}`);
  if (result.signal) fail(`${script} was terminated by ${result.signal}.`);

  const status = result.status ?? 1;
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s${status ? ` (exit ${status})` : ""}`);
  return status;
};

const runSlug = (url: string | undefined, base: string | undefined, head: string | undefined): string => {
  if (url) {
    const number = url.match(/(\d+)\s*$/);
    return `pr-${number ? number[1] : "unknown"}`;
  }
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `refs-${safe(base ?? "base")}..${safe(head ?? "head")}`;
};

const USAGE = `Usage: tsx ./scripts/graphs/behavior-cli.ts <pull request> [options]

Builds the route manifest, diffs the pull request's behavior, and reports per-project impact.

Target (one of):
  <pull request>       positional pull request url or number
  --url LINK|NUMBER    same, as a flag
  --base REF --head REF  diff two revisions instead of a pull request

Options:
  --out DIR            run directory for the artifacts (default: a temp dir, printed at the end)
  --report PATH        diff report json (default: <out>/report.json)
  --analysis PATH      analysis json (default: <out>/analysis.json)
  --markdown PATH      markdown summary (default: <out>/impact.md)
  --print              print the markdown summary to stdout when finished
  --skip-build         reuse the existing route manifest instead of rebuilding it
  --config PATH        behavior config (default: backend/.behavior-config.json)
  --manifest PATH      route manifest (default: backend/.behavior-manifest.json)
  --graph PATH         graph.json (default: ../graphify-out/graph.json)
  --registry PATH      project registry (default: backend/.behavior-projects.json, optional)
  --wide-threshold N   routes past which a file is reported as a count
  --max-depth N        import hops to follow back from a changed file
  --ci                 exit 1 when any project is critical or high risk
  -h, --help           show this message

Examples:
  npm run behavior:review -- 7589
  npm run behavior:review -- https://github.com/Infisical/infisical/pull/7589 --print
  npm run behavior:review -- --base origin/main --head my-branch --out ./impact
`;

const main = (): void => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      out: { type: "string" },
      report: { type: "string" },
      analysis: { type: "string" },
      markdown: { type: "string" },
      print: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      config: { type: "string" },
      manifest: { type: "string" },
      graph: { type: "string" },
      registry: { type: "string" },
      "wide-threshold": { type: "string" },
      "max-depth": { type: "string" },
      ci: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (positionals.length > 1) fail(`Expected one pull request, got ${positionals.length}: ${positionals.join(", ")}.\n${USAGE}`);
  const target = values.url ?? positionals[0];
  const byRefs = Boolean(values.base && values.head);

  if (target && byRefs) {
    fail(`Pass a pull request or --base together with --head, not both.\n${USAGE}`);
  }
  if (!target && !byRefs) {
    fail(
      `Pass a pull request url or number, or --base <ref> together with --head <ref>.\n` +
        `Example: npm run behavior:review -- 7589\n${USAGE}`
    );
  }

  const outDir = path.resolve(
    values.out ?? path.join(os.tmpdir(), "infisical-behavior", runSlug(target, values.base, values.head))
  );
  mkdirSync(outDir, { recursive: true });

  const reportPath = path.resolve(values.report ?? path.join(outDir, "report.json"));
  const analysisPath = path.resolve(values.analysis ?? path.join(outDir, "analysis.json"));
  const markdownPath = path.resolve(values.markdown ?? path.join(outDir, "impact.md"));

  const configPath = path.resolve(values.config ?? DEFAULT_CONFIG);
  const manifestPath = path.resolve(values.manifest ?? DEFAULT_MANIFEST);
  const graphPath = path.resolve(values.graph ?? DEFAULT_GRAPH);
  const registryPath = path.resolve(values.registry ?? DEFAULT_REGISTRY);

  if (!existsSync(configPath)) {
    fail(
      `No behavior config at '${path.relative(BACKEND_ROOT, configPath)}'.\n` +
        `Run \`npm run behavior:discover\` once to write it, then re-run this command.`
    );
  }
  if (values["skip-build"] && !existsSync(manifestPath)) {
    fail(
      `--skip-build was passed but there is no route manifest at '${path.relative(BACKEND_ROOT, manifestPath)}'.\n` +
        `Drop --skip-build so it gets built.`
    );
  }
  if (!existsSync(graphPath)) {
    console.warn(
      `\n  warn: no graph at ${graphPath}. Service reach still works via the DI wiring, but library ` +
        `changes cannot be traced and grouping falls back to unowned. Run graphify to get the full picture.`
    );
  }

  console.log(`\n  Behavior review`);
  console.log(`  target ............... ${target ?? `${values.base}...${values.head}`}`);
  console.log(`  artifacts ............ ${outDir}`);

  const total = values["skip-build"] ? 2 : 3;
  let index = 0;

  if (values["skip-build"]) {
    console.log(`  manifest ............. reusing ${path.relative(BACKEND_ROOT, manifestPath)} (--skip-build)`);
  } else {
    index += 1;
    const status = step(index, total, "Building the route manifest", "signature-builder.ts", [
      "build",
      "--config",
      configPath,
      "--output",
      manifestPath,
      "--graph",
      graphPath
    ]);
    if (status) fail(`The route manifest could not be built (exit ${status}), so there is nothing to join against.`);
  }

  index += 1;
  const diffArgs = target ? ["--url", target] : ["--base", values.base!, "--head", values.head!];
  const diffStatus = step(index, total, "Diffing behavior signatures", "pr-behavior-diff.ts", [
    ...diffArgs,
    "--config",
    configPath,
    "--report",
    reportPath
  ]);
  if (diffStatus) fail(`The signature diff failed (exit ${diffStatus}).`);
  if (!existsSync(reportPath)) fail(`The signature diff wrote no report to '${reportPath}'.`);

  index += 1;
  const analyzeArgs = [
    "analyze",
    "--report",
    reportPath,
    "--manifest",
    manifestPath,
    "--config",
    configPath,
    "--graph",
    graphPath,
    "--output",
    analysisPath,
    "--markdown",
    markdownPath
  ];
  if (existsSync(registryPath)) analyzeArgs.push("--registry", registryPath);
  if (values["wide-threshold"]) analyzeArgs.push("--wide-threshold", values["wide-threshold"]);
  if (values["max-depth"]) analyzeArgs.push("--max-depth", values["max-depth"]);
  if (values.ci) analyzeArgs.push("--ci");

  const analyzeStatus = step(index, total, "Analysing project impact", "project-analyzer.ts", analyzeArgs);
  // A non-zero exit here is the --ci risk gate firing, not a crash, as long as the artifacts landed.
  if (analyzeStatus && !existsSync(analysisPath)) fail(`The impact analysis failed (exit ${analyzeStatus}).`);

  if (values.print && existsSync(markdownPath)) {
    rule();
    console.log(readFileSync(markdownPath, "utf-8"));
  }

  rule();
  console.log(`  report ............... ${reportPath}`);
  console.log(`  analysis ............. ${analysisPath}`);
  console.log(`  markdown ............. ${markdownPath}\n`);

  process.exit(analyzeStatus);
};

main();
