#!/usr/bin/env node
/**
 * index.js — neat-doctor
 * Code structure analyser and organiser for TypeScript/Next.js projects.
 * Built by NoctisNova — noctisnova.com
 */

import * as p from "@clack/prompts";
import boxen from "boxen";
import chalk from "chalk";
import clipboardy from "clipboardy";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  runAllScans,
  computeStats,
  detectFramework,
} from "./src/scanner.js";

import {
  runGraphScans,
} from "./src/graph.js";

import {
  writeFixScripts,
} from "./src/fix.js";

import {
  renderProgressBar,
  renderScoreBadge,
  renderDashboard,
  renderIssueList,
  renderFrameworkLine,
  buildAgentPrompt,
} from "./src/ui.js";

import {
  buildIssueMap,
  renderCurrentTree,
  renderRecommendedStructure,
  renderMigrationPlan,
} from "./src/tree.js";

// ---------------------------------------------------------------------------
// Combined scan (filesystem rules + import-graph rules), single source of truth
// ---------------------------------------------------------------------------

async function runCombinedScan(projectPath) {
  const [{ issues: structureIssues, stats }, graph] = await Promise.all([
    runAllScans({ projectPath }),
    Promise.resolve().then(() => runGraphScans(projectPath)),
  ]);

  const framework = detectFramework(projectPath);
  const issues = [...structureIssues, ...graph.issues];
  const totalPenalty = issues.reduce((s, i) => s + i.penalty, 0);
  const score = Math.max(0, 100 - totalPenalty);

  return {
    generatedAt: new Date().toISOString(),
    projectPath: path.resolve(projectPath),
    framework,
    score,
    totalPenalty,
    issueCount: issues.length,
    stats,
    graphStats: graph.graphStats,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPORT_FILE = "./.neat-doctor-report.json";
const VERSION     = "1.0.0";

const HELP_TEXT = `
${chalk.bold("neat-doctor")}  v${VERSION}
Code structure analyser for TypeScript and Next.js codebases.
Built by NoctisNova — noctisnova.com

${chalk.bold("Usage")}
  neat-doctor [options] [path]

${chalk.bold("Arguments")}
  path            Root directory to analyse (default: current directory)

${chalk.bold("Options")}
  --tree          Show annotated ASCII tree of current structure
  --recommend     Show recommended clean structure (no scan needed)
  --json          Output raw JSON to stdout (CI mode)
  --no-ai         Skip the agent hand-off menu
  --depth <n>     Tree render depth (default: 4)
  --version, -v   Print version and exit
  --help, -h      Show this help message

${chalk.bold("Structure analysis")}
  ● Root chaos          — source files dumped in the project root
  ● Duplicate concepts  — utils/ AND helpers/ AND lib/ at the same level
  ● Deep nesting        — folders more than 5 levels deep
  ● Fat folders         — 18+ files with no subdirectory grouping
  ● Misplaced files     — components in utils/, config files in src/
  ● Naming mix          — kebab-case folders next to PascalCase folders
  ● Missing barrels     — folders with 3+ exports but no index.ts
  ● Scattered config    — *.config.ts nested inside src/
  ● Empty directories   — folders with nothing in them

${chalk.bold("Import-dependency-graph analysis")} ${chalk.dim("(the advanced engine)")}
  ● Circular deps       — true import cycles via Tarjan SCC detection
  ● Orphan files        — exports nothing imports (proven dead via the graph)
  ● God files           — 400+ lines or 30+ imports (low cohesion)
  ● Deep imports        — ../../../ chains that should be path aliases

${chalk.bold("Fix scripts")}
  Pick "Generate fix scripts" in the menu to write safe, reviewable
  git-mv migration scripts (.sh + .ps1) and a markdown plan.
  Nothing is executed automatically.

${chalk.bold("Examples")}
  neat-doctor                         # scan current dir
  neat-doctor ./my-nextjs-app         # scan specific project
  neat-doctor --tree                  # show annotated tree
  neat-doctor --recommend             # show ideal structure
  neat-doctor --tree --recommend      # show both side by side
  neat-doctor --json > report.json    # CI mode
`.trim();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function parseCLIArgs() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        tree:    { type: "boolean", default: false },
        recommend: { type: "boolean", default: false },
        json:    { type: "boolean", default: false },
        "no-ai": { type: "boolean", default: false },
        depth:   { type: "string" },
        version: { type: "boolean", short: "v", default: false },
        help:    { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`)); process.exit(1);
  }
  return {
    projectPath: parsed.positionals[0] ?? process.cwd(),
    showTree:    parsed.values.tree,
    showRecommend: parsed.values.recommend,
    jsonMode:    parsed.values.json,
    noAi:        parsed.values["no-ai"],
    depth:       parseInt(parsed.values.depth ?? "4", 10),
    showVersion: parsed.values.version,
    showHelp:    parsed.values.help,
  };
}

// ---------------------------------------------------------------------------
// Score animation
// ---------------------------------------------------------------------------

async function animateScoreReveal(score) {
  const frames = 40;
  process.stdout.write("\x1B[?25l");
  for (let i = 0; i <= frames; i++) {
    const cur = Math.round(easeOut(i / frames) * score);
    process.stdout.write(`\r  ${renderProgressBar(cur)}  ${renderScoreBadge(cur)}   `);
    await sleep(16);
  }
  process.stdout.write("\x1B[?25h\n\n");
}

// ---------------------------------------------------------------------------
// Section box header
// ---------------------------------------------------------------------------

function sectionBox(title, content, borderColor = "cyan") {
  return boxen(content, {
    title: chalk.bold(` ${title} `),
    titleAlignment: "center",
    padding: { top: 1, bottom: 1, left: 2, right: 2 },
    margin: { top: 0, bottom: 1 },
    borderStyle: "round",
    borderColor,
  });
}

// ---------------------------------------------------------------------------
// AI hand-off helpers
// ---------------------------------------------------------------------------

function handOffToClaude(prompt) {
  if (!fs.existsSync(path.resolve(REPORT_FILE))) {
    p.log.warn("Report not found — run neat-doctor first."); return;
  }
  p.log.step(chalk.dim("Launching Claude Code…"));
  const safe = prompt.replace(/"/g, '\\"');
  try {
    execSync(`claude -p "${safe}"`, { stdio: "inherit", shell: true });
  } catch (err) {
    if (err.status === 127 || /not found|is not recognized/i.test(err.message ?? "")) {
      p.log.error(chalk.red("`claude` not found.\n") + chalk.dim("  Install: https://docs.anthropic.com/en/docs/claude-code/getting-started"));
    } else {
      p.log.warn(chalk.yellow(`Claude exited with code ${err.status ?? "?"}.`));
    }
  }
}

async function copyToClipboard(text) {
  try {
    await clipboardy.write(text);
    p.log.success(chalk.green("Prompt copied to clipboard!"));
    p.log.info(chalk.dim("Paste into Cursor, ChatGPT, or any AI assistant."));
  } catch (err) {
    p.log.error(chalk.red(`Clipboard failed: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// Multi-phase scan with spinners
// ---------------------------------------------------------------------------

async function runPhasedScans({ projectPath }) {
  const spinner = p.spinner();
  spinner.start(chalk.dim("Reading project structure…"));
  await sleep(280);

  const framework = detectFramework(projectPath);
  const stats = computeStats(projectPath);
  const fwLabel = framework.labels.length ? framework.labels.slice(0, 3).join(" · ") : "project";
  spinner.message(chalk.dim(`${fwLabel} — ${stats.totalFiles} files, ${stats.totalDirs} dirs, max depth ${stats.maxDepth}…`));
  await sleep(380);

  const phases = [
    "Checking root-level organisation…",
    "Hunting for duplicate concept folders…",
    "Measuring folder depths & fat folders…",
    "Validating file placements & naming…",
    "Scanning for missing barrel files…",
  ];
  for (const msg of phases) { spinner.message(chalk.dim(msg)); await sleep(170); }

  // Filesystem rules
  const { issues: structureIssues, stats: _s } = await runAllScans({ projectPath });

  // ── The advanced part: build + analyse the import-dependency graph ──
  spinner.message(chalk.dim("Building import-dependency graph…"));
  await sleep(220);
  spinner.message(chalk.dim("Detecting circular dependencies (Tarjan SCC)…"));
  await sleep(220);
  spinner.message(chalk.dim("Finding orphan files & god modules…"));
  await sleep(220);
  const graph = runGraphScans(projectPath);

  spinner.message(chalk.dim("Computing cleanliness score…"));
  await sleep(260);

  const issues = [...structureIssues, ...graph.issues];
  const totalPenalty = issues.reduce((s, i) => s + i.penalty, 0);
  const score = Math.max(0, 100 - totalPenalty);

  // Persist combined report
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      projectPath: path.resolve(projectPath),
      framework,
      score, totalPenalty, issueCount: issues.length,
      stats, graphStats: graph.graphStats,
      issues,
    }, null, 2), "utf-8");
  } catch { /* non-fatal */ }

  const doneMsg = issues.length === 0
    ? chalk.green("Done — structure is clean!")
    : chalk.yellow(`Done — ${issues.length} issue${issues.length !== 1 ? "s" : ""} found across structure + dependency graph.`);

  spinner.stop(doneMsg);

  return { issues, totalPenalty, score, stats, framework, graphStats: graph.graphStats };
}

// ---------------------------------------------------------------------------
// Tree view section
// ---------------------------------------------------------------------------

function showTreeSection(projectPath, issueMap, depth) {
  console.log();
  const treeContent = renderCurrentTree(projectPath, issueMap, { maxDepth: depth });
  console.log(
    sectionBox(
      "📁  Current Structure  (annotated with issues)",
      treeContent,
      "yellow"
    )
  );
}

function showRecommendSection(projectPath, stats, issues) {
  console.log();
  const recContent = renderRecommendedStructure(projectPath, stats, issues);
  console.log(
    sectionBox(
      "✨  Recommended Structure  (Next.js best practice)",
      recContent,
      "green"
    )
  );
}

// ---------------------------------------------------------------------------
// Hand-off menu
// ---------------------------------------------------------------------------

async function showHandOffMenu(issues, stats, projectPath) {
  if (issues.length === 0) {
    p.log.success(chalk.green("Nothing to reorganise — structure is already clean!"));
    return;
  }

  const reportPath  = path.resolve(REPORT_FILE);
  const agentPrompt = buildAgentPrompt(issues, reportPath, stats);

  console.log();

  const choice = await p.select({
    message: chalk.bold("What do you want to do with these structure issues?"),
    options: [
      {
        value: "claude",
        label: chalk.cyan.bold("Send to Claude Code"),
        hint: "Claude reads the report and reorganises the project",
      },
      {
        value: "clipboard",
        label: chalk.magenta.bold("Copy prompt to clipboard"),
        hint: "paste into Cursor, ChatGPT, Claude.ai, or any AI",
      },
      {
        value: "tree",
        label: chalk.yellow.bold("Show annotated tree"),
        hint: "see exactly where issues are in the file tree",
      },
      {
        value: "recommend",
        label: chalk.green.bold("Show recommended structure"),
        hint: "see the clean target layout for this project type",
      },
      {
        value: "plan",
        label: chalk.white.bold("Show migration plan"),
        hint: "before/after table of what needs to move where",
      },
      {
        value: "fix",
        label: chalk.red.bold("Generate fix scripts"),
        hint: "write safe `git mv` migration scripts (.ps1 + .sh) + a markdown plan",
      },
      {
        value: "skip",
        label: chalk.dim("Skip"),
        hint: "report saved to .neat-doctor-report.json",
      },
    ],
  });

  if (p.isCancel(choice)) { p.cancel("Cancelled."); process.exit(0); }

  console.log();

  switch (choice) {
    case "claude":
      handOffToClaude(agentPrompt);
      break;
    case "clipboard":
      await copyToClipboard(agentPrompt);
      break;
    case "tree": {
      const iMap = buildIssueMap(issues);
      showTreeSection(projectPath, iMap, 4);
      break;
    }
    case "recommend": {
      showRecommendSection(projectPath, computeStats(projectPath), issues);
      break;
    }
    case "plan":
      console.log(renderMigrationPlan(issues));
      break;
    case "fix": {
      const written = writeFixScripts(projectPath, issues, stats);
      p.log.success(chalk.green(`Generated ${written.length} fix file${written.length !== 1 ? "s" : ""}:`));
      for (const f of written) p.log.info(chalk.cyan("  " + f));
      p.log.warn(chalk.dim("Review the scripts before running — they move files with `git mv`. Nothing was executed."));
      break;
    }
    case "skip":
      p.log.info(chalk.dim("Report saved to: ") + chalk.cyan(path.resolve(REPORT_FILE)));
      break;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCLIArgs();

  if (args.showVersion) { console.log(`neat-doctor v${VERSION}`); process.exit(0); }
  if (args.showHelp)    { console.log(HELP_TEXT);                 process.exit(0); }

  const resolvedProject = path.resolve(args.projectPath);
  if (!fs.existsSync(resolvedProject)) {
    console.error(chalk.red(`Error: path does not exist — ${resolvedProject}`));
    process.exit(1);
  }

  // ── CI / JSON mode ───────────────────────────────────────────────────────
  if (args.jsonMode) {
    const result = await runCombinedScan(args.projectPath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.issues.length > 0 ? 1 : 0);
  }

  // ── Standalone tree / recommend mode (no full scan) ──────────────────────
  if (args.showTree || args.showRecommend) {
    const stats = computeStats(args.projectPath);
    // Run a lightweight scan so the tree can still be annotated with issues
    const { issues } = await runAllScans({ projectPath: args.projectPath });
    if (args.showTree)      showTreeSection(args.projectPath, buildIssueMap(issues), args.depth);
    if (args.showRecommend) showRecommendSection(args.projectPath, stats, issues);
    process.exit(0);
  }

  // ── Interactive mode ─────────────────────────────────────────────────────
  console.log();
  p.intro(
    chalk.bgGreen.black.bold("  neat-doctor  ") +
    chalk.dim(`  v${VERSION}  ·  Code structure analyser  ·  by `) +
    chalk.magenta("NoctisNova") +
    chalk.dim("  noctisnova.com")
  );

  console.log();

  let result;
  try {
    result = await runPhasedScans({ projectPath: args.projectPath });
  } catch (err) {
    p.log.error(chalk.red(err.message));
    p.outro(chalk.red("neat-doctor encountered an error."));
    process.exit(1);
  }

  const { issues, score, totalPenalty, stats, framework, graphStats } = result;

  // Score reveal
  console.log();
  await animateScoreReveal(score);

  // Framework + dependency-graph summary line
  console.log(renderFrameworkLine(framework, graphStats));

  // Dashboard (issue list + score box)
  console.log(renderDashboard({ score, totalPenalty, issues, stats }));

  // Always show the annotated tree + recommended structure
  if (issues.length > 0) {
    const issueMap = buildIssueMap(issues);

    // Annotated current tree
    console.log();
    const treeContent = renderCurrentTree(args.projectPath, issueMap, { maxDepth: args.depth });
    console.log(sectionBox("📁  Current Structure  (issues highlighted)", treeContent, "yellow"));

    // Migration plan
    const plan = renderMigrationPlan(issues);
    if (plan.trim()) {
      console.log(sectionBox("🗺️   Migration Plan  (what needs to move)", plan.trim(), "magenta"));
    }

    // Recommended structure
    const recContent = renderRecommendedStructure(args.projectPath, stats, issues);
    console.log(sectionBox("✨  Recommended Structure", recContent, "green"));
  } else {
    // Show recommended anyway — it's still useful
    const recContent = renderRecommendedStructure(args.projectPath, stats, issues);
    console.log(sectionBox("✨  Recommended Structure  (already matching!)", recContent, "green"));
  }

  // Hand-off menu
  if (!args.noAi) {
    await showHandOffMenu(issues, stats, args.projectPath);
  } else {
    p.log.info(chalk.dim("Report: ") + chalk.cyan(path.resolve(REPORT_FILE)));
  }

  console.log();
  p.outro(
    issues.length === 0
      ? chalk.green("Structure is clean. Keep it that way.")
      : chalk.yellow(`${issues.length} issue${issues.length !== 1 ? "s" : ""} to fix. Follow the migration plan — your future self will thank you.`)
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(chalk.red("\nUnexpected error:"), err.message ?? err);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
