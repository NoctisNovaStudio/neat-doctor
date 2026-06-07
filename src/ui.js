/**
 * ui.js — neat-doctor
 * Score box, issue list, agent prompt builder, dashboard orchestrator.
 */

import boxen from "boxen";
import chalk from "chalk";
import path from "node:path";

const REPORT_FILE = "./.neat-doctor-report.json";
const BAR_WIDTH   = 30;
const MAX_FILES   = 3;

// ---------------------------------------------------------------------------
// Rule metadata
// ---------------------------------------------------------------------------

const RULE_META = {
  "root-chaos": {
    badge: "CRIT",
    badgeFn: (s) => chalk.bgRed.white.bold(` ${s} `),
    category: "Structure",
    label: "Source Files in Project Root",
    penalty: 6,
    explanation:
      "Multiple TypeScript/JSX source files sitting directly in the project root. " +
      "The root should contain only config and documentation (package.json, tsconfig, README) — " +
      "all source code belongs inside a src/ or app/ directory.",
    realWorld:
      "A flat root with 20 .tsx files means no clear separation between 'configuration layer' " +
      "and 'application layer' — every new developer is immediately confused about where things go.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  "duplicate-concept": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Structure",
    label: "Duplicate Concept Folders",
    penalty: 8,
    explanation:
      "Multiple directories at the same level that serve the same purpose — e.g. having both " +
      "`utils/`, `helpers/`, and `lib/` in the same parent. Code gets split across these " +
      "arbitrarily, making it impossible to know where something lives.",
    realWorld:
      "Having utils/, helpers/, and shared/ means a new developer writing a date formatting function " +
      "asks: which folder? They guess wrong, and now your utilities are spread across three locations.",
    docs: "https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis",
  },

  "deep-nesting": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Structure",
    label: "Excessive Folder Depth",
    penalty: 4,
    explanation:
      "A folder nested more than 5 levels deep. Every additional level adds '../' to every import " +
      "that needs to cross boundaries — resulting in paths like '../../../../lib/utils/format'. " +
      "Deep nesting also makes file searching and navigation slower.",
    realWorld:
      "Moving a file 6 levels deep requires updating every import in every file that used it — " +
      "which can be dozens of files. Flat structures are dramatically easier to refactor.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  "fat-folder": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Structure",
    label: "Fat Folder (Too Many Files, No Groups)",
    penalty: 6,
    explanation:
      "A directory with 18+ files and no subdirectory grouping. Scrolling through 25 " +
      "unsorted component files to find the one you need costs real time — and makes " +
      "it hard to understand what the directory is responsible for.",
    realWorld:
      "A components/ folder with 40 files forces every developer to visually scan the entire list. " +
      "Splitting into components/ui/, components/layout/, components/forms/ makes intent clear instantly.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  "misplaced-file": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Placement",
    label: "File in Wrong Directory",
    penalty: 4,
    explanation:
      "A file that lives in a directory that doesn't match its type — e.g. a React component " +
      "(.tsx) inside a utils/ folder, or a config file nested deep inside src/. " +
      "Misplaced files break the mental model of the project.",
    realWorld:
      "A .tsx component inside utils/ means the next developer searching for 'UI components' " +
      "won't find it — they'll create a duplicate. And imports from utils/ feel wrong.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  "naming-mismatch": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Naming",
    label: "Mixed Naming Conventions",
    penalty: 5,
    explanation:
      "Folders or files in the same directory use different naming styles — e.g. `MyComponent.tsx` " +
      "next to `my-helper.ts` and `userStore.ts`. Inconsistency forces developers to memorise " +
      "per-file conventions and leads to import typos.",
    realWorld:
      "A team member writes `import { formatDate } from './Format-Date'` — wrong case. " +
      "Works on macOS (case-insensitive FS) but crashes in production on Linux (case-sensitive). " +
      "Naming consistency prevents entire class of deployment bugs.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  "missing-barrel": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Exports",
    label: "Missing Barrel File (index.ts)",
    penalty: 3,
    explanation:
      "A folder with 3+ source files has no index.ts barrel export. Without a barrel, " +
      "every consumer must know the exact file path: `@/components/Button/Button`. " +
      "With a barrel, it's simply `@/components` — cleaner and refactor-safe.",
    realWorld:
      "When you rename Button.tsx to PrimaryButton.tsx, you update 1 barrel file. Without a barrel, " +
      "you update every import across every file in the project — potentially dozens of changes.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  "scattered-config": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Config",
    label: "Config File in Wrong Location",
    penalty: 3,
    explanation:
      "A config file (*.config.ts, .eslintrc, jest.config.js, etc.) is nested inside a " +
      "subdirectory instead of the project root. Most tooling (ESLint, Jest, TypeScript) " +
      "automatically searches from the root — nested configs may be silently ignored.",
    realWorld:
      "A jest.config.ts inside src/config/ might never be picked up by Jest's root-level search, " +
      "causing your entire test suite to run with the wrong configuration — no error, just silent failure.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  "empty-dir": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgGray.white.bold(` ${s} `),
    category: "Cleanup",
    label: "Empty Directory",
    penalty: 2,
    explanation:
      "A directory that contains no files or subdirectories. Empty folders have no purpose " +
      "and add visual noise to the project tree — every developer who opens the project " +
      "wonders if they're missing something.",
    realWorld: "Empty folders inflate the apparent complexity of a project. New developers feel " +
      "the project is bigger and more complex than it is — before they've read a single line of code.",
    docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
  },

  // ── Advanced import-dependency-graph rules ────────────────────────────────

  "circular-dependency": {
    badge: "CRIT",
    badgeFn: (s) => chalk.bgRed.white.bold(` ${s} `),
    category: "Architecture",
    label: "Circular Dependency",
    penalty: 10,
    explanation:
      "Two or more modules import each other, forming a cycle in the dependency graph. " +
      "Cycles break tree-shaking, make modules impossible to test in isolation, and cause " +
      "subtle runtime bugs where one module sees the other as 'undefined' during initialisation.",
    realWorld:
      "A → B → A cycle throws 'Cannot access B before initialization' at runtime — but only " +
      "sometimes, depending on which file the bundler loads first. These are nightmare bugs to " +
      "reproduce because they're sensitive to import order.",
    docs: "https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis",
  },

  "orphan-file": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Architecture",
    label: "Orphan File (Imported by Nothing)",
    penalty: 5,
    explanation:
      "A file that exports code but is imported by no other file, and isn't an entry point " +
      "(page, route, config, test). The import graph proves nothing references it — it's almost " +
      "certainly dead code left behind by a refactor.",
    realWorld:
      "An old helpers/legacy-parser.ts that nothing imports still shows up in search results, " +
      "still gets reviewed in PRs, and still confuses every developer who finds it — for zero benefit.",
    docs: "https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis",
  },

  "god-file": {
    badge: "WARN",
    badgeFn: (s) => chalk.bgYellow.black.bold(` ${s} `),
    category: "Architecture",
    label: "God File (Too Big / Too Coupled)",
    penalty: 5,
    explanation:
      "A file with 400+ lines or 30+ imports. These 'god modules' concentrate too much " +
      "responsibility in one place — they're hard to test, slow to review, painful to merge " +
      "(constant conflicts), and impossible to reuse piecemeal.",
    realWorld:
      "A 900-line utils.ts that imports 40 things is touched by every feature branch — so it's " +
      "in every merge conflict. Splitting it into focused modules means teams stop stepping on each other.",
    docs: "https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis",
  },

  "deep-relative-import": {
    badge: "INFO",
    badgeFn: (s) => chalk.bgBlue.white.bold(` ${s} `),
    category: "Imports",
    label: "Deep Relative Import (../../../)",
    penalty: 2,
    explanation:
      "An import that climbs 3+ directory levels with ../../../. These paths are fragile: moving " +
      "either file breaks the import, and they're hard to read. A tsconfig path alias (@/*) makes " +
      "imports absolute and refactor-proof.",
    realWorld:
      "import { db } from '../../../../lib/db' breaks the moment you move the file one folder. " +
      "With '@/lib/db' you can move files freely and the import never changes.",
    docs: "https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis",
  },
};

const RULE_ORDER = [
  "circular-dependency", "root-chaos", "duplicate-concept", "god-file",
  "deep-nesting", "fat-folder", "orphan-file", "misplaced-file",
  "naming-mismatch", "missing-barrel", "deep-relative-import",
  "scattered-config", "empty-dir",
];

// ---------------------------------------------------------------------------
// Progress bar + score badge
// ---------------------------------------------------------------------------

export function renderProgressBar(score) {
  const c = Math.min(100, Math.max(0, score));
  const b = "█".repeat(Math.round((c / 100) * BAR_WIDTH)) + "░".repeat(BAR_WIDTH - Math.round((c / 100) * BAR_WIDTH));
  return c >= 80 ? chalk.green(b) : c >= 50 ? chalk.yellow(b) : chalk.red(b);
}

export function renderScoreBadge(score) {
  const c = Math.min(100, Math.max(0, score));
  let grade, fn;
  if (c >= 90)      { grade = "A · Pristine";   fn = chalk.green.bold; }
  else if (c >= 80) { grade = "B · Neat";        fn = chalk.green; }
  else if (c >= 65) { grade = "C · Cluttered";   fn = chalk.yellow.bold; }
  else if (c >= 50) { grade = "D · Messy";       fn = chalk.yellow; }
  else              { grade = "F · Chaotic";     fn = chalk.red.bold; }
  return fn(`${c}/100  ${grade}`);
}

// ---------------------------------------------------------------------------
// Framework + dependency-graph summary line
// ---------------------------------------------------------------------------

export function renderFrameworkLine(framework, graphStats) {
  if (!framework && !graphStats) return "";
  const lines = [];

  if (framework?.labels?.length) {
    lines.push(
      chalk.dim("  Detected: ") +
      framework.labels.map((l) => chalk.magenta(l)).join(chalk.dim(" · ")) +
      chalk.dim(`   (${framework.pm})`)
    );
  }

  if (graphStats) {
    const aliasNote = graphStats.aliasConfig
      ? chalk.green(`${graphStats.aliasCount} path alias${graphStats.aliasCount !== 1 ? "es" : ""}`)
      : chalk.yellow("no path aliases");
    const fanIn = graphStats.maxFanInFile
      ? chalk.dim(`  ·  most-imported: `) + chalk.cyan(graphStats.maxFanInFile) + chalk.dim(` (${graphStats.maxFanIn}×)`)
      : "";
    lines.push(
      chalk.dim("  Graph: ") +
      chalk.white(`${graphStats.edges}`) + chalk.dim(" import edges  ·  ") +
      chalk.white(`${graphStats.avgImports}`) + chalk.dim(" avg imports/file  ·  ") +
      aliasNote + fanIn
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Score header box
// ---------------------------------------------------------------------------

export function renderScoreBox({ score, totalPenalty, issueCount, stats }) {
  const content = [
    chalk.bold.white("neat-doctor") + chalk.dim("  v1.0.0"),
    chalk.dim(`${stats.totalFiles} files  ·  ${stats.totalDirs} dirs  ·  max depth ${stats.maxDepth}`),
    "",
    `${renderProgressBar(score)}  ${renderScoreBadge(score)}`,
    chalk.dim(`${issueCount} issue${issueCount !== 1 ? "s" : ""}  ·  penalty -${totalPenalty}pts`),
  ].join("\n");

  return boxen(content, {
    padding: { top: 0, bottom: 0, left: 2, right: 2 },
    margin: { top: 1, bottom: 0 },
    borderStyle: "round",
    borderColor: score >= 80 ? "green" : score >= 50 ? "yellow" : "red",
  });
}

// ---------------------------------------------------------------------------
// Numbered issue list
// ---------------------------------------------------------------------------

export function renderIssueList(issues, { colour = true } = {}) {
  if (issues.length === 0) {
    return colour
      ? chalk.green("\n  ✓  Project structure is pristine!\n")
      : "\n  No structural issues found.\n";
  }

  const grouped = groupByRule(issues);
  const ordered = [
    ...RULE_ORDER.filter((r) => grouped[r]),
    ...Object.keys(grouped).filter((r) => !RULE_ORDER.includes(r)),
  ];

  const lines = [""];
  let idx = 1;

  for (const rule of ordered) {
    const ruleIssues = grouped[rule];
    const meta = RULE_META[rule] ?? {
      badge: "INFO", badgeFn: (s) => `[${s}]`, category: "Structure",
      label: rule, explanation: "", realWorld: "", docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
    };

    const count    = ruleIssues.length;
    const badge    = colour ? meta.badgeFn(meta.badge) : `[${meta.badge}]`;
    const heading  = colour ? chalk.bold(`${meta.category}: ${meta.label}`) : `${meta.category}: ${meta.label}`;
    const countStr = colour ? chalk.dim(`(×${count})`) : `(×${count})`;

    lines.push(`${idx}. ${badge} ${heading} ${countStr}`);
    if (meta.explanation) lines.push(`   ${colour ? chalk.white(meta.explanation) : meta.explanation}`);
    if (meta.realWorld)   lines.push(`   ${colour ? chalk.dim(meta.realWorld)   : meta.realWorld}`);
    lines.push(
      `   ${colour ? chalk.dim("Canonical fix:") : "Canonical fix:"}` +
      `${colour ? chalk.cyan(" " + meta.docs) : " " + meta.docs}`
    );

    const shown = ruleIssues.slice(0, MAX_FILES);
    const overflow = ruleIssues.length - shown.length;

    for (const issue of shown) {
      const loc = colour ? chalk.cyan(issue.file) : issue.file;
      const snip = issue.snippet ? chalk.dim("  — " + issue.snippet) : "";
      lines.push(`   ${colour ? chalk.dim("-") : "-"} ${loc}${colour ? snip : ""}`);
    }
    if (overflow > 0) lines.push(colour ? chalk.dim(`   +${overflow} more`) : `   +${overflow} more`);

    lines.push("");
    idx++;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full dashboard
// ---------------------------------------------------------------------------

export function renderDashboard({ score, totalPenalty, issues, stats }) {
  const parts = [];

  parts.push(renderScoreBox({ score, totalPenalty, issueCount: issues.length, stats }));

  if (issues.length === 0) {
    parts.push(chalk.green("\n  ✓  Structure is clean — well organised!\n"));
    return parts.join("\n");
  }

  parts.push(renderIssueList(issues, { colour: true }));

  parts.push(chalk.dim("Full details (.neat-doctor-report.json): ") + chalk.cyan(path.resolve(REPORT_FILE)));
  parts.push("");
  parts.push(chalk.dim("─".repeat(64)));
  parts.push(
    chalk.dim("  Built by ") + chalk.magenta.bold("NoctisNova") +
    chalk.dim("  ·  noctisnova.com  ·  hello@noctisnova.com")
  );
  parts.push("");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Agent prompt builder
// ---------------------------------------------------------------------------

export function buildAgentPrompt(issues, reportPath, stats) {
  const projectContext = [
    "CODEBASE CONTEXT — READ BEFORE TOUCHING ANY FILE",
    "──────────────────────────────────────────────────",
    `Project: ${stats.totalFiles} source files  ·  ${stats.totalDirs} directories  ·  max depth ${stats.maxDepth}`,
    "",
    "Reorganisation conventions (DO NOT deviate):",
    "  - All source code lives in src/ (or app/ if App Router only)",
    "  - Folder naming: kebab-case everywhere",
    "  - React components: PascalCase filenames",
    "  - Utility/hook files: kebab-case filenames",
    "  - Every folder with 3+ exports must have an index.ts barrel",
    "  - Config files belong at the project root only",
    "  - When moving a file: update ALL imports across the codebase",
    "  - When deleting a folder: confirm it's empty first",
    "──────────────────────────────────────────────────",
    "",
  ].join("\n");

  const header = `Reorganise this project to fix all ${issues.length} structural issue${issues.length !== 1 ? "s" : ""} detected by neat-doctor.`;

  const issueBlock = renderIssueList(issues, { colour: false });

  const footer = [
    `Full report (.neat-doctor-report.json): ${reportPath}`,
    "",
    "Work through issues in this order (most impactful first):",
    "  1. Root chaos — move all source files into src/",
    "  2. Duplicate concepts — consolidate utils/helpers/lib into one",
    "  3. Deep nesting — flatten or add path aliases in tsconfig.json",
    "  4. Fat folders — create subdirectories grouped by concern",
    "  5. Misplaced files — move to the correct directory type",
    "  6. Naming — rename folders to kebab-case, components to PascalCase",
    "  7. Barrel files — add index.ts to qualifying directories",
    "  8. Scattered config — move config files to project root",
    "  9. Empty dirs — delete them",
    "",
    "CRITICAL: when moving files, update every import that references them.",
    "Run `npx neat-doctor` after each category to verify issue count drops.",
    "",
    "For every fix, explain in simple everyday language — no jargon — what was reorganised and why it helps. " +
    "Focus on real-world benefits (e.g. \"easier to find the right file\", \"fewer bugs from tangled imports\", " +
    "\"new team members can onboard faster\") so someone non-technical understands why it mattered.",
    "",
    "─────────────────────────────────────────────────────────────────",
    "neat-doctor  ·  Built by NoctisNova  ·  https://noctisnova.com",
  ].join("\n");

  return [projectContext, header, issueBlock, footer].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByRule(issues) {
  const g = {};
  for (const i of issues) (g[i.rule] ??= []).push(i);
  return g;
}
