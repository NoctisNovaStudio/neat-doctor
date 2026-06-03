/**
 * tree.js — neat-doctor
 * Renders a beautiful, annotated ASCII file tree and a recommended structure.
 */

import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "out", ".turbo",
  "coverage", ".nyc_output", "storybook-static", ".cache",
  "__generated__", ".vercel", ".husky",
]);

const TREE_MAX_DEPTH = 4;  // how deep to render the ASCII tree
const TREE_MAX_FILES = 6;  // max files to show per directory before collapsing

// Tree branch characters
const BRANCH = "├── ";
const LAST   = "└── ";
const PIPE   = "│   ";
const SPACE  = "    ";

// ---------------------------------------------------------------------------
// Icon mapping
// ---------------------------------------------------------------------------

const ICONS = {
  // Folders
  dir:          "📁",
  components:   "🧩",
  app:          "⚡",
  pages:        "📄",
  api:          "🔌",
  lib:          "📦",
  utils:        "🔧",
  helpers:      "🔧",
  hooks:        "🪝",
  types:        "🏷️ ",
  styles:       "🎨",
  public:       "🌐",
  tests:        "🧪",
  __tests__:    "🧪",
  actions:      "⚡",
  store:        "🗄️ ",
  stores:       "🗄️ ",
  config:       "⚙️ ",
  docs:         "📚",
  scripts:      "📜",
  prisma:       "🗃️ ",
  // Files
  ts:           "📘",
  tsx:          "⚛️ ",
  js:           "📒",
  jsx:          "⚛️ ",
  json:         "📋",
  md:           "📖",
  env:          "🔑",
  prisma_file:  "🗃️ ",
  css:          "🎨",
  svg:          "🖼️ ",
  png:          "🖼️ ",
  lock:         "🔒",
  config_file:  "⚙️ ",
};

function getIcon(name, isDir) {
  if (isDir) {
    const lower = name.toLowerCase().replace(/^[\[(]|[\])]$/g, "");
    return ICONS[lower] ?? ICONS.dir;
  }
  const ext = name.split(".").pop()?.toLowerCase();
  if (name.startsWith(".env")) return ICONS.env;
  if (name.endsWith(".config.ts") || name.endsWith(".config.js") || name.endsWith(".config.mjs")) return ICONS.config_file;
  if (name.endsWith(".prisma")) return ICONS.prisma_file;
  if (name.endsWith(".lock")) return ICONS.lock;
  if (ext === "tsx" || ext === "jsx") return ICONS.tsx;
  if (ext === "ts") return ICONS.ts;
  if (ext === "js") return ICONS.js;
  if (ext === "json") return ICONS.json;
  if (ext === "md" || ext === "mdx") return ICONS.md;
  if (ext === "css" || ext === "scss" || ext === "sass") return ICONS.css;
  if (ext === "svg") return ICONS.svg;
  if (ext === "png" || ext === "jpg" || ext === "webp" || ext === "gif") return ICONS.png;
  return "  ";
}

// ---------------------------------------------------------------------------
// Issue annotation (maps file paths to issue badges)
// ---------------------------------------------------------------------------

/**
 * Build a map: relPath → list of issue badges for that path.
 */
export function buildIssueMap(issues) {
  const map = new Map();
  for (const issue of issues) {
    const key = issue.file.replace(/\/$/, ""); // strip trailing slash
    const badge = ruleToTag(issue.rule);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(badge);
  }
  return map;
}

function ruleToTag(rule) {
  const tags = {
    "deep-nesting":      chalk.bgRed.white(" DEEP "),
    "fat-folder":        chalk.bgYellow.black(" FAT "),
    "naming-mismatch":   chalk.bgYellow.black(" NAMES "),
    "misplaced-file":    chalk.bgRed.white(" WRONG DIR "),
    "missing-barrel":    chalk.bgBlue.white(" NO INDEX "),
    "duplicate-concept": chalk.bgRed.white(" DUPLICATE "),
    "empty-dir":         chalk.bgGray.white(" EMPTY "),
    "root-chaos":        chalk.bgRed.white(" CHAOS "),
    "scattered-config":  chalk.bgYellow.black(" MISPLACED "),
  };
  return tags[rule] ?? chalk.bgGray.white(` ${rule} `);
}

// ---------------------------------------------------------------------------
// Current structure tree renderer
// ---------------------------------------------------------------------------

/**
 * Renders the annotated current project tree as a chalk-coloured string.
 */
export function renderCurrentTree(rootPath, issueMap, { maxDepth = TREE_MAX_DEPTH } = {}) {
  const lines = [];
  const rootName = path.basename(path.resolve(rootPath));

  const rootIssues = issueMap.get(".") ?? [];
  const rootBadges = rootIssues.map(ruleToTag).join(" ");

  lines.push(
    chalk.bold.white(`${ICONS.dir} ${rootName}/`) +
    (rootBadges ? "  " + rootBadges : "") +
    chalk.dim("  ← project root")
  );

  renderDirChildren(rootPath, rootPath, "", 0, maxDepth, issueMap, lines);

  return lines.join("\n");
}

function renderDirChildren(dirPath, rootPath, prefix, depth, maxDepth, issueMap, lines) {
  if (depth >= maxDepth) return;

  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return; }

  const dirs  = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

  // Show dirs then files; collapse files if too many
  const allItems = [...dirs, ...files];
  if (allItems.length === 0) {
    lines.push(prefix + LAST + chalk.dim("(empty)"));
    return;
  }

  const showFiles = files.slice(0, TREE_MAX_FILES);
  const hiddenFiles = files.length - showFiles.length;
  const visibleItems = [...dirs, ...showFiles];

  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const isLast = i === visibleItems.length - 1 && hiddenFiles === 0;
    const connector = isLast ? LAST : BRANCH;
    const childPrefix = isLast ? prefix + SPACE : prefix + PIPE;

    const relPath = path.relative(rootPath, path.join(dirPath, item.name)).replace(/\\/g, "/");
    const issues  = issueMap.get(relPath) ?? [];
    const badges  = issues.map(ruleToTag).join(" ");

    if (item.isDirectory()) {
      const subFiles = safeReaddir(path.join(dirPath, item.name));
      const fileCnt  = subFiles.filter((e) => e.isFile()).length;
      const dirCnt   = subFiles.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).length;
      const hint     = chalk.dim(`  ${fileCnt}f ${dirCnt}d`);

      lines.push(
        prefix + connector +
        chalk.cyan.bold(`${getIcon(item.name, true)} ${item.name}/`) +
        hint +
        (badges ? "  " + badges : "")
      );
      renderDirChildren(path.join(dirPath, item.name), rootPath, childPrefix, depth + 1, maxDepth, issueMap, lines);
    } else {
      const fileColour = /\.(tsx|jsx)$/.test(item.name)
        ? chalk.blue
        : /\.ts$/.test(item.name)
          ? chalk.cyan
          : /\.(json|md|mdx)$/.test(item.name)
            ? chalk.yellow
            : /\.(css|scss|sass)$/.test(item.name)
              ? chalk.magenta
              : chalk.white;

      lines.push(
        prefix + connector +
        fileColour(`${getIcon(item.name, false)} ${item.name}`) +
        (badges ? "  " + badges : "")
      );
    }
  }

  if (hiddenFiles > 0) {
    lines.push(prefix + LAST + chalk.dim(`… +${hiddenFiles} more file${hiddenFiles !== 1 ? "s" : ""}`));
  }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}

// ---------------------------------------------------------------------------
// Recommended structure generator
// ---------------------------------------------------------------------------

/**
 * Analyses the project and produces a recommended clean structure
 * tailored to what it finds (Next.js App Router, tRPC, Prisma, etc.).
 */
export function renderRecommendedStructure(rootPath, stats, issues) {
  const resolved = path.resolve(rootPath);
  const rootName = path.basename(resolved);

  // Detect what's already in the project to tailor the recommendation
  const hasApp     = fs.existsSync(path.join(resolved, "app"))    || fs.existsSync(path.join(resolved, "src", "app"));
  const hasPages   = fs.existsSync(path.join(resolved, "pages"))  || fs.existsSync(path.join(resolved, "src", "pages"));
  const hasPrisma  = fs.existsSync(path.join(resolved, "prisma"));
  const hasSrc     = fs.existsSync(path.join(resolved, "src"));
  const hasPublic  = fs.existsSync(path.join(resolved, "public"));
  const hasTests   = fs.existsSync(path.join(resolved, "__tests__")) || fs.existsSync(path.join(resolved, "tests"));
  const hasActions = fs.existsSync(path.join(resolved, "actions")) || fs.existsSync(path.join(resolved, "src", "actions"));

  const lines = [];

  const G = chalk.green;
  const C = chalk.cyan.bold;
  const D = chalk.dim;
  const Y = chalk.yellow;

  lines.push(chalk.bold.white(`${ICONS.dir} ${rootName}/`) + D("  ← recommended structure"));
  lines.push(PIPE);

  // Root-level config files (always there)
  lines.push(BRANCH + Y(`${ICONS.config_file} next.config.ts`) + D("        ← Next.js config (root only)"));
  lines.push(BRANCH + Y(`${ICONS.config_file} tsconfig.json`) + D("         ← TypeScript config"));
  lines.push(BRANCH + Y(`${ICONS.json}  package.json`) + D("           ← dependencies"));
  lines.push(BRANCH + Y(`${ICONS.md}  README.md`) + D("              ← project docs"));
  lines.push(BRANCH + Y(`${ICONS.env}  .env.local`) + D("             ← secrets (not committed)"));
  lines.push(BRANCH + Y(`${ICONS.env}  .env.example`) + D("           ← template for devs"));
  lines.push(PIPE);

  // Public dir
  if (hasPublic) {
    lines.push(BRANCH + G(`${ICONS.public} public/`));
    lines.push(PIPE + BRANCH + D("🖼️   icons/"));
    lines.push(PIPE + LAST  + D("🖼️   images/"));
    lines.push(PIPE);
  }

  // Prisma
  if (hasPrisma) {
    lines.push(BRANCH + G(`${ICONS.prisma} prisma/`));
    lines.push(PIPE + BRANCH + D(`${ICONS.prisma_file} schema.prisma    ← single source of truth`));
    lines.push(PIPE + BRANCH + D("📁  migrations/       ← auto-generated"));
    lines.push(PIPE + LAST  + D("📒  seed.ts            ← seeding script"));
    lines.push(PIPE);
  }

  const srcRoot = hasSrc ? "src" : hasApp ? "app" : "src";

  if (hasSrc) {
    lines.push(BRANCH + C(`📁 src/`) + D("                  ← all application source code here"));
    renderSrcRecommendation(lines, hasApp, hasPages, hasActions, hasTests, PIPE);
    lines.push(PIPE);
  } else if (hasApp) {
    lines.push(BRANCH + C(`${ICONS.app} app/`) + D("                  ← Next.js App Router"));
    renderAppRecommendation(lines, PIPE);
    lines.push(PIPE);
    renderLibRecommendation(lines, hasActions, "");
  } else {
    lines.push(BRANCH + C(`📁 src/`) + D("                  ← all application source code here"));
    renderSrcRecommendation(lines, false, hasPages, hasActions, hasTests, PIPE);
    lines.push(PIPE);
  }

  // Tests
  if (hasTests) {
    lines.push(BRANCH + G(`${ICONS.tests} __tests__/`) + D("            ← all tests here, mirrors src/"));
    lines.push(PIPE + LAST + D("📁  unit/  e2e/  integration/"));
    lines.push(PIPE);
  }

  lines.push(LAST + D("(no other files or folders at the root)"));

  return lines.join("\n");
}

function renderSrcRecommendation(lines, hasApp, hasPages, hasActions, hasTests, prefix) {
  const D = chalk.dim;
  const C = chalk.cyan.bold;
  const G = chalk.green;

  if (hasApp) {
    lines.push(prefix + BRANCH + C(`${ICONS.app} app/`) + D("               ← Next.js App Router routes only"));
    lines.push(prefix + PIPE + BRANCH + D("📁  (auth)/          ← route groups keep structure flat"));
    lines.push(prefix + PIPE + BRANCH + D("📁  (dashboard)/"));
    lines.push(prefix + PIPE + BRANCH + D(`${ICONS.api} api/               ← route handlers`));
    lines.push(prefix + PIPE + BRANCH + D("📄  layout.tsx        ← root layout"));
    lines.push(prefix + PIPE + LAST  + D("📄  page.tsx          ← home page"));
  } else if (hasPages) {
    lines.push(prefix + BRANCH + C(`${ICONS.pages} pages/`) + D("             ← Next.js Pages Router"));
    lines.push(prefix + PIPE + BRANCH + D(`${ICONS.api} api/`));
    lines.push(prefix + PIPE + LAST  + D("📄  _app.tsx  _document.tsx  index.tsx"));
  }

  lines.push(prefix + PIPE);
  lines.push(prefix + BRANCH + G(`🧩 components/`) + D("         ← React components, organised by concern"));
  lines.push(prefix + PIPE + BRANCH + D("📁  ui/              ← primitives: Button, Input, Modal"));
  lines.push(prefix + PIPE + BRANCH + D("📁  layout/          ← Header, Footer, Sidebar, Nav"));
  lines.push(prefix + PIPE + BRANCH + D("📁  forms/           ← form-specific components"));
  lines.push(prefix + PIPE + LAST  + D("📄  index.ts         ← barrel: export * from './ui'"));
  lines.push(prefix + PIPE);
  lines.push(prefix + BRANCH + G(`📦 lib/`) + D("               ← core integrations (db, auth, email)"));
  lines.push(prefix + PIPE + BRANCH + D("📘  db.ts            ← Prisma client singleton"));
  lines.push(prefix + PIPE + BRANCH + D("📘  auth.ts          ← NextAuth / Clerk config"));
  lines.push(prefix + PIPE + LAST  + D("📄  index.ts         ← barrel"));
  lines.push(prefix + PIPE);

  if (hasActions) {
    lines.push(prefix + BRANCH + G(`⚡ actions/`) + D("            ← Server Actions ('use server')"));
    lines.push(prefix + PIPE + BRANCH + D("📘  posts.ts"));
    lines.push(prefix + PIPE + LAST  + D("📘  users.ts"));
    lines.push(prefix + PIPE);
  }

  lines.push(prefix + BRANCH + G(`🔧 utils/`) + D("             ← pure functions, no side effects"));
  lines.push(prefix + PIPE + LAST  + D("📄  index.ts         ← barrel"));
  lines.push(prefix + PIPE);
  lines.push(prefix + BRANCH + G(`🪝 hooks/`) + D("             ← custom React hooks (use*.ts)"));
  lines.push(prefix + PIPE + LAST  + D("📄  index.ts         ← barrel"));
  lines.push(prefix + PIPE);
  lines.push(prefix + BRANCH + G(`🏷️  types/`) + D("             ← shared TypeScript types & enums"));
  lines.push(prefix + PIPE + LAST  + D("📘  index.ts"));
  lines.push(prefix + PIPE);
  lines.push(prefix + LAST  + G(`⚙️  config/`) + D("            ← app-level constants, feature flags"));
}

function renderAppRecommendation(lines, prefix) {
  const D = chalk.dim;

  lines.push(prefix + BRANCH + D("📁  (auth)/          ← route group (doesn't affect URL)"));
  lines.push(prefix + PIPE + BRANCH + D("📁  login/"));
  lines.push(prefix + PIPE + LAST  + D("📁  register/"));
  lines.push(prefix + BRANCH + D("📁  (dashboard)/"));
  lines.push(prefix + PIPE + LAST  + D("📁  settings/  profile/  ..."));
  lines.push(prefix + BRANCH + D(`${ICONS.api} api/             ← route handlers`));
  lines.push(prefix + BRANCH + D("📄  layout.tsx"));
  lines.push(prefix + LAST  + D("📄  page.tsx"));
}

function renderLibRecommendation(lines, hasActions, prefix) {
  const D = chalk.dim;
  const G = chalk.green;

  lines.push(prefix + BRANCH + G("🧩 components/"));
  lines.push(prefix + PIPE + BRANCH + D("📁  ui/  layout/  forms/"));
  lines.push(prefix + PIPE + LAST  + D("📄  index.ts"));
  lines.push(prefix + BRANCH + G("📦 lib/"));
  lines.push(prefix + BRANCH + G("🔧 utils/"));
  lines.push(prefix + BRANCH + G("🪝 hooks/"));
  lines.push(prefix + BRANCH + G("🏷️  types/"));
  if (hasActions) lines.push(prefix + BRANCH + G("⚡ actions/"));
  lines.push(prefix + LAST  + G("⚙️  config/"));
}

// ---------------------------------------------------------------------------
// Diff summary — what needs to move
// ---------------------------------------------------------------------------

/**
 * Generates a concise before/after table for the top structural changes.
 */
export function renderMigrationPlan(issues) {
  if (issues.length === 0) return "";

  const D = chalk.dim;
  const R = chalk.red;
  const G = chalk.green;
  const Y = chalk.yellow;

  const lines = [
    "",
    chalk.bold.white("  Migration Plan  ") + D("— what needs to change"),
    D("  " + "─".repeat(60)),
  ];

  const priority = [
    "root-chaos", "duplicate-concept", "misplaced-file",
    "deep-nesting", "fat-folder", "naming-mismatch",
    "missing-barrel", "scattered-config", "empty-dir",
  ];

  const grouped = {};
  for (const issue of issues) {
    (grouped[issue.rule] ??= []).push(issue);
  }

  let idx = 1;
  for (const rule of priority) {
    const ruleIssues = grouped[rule];
    if (!ruleIssues) continue;

    for (const issue of ruleIssues) {
      const action = getMigrationAction(issue);
      if (!action) continue;

      lines.push(
        `\n  ${Y(idx + ".")} ${R("✗ " + action.from)}\n` +
        `     ${G("→ " + action.to)}\n` +
        `     ${D(action.why)}`
      );
      idx++;
      if (idx > 12) { lines.push(D(`\n  … +${issues.length - 12} more — see .neat-doctor-report.json`)); break; }
    }
    if (idx > 12) break;
  }

  lines.push("");
  return lines.join("\n");
}

function getMigrationAction(issue) {
  switch (issue.rule) {
    case "root-chaos":
      return {
        from: `${issue.snippet}  (in project root)`,
        to:   "src/  (move all source files into src/)",
        why:  "Root should contain only config files, not source code",
      };
    case "duplicate-concept":
      return {
        from: issue.duplicates?.map((d) => `${issue.file}${d}/`).join("  +  ") ?? issue.file,
        to:   `${issue.file}${issue.duplicates?.[0] ?? "lib"}/  (consolidate into one)`,
        why:  "Multiple folders with the same purpose split your utilities across locations",
      };
    case "misplaced-file":
      return {
        from: issue.file,
        to:   issue.message.match(/in (.+?),/)?.[1] ?? "correct directory",
        why:  issue.message.split(" — ").pop() ?? "",
      };
    case "deep-nesting":
      return {
        from: issue.file + "  (" + issue.depth + " levels deep)",
        to:   "Flatten by 1-2 levels or add path aliases in tsconfig.json",
        why:  "Deep nesting creates long import paths like ../../../lib/utils",
      };
    case "fat-folder":
      return {
        from: `${issue.file}  (${issue.fileCount} files, no groups)`,
        to:   `${issue.file}ui/  ${issue.file}layout/  ${issue.file}forms/  (group by concern)`,
        why:  "Too many files in one directory makes it hard to find anything",
      };
    case "naming-mismatch":
      return {
        from: `Mixed naming in ${issue.file}  (${issue.styles?.join(" + ") ?? "inconsistent"})`,
        to:   "All folders → kebab-case | React components → PascalCase | utils → kebab-case",
        why:  "Inconsistent naming creates cognitive friction and import typos",
      };
    case "missing-barrel":
      return {
        from: `${issue.file}  (no index.ts)`,
        to:   `${issue.file}index.ts  → export { default as Button } from './Button'`,
        why:  "Without a barrel, imports look like: import { Button } from '@/components/Button/Button'",
      };
    case "scattered-config":
      return {
        from: issue.file,
        to:   `${path.basename(issue.file)}  (move to project root)`,
        why:  "Tooling (ESLint, Jest, etc.) looks for config at the root by default",
      };
    case "empty-dir":
      return {
        from: issue.file,
        to:   "(delete it)",
        why:  "Empty directories create noise in the file tree",
      };
    default: return null;
  }
}
