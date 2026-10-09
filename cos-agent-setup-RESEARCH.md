# CoS Agent Setup — Research Findings

Worktree: `/Users/chukycheese/dev/chuky-wiki-cos` (branch `chukycheese/cos-agent-setup`)
Date: 2026-10-09
Scope: research only — no opencode config modified, no commit.
Skill loaded: `customize-opencode` (built-in). Schema verified against `https://opencode.ai/config.json`. Docs verified: `/docs/agents/`, `/docs/permissions/`, `/docs/tools/`, `/docs/config/`.

---

## (a) How opencode agents / subagents work

### Where configs live

| Scope | Path |
|---|---|
| Project config | `./opencode.json`, `./opencode.jsonc`, or `.opencode/opencode.json` (opencode walks up from cwd to worktree root) |
| Global config | `~/.config/opencode/opencode.json` or `.jsonc` (NOT `~/.opencode/`) |
| Project agents (file form, preferred) | `.opencode/agents/<name>.md` (plural preferred; `.opencode/agent/<name>.md` singular also accepted for back-compat) |
| Global agents | `~/.config/opencode/agents/<name>.md` |
| Project commands | `.opencode/commands/<name>.md` |
| Project skills | `.opencode/skills/<name>/SKILL.md` |
| Project plugins (auto-discovered) | `.opencode/plugin/*.ts` / `.opencode/plugins/*.ts` |

Merge model: all scopes deep-merged, later overrides earlier (remote < global < `OPENCODE_CONFIG` < project < `.opencode/` dirs < `OPENCODE_CONFIG_CONTENT` < managed). Project overrides global. Unknown top-level keys in `opencode.json` → `ConfigInvalidError`, opencode refuses to start.

Current state verified on this machine:
- `/Users/chukycheese/dev/chuky-wiki-cos/.opencode/` — does NOT exist.
- `/Users/chukycheese/dev/chuky-wiki/.opencode/` — does NOT exist.
- `~/.config/opencode/opencode.json` — exists, contains ONLY `mcp` (servers: `chuky-opencode` remote, `linear` remote, `kaggle` local). No `agent:` section today. So built-ins are untouched defaults.

### Config file format — two equivalent forms

Inline in `opencode.json` (`agent` is an object keyed by name, NOT an array):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "my-reviewer": {
      "description": "Reviews PRs for style violations.",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-6",
      "permission": { "edit": "deny", "bash": "ask" },
      "prompt": "You are a strict PR reviewer..."
    }
  }
}
```

File form (recommended for anything non-trivial). Filename becomes agent name (`review.md` → `review` agent). Body becomes `prompt`; do NOT also put `prompt:` in frontmatter:

```markdown
---
description: Reviews PRs for style violations.
mode: subagent
model: anthropic/claude-sonnet-4-6
permission:
  edit: deny
  bash: ask
---

You are a strict PR reviewer. Focus on...
```

Allowed frontmatter / JSON fields (schema `AgentConfig`): `model, variant, temperature, top_p, prompt, description, mode, hidden, color, steps, options, permission, disable`. Unknown fields silently route into `options`. Legacy `maxSteps` → use `steps`. Legacy `tools: {write: false}` → use `permission`.

Rules from the skill + schema:
- Every `opencode.json` must declare `"$schema": "https://opencode.ai/config.json"` (editor validation; opencode hard-fails on invalid config).
- `model` always has provider prefix (`anthropic/...`, `opencode/...`). If omitted on a subagent, it **inherits the invoking primary's model**.
- `description` is effectively required — it is what the primary model uses to decide auto-delegation, and what shows in `@` autocomplete.
- `default_agent` must point at a non-hidden `primary`-mode agent (falls back to `build` with warning otherwise).
- Config is loaded **once at startup, no hot-reload** — must quit + restart opencode after any agent/config change.
- Scaffolder exists: `opencode agent create` (asks global vs project, description, generates prompt, permission allow-list, writes the `.md` file).
- Escape hatches if config breaks startup: `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_CONFIG=/path`, `OPENCODE_CONFIG_CONTENT='{...}'`, `opencode debug config`.

### Primary vs subagent (`mode`)

- `mode: primary` — main assistant, Tab-cyclable. Built-ins: `build` (default, full tools), `plan` (restricted: `edit`+`bash` ask/deny — analysis without changes).
- `mode: subagent` — invoked by primaries for specialist work, or manually via `@name`. Built-ins: `general`, `explore`, `scout`. Hidden system agents: `compaction`, `title`, `summary` (mode `primary`, not selectable).
- `mode: all` — usable both ways. Default when `mode` omitted.
- `hidden: true` (subagent only) — removes from `@` autocomplete; still invokable via Task tool by other agents. Useful for workers that should only be reached through the coordinator.

### How a coordinator delegates to subagents

1. **Task tool** (primary mechanism). Primary agent calls `task` with a `subagent_type` (= agent name) + prompt. Child sessions are created; navigate with `session_child_first` (Leader+Down), `session_child_cycle` / `_reverse` (Right/Left), `session_parent` (Up).
2. **`@mention`** — user (or agent text) can explicitly invoke `@worker-name ...`. Users can always `@`-invoke any subagent directly even if the coordinator's `permission.task` would deny it — task-permission only hides agents from the *model's* Task tool description.
3. **Auto-delegation** — primary decides from subagent `description` fields. Hence descriptions must say *what* and *when* ("Use for ...; trigger on ...").

Nesting limit — `subagent_depth` (top-level `opencode.json`, default `1`):
- `0` = no subagent launches at all.
- `1` (default) = primary → subagent OK, but subagent → subagent blocked. **This is all a 1-level CoS design needs; no change required.**
- `2` = one extra nesting level. Only needed if workers must themselves fan out (e.g. inkstone-dev spawning explore/scout). Prefer keeping workers at depth 1 and letting CoS fan out in parallel instead.

Parallelism: a primary can launch multiple Task calls in one turn (independent workers run concurrently). `general` doc explicitly blesses this pattern ("run multiple units of work in parallel").

`todowrite` note: disabled for subagents by default — coordinator should own the todo list; enable per-worker only if a worker needs its own checklist (`permission: {todowrite: allow}` — flat action only).

### Permission scoping per agent

- Top-level `permission:` sets defaults; per-agent `permission:` merges over it, agent rules win.
- Actions: `allow` | `ask` | `deny`. Defaults are permissive (`allow` almost everywhere; `doom_loop` + `external_directory` default `ask`; `.env` reads denied by default).
- Granular object form for `read, edit, glob, grep, list, bash, task, external_directory, lsp, skill`: `{ "<pattern>": "<action>" }`. **Last matching rule wins** — put `"*"` catch-all first, specifics after. Wildcards: `*` (any run), `?` (one char). Bash matches parsed command strings (`"git *": "allow"`); include trailing `*` when args are passed (`"grep *"` not `"grep"`). MCP tools match by wildcard too (`"chuky-opencode_*": "allow"`, `"linear_*": "ask"`).
- Flat-action-only keys (no object form): `todowrite, question, webfetch, websearch, doom_loop`.
- Key gate: `permission.task` controls which subagents an agent may launch, by glob on agent name. Denied agents vanish from the Task tool description (model won't try them):

```json
{ "agent": { "chief-of-staff": {
  "permission": { "task": { "*": "deny", "wiki-librarian": "allow", "inkstone-dev": "allow", "workout-planner": "allow" } }
}}}
```

- `external_directory`: any tool touching paths outside the launch worktree must be allowed here (e.g. CoS launched in `chuky-wiki-cos` but workers touching `chuky-wiki`, Inkstone notes store, etc.). Reads inherit workspace defaults once allowed; layer explicit `edit: deny` if a worker should be read-only outside.
- `--auto` flag / auto-approve only upgrades `ask` → allow; `deny` is always enforced.
- Validate permission-heavy configs against the schema before writing; `task`/`skill` accept `PermissionRuleConfig` (string or object) — both forms legal.

### Built-in `explore` / `general` conventions (for mirroring)

These are **code-defined, not file-visible** — nothing to read under `~/.config/opencode/agents/` (verified: no agent `.md` files exist there today). Documented behavior:

- `general` (`mode: subagent`): general-purpose research + multi-step execution. Full tool access **except todo** (i.e. `todowrite` off). Can make file changes. Convention: leave `model` unset (inherits invoker) or pin a strong model; `steps` unset (run to completion); broad `description` so it catches complex overflow work.
- `explore` (`mode: subagent`): fast **read-only** codebase explorer. `permission: {edit: deny, bash: deny-ish}` equivalent — finds files, greps, answers questions, never modifies. Convention: tight read-only prompt, low `temperature` (~0.1), small/cheap model.
- `scout` (`mode: subagent`): read-only like explore but for **external docs / dependency source** (clones deps into managed cache, cross-references upstream). Useful precedent for workers that mostly `webfetch`/`read` and rarely `edit`.

Takeaway: mirror with (1) one-line `description` covering duty + trigger, (2) `temperature: 0.1–0.2` for librarian/dev, slightly higher ok for planner, (3) explicit least-privilege `permission:` block per worker, (4) `color` per agent for TUI distinguishability (optional but cheap).

---

## (b) Proposed setup — 1 coordinator + 3 workers

### Placement recommendation

**Project-scoped, file form, checked into git** in the worktree repo (so the CoS team travels with the project and works on any machine):

```
.opencode/
  agents/
    chief-of-staff.md    # mode: primary (the coordinator you Tab to / set default)
    wiki-librarian.md    # mode: subagent, hidden
    inkstone-dev.md      # mode: subagent, hidden
    workout-planner.md   # mode: subagent, hidden
```

Optionally a thin `opencode.json` (or `.opencode/opencode.json`) holding only `default_agent` + `subagent_depth` + shared `permission` defaults; keep agent bodies in the `.md` files, not inline. Global `~/.config/opencode/agents/` is the wrong home — CoS workers are project-specific (wiki inbox conventions, Inkstone ticket workflow, workout history live in/around this repo).

`subagent_depth`: leave default `1` (no config needed). Only raise to `2` if a worker must itself delegate.

### Responsibility split

| Agent | Mode | Duties | Must NOT do |
|---|---|---|---|
| `chief-of-staff` (coordinator) | `primary` | Triage every recurring request; own `todowrite`; route to exactly one worker (or run parallel fan-out); merge worker results into one reply; enforce "ticket-size-or-larger → worker, micro-task → inline" rule; ask clarifying `question` when ambiguous | Direct file edits / ticket writes when a worker owns the domain (delegate instead); invent worker results |
| `wiki-librarian` | `subagent` (hidden) | Wiki inbox cleanup + tagging: scan inbox notes via `chuky-opencode` MCP, apply tag/folder conventions, archive/organize, report what moved | Restructure outside inbox scope; delete (trash needs separate consent anyway) without CoS confirmation |
| `inkstone-dev` | `subagent` (hidden) | Inkstone dev tickets: turn bug/feature asks into Linear issues (`linear` MCP), implement small code changes in repo, link branch/issue, run relevant tests | Large refactors without a plan checkpoint; push/commit unless CoS explicitly passes commit intent |
| `workout-planner` | `subagent` (hidden) | Weekly workout plans: read prior plans/history, draft next week, adjust for constraints (travel, injury, equipment), write plan note | Give medical diagnosis; change plan mid-week without being asked |

### Delegation rules (put verbatim in `chief-of-staff.md` prompt)

1. **Ticket-size-or-larger goes through CoS.** Single-file typo / one-line answer → answer inline, no Task call. Anything needing ≥2 steps, a ticket, an inbox sweep, or a weekly plan → delegate to the owning worker via the Task tool (`subagent_type` = worker name), then synthesize.
2. **One owner per task.** Never send the same task to two workers. Parallel fan-out only for independent tasks (e.g. inbox sweep + next week's plan can run together; report separately, merge at the end).
3. **Workers don't delegate.** Workers do their own work with their own tools; they never call other subagents (depth 1). If a worker needs help outside its domain, it returns "needs X from <other-worker>" and CoS re-routes.
4. **Structured handoffs.** Every Task call passes: goal, scope bounds, done-criteria, and output format ("return: files changed + tests run + follow-ups"). Workers return summaries, not dumps.
5. **Least privilege by default.** CoS holds `question`+`todowrite`; workers get only the MCP/tools they need (below). Reads stay open; writes are worker-scoped.
6. **User can bypass.** `@wiki-librarian` etc. still work directly (hidden only hides autocomplete) — document this as the escape hatch for "just do it, skip triage."

### Example config snippets (file form)

`.opencode/agents/chief-of-staff.md`:

```markdown
---
description: Chief-of-Staff coordinator. Use for any recurring wiki, Inkstone ticket, or workout-plan request needing triage and delegation to specialist workers.
mode: primary
temperature: 0.2
color: accent
permission:
  todowrite: allow
  question: allow
  task:
    "*": deny
    wiki-librarian: allow
    inkstone-dev: allow
    workout-planner: allow
    general: allow
    explore: allow
---

You are the Chief of Staff. Triage, then delegate via the Task tool.

Rules:
1. Micro-tasks (one step, one file, one answer) — do inline, no delegation.
2. Ticket-size-or-larger (multi-step, inbox sweep, new ticket, weekly plan) — delegate to exactly one owning worker: wiki-librarian (wiki inbox/tagging), inkstone-dev (Linear tickets + repo code), workout-planner (weekly plans).
3. Independent tasks may fan out in parallel in a single turn; merge results into one reply.
4. Own the todo list (todowrite). Each Task handoff states goal, scope bounds, done-criteria, and required return format (files changed, tests run, follow-ups).
5. Workers never delegate further. If a worker reports needing another domain, re-route yourself.
6. Never commit/push unless the user explicitly asked.
```

`.opencode/agents/wiki-librarian.md`:

```markdown
---
description: Wiki inbox cleanup and tagging specialist. Use when sweeping the wiki inbox, applying tags/folders, or archiving processed notes.
mode: subagent
hidden: true
temperature: 0.1
color: info
permission:
  edit: allow
  bash:
    "*": deny
  task:
    "*": deny
  chuky-opencode_*: allow
---

You are the wiki librarian. You keep the Inkstone wiki inbox at zero via the chuky-opencode MCP tools (search before fetch, fetch only relevant notes, bounded reads).

Bounds: organize/tag/archive inbox notes only. Never trash without explicit confirmation passed in the handoff. Return: notes processed, tags/folders applied, items needing human judgment.
```

`.opencode/agents/inkstone-dev.md`:

```markdown
---
description: Inkstone dev-ticket worker. Use when filing Linear issues, implementing small repo changes for a ticket, or running related tests.
mode: subagent
hidden: true
temperature: 0.1
color: secondary
permission:
  edit: allow
  bash:
    "*": ask
    "git status *": allow
    "git diff *": allow
    "git log *": allow
    "npm test *": allow
    "npx vitest *": allow
  task:
    "*": deny
  linear_*: allow
  chuky-opencode_*: allow
---

You are the Inkstone dev worker. File/implement tickets via the linear MCP tools; make minimal repo edits; run the narrowest relevant test (vitest) and report.

Bounds: no refactors beyond the ticket; no commit/push unless the handoff explicitly includes commit intent. Return: issue URL, files changed, tests run + result, follow-ups.
```

`.opencode/agents/workout-planner.md`:

```markdown
---
description: Weekly workout-plan writer. Use when drafting next week's training plan or adjusting for travel, injury, or equipment constraints.
mode: subagent
hidden: true
temperature: 0.3
color: success
permission:
  edit: allow
  bash:
    "*": deny
  task:
    "*": deny
  websearch: allow
  webfetch: allow
  chuky-opencode_*: allow
---

You are the workout planner. Read prior plans/history first, then draft next week (days, lifts/conditioning, sets×reps, progression vs last week, deload flags).

Bounds: training plans only — no medical diagnosis. Return: the plan + what changed vs last week + open questions (equipment, schedule).
```

Thin project `opencode.json` (only if you want CoS as default; otherwise skip the file entirely):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "chief-of-staff"
}
```

(`subagent_depth` intentionally omitted — default `1` is correct. `permission.task` on CoS already constrains delegation; MCP servers are inherited from global config, no need to repeat.)

Optional accelerator: `.opencode/commands/cos.md` (`/cos <request>`) with `agent: chief-of-staff` in frontmatter so recurring work has a one-word entry point. Commands are `**/*.md` under `.opencode/commands/` with `$ARGUMENTS` as user input.

After creating files: **quit + restart opencode** (config loads once at startup). Validate first with `opencode debug config` and keep `$schema` so editors catch shape errors.

---

## (c) Open questions / risks

1. **Latency overhead of the extra hop.** Every delegated task pays for 2+ model calls (CoS triage + worker + synthesis) instead of 1. For micro-tasks this is pure waste — hence the ticket-size threshold rule. Measure: if median CoS-handled task feels slower than direct `@worker` invocation, lower the threshold or bypass CoS for that lane.
2. **Context cost duplication.** Worker sessions re-read files/notes the coordinator already saw; summaries passed back up are lossy. Mitigations: structured handoffs (goal/scope/done-criteria), workers return summaries not dumps, keep `subagent_depth: 1` so no third-level re-reads. Watch compaction interplay (`compaction.auto/tail_turns`) on long inbox sweeps.
3. **Hidden ≠ enforced.** `hidden: true` only removes workers from `@` autocomplete; users (and sloppy prompts) can still invoke them directly, and `permission.task: deny` only hides them from the *model's* Task menu. Delegation discipline is by prompt convention, not hard enforcement. Accept or add a plugin hook if strict routing is ever needed.
4. **Subagent model inheritance.** Unpinned worker `model` = invoker's model at call time. Good for cost control (one switch changes all), bad for predictability (worker quality shifts with CoS model). Pin `model:` per worker once stable (e.g. cheap/fast for librarian, strong for dev).
5. **Permission wildcard naming for MCP tools.** `linear_*` / `chuky-opencode_*` gating assumes tool names are prefixed by server name (documented pattern, but verify with `opencode debug config` / tool list after first run — a wrong pattern silently over- or under-permits since last-match-wins).
6. **`ask` in unattended runs.** `inkstone-dev`'s `bash "*": ask` blocks `opencode run --auto`-style automation unless overridden. Decide per lane: interactive TUI (`ask` fine) vs cron/batch (`allow` narrow patterns + `deny` for destructive).
7. **Depth-1 ceiling.** If `inkstone-dev` ever needs its own `explore` pass over a large codebase, depth 1 blocks it — CoS must launch `explore` separately and hand results down. Either accept the orchestration burden or trial `subagent_depth: 2` with explicit "workers may call explore/scout only" task grants.
8. **No existing `.opencode/` to conflict with** (verified absent in both worktree and main checkout) — greenfield, but also means AGENTS.md/instructions conventions for this repo should be written alongside the agents or workers will each invent their own (tag taxonomy, ticket format, plan template).
9. **Restart-to-apply + strict validation.** Any typo in frontmatter/`opencode.json` breaks startup for the whole project config (`OPENCODE_DISABLE_PROJECT_CONFIG=1` is the recovery). Keep `$schema`, change one agent at a time, `opencode debug config` after each.
10. **Eval gap.** No harness yet for "did the librarian tag correctly / did the dev close the right ticket." Before scaling, keep a human in the loop on trash/commit/push actions (already `deny`/`ask` above) and spot-check worker returns for a few weeks.

---

## Sources

- Skill `customize-opencode` (built-in) + live schema `https://opencode.ai/config.json` (fetched 2026-10-09; confirms `AgentConfig`, `PermissionConfig`, `subagent_depth`, `mode: subagent|primary|all`).
- Docs: `https://opencode.ai/docs/agents/` (types, built-ins incl. `scout`, Task/`@` usage, `permission.task` globbing, `hidden`, `steps`), `/docs/permissions/` (actions, last-match-wins, `external_directory`, per-agent override), `/docs/tools/` (`todowrite` off for subagents by default), `/docs/config/` (locations, precedence, `subagent_depth` semantics, restart requirement).
- Local verification: `~/.config/opencode/opencode.json` (mcp-only), absence of `.opencode/` in worktree + main, branch `chukycheese/cos-agent-setup`.
