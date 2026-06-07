---
name: neat-doctor
version: 1.0.0
publisher: NoctisNova
publisher_url: https://noctisnova.com
contact: hello@noctisnova.com
description: >
  Code structure analyser for TypeScript and Next.js codebases. Detects messy
  folder hierarchies, fat directories, naming inconsistencies, misplaced files,
  missing barrel exports, duplicate concept folders, and empty directories.
  Shows an annotated current tree, a recommended clean structure, and a
  migration plan. Built by NoctisNova.
triggers:
  - neat-doctor
  - neat doctor
  - organise code
  - organize code
  - code structure
  - folder structure
  - project structure
  - messy folders
  - clean up project
  - restructure
  - too many folders
  - improve organisation
  - file organisation
tags:
  - code-organisation
  - project-structure
  - nextjs
  - typescript
  - static-analysis
  - refactoring
  - noctisnova
binary: neat-doctor
install: npx neat-doctor
---

# neat-doctor — by NoctisNova

> Analyses and reorganises the structure of TypeScript/Next.js codebases.
> Shows you exactly what's messy, why it's a problem, and what it should look like.
> Built by **[NoctisNova](https://noctisnova.com)**.

---

## What neat-doctor Detects

### Filesystem structure rules

| Rule | Severity | Penalty | What It Finds |
|---|---|---|---|
| `root-chaos` | WARN | -6 pts | Source files dumped in the project root |
| `duplicate-concept` | WARN | -8 pts | `utils/` + `helpers/` + `lib/` at the same level |
| `deep-nesting` | WARN | -4 pts | Folders more than 5 levels deep |
| `fat-folder` | WARN | -6 pts | 18+ files with no subdirectory grouping |
| `misplaced-file` | WARN | -4 pts | Components in utils/, config in src/ |
| `naming-mismatch` | INFO | -5 pts | kebab-case folders next to PascalCase folders |
| `missing-barrel` | INFO | -3 pts | Folders with 3+ exports but no index.ts |
| `scattered-config` | INFO | -3 pts | Config files nested inside src/ |
| `empty-dir` | INFO | -2 pts | Completely empty directories |

### Import-dependency-graph rules (the advanced engine)

neat-doctor builds a real import graph of your project — resolving relative
imports, tsconfig `paths` aliases, and `baseUrl` — then runs graph-theoretic
analyses that filesystem scanning can never find:

| Rule | Severity | Penalty | What It Finds |
|---|---|---|---|
| `circular-dependency` | CRIT | -10 pts | True import cycles (Tarjan strongly-connected components) |
| `orphan-file` | WARN | -5 pts | Exports code, imported by nothing, not an entry point |
| `god-file` | WARN | -5 pts | 400+ lines or 30+ imports (low cohesion) |
| `deep-relative-import` | INFO | -2 pts | `../../../` chains that should be path aliases |

The report header also shows **detected stack** (Next.js version, router type,
Prisma/Drizzle/tRPC/Tailwind, monorepo, package manager) and **graph stats**
(import edges, average imports/file, path-alias usage, most-imported file).

---

## Score Tiers

| Score | Grade | Meaning |
|---|---|---|
| 90–100 | A — Pristine | Excellent structure, minimal issues |
| 80–89 | B — Neat | Well-organised with minor cleanup needed |
| 65–79 | C — Cluttered | Noticeable structural debt |
| 50–64 | D — Messy | Significant reorganisation needed |
| 0–49 | F — Chaotic | Major structural problems affecting all developers |

---

## Canonical Structure (Next.js App Router)

```
my-app/
├── next.config.ts        ← config (root only)
├── tsconfig.json
├── package.json
├── .env.local
├── public/
│
├── prisma/               ← if using Prisma
│   └── schema.prisma
│
└── src/                  ← ALL source code lives here
    ├── app/              ← routes only (no business logic)
    │   ├── (auth)/       ← route groups keep structure flat
    │   ├── (dashboard)/
    │   └── api/
    ├── components/
    │   ├── ui/           ← primitives: Button, Input, Modal
    │   ├── layout/       ← Header, Footer, Sidebar
    │   ├── forms/
    │   └── index.ts      ← barrel
    ├── lib/              ← integrations: db, auth, email
    ├── actions/          ← Server Actions ('use server')
    ├── hooks/            ← custom React hooks
    ├── utils/            ← pure functions, no side effects
    ├── types/            ← TypeScript types and enums
    └── config/           ← constants and feature flags
```

---

## Naming Conventions

| Item | Convention | Example |
|---|---|---|
| Folders | kebab-case | `user-settings/`, `auth-guard/` |
| React components | PascalCase | `Button.tsx`, `UserCard.tsx` |
| Utility/hook files | kebab-case | `format-date.ts`, `use-debounce.ts` |
| Constants (values) | UPPER_SNAKE_CASE | `const MAX_RETRY = 3` |

---

## How to Use

```bash
# Full analysis (scan + tree + recommended structure + migration plan)
npx neat-doctor

# Scan a specific directory
npx neat-doctor ./my-nextjs-app

# Show annotated tree only (no scan)
npx neat-doctor --tree

# Show recommended structure only
npx neat-doctor --recommend

# Both tree and recommended side by side
npx neat-doctor --tree --recommend

# CI mode — exit 1 if issues found (includes graph rules)
npx neat-doctor --json > .neat-doctor-report.json
```

### Generating fix scripts

In the interactive menu choose **"Generate fix scripts"** to write:

- `neat-doctor-fix.sh` — `git mv` commands for macOS/Linux
- `neat-doctor-fix.ps1` — `git mv` commands for Windows PowerShell
- `neat-doctor-migration.md` — a human-readable, phased plan

Deterministic moves (root → `src/`, nested config → root, empty-dir removal)
become real commands; judgment calls (consolidating folders, breaking cycles,
splitting god files) become clearly-marked TODO guidance. **Nothing executes
automatically** — review the script, then run it yourself.

---

## Agent Instructions

When this skill is present in a repository, AI agents must:

1. **Run neat-doctor first** and read `.neat-doctor-report.json` before reorganising anything.
2. **Fix `circular-dependency` issues first** — they are correctness bugs, not just style. Break the cycle by extracting shared symbols into a new leaf module both sides import.
3. **Follow the migration order**: circular-deps → root-chaos → duplicate-concepts → god-files → deep-nesting → fat-folders → orphan-files → misplaced-files → naming → barrels → deep-imports → config → empty-dirs.
4. **Confirm before deleting `orphan-file` results** — search the repo for dynamic/string references first, then `git rm`.
5. **Update ALL imports** when moving or renaming a file — never leave broken imports.
6. **Create barrel files** (index.ts) in every folder with 3+ exported files.
7. **Verify with `npx tsc --noEmit`** after each phase — fix TypeScript errors before moving on.
8. **Re-run `npx neat-doctor`** after each category to confirm the issue count drops.
9. **Never move files inside `app/`** without verifying the resulting URL structure is correct.
10. **Explain every fix in simple everyday language** — no jargon. Say what was reorganised and why it helps in terms a non-developer would understand (e.g. "easier to find the right file", "new team members can onboard faster").

---

## Documentation

The full, canonical guides for neat-doctor are hosted on the NoctisNova site — they are no longer bundled with this package. Fetch them from the URLs below.

**For AI agents:** request any doc with an `Accept: text/markdown` header to get the raw markdown source back (content negotiation). The server reads the source file, converts it to clean markdown (fenced code blocks, `##` headers, `- [ ]` checklists) and returns it with `Content-Type: text/markdown` plus an `x-markdown-tokens` header.

```bash
curl -H "Accept: text/markdown" https://noctisnova.com/tools/neat-doctor/project-structure-guide
```

| Guide | URL |
|---|---|
| Project Structure Guide | https://noctisnova.com/tools/neat-doctor/project-structure-guide |
| Advanced Architecture Analysis | https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis |
| All NoctisNova tools | https://noctisnova.com/tools |

---

## Links

| Resource | URL |
|---|---|
| NoctisNova | https://noctisnova.com |
| Structure guide | https://noctisnova.com/tools/neat-doctor |
| Naming conventions | https://noctisnova.com/tools/neat-doctor/project-structure-guide |
| Barrel files | https://noctisnova.com/tools/neat-doctor/project-structure-guide |
| Path aliases | https://noctisnova.com/tools/neat-doctor/advanced-architecture-analysis |
| Migration playbook | https://noctisnova.com/tools/neat-doctor/project-structure-guide |
