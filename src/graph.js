/**
 * graph.js — neat-doctor
 *
 * The advanced engine. Builds a real import-dependency graph of the project
 * (resolving relative imports, tsconfig path aliases, and baseUrl), then runs
 * graph-theoretic analyses that filesystem scanning alone can never find:
 *
 *   • circular-dependency   — Tarjan SCCs of size > 1 (true import cycles)
 *   • orphan-file           — exports something, imported by nothing, not an entry point
 *   • god-file              — too many lines or too many imports (low cohesion)
 *   • deep-relative-import  — import specifiers with 3+ "../" segments
 *
 * No third-party parser — fast, tolerant regex extraction + disk-truth resolution.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Penalties + thresholds
// ---------------------------------------------------------------------------

const PENALTY_CIRCULAR      = 10; // per cyclic group (capped)
const PENALTY_ORPHAN        = 5;  // per orphaned source file
const PENALTY_GOD_FILE      = 5;  // per oversized/over-coupled file
const PENALTY_DEEP_IMPORT   = 2;  // per file with deep ../../../ imports

const GOD_FILE_LOC          = 400; // lines of code
const GOD_FILE_IMPORTS      = 30;  // distinct imports
const DEEP_IMPORT_SEGMENTS  = 3;   // number of ../ to flag
const MAX_CYCLES_REPORTED   = 12;

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "out", ".turbo",
  "coverage", ".nyc_output", "storybook-static", ".cache",
  "__generated__", ".vercel", ".husky",
]);

const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];

// All graph keys live in a single normalised (forward-slash) path space so that
// alias/baseUrl resolution works identically on Windows and POSIX.
const norm = (p) => p.replace(/\\/g, "/");

// Files that are entry points — never flagged as orphans even with no importers.
const ENTRY_BASENAMES = new Set([
  "page", "layout", "loading", "error", "not-found", "template",
  "default", "global-error", "route", "middleware", "instrumentation",
  "sitemap", "robots", "manifest", "opengraph-image", "icon", "apple-icon",
  "_app", "_document", "index",
]);

const ENTRY_PATH_HINTS = [/\/app\//, /\/pages\//, /(^|\/)scripts\//];
const CONFIG_FILE_RE = /\.config\.[mc]?[jt]s$|(^|\/)(next|tailwind|postcss|jest|vitest|playwright|eslint|prettier|vite|drizzle)\.config\./;
const TEST_FILE_RE   = /\.(test|spec|stories|story)\.[tj]sx?$/;

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

export function collectSourceFiles(rootPath) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (SOURCE_EXT.some((ext) => e.name.endsWith(ext)) && !e.name.endsWith(".d.ts")) {
        out.push(norm(full));
      }
    }
  }
  walk(path.resolve(rootPath));
  return out;
}

// ---------------------------------------------------------------------------
// tsconfig alias loading (tolerant of comments + trailing commas)
// ---------------------------------------------------------------------------

function parseJsonc(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine  = noBlock.replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // keep http:// in strings mostly
  const noTrail = noLine.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrail);
}

/**
 * Loads { baseUrl(abs), paths:[{ prefix, suffix, targets:[absTemplate] }] }
 * from tsconfig.json / jsconfig.json. Returns null-ish defaults if absent.
 */
function loadAliases(projectRoot) {
  const candidates = ["tsconfig.json", "jsconfig.json"];
  for (const name of candidates) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      const cfg = parseJsonc(fs.readFileSync(file, "utf-8"));
      const co = cfg.compilerOptions ?? {};
      const baseUrl = norm(path.resolve(projectRoot, co.baseUrl ?? "."));
      const paths = [];
      for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
        const star = pattern.indexOf("*");
        const prefix = star === -1 ? pattern : pattern.slice(0, star);
        const suffix = star === -1 ? "" : pattern.slice(star + 1);
        const absTargets = (targets ?? []).map((t) =>
          norm(path.resolve(baseUrl, t.replace("*", "\u0000")))
        );
        paths.push({ prefix, suffix, hasStar: star !== -1, targets: absTargets });
      }
      return { baseUrl, paths, configFile: name };
    } catch { /* fall through */ }
  }
  return { baseUrl: path.resolve(projectRoot), paths: [], configFile: null };
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * Returns an array of { spec, deep } for every import/require/dynamic-import.
 * `deep` is the count of leading "../" segments.
 */
export function extractImports(source) {
  const clean = stripComments(source);
  const specs = new Set();

  const patterns = [
    /(?:import|export)\s[^'"`]*?\sfrom\s*['"`]([^'"`]+)['"`]/g, // import/export ... from '...'
    /import\s*['"`]([^'"`]+)['"`]/g,                              // side-effect import '...'
    /(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,        // dynamic import() / require()
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(clean)) !== null) specs.add(m[1]);
  }

  return [...specs].map((spec) => {
    const deepMatch = spec.match(/^(?:\.\.\/)+/);
    const deep = deepMatch ? (deepMatch[0].match(/\.\.\//g) || []).length : 0;
    return { spec, deep };
  });
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function tryResolveFile(candidateNoExt, fileSet) {
  const base = norm(candidateNoExt);
  // exact (already has extension)
  if (fileSet.has(base)) return base;
  for (const ext of RESOLVE_EXT) {
    const withExt = base + ext;
    if (fileSet.has(withExt)) return withExt;
  }
  for (const ext of RESOLVE_EXT) {
    const asIndex = base + "/index" + ext;
    if (fileSet.has(asIndex)) return asIndex;
  }
  return null;
}

/**
 * Resolves an import specifier to an absolute file path inside the project,
 * or null if it's external / unresolvable.
 */
function resolveImport(spec, fromFile, aliases, fileSet) {
  // 1. relative
  if (spec.startsWith(".")) {
    const candidate = path.resolve(path.dirname(fromFile), spec);
    return tryResolveFile(candidate, fileSet);
  }

  // 2. alias paths
  for (const a of aliases.paths) {
    if (a.hasStar) {
      if (spec.startsWith(a.prefix) && spec.endsWith(a.suffix)) {
        const middle = spec.slice(a.prefix.length, spec.length - a.suffix.length || undefined);
        for (const target of a.targets) {
          const candidate = target.replace("\u0000", middle);
          const hit = tryResolveFile(candidate, fileSet);
          if (hit) return hit;
        }
      }
    } else if (spec === a.prefix) {
      for (const target of a.targets) {
        const hit = tryResolveFile(target, fileSet);
        if (hit) return hit;
      }
    }
  }

  // 3. baseUrl-relative (non-relative, non-aliased) — e.g. "components/Button"
  if (aliases.baseUrl) {
    const candidate = path.resolve(aliases.baseUrl, spec);
    const hit = tryResolveFile(candidate, fileSet);
    if (hit) return hit;
  }

  // 4. external package — ignore
  return null;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Builds the full import graph.
 * Node: { abs, rel, loc, exportsSomething, imports:Set<abs>, importedBy:Set<abs>, deepImports:[{spec,deep}] }
 */
export function buildImportGraph(projectPath) {
  const projectRoot = path.resolve(projectPath);
  const aliases = loadAliases(projectRoot);
  const files = collectSourceFiles(projectRoot);
  const fileSet = new Set(files);

  const nodes = new Map();

  // Initialise nodes
  for (const abs of files) {
    let source = "";
    try { source = fs.readFileSync(abs, "utf-8"); } catch { /* */ }
    const loc = source.length ? source.split("\n").length : 0;
    const exportsSomething = /(^|\n|;)\s*export\b/.test(source);
    nodes.set(abs, {
      abs,
      rel: path.relative(projectRoot, abs).replace(/\\/g, "/"),
      loc,
      exportsSomething,
      _source: source,
      imports: new Set(),
      importedBy: new Set(),
      deepImports: [],
    });
  }

  // Build edges
  let edgeCount = 0;
  for (const node of nodes.values()) {
    const imports = extractImports(node._source);
    for (const { spec, deep } of imports) {
      if (deep >= DEEP_IMPORT_SEGMENTS) node.deepImports.push({ spec, deep });
      const target = resolveImport(spec, node.abs, aliases, fileSet);
      if (target && target !== node.abs && nodes.has(target)) {
        node.imports.add(target);
        nodes.get(target).importedBy.add(node.abs);
        edgeCount++;
      }
    }
    node.importCount = node.imports.size;
    delete node._source; // free memory
  }

  return { projectRoot, nodes, aliases, edgeCount, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// Tarjan strongly-connected components (iterative — safe on large graphs)
// ---------------------------------------------------------------------------

function tarjanSCCs(nodes) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  const ids = [...nodes.keys()];

  for (const start of ids) {
    if (indices.has(start)) continue;

    // iterative DFS
    const callStack = [{ v: start, neighbors: [...nodes.get(start).imports], i: 0 }];
    indices.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      const { v } = frame;

      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++];
        if (!nodes.has(w)) continue;
        if (!indices.has(w)) {
          indices.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          callStack.push({ v: w, neighbors: [...nodes.get(w).imports], i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), indices.get(w)));
        }
      } else {
        if (low.get(v) === indices.get(v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          if (comp.length > 1) sccs.push(comp);
        }
        callStack.pop();
        if (callStack.length) {
          const parent = callStack[callStack.length - 1].v;
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
      }
    }
  }

  return sccs;
}

// ---------------------------------------------------------------------------
// Rule: circular dependencies
// ---------------------------------------------------------------------------

export function findCircularDependencies(graph) {
  const issues = [];
  const sccs = tarjanSCCs(graph.nodes);

  // Self-loops (file importing itself) — rare but real
  for (const node of graph.nodes.values()) {
    if (node.imports.has(node.abs)) {
      issues.push(makeCycleIssue([node.rel], node.rel));
    }
  }

  const sorted = sccs.sort((a, b) => a.length - b.length); // tightest cycles first
  for (const comp of sorted.slice(0, MAX_CYCLES_REPORTED)) {
    const rels = comp.map((abs) => graph.nodes.get(abs).rel).sort();
    issues.push(makeCycleIssue(rels, rels[0]));
  }

  return issues;
}

function makeCycleIssue(rels, file) {
  const chain = rels.length > 4 ? rels.slice(0, 4).concat(`+${rels.length - 4} more`) : rels;
  return {
    type: "Circular Dependency",
    rule: "circular-dependency",
    severity: "critical",
    file,
    line: 1,
    snippet: chain.join(" → ") + " → " + chain[0],
    message:
      `Import cycle between ${rels.length} file${rels.length !== 1 ? "s" : ""}: ${chain.join(" ↔ ")}. ` +
      "Circular imports cause undefined-at-runtime bugs, break tree-shaking, and can crash with " +
      "'Cannot access X before initialization'. Extract the shared piece into a third module both can import.",
    docs: "https://noctisnova.com/docs/structure/circular-dependencies",
    penalty: PENALTY_CIRCULAR,
    cycle: rels,
  };
}

// ---------------------------------------------------------------------------
// Rule: orphan files
// ---------------------------------------------------------------------------

function isEntryPoint(rel) {
  const base = path.basename(rel).replace(/\.[tj]sx?$/, "").replace(/\.d$/, "");
  if (ENTRY_BASENAMES.has(base)) return true;
  if (CONFIG_FILE_RE.test(rel)) return true;
  if (TEST_FILE_RE.test(rel)) return true;
  if (ENTRY_PATH_HINTS.some((re) => re.test("/" + rel))) return true;
  return false;
}

export function findOrphanFiles(graph) {
  const issues = [];
  for (const node of graph.nodes.values()) {
    if (node.importedBy.size > 0) continue;     // someone imports it
    if (!node.exportsSomething) continue;        // nothing to consume → not an orphan export
    if (isEntryPoint(node.rel)) continue;        // route/config/test/entry

    issues.push({
      type: "Orphan File",
      rule: "orphan-file",
      severity: "warning",
      file: node.rel,
      line: 1,
      snippet: `${node.loc} lines, 0 importers`,
      message:
        `\`${node.rel}\` exports code but is imported by nothing and isn't an entry point. ` +
        "It's almost certainly dead — left behind by a refactor. Confirm it's unused, then delete it.",
      docs: "https://noctisnova.com/docs/structure/orphan-files",
      penalty: PENALTY_ORPHAN,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule: god files
// ---------------------------------------------------------------------------

export function findGodFiles(graph) {
  const issues = [];
  for (const node of graph.nodes.values()) {
    const tooLong   = node.loc >= GOD_FILE_LOC;
    const tooCoupled = node.importCount >= GOD_FILE_IMPORTS;
    if (!tooLong && !tooCoupled) continue;

    const reasons = [];
    if (tooLong)    reasons.push(`${node.loc} lines`);
    if (tooCoupled) reasons.push(`${node.importCount} imports`);

    issues.push({
      type: "God File",
      rule: "god-file",
      severity: "warning",
      file: node.rel,
      line: 1,
      snippet: reasons.join(", "),
      message:
        `\`${node.rel}\` is doing too much (${reasons.join(", ")}). ` +
        "Large, highly-coupled files are hard to test, review, and reuse. Split it into focused " +
        "modules grouped by responsibility.",
      docs: "https://noctisnova.com/docs/structure/god-files",
      penalty: PENALTY_GOD_FILE,
      loc: node.loc,
      importCount: node.importCount,
    });
  }
  // Worst offenders first
  return issues.sort((a, b) => (b.loc + b.importCount * 10) - (a.loc + a.importCount * 10));
}

// ---------------------------------------------------------------------------
// Rule: deep relative imports
// ---------------------------------------------------------------------------

export function findDeepRelativeImports(graph) {
  const issues = [];
  for (const node of graph.nodes.values()) {
    if (node.deepImports.length === 0) continue;
    const worst = node.deepImports.reduce((a, b) => (b.deep > a.deep ? b : a));

    issues.push({
      type: "Deep Relative Import",
      rule: "deep-relative-import",
      severity: "info",
      file: node.rel,
      line: 1,
      snippet: worst.spec,
      message:
        `\`${node.rel}\` reaches across ${worst.deep} directory levels with \`${worst.spec}\`. ` +
        "Long ../../../ chains are brittle — one folder move breaks them all. Add a tsconfig path " +
        "alias (e.g. '@/*': ['./src/*']) and import from '@/...' instead.",
      docs: "https://noctisnova.com/docs/structure/path-aliases",
      penalty: PENALTY_DEEP_IMPORT,
      deep: worst.deep,
    });
  }
  return issues.sort((a, b) => b.deep - a.deep);
}

// ---------------------------------------------------------------------------
// Aggregate architecture stats (for the report header)
// ---------------------------------------------------------------------------

export function computeGraphStats(graph) {
  let maxFanIn = 0, maxFanInFile = null, totalImports = 0;
  for (const node of graph.nodes.values()) {
    totalImports += node.importCount;
    if (node.importedBy.size > maxFanIn) {
      maxFanIn = node.importedBy.size;
      maxFanInFile = node.rel;
    }
  }
  return {
    edges: graph.edgeCount,
    avgImports: graph.fileCount ? +(totalImports / graph.fileCount).toFixed(1) : 0,
    maxFanIn,
    maxFanInFile,
    aliasConfig: graph.aliases.configFile,
    aliasCount: graph.aliases.paths.length,
  };
}

// ---------------------------------------------------------------------------
// Run all graph-based scans
// ---------------------------------------------------------------------------

export function runGraphScans(projectPath) {
  const graph = buildImportGraph(projectPath);
  const issues = [
    ...findCircularDependencies(graph),
    ...findOrphanFiles(graph),
    ...findGodFiles(graph),
    ...findDeepRelativeImports(graph),
  ];
  return { issues, graphStats: computeGraphStats(graph) };
}
