/**
 * fix.js — neat-doctor
 *
 * Turns structural issues into SAFE, REVIEWABLE migration scripts. It never
 * executes anything itself — it writes:
 *
 *   neat-doctor-fix.sh         git-mv commands for bash/zsh (macOS/Linux)
 *   neat-doctor-fix.ps1        git-mv commands for PowerShell (Windows)
 *   neat-doctor-migration.md   a human-readable, step-by-step plan
 *
 * Deterministic moves (root files → src/, nested config → root, empty dirs)
 * are emitted as real commands. Judgment calls (consolidating utils/helpers,
 * splitting fat folders) are emitted as clearly-marked TODO guidance.
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx"];
const ENTRY_AT_ROOT = /^(next|tailwind|postcss|jest|vitest|playwright|eslint|prettier|vite|drizzle)\.config\.|\.config\.[mc]?[jt]s$|^middleware\.[tj]s$|^instrumentation\.[tj]s$/;

// ---------------------------------------------------------------------------
// Build the move/guidance plan from issues + filesystem truth
// ---------------------------------------------------------------------------

function deriveRootMoves(projectRoot) {
  // Loose source files sitting directly in the root that should move to src/
  let entries;
  try { entries = fs.readdirSync(projectRoot, { withFileTypes: true }); } catch { return []; }
  const moves = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!SOURCE_EXT.some((ext) => e.name.endsWith(ext))) continue;
    if (e.name.endsWith(".d.ts")) continue;
    if (ENTRY_AT_ROOT.test(e.name)) continue;
    moves.push({ from: e.name, to: `src/${e.name}`, kind: "move" });
  }
  return moves;
}

/**
 * @returns {{ moves, removes, guidance }}
 */
export function buildPlan(projectPath, issues) {
  const projectRoot = path.resolve(projectPath);
  const moves = [];
  const removes = [];
  const guidance = [];

  const grouped = {};
  for (const i of issues) (grouped[i.rule] ??= []).push(i);

  // 1. root-chaos → move loose root source files into src/
  if (grouped["root-chaos"]) {
    moves.push(...deriveRootMoves(projectRoot));
  }

  // 2. scattered-config → move back to project root
  for (const issue of grouped["scattered-config"] ?? []) {
    moves.push({ from: issue.file, to: path.basename(issue.file), kind: "move" });
  }

  // 3. empty-dir → remove
  for (const issue of grouped["empty-dir"] ?? []) {
    removes.push(issue.file.replace(/\/$/, ""));
  }

  // 4. Judgment-call guidance
  for (const issue of grouped["duplicate-concept"] ?? []) {
    const dupes = issue.duplicates ?? [];
    const keep = dupes[0] ?? "lib";
    guidance.push({
      title: `Consolidate duplicate folders in ${issue.file}`,
      detail: `Pick ONE: keep "${keep}/", move files from ${dupes.slice(1).map((d) => `"${d}/"`).join(", ")} into it, then delete the empties. Update imports.`,
    });
  }
  for (const issue of grouped["fat-folder"] ?? []) {
    guidance.push({
      title: `Split fat folder ${issue.file} (${issue.fileCount ?? "many"} files)`,
      detail: `Create subfolders by concern (e.g. ui/, layout/, forms/), move files in, add an index.ts barrel re-exporting them.`,
    });
  }
  for (const issue of grouped["misplaced-file"] ?? []) {
    guidance.push({
      title: `Move misplaced file ${issue.file}`,
      detail: issue.message,
    });
  }
  for (const issue of grouped["missing-barrel"] ?? []) {
    guidance.push({
      title: `Add a barrel to ${issue.file}`,
      detail: `Create ${issue.file}index.ts that re-exports the public members of this folder.`,
    });
  }
  for (const issue of grouped["naming-mismatch"] ?? []) {
    guidance.push({
      title: `Standardise naming in ${issue.file}`,
      detail: `Folders → kebab-case, React components → PascalCase, utilities/hooks → kebab-case. Use 'git mv' so history is preserved; update imports.`,
    });
  }
  for (const issue of grouped["circular-dependency"] ?? []) {
    guidance.push({
      title: `Break import cycle: ${(issue.cycle ?? []).join(" ↔ ")}`,
      detail: `Extract the shared symbols into a new leaf module that all members import, removing the back-edges.`,
    });
  }
  for (const issue of grouped["god-file"] ?? []) {
    guidance.push({
      title: `Split god file ${issue.file} (${issue.snippet})`,
      detail: `Break into focused modules by responsibility; keep each under ~300 lines.`,
    });
  }
  for (const issue of grouped["deep-relative-import"] ?? []) {
    guidance.push({
      title: `Replace deep import in ${issue.file}`,
      detail: `Add tsconfig path alias '@/*': ['./src/*'] and rewrite "${issue.snippet}" to an '@/...' import.`,
    });
  }
  for (const issue of grouped["orphan-file"] ?? []) {
    guidance.push({
      title: `Verify + delete orphan ${issue.file}`,
      detail: `Imported by nothing. Confirm it's unused (search the repo), then 'git rm' it.`,
    });
  }

  // De-duplicate moves by 'from'
  const seen = new Set();
  const uniqueMoves = moves.filter((m) => (seen.has(m.from) ? false : (seen.add(m.from), true)));

  return { moves: uniqueMoves, removes: [...new Set(removes)], guidance };
}

// ---------------------------------------------------------------------------
// Script renderers
// ---------------------------------------------------------------------------

function renderBash(plan) {
  const L = [
    "#!/usr/bin/env bash",
    "# neat-doctor migration — generated by NoctisNova (https://noctisnova.com)",
    "# REVIEW EVERY LINE before running. Uses `git mv` so all moves are reversible.",
    "set -euo pipefail",
    "",
    'echo "neat-doctor migration starting…"',
    "",
  ];

  if (plan.moves.length) {
    L.push("# ── File moves ───────────────────────────────────────────────");
    const dirs = new Set(plan.moves.map((m) => path.posix.dirname(m.to)).filter((d) => d && d !== "."));
    for (const d of dirs) L.push(`mkdir -p "${d}"`);
    L.push("");
    for (const m of plan.moves) L.push(`git mv "${m.from}" "${m.to}"`);
    L.push("");
  }

  if (plan.removes.length) {
    L.push("# ── Remove empty directories ─────────────────────────────────");
    for (const d of plan.removes) L.push(`rmdir "${d}" 2>/dev/null || echo "skip (not empty): ${d}"`);
    L.push("");
  }

  if (plan.guidance.length) {
    L.push("# ── Manual steps (judgment required — not automated) ─────────");
    plan.guidance.forEach((g, i) => {
      L.push(`# ${i + 1}. ${g.title}`);
      L.push(`#    ${g.detail}`);
    });
    L.push("");
  }

  L.push('echo "Done. Now run: npx tsc --noEmit  &&  npx neat-doctor --no-ai"');
  return L.join("\n") + "\n";
}

function renderPowerShell(plan) {
  const L = [
    "# neat-doctor migration — generated by NoctisNova (https://noctisnova.com)",
    "# REVIEW EVERY LINE before running. Uses `git mv` so all moves are reversible.",
    "$ErrorActionPreference = 'Stop'",
    "",
    'Write-Host "neat-doctor migration starting…"',
    "",
  ];

  if (plan.moves.length) {
    L.push("# ── File moves ───────────────────────────────────────────────");
    const dirs = new Set(plan.moves.map((m) => path.posix.dirname(m.to)).filter((d) => d && d !== "."));
    for (const d of dirs) L.push(`New-Item -ItemType Directory -Force -Path "${d}" | Out-Null`);
    L.push("");
    for (const m of plan.moves) L.push(`git mv "${m.from}" "${m.to}"`);
    L.push("");
  }

  if (plan.removes.length) {
    L.push("# ── Remove empty directories ─────────────────────────────────");
    for (const d of plan.removes) {
      L.push(`if ((Get-ChildItem -Force "${d}" | Measure-Object).Count -eq 0) { Remove-Item "${d}" } else { Write-Host "skip (not empty): ${d}" }`);
    }
    L.push("");
  }

  if (plan.guidance.length) {
    L.push("# ── Manual steps (judgment required — not automated) ─────────");
    plan.guidance.forEach((g, i) => {
      L.push(`# ${i + 1}. ${g.title}`);
      L.push(`#    ${g.detail}`);
    });
    L.push("");
  }

  L.push('Write-Host "Done. Now run: npx tsc --noEmit ; npx neat-doctor --no-ai"');
  return L.join("\n") + "\n";
}

function renderMarkdown(plan, stats) {
  const L = [
    "# neat-doctor Migration Plan",
    "",
    "> Generated by [NoctisNova](https://noctisnova.com). Reorganise safely, one phase at a time.",
    "",
    `Project: ${stats?.totalFiles ?? "?"} files · ${stats?.totalDirs ?? "?"} dirs · max depth ${stats?.maxDepth ?? "?"}`,
    "",
    "## Automated moves",
    "",
  ];

  if (plan.moves.length) {
    L.push("| From | → | To |", "|---|---|---|");
    for (const m of plan.moves) L.push(`| \`${m.from}\` | → | \`${m.to}\` |`);
  } else {
    L.push("_No deterministic moves — everything left needs judgment (see below)._");
  }
  L.push("");

  if (plan.removes.length) {
    L.push("## Empty directories to remove", "");
    for (const d of plan.removes) L.push(`- \`${d}\``);
    L.push("");
  }

  if (plan.guidance.length) {
    L.push("## Manual steps (judgment required)", "");
    plan.guidance.forEach((g, i) => {
      L.push(`### ${i + 1}. ${g.title}`, "", g.detail, "");
    });
  }

  L.push(
    "## Verify after each phase",
    "",
    "```bash",
    "npx tsc --noEmit        # no broken imports",
    "npm run build           # build still works",
    "npx neat-doctor --no-ai # score should rise",
    "```",
    "",
    "---",
    "Built by NoctisNova · https://noctisnova.com",
  );

  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Public: write the three files
// ---------------------------------------------------------------------------

/**
 * Writes the migration scripts into the current working directory.
 * @returns {string[]} absolute paths of files written
 */
export function writeFixScripts(projectPath, issues, stats) {
  const plan = buildPlan(projectPath, issues);
  const written = [];

  const files = [
    { name: "neat-doctor-fix.sh",         content: renderBash(plan) },
    { name: "neat-doctor-fix.ps1",        content: renderPowerShell(plan) },
    { name: "neat-doctor-migration.md",   content: renderMarkdown(plan, stats) },
  ];

  for (const f of files) {
    const abs = path.resolve(f.name);
    try {
      fs.writeFileSync(abs, f.content, "utf-8");
      written.push(abs);
    } catch { /* skip unwritable */ }
  }

  return written;
}
