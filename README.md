# neat-doctor

Code structure analyser for **TypeScript and Next.js** codebases. Finds messy folders, fat directories, naming drift, misplaced files, circular dependencies, and deep imports — then generates safe `git mv` migration scripts to fix them.

Built by [NoctisNova](https://noctisnova.com).

## Install & run

No install required:

```bash
npx neat-doctor
npx neat-doctor ./my-app
npx neat-doctor --tree
npx neat-doctor --recommend
npx neat-doctor --json
```

Global install (optional):

```bash
npm install -g neat-doctor
neat-doctor
```

## What it detects

**Structure analysis**
- **Root chaos** — source files dumped in the project root
- **Duplicate concepts** — `utils/` AND `helpers/` AND `lib/` at the same level
- **Deep nesting** — folders more than 5 levels deep
- **Fat folders** — 18+ files with no subdirectory grouping
- **Misplaced files** — components in `utils/`, config files in `src/`
- **Naming mix** — kebab-case folders next to PascalCase folders
- **Missing barrels** — folders with 3+ exports but no `index.ts`
- **Scattered config** — `*.config.ts` nested inside `src/`
- **Empty directories** — folders with nothing in them

**Import-dependency-graph analysis**
- **Circular deps** — true import cycles via Tarjan SCC detection
- **Orphan files** — files nothing imports (proven dead via the graph)
- **God files** — 400+ lines or 30+ imports (low cohesion)
- **Deep imports** — `../../../` chains that should be path aliases

Produces a scored health report (0–100), saves `.neat-doctor-report.json`, and generates reviewable `git mv` migration scripts.

## Options

```
neat-doctor [options] [path]

  --tree          Show annotated ASCII tree of current structure
  --recommend     Show recommended clean structure
  --json          Output raw JSON to stdout (CI mode)
  --no-ai         Skip the agent hand-off menu
  --depth <n>     Tree render depth (default: 4)
  --version, -v   Print version and exit
  --help, -h      Show this help message
```

## Requirements

- Node.js **18+**

## Links

- **Homepage:** https://noctisnova.com
- **Repository:** https://github.com/noctisnova/neat-doctor
- **Issues:** https://github.com/noctisnova/neat-doctor/issues

## License

MIT
