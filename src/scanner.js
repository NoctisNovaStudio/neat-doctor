/**
 * scanner.js — neat-doctor
 * Analyses project folder structure for organisation anti-patterns:
 * deep nesting, fat folders, naming inconsistency, misplaced files,
 * missing barrel files, scattered config, duplicate concepts, empty dirs.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Penalties
// ---------------------------------------------------------------------------

const PENALTY_DEEP_NESTING      = 4;  // per folder > MAX_DEPTH
const PENALTY_FAT_FOLDER        = 6;  // per folder with too many direct files
const PENALTY_NAMING_MISMATCH   = 5;  // per directory with mixed naming styles
const PENALTY_MISPLACED_FILE    = 4;  // per file in clearly wrong location
const PENALTY_MISSING_BARREL    = 3;  // per folder that should have index.ts
const PENALTY_DUPLICATE_CONCEPT = 8;  // per group of synonymous folder names
const PENALTY_EMPTY_DIR         = 2;  // per genuinely empty directory
const PENALTY_ROOT_CHAOS        = 6;  // if root has too many loose files
const PENALTY_SCATTERED_CONFIG  = 3;  // per misplaced config file

const MAX_DEPTH         = 5;   // deeper than this = flag
const FAT_FOLDER_LIMIT  = 18;  // more than this many files in one dir = flag
const ROOT_FILE_LIMIT   = 10;  // more than this many files in root = flag
const BARREL_MIN_FILES  = 3;   // if a dir has 3+ exports, it should have a barrel

const REPORT_FILE = "./.neat-doctor-report.json";

// ---------------------------------------------------------------------------
// Directories to skip entirely
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "out", ".turbo",
  "coverage", ".nyc_output", "storybook-static", ".cache",
  "__generated__", ".vercel", ".husky",
]);

// ---------------------------------------------------------------------------
// Naming style detection
// ---------------------------------------------------------------------------

const STYLES = {
  kebab:   /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,         // my-component
  camel:   /^[a-z][a-zA-Z0-9]*$/,                     // myComponent
  pascal:  /^[A-Z][a-zA-Z0-9]*$/,                     // MyComponent
  snake:   /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,           // my_component
  upper:   /^[A-Z][A-Z0-9_]*$/,                        // MY_CONSTANT
  dotted:  /^\.[a-z]/,                                 // .env, .gitignore
  special: /^[\[(]/,                                   // [param], (group)
};

function detectStyle(name) {
  const base = name.replace(/\.[^.]+$/, "").replace(/\.[^.]+$/, ""); // strip ext(s)
  if (STYLES.special.test(name)) return "special";
  if (STYLES.dotted.test(name))  return "dotted";
  if (STYLES.upper.test(base))   return "upper";
  if (STYLES.pascal.test(base))  return "pascal";
  if (STYLES.kebab.test(base))   return "kebab";
  if (STYLES.snake.test(base))   return "snake";
  if (STYLES.camel.test(base))   return "camel";
  return "mixed";
}

// ---------------------------------------------------------------------------
// Duplicate concept groups (folder names that mean the same thing)
// ---------------------------------------------------------------------------

const DUPLICATE_CONCEPT_GROUPS = [
  new Set(["utils", "helpers", "lib", "shared", "common", "core"]),
  new Set(["types", "interfaces", "models", "schemas"]),
  new Set(["hooks", "composables", "custom-hooks"]),
  new Set(["services", "api", "queries", "fetchers", "requests"]),
  new Set(["styles", "css", "scss", "sass", "theme"]),
  new Set(["constants", "config", "settings", "configuration"]),
  new Set(["store", "stores", "state", "zustand", "redux", "context"]),
  new Set(["tests", "test", "__tests__", "spec", "specs", "e2e"]),
];

// ---------------------------------------------------------------------------
// File placement rules: { pattern, should NOT be in, reason }
// ---------------------------------------------------------------------------

const MISPLACEMENT_RULES = [
  {
    filePattern: /\.(tsx|jsx)$/,
    badDirPattern: /\/(utils|helpers|lib|hooks|services)\//i,
    mustBeDirPattern: /\/(components|pages|app|views|screens|layouts)\//i,
    reason: "React component files (.tsx/.jsx) should live in components/, not in utils/ or lib/",
  },
  {
    filePattern: /\.(test|spec)\.(ts|tsx|js|jsx)$/,
    badDirPattern: /^\/(src|app|components|pages)\//,
    mustBeDirPattern: /\/(__tests__|tests?|spec)\//i,
    reason: "Test files should be in a dedicated tests/ or __tests__/ directory, not mixed with source files",
  },
  {
    filePattern: /\.(config|rc)\.(ts|js|mjs|cjs)$|^(jest|vitest|playwright|eslint|prettier|tailwind|postcss|next)\.config/,
    badDirPattern: /\/(src|components|lib|utils)\//,
    mustBeDirPattern: /^[^/]*\//,  // should be at or near root
    reason: "Config files (.config.ts, .rc) should be at the project root, not nested inside src/",
  },
  {
    filePattern: /\.prisma$|schema\.prisma$/,
    badDirPattern: /\/(src|app|components)\//,
    mustBeDirPattern: /\/(prisma)\//i,
    reason: "Prisma schema files should live in prisma/, not in src/",
  },
];

// ---------------------------------------------------------------------------
// Folders that should have barrel files (index.ts) but don't
// ---------------------------------------------------------------------------

const BARREL_CANDIDATE_DIRS = new Set([
  "components", "hooks", "utils", "lib", "services",
  "helpers", "providers", "contexts", "stores", "actions",
]);

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

/**
 * Recursively builds a directory tree up to MAX_SCAN_DEPTH.
 * Each node: { name, path, isDir, children, depth, fileCount }
 */
const MAX_SCAN_DEPTH = 8;

export function buildTree(rootPath, depth = 0) {
  const node = {
    name:      path.basename(rootPath),
    absPath:   rootPath,
    relPath:   "",
    isDir:     true,
    children:  [],
    depth,
    fileCount: 0,
    dirCount:  0,
  };

  if (depth > MAX_SCAN_DEPTH) return node;

  let entries;
  try { entries = fs.readdirSync(rootPath, { withFileTypes: true }); }
  catch { return node; }

  // Sort: dirs first, then files, alphabetically within each group
  const dirs  = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

  node.fileCount = files.length;
  node.dirCount  = dirs.length;

  for (const dir of dirs) {
    const child = buildTree(path.join(rootPath, dir.name), depth + 1);
    node.children.push(child);
  }

  for (const file of files) {
    node.children.push({
      name:    file.name,
      absPath: path.join(rootPath, file.name),
      relPath: "",
      isDir:   false,
      depth,
    });
  }

  return node;
}

/** Assign relative paths after tree is built */
export function annotateRelPaths(node, rootPath) {
  node.relPath = path.relative(rootPath, node.absPath).replace(/\\/g, "/") || ".";
  for (const child of node.children ?? []) annotateRelPaths(child, rootPath);
}

/** Flatten tree to a list of all nodes */
export function flattenTree(node) {
  const list = [node];
  for (const child of node.children ?? []) {
    list.push(...flattenTree(child));
  }
  return list;
}

// ---------------------------------------------------------------------------
// Collect all direct children stats per directory
// ---------------------------------------------------------------------------

function collectDirStats(rootPath) {
  const stats = new Map(); // absPath → { files: [], dirs: [], totalFiles }

  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    const s = { files: [], dirs: [], depth };
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) {
          s.dirs.push({ name: e.name, absPath: full });
          walk(full, depth + 1);
        }
      } else {
        s.files.push({ name: e.name, absPath: full });
      }
    }
    stats.set(dir, s);
  }

  walk(path.resolve(rootPath), 0);
  return stats;
}

// ---------------------------------------------------------------------------
// Rule 1 — Deep Nesting
// ---------------------------------------------------------------------------

export async function scanDeepNesting(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const dirStats = collectDirStats(resolved);

  for (const [absPath, { depth }] of dirStats) {
    if (depth <= MAX_DEPTH) continue;
    const relPath = path.relative(resolved, absPath).replace(/\\/g, "/");

    issues.push({
      type: "Deep Nesting",
      rule: "deep-nesting",
      severity: "warning",
      file: relPath,
      line: 1,
      snippet: relPath,
      message:
        `Folder is ${depth} levels deep (limit: ${MAX_DEPTH}). ` +
        "Deep nesting forces long import paths like ../../../../lib/utils — " +
        "flatten the structure or use path aliases.",
      docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
      penalty: PENALTY_DEEP_NESTING,
      depth,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 2 — Fat Folders (too many direct files)
// ---------------------------------------------------------------------------

export async function scanFatFolders(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const dirStats = collectDirStats(resolved);

  for (const [absPath, { files, depth }] of dirStats) {
    if (files.length <= FAT_FOLDER_LIMIT) continue;
    if (depth === 0 && files.length <= ROOT_FILE_LIMIT * 2) continue; // root is looser

    const relPath = path.relative(resolved, absPath).replace(/\\/g, "/") || ".";

    issues.push({
      type: "Fat Folder",
      rule: "fat-folder",
      severity: "warning",
      file: relPath + "/",
      line: 1,
      snippet: `${files.length} files in one directory`,
      message:
        `\`${relPath || "."}\` contains ${files.length} files with no sub-grouping. ` +
        "Group related files into subdirectories (e.g. components/forms/, components/layout/, components/ui/).",
      docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
      penalty: PENALTY_FAT_FOLDER,
      fileCount: files.length,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 3 — Naming Inconsistency
// ---------------------------------------------------------------------------

export async function scanNamingInconsistency(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const dirStats = collectDirStats(resolved);

  for (const [absPath, { dirs, files }] of dirStats) {
    const relPath = path.relative(resolved, absPath).replace(/\\/g, "/") || ".";

    // Check folder naming inside this directory
    const folderStyles = dirs
      .filter((d) => !SKIP_DIRS.has(d.name))
      .map((d) => ({ name: d.name, style: detectStyle(d.name) }))
      .filter((d) => !["special", "dotted", "upper"].includes(d.style));

    const uniqueFolderStyles = new Set(folderStyles.map((d) => d.style));
    uniqueFolderStyles.delete("special");
    uniqueFolderStyles.delete("dotted");

    if (uniqueFolderStyles.size > 1 && folderStyles.length >= 3) {
      const styleMap = {};
      for (const { name, style } of folderStyles) {
        (styleMap[style] ??= []).push(name);
      }
      const summary = Object.entries(styleMap)
        .map(([style, names]) => `${style}: ${names.slice(0, 3).join(", ")}`)
        .join("  |  ");

      issues.push({
        type: "Naming Inconsistency",
        rule: "naming-mismatch",
        severity: "info",
        file: relPath + "/",
        line: 1,
        snippet: summary,
        message:
          `Subfolders in \`${relPath || "."}\` use mixed naming styles: ${[...uniqueFolderStyles].join(" and ")}. ` +
          "Pick one convention (prefer kebab-case for folders) and rename everything to match.",
        docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
        penalty: PENALTY_NAMING_MISMATCH,
        styles: [...uniqueFolderStyles],
      });
    }

    // Check source file naming (components should be PascalCase, utils/hooks kebab-case)
    const sourceFiles = files.filter((f) => /\.[tj]sx?$/.test(f.name));
    if (sourceFiles.length < 3) continue;

    const fileStyles = sourceFiles
      .map((f) => ({ name: f.name, style: detectStyle(f.name) }))
      .filter((f) => !["special", "dotted"].includes(f.style));

    const uniqueFileStyles = new Set(fileStyles.map((f) => f.style));
    uniqueFileStyles.delete("special");
    uniqueFileStyles.delete("dotted");

    // Only flag if it's a mix of pascal and kebab/camel (very obviously wrong)
    if (uniqueFileStyles.has("pascal") && (uniqueFileStyles.has("kebab") || uniqueFileStyles.has("camel"))) {
      const pascalFiles = fileStyles.filter((f) => f.style === "pascal").map((f) => f.name).slice(0, 2);
      const kebabFiles  = fileStyles.filter((f) => f.style !== "pascal").map((f) => f.name).slice(0, 2);

      issues.push({
        type: "Naming Inconsistency",
        rule: "naming-mismatch",
        severity: "info",
        file: relPath + "/",
        line: 1,
        snippet: `PascalCase: ${pascalFiles.join(", ")}  |  other: ${kebabFiles.join(", ")}`,
        message:
          `Source files in \`${relPath || "."}\` mix PascalCase and kebab/camelCase. ` +
          "Use PascalCase for React components (Button.tsx), kebab-case for utilities (format-date.ts).",
        docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
        penalty: PENALTY_NAMING_MISMATCH,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 4 — Misplaced Files
// ---------------------------------------------------------------------------

export async function scanMisplacedFiles(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = path.relative(resolved, full).replace(/\\/g, "/");
      const normRel = "/" + relPath + "/";

      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else {
        for (const rule of MISPLACEMENT_RULES) {
          if (!rule.filePattern.test(e.name)) continue;
          if (!rule.badDirPattern.test(normRel)) continue;

          issues.push({
            type: "Misplaced File",
            rule: "misplaced-file",
            severity: "warning",
            file: relPath,
            line: 1,
            snippet: e.name,
            message: rule.reason,
            docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
            penalty: PENALTY_MISPLACED_FILE,
          });
          break;
        }
      }
    }
  }

  walk(resolved);
  return issues;
}

// ---------------------------------------------------------------------------
// Rule 5 — Missing Barrel Files
// ---------------------------------------------------------------------------

export async function scanMissingBarrels(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const dirStats = collectDirStats(resolved);

  for (const [absPath, { dirs, files }] of dirStats) {
    const dirName = path.basename(absPath).toLowerCase();
    if (!BARREL_CANDIDATE_DIRS.has(dirName)) continue;

    // Check if index.ts/index.tsx/index.js exists
    const hasBarrel = files.some((f) => /^index\.[tj]sx?$/.test(f.name));
    if (hasBarrel) continue;

    // Only flag if there are enough source files to warrant a barrel
    const sourceFiles = files.filter((f) => /\.[tj]sx?$/.test(f.name));
    if (sourceFiles.length < BARREL_MIN_FILES) continue;

    const relPath = path.relative(resolved, absPath).replace(/\\/g, "/");

    issues.push({
      type: "Missing Barrel",
      rule: "missing-barrel",
      severity: "info",
      file: relPath + "/",
      line: 1,
      snippet: `${sourceFiles.length} files, no index.ts`,
      message:
        `\`${relPath}\` has ${sourceFiles.length} source files but no \`index.ts\` barrel. ` +
        "A barrel file lets consumers import from '@/components' instead of '@/components/Button/Button' " +
        "— cleaner imports, single place to manage the public API.",
      docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
      penalty: PENALTY_MISSING_BARREL,
      sourceFileCount: sourceFiles.length,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 6 — Duplicate Concept Folders (utils AND helpers AND lib at same level)
// ---------------------------------------------------------------------------

export async function scanDuplicateConcepts(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const dirStats = collectDirStats(resolved);

  for (const [absPath, { dirs }] of dirStats) {
    const relPath = path.relative(resolved, absPath).replace(/\\/g, "/") || ".";
    const dirNames = dirs.map((d) => d.name.toLowerCase());

    for (const conceptGroup of DUPLICATE_CONCEPT_GROUPS) {
      const found = dirNames.filter((n) => conceptGroup.has(n));
      if (found.length < 2) continue;

      issues.push({
        type: "Duplicate Concept",
        rule: "duplicate-concept",
        severity: "warning",
        file: relPath + "/",
        line: 1,
        snippet: found.join(", "),
        message:
          `\`${relPath || "."}\` has multiple folders for the same concept: ${found.map((n) => `\`${n}/\``).join(", ")}. ` +
          "Consolidate into one canonical name — pick the most specific and move everything there.",
        docs: "https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis",
        penalty: PENALTY_DUPLICATE_CONCEPT,
        duplicates: found,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 7 — Empty Directories
// ---------------------------------------------------------------------------

export async function scanEmptyDirectories(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);
  const dirStats = collectDirStats(resolved);

  for (const [absPath, { dirs, files }] of dirStats) {
    if (dirs.length > 0 || files.length > 0) continue;

    const relPath = path.relative(resolved, absPath).replace(/\\/g, "/");
    if (!relPath) continue;

    issues.push({
      type: "Empty Directory",
      rule: "empty-dir",
      severity: "info",
      file: relPath + "/",
      line: 1,
      snippet: "(empty)",
      message:
        `\`${relPath}\` is completely empty. Remove it — empty folders create noise in the file tree.`,
      docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
      penalty: PENALTY_EMPTY_DIR,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 8 — Root Chaos (too many files directly in root)
// ---------------------------------------------------------------------------

export async function scanRootChaos(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);

  let entries;
  try { entries = fs.readdirSync(resolved, { withFileTypes: true }); }
  catch { return issues; }

  // Count non-dotfile, non-config, non-standard source files sitting at the root
  const rootSourceFiles = entries
    .filter((e) => e.isFile())
    .filter((e) => /\.[tj]sx?$/.test(e.name))
    .filter((e) => !/^(index|app|main|server|entry)\.[tj]sx?$/.test(e.name));

  // Count all root files (including configs, docs, etc.)
  const allRootFiles = entries.filter((e) => e.isFile());

  if (rootSourceFiles.length > 3) {
    issues.push({
      type: "Root Chaos",
      rule: "root-chaos",
      severity: "warning",
      file: ".",
      line: 1,
      snippet: rootSourceFiles.map((f) => f.name).slice(0, 5).join(", "),
      message:
        `${rootSourceFiles.length} source files sitting directly in the project root. ` +
        "Move them into a src/ or app/ directory — the root should contain only config files " +
        "(package.json, tsconfig.json, next.config.ts, README.md) and nothing else.",
      docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
      penalty: PENALTY_ROOT_CHAOS,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Rule 9 — Scattered Config Files
// ---------------------------------------------------------------------------

export async function scanScatteredConfig(projectPath) {
  const issues = [];
  const resolved = path.resolve(projectPath);

  const CONFIG_PATTERN = /\.(config|rc)\.(ts|js|mjs|cjs|json)$|^\.eslintrc|^\.prettierrc|^jest\.config|^vitest\.config/;

  function walk(dir, depth) {
    if (depth === 0) return; // root is fine
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (CONFIG_PATTERN.test(e.name)) {
        const relPath = path.relative(resolved, full).replace(/\\/g, "/");
        issues.push({
          type: "Scattered Config",
          rule: "scattered-config",
          severity: "info",
          file: relPath,
          line: 1,
          snippet: e.name,
          message:
            `Config file \`${e.name}\` is nested ${depth} level${depth !== 1 ? "s" : ""} deep (${relPath}). ` +
            "Config files should live at the project root where tooling expects them.",
          docs: "https://noctisnova.com/tools/neat-doctor/project-structure-guide",
          penalty: PENALTY_SCATTERED_CONFIG,
        });
      }
    }
  }

  walk(resolved, 0);
  return issues;
}

// ---------------------------------------------------------------------------
// Project stats
// ---------------------------------------------------------------------------

export function computeStats(projectPath) {
  const resolved = path.resolve(projectPath);
  let totalFiles = 0, totalDirs = 0, maxDepth = 0, totalKb = 0;

  function walk(dir, depth) {
    maxDepth = Math.max(maxDepth, depth);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) { totalDirs++; walk(full, depth + 1); }
      } else {
        totalFiles++;
        try { totalKb += Math.round(fs.statSync(full).size / 1024); } catch { /**/ }
      }
    }
  }

  walk(resolved, 0);
  return { totalFiles, totalDirs, maxDepth, totalKb };
}

// ---------------------------------------------------------------------------
// Framework / project detection
// ---------------------------------------------------------------------------

/**
 * Inspects package.json + filesystem to identify the project's stack.
 * Used to tailor the recommended structure and the report header.
 */
export function detectFramework(projectPath) {
  const root = path.resolve(projectPath);
  const has = (rel) => fs.existsSync(path.join(root, rel));

  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")); } catch { /* */ }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  // Package manager from lockfile
  let pm = "npm";
  if (has("pnpm-lock.yaml")) pm = "pnpm";
  else if (has("yarn.lock")) pm = "yarn";
  else if (has("bun.lockb")) pm = "bun";

  // Router style
  const appRouter   = has("app") || has("src/app");
  const pagesRouter = has("pages") || has("src/pages");

  // Monorepo signals
  const isMonorepo = Boolean(
    pkg.workspaces ||
    has("pnpm-workspace.yaml") ||
    has("turbo.json") ||
    has("lerna.json") ||
    has("nx.json")
  );

  const labels = [];
  if (deps.next)              labels.push(`Next.js${verOf(deps.next)}`);
  else if (deps.react)        labels.push(`React${verOf(deps.react)}`);
  if (deps.typescript || has("tsconfig.json")) labels.push("TypeScript");
  if (appRouter)              labels.push("App Router");
  else if (pagesRouter)       labels.push("Pages Router");
  if (deps["@prisma/client"] || deps.prisma || has("prisma")) labels.push("Prisma");
  if (deps["drizzle-orm"])    labels.push("Drizzle");
  if (deps["@trpc/server"])   labels.push("tRPC");
  if (deps.tailwindcss)       labels.push("Tailwind");
  if (deps["next-auth"])      labels.push("NextAuth");
  if (deps["@clerk/nextjs"])  labels.push("Clerk");
  if (isMonorepo)             labels.push("Monorepo");

  return {
    name: pkg.name ?? path.basename(root),
    labels,
    pm,
    appRouter,
    pagesRouter,
    isMonorepo,
    hasSrc: has("src"),
    hasPrisma: has("prisma") || Boolean(deps.prisma) || Boolean(deps["@prisma/client"]),
    hasTests: has("__tests__") || has("tests") || has("test"),
  };
}

function verOf(range) {
  const m = String(range).match(/(\d+)/);
  return m ? ` ${m[1]}` : "";
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runAllScans({ projectPath }) {
  const [
    deepNestingIssues,
    fatFolderIssues,
    namingIssues,
    misplacedIssues,
    barrelIssues,
    duplicateIssues,
    emptyDirIssues,
    rootChaosIssues,
    scatteredCfgIssues,
  ] = await Promise.all([
    scanDeepNesting(projectPath),
    scanFatFolders(projectPath),
    scanNamingInconsistency(projectPath),
    scanMisplacedFiles(projectPath),
    scanMissingBarrels(projectPath),
    scanDuplicateConcepts(projectPath),
    scanEmptyDirectories(projectPath),
    scanRootChaos(projectPath),
    scanScatteredConfig(projectPath),
  ]);

  const issues = [
    ...rootChaosIssues,
    ...duplicateIssues,
    ...deepNestingIssues,
    ...fatFolderIssues,
    ...misplacedIssues,
    ...namingIssues,
    ...barrelIssues,
    ...scatteredCfgIssues,
    ...emptyDirIssues,
  ];

  const totalPenalty = issues.reduce((s, i) => s + i.penalty, 0);
  const score = Math.max(0, 100 - totalPenalty);
  const stats = computeStats(projectPath);

  const report = {
    generatedAt: new Date().toISOString(),
    projectPath: path.resolve(projectPath),
    score,
    totalPenalty,
    issueCount: issues.length,
    stats,
    issues,
  };

  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf-8");
  } catch { /* non-fatal */ }

  return { issues, totalPenalty, score, stats };
}
