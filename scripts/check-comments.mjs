import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Functional directives (Vitest environment, ts/eslint/prettier pragmas) are
// consumed by tooling, not prose for readers, so they never need an allowlist
// entry.
const DIRECTIVE = /^\/\/\s*@(?:vitest-environment|ts-ignore|ts-expect-error|ts-nocheck|eslint|prettier)\b/

const allowed = new Map([
  ["scripts/check-comments.mjs", [
    "// Functional directives (Vitest environment, ts/eslint/prettier pragmas) are",
    "// consumed by tooling, not prose for readers, so they never need an allowlist",
    "// entry.",
  ]],
  ["scripts/check-i18n.mjs", [
    "// The OAuth consent page is a self-contained HTML document with its own",
    "// language switch (cookie-based); it does not use the React i18n layer.",
  ]],
  ["scripts/llm-wiki-local-distill.mjs", [
    "// Local distill helper: POST /api/distill via Bearer ink_ token",
    "// Usage:",
    "//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --dry-run",
    "//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --dry-run --folder-id <id>",
    "//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --limit 3",
    "//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --note-id <note_id>",
    "//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --limit 1 --folder-id <id>",
    "// batch — sequential to avoid neuron burst",
  ]],
  ["scripts/llm-wiki-local-ingest.mjs", [
    "// Local ingest helper: POST /api/capture via Bearer ink_ token",
    "// Usage:",
    "//   node scripts/llm-wiki-local-ingest.mjs --base http://localhost:7712 --token ink_... --url https://example.com",
    "//   node scripts/llm-wiki-local-ingest.mjs --base http://localhost:7712 --token ink_... --file ./draft.md --title \"My Concept\" --folder-id <id>",
  ]],
  ["src/client/editor/CodeEditor.tsx", [
    "// Preserve undo history across mode changes once editing has started.",
  ]],
  ["src/client/editor/codeLanguages.ts", [
    "// Highlighting removed: no code languages are loaded.",
    "// Kept as empty array so the editor behaves as plain Markdown without syntax colors.",
  ]],
  ["src/client/editor/live-preview.ts", [
    "// Preserve the source line under the pointer, including rows inside tables/lists.",
    "/** Decorations change presentation only; all editing, undo, search and saving use Markdown. */",
    "// Keep typing synchronous and cheap. Reparse after a short idle window; never",
    "// display stale HTML for a block whose source was touched in the meantime.",
  ]],
  ["src/client/features/graph/GraphPanel.tsx", [
    "// Private browsing or a locked-down browser can reject local preferences.",
  ]],
  ["src/client/features/preview/block-edit.ts", [
    "/** Pure helpers for per-block click-to-edit inside the reading preview.\n *\n * Blocks map to Markdown source lines: the renderer stamps top-level preview\n * elements with `data-line` (0-based start line). The end line is derived from\n * the next sibling block's start line, falling back to the total line count.\n * All edits splice plain source lines so the existing revision-safe\n * `editContent` path stays the single writer.\n */",
    "/** Slice the half-open `[startLine, endLine)` range; out-of-range ends clamp. */",
    "/**\n * Replace the half-open `[startLine, endLine)` range with draft lines.\n * Returns the original source untouched when the range is invalid, so callers\n * can never corrupt a note from a stale block anchor.\n */",
    "/** End line for the block starting at `startLine`: next sibling start or EOF. */",
    "/**\n * Map a click target to the top-level preview block being edited. Nested\n * `data-line` elements (tables, callouts) ascend to the direct child of the\n * preview host so one tap edits exactly the visible block.\n */",
    "/** Links, media, tasks, tabs and toolbar buttons keep their own behavior. */",
  ]],
  ["src/client/features/preview/BlockEditor.tsx", [
    "/** In-place per-block editor: readable view stays, tools appear only here. */",
  ]],
  ["src/client/features/preview/Preview.tsx", [
    "/** Click a rendered block to edit it in place. Defaults to true. */",
    "// Per-block click-to-edit: the rendered block is hidden and a small editor",
    "// is mounted in its place. Writes go through the same revision-safe",
    "// `editContent` path as the full editor, so no edit capability is lost.",
    "// While a block is being edited the preview DOM hosts the editor mount;",
    "// defer re-rendering so the draft is never wiped, then refresh on close.",
    "// An editor opened while this prepare was in flight: never wipe its",
    "// DOM node, defer the refresh until the editor closes instead.",
    "// Clicks inside the in-place block editor belong to the editor.",
    "// Reading view stays readable by default; a plain click on a rendered",
    "// block opens it for editing right in place. Focus leaving the editor",
    "// (save on blur, cancel on Escape) restores the read appearance.",
  ]],
  ["src/client/features/settings/PushSettings.tsx", [
    "/** CKCZ-27: per-device Web Push opt-in. Default off; state lives in the push service, not in user settings. */",
    "// toJSON keys are already base64url, matching the server format.",
  ]],
  ["src/client/features/share/share-form.ts", [
    "// A new or replaced passcode must be at least 4 characters (the server",
    "// enforces the same minimum); short codes are trivially brute-forced.",
  ]],
  ["src/client/features/workspace/reading-position.ts", [
    "// Reading position is optional when browser storage is unavailable.",
  ]],
  ["src/client/lib/autosave.ts", [
    "/**\n * Autosave scheduling for the editor.\n *\n * Short notes save on the user's own `autoSaveDelay`. Long notes add delay as\n * they grow: every save sends the whole body and queues a full-text re-index of\n * it, so typing at the end of a 100k-character note would otherwise cost the\n * same as a fresh paragraph every time the writer pauses. The extra delay is\n * bounded, and content is written to the local outbox on every keystroke, so a\n * longer debounce never risks the draft.\n */",
    "/** Notes at or below this size save exactly on the user's configured delay. */",
    "/** Characters of growth that add one `AUTOSAVE_GROWTH_STEP_MS` of delay. */",
    "/** Ceiling on the added delay. */",
  ]],
  ["src/client/lib/i18n.ts", [
    "/** Provides typed runtime localization with on-demand locale loading. */",
    "// Preload the other locale in background for instant switching, but don't block init",
  ]],
  ["src/client/lib/markdown/renderer.ts", [
    "/** Builds the sanitized Markdown rendering pipeline and its Inkstone-specific syntax extensions. */",
    "/** Parse once with the full document environment so reference links retain their targets. */",
  ]],
  ["src/client/lib/sync.ts", [
    "/**\n * CKCZ-26: floor for the polling fallback. Realtime stays untouched; only\n * the no-realtime poll path is slowed (was 5s).\n */",
    "/**\n * Idle backoff ceiling: consecutive no-change polls back off up to this.\n * CKCZ-31: doubled from 5 to 10 minutes — quiet tabs now poll D1 at most\n * ~6x/hour instead of ~12x/hour. Realtime pushes bypass this entirely.\n */",
    "/** After this many consecutive no-change polls the backoff is maxed out. */",
    "/**\n * Effective poll gap for the fallback path: doubles per consecutive\n * no-change poll (30s → 60s → 120s → 240s → 480s → 600s cap). Any poll that\n * observes a change resets the streak to zero. Pure helper for tests.\n */",
    "/** Test seam: current idle streak driving the poll backoff. */",
    "/**\n   * Applies live setting changes (realtime toggle, poll interval) without\n   * tearing down the engine, its WebSocket, or its leadership claim.\n   */",
    "// CKCZ-26: idle backoff — consecutive no-change polls stretch the gap",
    "// so quiet tabs stop hammering D1. Realtime pushes bypass this via",
    "// schedulePull; only the timer path is throttled.",
    "// The engine is created exactly once; later setting changes are pushed",
    "// through updateConfig instead of rebuilding the whole engine.",
  ]],
  ["src/client/store/notes.ts", [
    "/** Coordinates the note cache, offline write-ahead log, optimistic updates, and server synchronization. */",
    "// Keep the current document for fast reads; only slow reads need a loading page.",
    "// Loaded content keeps its revision until the full note arrives.",
  ]],
  ["src/client/store/pwa.ts", [
    "// Reset the flag once the toast is gone, so a later installed worker can",
    "// notify again instead of being permanently suppressed.",
  ]],
  ["src/client/store/session.ts", [
    "// Push unsaved offline edits before clearing local data, otherwise",
    "// they would be silently dropped. Dynamic import keeps the session",
    "// store free of a circular dependency on the notes store.",
  ]],
  ["src/client/styles/editor.css", [
    "/* Live preview shares the preview typography without nesting scroll containers. */",
  ]],
  ["src/client/styles/tokens.css", [
    "/* Small labels are used on both the editor and the darker sunken sidebar. */",
  ]],
  ["src/shared/constants.ts", [
    "// D1 limits an entire row to 2,000,000 bytes; reserve room for note metadata.",
    "// CKCZ-26: slower polling fallback so quiet tabs stop hammering D1.",
  ]],
  ["src/shared/markdown-utils.ts", [
    "/** Provides pure Markdown analysis shared by the browser and Worker runtimes. */",
    "// md-example fences are rendered as live markdown by the client renderer,",
    "// so references inside them count even though stripCodeRegions discards",
    "// them as ordinary code regions.",
    "// A closing fence may only be followed by spaces or tabs.",
  ]],
  ["src/worker/attachments/references.ts", [
    "// Retained versions must remain restorable after unused attachments are pruned.",
  ]],
  ["src/worker/backup/snapshot.ts", [
    "/** Produces restorable JSON, readable Markdown, and attachment files for every backup target. */",
  ]],
  ["src/worker/db/fts.ts", [
    "/**\n * Most recently queued notes, newest first. A search uses the ids to read the\n * few notes whose index entry is still settling straight from `notes` instead\n * of abandoning FTS for a full-table LIKE scan.\n *\n * `truncated` means there are more queued notes than the window asked for —\n * the index is genuinely behind (bulk import, fresh database) and the caller\n * should fall back to the LIKE scan.\n */",
  ]],
  ["src/worker/db/schema.ts", [
    "/** Defines the idempotent final D1 schema initialized by every Worker isolate. */",
    "// Explicit whitelist (not a regex over SCHEMA_STATEMENTS) so later",
    "// additions like mcp_api_keys can never be picked up accidentally.",
    "// Only CREATE TABLE / INDEX statements: D1 does not reliably support",
    "// ALTER TABLE ADD COLUMN with constraints, so the AI search preference",
    "// lives in app_meta (key `ai-search-enabled:<userId>`) instead of a",
    "// new column on the pre-existing mcp_preferences table.",
    "// Existing installations must converge additively. CREATE IF NOT EXISTS",
    "// never rewrites user data; running table creation before indexes also",
    "// lets a partially initialized database recover missing feature tables.",
    "// Keep the existing indexed text and rowids. The batch either replaces the",
    "// complete index or rolls back, including when an old installation retries.",
  ]],
  ["src/worker/db/writes.ts", [
    "/** Keeps tags, backlinks, full-text indexes, and change records consistent with note writes. */",
    "/**\n   * Content before this write, when the caller already loaded the row. Lets\n   * the FTS queue skip a re-index whose indexed text (the title plus the\n   * truncated body) did not actually change.\n   */",
    "// A brand-new note (rev 1, no previous title) must also resolve links that",
    "// already point at its title; otherwise a \"wanted\" note stays unresolved",
    "// until every source note is saved again.",
    "/**\n * True when the text `notes_fts` stores for this note differs from what it\n * stored before. Only the title and the first `ftsContentChars` of the body\n * are indexed, so appending to a very long note past that window leaves the\n * index entry correct and the whole-note re-index unnecessary.\n */",
  ]],
  ["src/worker/env.ts", [
    "/** Workers AI binding for semantic search; optional so AI search degrades gracefully. */",
    "/** Optional jina Reader API key to avoid 429 rate limits on Worker egress IPs. */",
    "/**\n   * NVIDIA NIM API key (CKCZ-48), used as the third chat-generation fallback\n   * after Workers AI's model chain. Set it without committing the value:\n   *   npx wrangler secret put NVIDIA_API_KEY\n   * Optional NVIDIA_MODEL overrides the default\n   * `meta/llama-3.3-70b-instruct` NIM model.\n   */",
    "/**\n   * Web Push (VAPID) bindings for PWA notifications (CKCZ-27).\n   * Provisioning (owner, one time):\n   *   1. Generate a P-256 VAPID pair. Any tool works, e.g.:\n   *        npx --yes web-push generate-vapid-keys --json\n   *   2. Store the secrets (never commit them):\n   *        npx wrangler secret put VAPID_PUBLIC_KEY   # base64url public key\n   *        npx wrangler secret put VAPID_PRIVATE_KEY  # base64url private key\n   *        npx wrangler secret put VAPID_SUBJECT      # e.g. mailto:owner@example.com\n   *   The public key is exposed to signed-in clients via GET /api/push/vapid-key\n   *   so browsers can subscribe; the private key never leaves the Worker.\n   *   Until the secrets exist, push endpoints report `configured: false` and\n   *   subscriptions are accepted but no messages are sent.\n   */",
  ]],
  ["src/worker/index.ts", [
    "// Codex CLI drops the `iss` callback parameter while its rmcp",
    "// dependency enforces it whenever the authorization server advertises",
    "// `authorization_response_iss_parameter_supported` (openai/codex#31573), so",
    "// login fails even though the parameter is on the wire. Serve the metadata",
    "// without that flag to keep codex compatible; the standard RFC 9207 `iss`",
    "// parameter is still appended to callbacks for conforming clients.",
    "// CKCZ-28: daily word (3x) + quiz (1x) pushes. Best-effort internally;",
    "// the outer catch keeps one flaky user from breaking the shared cron.",
  ]],
  ["src/worker/lib/ai-budget.test.ts", [
    "// Minimal in-memory D1Database stub: only the app_meta access used by the",
    "// budget helpers (getMeta/setMeta plus the LIKE scan in listAiBudgetUsage).",
    "// Caller binds `${PREFIX}%:${day}`; emulate the LIKE match.",
    "// Other users and other days are unaffected.",
  ]],
  ["src/worker/lib/ai-budget.ts", [
    "/**\n * Per-user daily budget for Workers AI chat calls (distill + query share one\n * account-wide neuron pool, so each user gets their own daily call cap and a\n * member who burns through theirs can't starve the owner's crons).\n */",
    "/** app_meta key holding an admin-configured override for the daily cap. */",
    "/** app_meta key prefix for per-user daily usage: `ai_budget:<user_id>:<day>`. */",
    "/** UTC day (`YYYY-MM-DD`) a usage counter belongs to. */",
    "/** Meta key tracking one user's AI calls for one UTC day. */",
    "/** Inverse of {@link aiBudgetKey}; null when the key is not a budget key. */",
    "/** Parse a stored usage counter; garbage reads as zero so one bad row can't lock a user out. */",
    "/** Sanitize a configured cap; non-positive garbage falls back to the default. */",
    "/** Effective per-user daily cap: admin override from meta, else the default constant. */",
    "/** How many AI calls a user has consumed on the given UTC day. */",
    "/** Full budget status for one user on the given UTC day. */",
    "/** Every user's usage for one UTC day (for monitoring, e.g. the lint report). */",
    "/**\n * Reserve one AI call for a user. Returns `allowed: false` (and does NOT\n * consume) when the user already hit their daily cap — callers must skip the\n * model call and warn instead of throwing, so one over-budget member never\n * breaks other users' pipelines.\n */",
  ]],
  ["src/worker/lib/ai-chat.ts", [
    "// Primary and fallback Workers AI chat models. Every model in the chain must",
    "// accept { messages, max_tokens, temperature } so one prompt shape works",
    "// across fallbacks. Shared by the distill and query pipelines.",
    "// CKCZ-48: third fallback. When every Workers AI model fails (neuron cap, 429,",
    "// outage) and NVIDIA_API_KEY is configured, generation retries against NVIDIA",
    "// NIM's OpenAI-compatible endpoint so distill/query/vocab keep working.",
    "// Minimal environment needed for chat generation: the Workers AI binding and",
    "// the optional NVIDIA fallback credentials. Callers pass the full Worker Env.",
    "// True when at least one chat provider is configured: the Workers AI binding",
    "// or the NVIDIA NIM fallback key. Routes gate on this instead of AI alone so a",
    "// deployment can run on NVIDIA only, and so a runtime AI outage still degrades",
    "// to the fallback instead of failing the request outright.",
    "// Runs the Workers AI chain, then the NVIDIA NIM fallback. Returns the first",
    "// non-empty response. Returns null when every provider fails or returns",
    "// garbage; never throws.",
  ]],
  ["src/worker/lib/cron-schedule.ts", [
    "/**\n * Cron gating for the scheduled handler.\n *\n * `wrangler.toml` registers `0 * * * *` and `15,45 * * * *`, so `scheduled()`\n * runs 72 times a day and used to re-run every maintenance job each time:\n * backups, four purges, the OAuth provider purge, AI and FTS queue drains,\n * distill, wiki lint and vocab push, each reading and writing D1 rows even\n * when it has nothing to do.\n *\n * Two cadences replace that:\n * - Backups keep an hourly slot on the hourly trigger, because the per-account\n *   schedule setting goes down to `hourly` and `sixHourly` is the default\n *   (BACKUP_INTERVALS); the sweep itself decides who is due.\n * - Everything else is not minute-critical and runs twice a day, at 01:00 and\n *   13:00 UTC (10:00 and 22:00 KST).\n * Vocab pushes are not gated at all: their KST slots need minute punctuality.\n */",
  ]],
  ["src/worker/lib/notify.ts", [
    "/**\n * How long continuous editing may postpone an FTS re-index. Every save re-arms\n * the settle window, so without this a note typed for minutes would stay out of\n * the index until the writer paused; past this budget the burst indexes the\n * current state once and the window starts over.\n */",
    "/**\n * Round budget for one deferral window. A round either indexes what has\n * settled or waits one more window, so this caps how many waits (and forced\n * passes) a single window may spend before the next budget restarts.\n */",
    "/** When the current deferral budget started. */",
    "/** Drains queued notes; `force` ignores the settle window. */",
    "/** Resolves after one settle window has elapsed (arming it if needed). */",
    "/**\n * The background drain loop for one burst of note writes.\n *\n * `drain(max, false)` honours the settle window, so a note that changed a\n * moment ago is left in the queue and the whole-note FTS re-index is deferred\n * until the writer pauses. When the round budget runs out with work still\n * queued, one forced drain indexes the current state so the queue never\n * drifts far behind the notes table.\n */",
    "// A budget that ran out stops waiting: the next tick indexes the current",
    "// state instead of postponing it again for another settle window.",
    "// The budget restarts once a pass indexes the state being written.",
    "/**\n * Schedules the background FTS drain for this account.\n *\n * A save re-arms the settle window instead of adding work, so a burst of\n * autosaves (a long note being typed) costs one FTS re-index when the writer\n * pauses rather than one per save. Search freshness is unaffected: reads merge\n * the notes still in the queue straight from `notes`.\n */",
    "// A save that lands while the loop is finishing marks the burst for",
    "// another pass; give it one before the entry is dropped, so that note is",
    "// not left queued until the next write.",
  ]],
  ["src/worker/lib/oauth-request.ts", [
    "// Rebuild after consuming the bounded body so the provider can read it once.",
  ]],
  ["src/worker/lib/request.ts", [
    "// CF-Connecting-IP is injected by the Cloudflare edge and cannot be",
    "// spoofed there. On any other runtime the header is client-controlled,",
    "// so ignore it rather than trusting it for throttling.",
  ]],
  ["src/worker/lib/search-budget.test.ts", [
    "// Minimal in-memory D1Database stub: only the app_meta access used by the",
    "// budget helpers (getMeta/setMeta plus the LIKE scans in the list helpers).",
    "// Caller binds `${PREFIX}%:${day}`; emulate the LIKE match.",
  ]],
  ["src/worker/lib/search-budget.ts", [
    "/**\n * Per-user daily budget for lexical/semantic search calls (CKCZ-26).\n *\n * Tables are small but FTS `MATCH` + `bm25` scores every match before LIMIT\n * and LIKE fallbacks do full-table scans, so cost is cumulative across\n * calls. This mirrors the ai-budget pattern (CKCZ-24): per-user daily call\n * counters in app_meta, warn-and-skip / 429 semantics, generous default cap.\n */",
    "/** app_meta key holding an admin-configured override for the daily cap. */",
    "/** app_meta key prefix for per-user daily usage: `search_budget:<user_id>:<day>`. */",
    "/** app_meta key prefix for per-user daily sync-poll counts: `sync_poll:<user_id>:<day>`. */",
    "/** UTC day (`YYYY-MM-DD`) a usage counter belongs to. Reuses the AI-budget clock. */",
    "/** Meta key tracking one user's search calls for one UTC day. */",
    "/** Inverse of {@link searchBudgetKey}; null when the key is not a search-budget key. */",
    "/** Meta key tracking one user's sync pulls for one UTC day. */",
    "/** Inverse of {@link syncPollKey}; null when the key is not a sync-poll key. */",
    "/** Effective per-user daily cap: admin override from meta, else the default constant. */",
    "/** How many search calls a user has consumed on the given UTC day. */",
    "/** Full budget status for one user on the given UTC day. */",
    "/** Every user's search usage for one UTC day (for monitoring, e.g. the lint report). */",
    "/**\n * Reserve one search call for a user. Returns `allowed: false` (and does NOT\n * consume) when the user already hit their daily cap — callers must skip the\n * D1 query and warn / answer 429 instead of running it, so one abusive\n * client can't burn the account's daily rows-read quota.\n */",
    "/**\n * Record one sync pull for monitoring (no cap — the client backoff in\n * `src/client/lib/sync.ts` is the throttle; this counter only feeds the lint\n * report so runaway pollers are visible without a Cloudflare API token).\n * No longer called by `GET /api/sync`: one app_meta row write per poll was pure\n * D1 quota burn. Kept exported for ad-hoc diagnostics and existing tests.\n */",
    "/** How many sync pulls a user has made on the given UTC day. */",
    "/** Every user's sync-poll counts for one UTC day (for the lint report). */",
  ]],
  ["src/worker/lib/vocab-push.test.ts", [
    "// Day 1 slot 1 starts at offset (15 + 5) % 20 = 0.",
    "// Day 1 slot 0 starts at 15, wrapping past the end.",
    "// Offsets advance 15/day with no overlap for 42 days (630 words), then",
    "// day 42 wraps and covers the remaining 12 — well before the exam.",
    "// 2026-10-11 22:30 UTC == 2026-10-12 07:30 KST.",
    "// 2026-10-12 00:00 UTC == 2026-10-12 09:00 KST.",
    "// The 12:30 slot is served by the :45 cron tick.",
    "// Any pool edit changes the checksum and forces a reload.",
    "// One bad entry invalidates the whole cache (protects the rotation).",
  ]],
  ["src/worker/lib/vocab-push.ts", [
    "/**\n * CKCZ-28: daily English word + quiz push notifications.\n *\n * The content pool lives in the user's wiki (not in the repo): folder\n * `10 English` with the `IELTS 기출 단어` (310 words) and `TOEFL 기출 단어`\n * (332 words) notes as Markdown tables (word | meaning-Korean |\n * example-English). The selector reads those notes at runtime, per user.\n *\n * Word pushes go out 3x/day (morning/noon/evening), 5 words each, with a\n * deterministic date rotation (no LLM). The quiz push goes out 1x/day in the\n * morning and costs exactly 1 LLM call/day, gated by the per-user AI budget\n * (CKCZ-24 pattern: try-consume, warn-and-skip).\n *\n * Coverage math: 642 nominal pool words, 15 words/day starting 2026-10-12.\n * Offsets advance by 15/day with no overlap for the first 42 days (630\n * words); day 42 wraps and covers the remaining 12, so the full pool is\n * covered by 2026-11-23 — before the early-December 2026 exam. A unit test\n * simulates this rotation to keep the math provable.\n */",
    "/** Wiki folder (matched case-insensitively) holding the vocab pool notes. */",
    "/** Pool notes in deterministic order: IELTS first, then TOEFL. */",
    "/** Nominal 기출 pool size (310 IELTS + 332 TOEFL); the rotation math is sized for this. */",
    "/** First rotation day (UTC/KST calendar day `YYYY-MM-DD`). */",
    "/** Exam target: the rotation provably covers the pool before this day. */",
    "/** Default send times, `HH:MM` in KST (the user is on KST). */",
    "/** A slot counts as due for this long after its configured time. */",
    "/**\n * Parses one vocab pool note body. Accepts Markdown table rows shaped\n * `| word | meaning-Korean | example-English |`; skips the header row,\n * separator rows, and blank rows. Never throws on malformed input.\n */",
    "/** Whole days from VOCAB_START_DAY to `day` (`YYYY-MM-DD`); clamps at 0. */",
    "/**\n * Deterministic rotation: day `dayIndex`, slot `slotIndex` (0-2) takes 5\n * consecutive words starting at `(dayIndex * 15 + slotIndex * 5) % N`,\n * wrapping around the pool end.\n */",
    "/** All words scheduled for one day (the 3 slots concatenated, in order). */",
    "/** Current time in KST as a calendar day plus minutes since midnight. */",
    "/** Parses `HH:MM` into minutes since midnight; null when malformed. */",
    "/** True while inside the send window after a slot's configured time. */",
    "/** Master toggle for word + quiz pushes. Default off (CKCZ-27 convention). */",
    "/** Three word-push times, `HH:MM` KST. */",
    "/** Quiz-push time, `HH:MM` KST. */",
    "/** Sanitizes stored user input; garbage falls back to defaults per field. */",
    "/** Meta key caching one user's parsed vocab pool so cron ticks don't re-scan the giant notes. */",
    "/**\n * Lightweight checksum over pool-note identity + freshness + size. Content\n * is never read: the checksum query selects `length(content)`, so an\n * unchanged pool is detected without pulling the giant table bodies.\n */",
    "/**\n * Parses a cached pool; null on any garbage so callers fall through to a\n * fresh load. Strict on purpose: a partial word list would shift the\n * deterministic rotation, so one bad entry invalidates the whole cache.\n */",
    "/** Reads the 기출 pool for one user: IELTS note first, then TOEFL. */",
    "/**\n * CKCZ-31: cached pool read. The pool notes are giant (~3,600-word tables)\n * and the cron ticks 3x/hour, so every tick re-scanning them adds up. The\n * checksum query reads only id/updated_at/length — no bodies — and a cache\n * hit skips the full-content read entirely. One key per user (no per-day\n * fan-out); a pool edit changes the checksum and reloads on the next tick.\n * Best-effort throughout: cache failures fall through to a fresh load.\n */",
    "// Fall through to a fresh load.",
    "// A failed cache write must never fail the push.",
    "/** Builds one 5-word push; deep-links to the note contributing most words. */",
    "/** Prompt for the single daily quiz-generation LLM call. */",
    "/**\n * Cron entry: word pushes 3x/day + quiz push 1x/day per subscribed user.\n * Best-effort throughout — one user's failure never breaks other users or\n * the cron (mirrors how distill handles push errors). Never throws.\n */",
    "// No send when unsubscribed — and skip the pool/LLM work entirely.",
    "// CKCZ-31: one lazy pool load per tick, shared by the word slots and the",
    "// quiz slot. The old code re-read the giant pool notes per slot (up to 4",
    "// full-content reads/user/day); now a tick with N due slots reads once.",
    "// Mark unless the model transiently failed, so an over-budget or",
    "// unconfigured account still caps at one quiz attempt per day while a",
    "// flaky model gets retried on the next cron tick inside the window.",
    "// One LLM call/day: reserve from this user's daily budget first; an",
    "// over-budget member skips with a warning instead of starving others.",
  ]],
  ["src/worker/lib/web-push.test.ts", [
    "// Independent receiver side: ECDH with the client private key.",
  ]],
  ["src/worker/lib/web-push.ts", [
    "/**\n * Minimal Web Push sender (RFC 8291 aes128gcm + RFC 8292 VAPID) built only on\n * WebCrypto, so it runs under workerd. The Node-only `web-push` npm package\n * is intentionally NOT used (it needs Node crypto).\n *\n * VAPID key provisioning (owner, one time):\n *   1. Generate a P-256 pair, e.g. `npx --yes web-push generate-vapid-keys --json`\n *      (any tool that emits base64url keys works; see generateVapidKeyPair below\n *      for the exact key shapes: 65-byte uncompressed public starting with 0x04,\n *      32-byte private).\n *   2. `npx wrangler secret put VAPID_PUBLIC_KEY`  (base64url public key)\n *      `npx wrangler secret put VAPID_PRIVATE_KEY` (base64url private key)\n *      `npx wrangler secret put VAPID_SUBJECT`     (e.g. mailto:owner@example.com)\n */",
    "/** Raw 65-byte uncompressed P-256 public key. */",
    "/** Raw 32-byte P-256 private key. */",
    "/** Base64url-encoded public key, as shared with clients. */",
    "/** Returns null when the deployment has no VAPID keys configured. */",
    "/** Generates a fresh P-256 VAPID pair (handy for tests and local tooling). */",
    "/** Validates untrusted subscribe input; throws on anything malformed. */",
    "/**\n * Encrypts a payload per RFC 8291 (aes128gcm). Returns the exact HTTP body to\n * POST to the push endpoint.\n */",
    "/** Builds the `Authorization` header value for a push request (RFC 8292). */",
    "/** True when the subscription is gone upstream (404/410) and must be deleted. */",
    "/** Sends one encrypted push message. Never throws on HTTP errors. */",
  ]],
  ["src/worker/lib/youtube-clean.ts", [
    "/**\n * Helpers for YouTube captures.\n *\n * Raw YouTube page dumps are ~90% boilerplate: nav chrome, sidebar\n * recommendation cards, comments, shopping shelves and transcript sidebars.\n * Feeding all of that to distill wastes neurons and leaks unrelated video\n * titles/products into the summary. These pure helpers keep the header +\n * description (+ a real transcript when present) and drop the rest.\n */",
    "/** Markers where the useful body ends and sidebar/chrome begins. */",
    "/**\n * Pull a real transcript out of the dump when one exists.\n * Placeholder dumps (\"NaN / NaN\") and stubs under 200 chars are ignored.\n */",
    "/**\n * Keep the capture header + description, drop sidebar/comments/shopping\n * cards and image-only thumbnail lines. Appends a salvaged transcript when\n * the dump actually contains one.\n */",
    "// Never cut inside the transcript here — it is salvaged separately.",
    "// Drop nav chrome / bare links only before the description starts.",
    "/**\n * Compact replacement for the raw capture after a successful distill.\n * Keeps title + source URL so the note stays attributable and re-capturable,\n * and removes the multi-KB page dump.\n */",
  ]],
  ["src/worker/mcp/ai-search.ts", [
    "/**\n * Private AI semantic search for the MCP module.\n *\n * Notes are embedded with Workers AI (`@cf/baai/bge-m3`, 1024 dims,\n * multilingual) and the vectors live in D1 — no public query endpoint, one\n * index per account. Content changes are queued and drained in the\n * background; when the AI binding is missing or the model call fails the\n * feature degrades to plain lexical search instead of failing (the old\n * behavior that surfaced as HTTP 503s).\n */",
    "/**\n * CKCZ-31: per-query vector row ceiling (was 8,000). Semantic retrieval\n * loads every candidate vector into memory to score it, so each MCP/HTTP\n * search read up to 8k rows; 2k keeps recall for personal-size libraries\n * while cutting the worst case 4x.\n *\n * The ceiling applies to a cold load only: candidates are cached per isolate\n * (see `loadSemanticCandidates`) and refreshed from `MAX(indexed_at)`, so a\n * search normally re-reads just the vectors indexed since the previous one.\n * The newest 2,000 vectors are kept, which is what an order-by-recency window\n * of this size means for accounts above the ceiling.\n */",
    "// Stored in app_meta instead of a column on mcp_preferences: D1 does not",
    "// reliably support ALTER TABLE ADD COLUMN with constraints, and app_meta",
    "// exists on every database without any migration.",
    "/**\n * Queues a note for embedding (or vector deletion). The single row per note\n * uses last-write-wins semantics: a delete supersedes a pending embed and\n * vice versa. Queuing is skipped entirely while the account has AI search\n * disabled, except deletions which always clean up stale vectors.\n */",
    "/**\n * True when a write leaves the embedded text (title plus the head of the body)\n * unchanged, so the note does not have to be queued for embedding again. A\n * long note edited past that head keeps its vector, which is what the previous\n * drain would have computed for it anyway.\n */",
    "/**\n * Processes queued embedding jobs. Called from the hourly cron with a large\n * budget and from write paths (via waitUntil) with a small one. Items are\n * processed sequentially so Workers AI rate limits are respected; a failing\n * item stops the batch and is retried on the next run.\n */",
    "// The account turned AI search off; its queue would otherwise grow forever.",
    "/**\n * How many scored candidates are hydrated with note metadata. The window is\n * twice the result size so the `updated_at` tie-break still sees every note\n * that can reach the result list.\n */",
    "/**\n * Candidate-cache tunables. The cache holds decoded vectors per account and\n * filter combination inside one isolate; `MAX(indexed_at)` validates it, so a\n * TTL only bounds how long an unused entry may keep its memory.\n */",
    "/** Rows re-read to refresh a cached candidate set before falling back to a full load. */",
    "/** Drops every cached candidate set; tests use it to isolate runs. */",
    "/** Cache key for one account and filter combination. */",
    "/**\n * Semantic retrieval over the account's embedding index. Returns null when\n * AI is unavailable or the query embedding fails; the caller degrades to\n * lexical search.\n *\n * D1 cost per call, cheapest first: the account's vectors are pulled without\n * a `notes` join and only for the columns the scorer reads, cached per isolate\n * and refreshed from the rows indexed since the previous call; note metadata\n * (title, excerpt, rev, updated_at) is then fetched for the shortlist that can\n * reach the result window, not for every candidate vector.\n */",
    "// `updated_at` tie-break, matching the previous ranking contract.",
    "/**\n * Returns the account's candidates for these filters, reusing the isolate\n * cache when `MAX(indexed_at)` shows nothing new and otherwise appending only\n * the rows indexed since the cached snapshot.\n */",
    "/**\n * Vector rows for one account, newest first. The account's notes are only\n * joined when the query actually filters on note attributes, and then as an\n * existence probe on the primary key — the candidate projection never carries\n * note columns.\n */",
    "/** Note metadata for the shortlist only. */",
    "// ?1 is the account, ?2 the id list; filter placeholders follow them.",
    "/**\n * Folds rows indexed since the cached snapshot into it. Rows already cached\n * are replaced in place (re-embeds), new ones are merged by `indexed_at` so\n * the newest `MAX_SEMANTIC_VECTORS` survive and the order stays newest-first.\n */",
    "/**\n * Keeps the most recently used entries inside the entry-count and byte\n * budgets, and drops entries untouched for `SEMANTIC_CACHE_IDLE_TTL_MS`.\n */",
    "/**\n * Note-attribute filters over one alias, with placeholders starting at\n * `start`. Shared by the candidate probe and the metadata hydration so both\n * apply exactly the same filter contract.\n */",
    "/**\n * Reciprocal-rank fusion: merges two ranked lists into one by rank, so a\n * note that ranks well in both lexical and semantic search surfaces above\n * one that only appears in a single index.\n */",
    "/** Calls the Workers AI embedding model and returns a Float32Array. */",
    "/** Handles both the `{ data: [{ embedding }] }` and `{ shape, data }` shapes. */",
  ]],
  ["src/worker/mcp/api-keys.ts", [
    "/**\n * Static API keys for MCP access.\n *\n * Small or generic MCP clients (scripts, SDKs, unnamed agents) cannot run the\n * OAuth 2.1 dance, so they authenticate with a plain `Authorization: Bearer\n * <key>` header — the universal HTTP standard. The OAuth provider resolves\n * these tokens through its official `resolveExternalToken` hook; the key is\n * never stored or returned again, only its SHA-256 hash.\n */",
    "// 32 random bytes encoded as unpadded base64url is exactly 43 characters.",
    "/**\n * Resolves a bearer token to an account. Returns null for unknown, revoked,\n * or malformed keys so the OAuth provider can answer with 401 invalid_token.\n */",
  ]],
  ["src/worker/mcp/library.ts", [
    "/**\n * CKCZ-31: per-request full-content row ceiling for property queries (was\n * an uncapped-feeling 500). Each scanned row pulls the whole note body.\n */",
    "// CKCZ-31: this path reads every scanned note's full content (giant table",
    "// notes included), so an uncapped full-library scan per call is the",
    "// fastest way a mass MCP session burns the daily rows-read quota.",
  ]],
  ["src/worker/mcp/oauth.ts", [
    "// Static API keys let small or generic MCP clients authenticate with a",
    "// plain `Authorization: Bearer ink_...` header instead of running the",
    "// full OAuth 2.1 dance. Keys are hashed and revocable.",
    "// This path runs before the API handler, so ensure the schema exists",
    "// (cheap after the first request thanks to the initialization cache).",
  ]],
  ["src/worker/mcp/operations.ts", [
    "// The mutation itself failed before committing; remove the pending row",
    "// so the client can retry the same operation_id cleanly.",
    "// The mutation already committed. Keep the pending row so a retry goes",
    "// through the recovery path instead of re-executing and colliding",
    "// (e.g. create_note with the same id).",
  ]],
  ["src/worker/mcp/retrieval.ts", [
    "// CKCZ-26: capped lexical fallback window for the semantic-first path.",
    "// CKCZ-26: per-user daily search-call guard, same 429 style as the HTTP",
    "// search route (safeTool surfaces the ApiError to the MCP caller).",
    "// CKCZ-26: semantic-first. The old code always ran the lexical (FTS/LIKE)",
    "// scan before even trying semantic; now semantic runs first and the D1",
    "// lexical scan only runs as a capped fallback (or for explicit hybrid).",
    "// AI unavailable, rate-limited, or malformed response: degrade to lexical.",
    "// Semantic hit on the default path: skip the lexical D1 scan entirely.",
    "// CKCZ-31: never drain the FTS queue inline here. Draining re-indexes up",
    "// to 50 queued notes (full-content reads + FTS writes) per search, so a",
    "// mass MCP session of hundreds of searches/edits multiplies rows-read per",
    "// call. Indexing is covered by the hourly cron drain plus the write-path",
    "// scheduled drain — same split the HTTP search route already uses.",
  ]],
  ["src/worker/middleware/auth.ts", [
    "// Shortcut-friendly capture/distill/query/lint endpoints authenticate via Bearer ink_ token",
  ]],
  ["src/worker/routes/auth.ts", [
    "// Account-wide cap so a distributed botnet cannot retry one account",
    "// from many IPs forever; cleared on every successful sign-in, so a",
    "// normal user only ever notices it after 30 failed attempts per hour.",
    "// A successful sign-in proves this identity and IP are legitimate:",
    "// clear every throttling key (identity, IP, and account level) so a",
    "// shared IP / NAT is never locked out by a full window of attempts.",
  ]],
  ["src/worker/routes/capture.ts", [
    "// Dedicated shortcut-friendly endpoint: no X-Inkstone-Client header required,",
    "// accepts either session cookie (via loadSession) or Bearer ink_ token.",
    "// Reuse MCP write gate: user must have enabled writes",
    "// If token scopes are present, verify write scope separately in resolveCaptureUserId",
    "// Handle multipart audio upload (e.g., podcast file shared from iPhone)",
    "// base64",
    "// Normalize inputs: Shortcut sends {title, content, url, audio}",
    "// Handle base64 audio in JSON (e.g., {\"audio\":\"<base64>\", \"title\":\"...\"})",
    "// PDF handling: arXiv PDFs -> try HTML version via jina, other PDFs try jina with longer timeout",
    "// Fallback: try jina on original PDF URL with longer timeout (may be slow)",
    "// PDF text extraction failed, save URL with note",
    "// Audio handling: if url is an audio file or request contains audio data, transcribe via Workers AI Whisper",
    "// Server-side fetch via r.jina.ai so shortcut only needs to send URL (for articles/show notes)",
    "// Optional jina API key avoids 429 rate limits on Worker egress IPs",
    "// jina can be slow (15s+ for some sites); allow 25s",
    "// r.jina.ai returns markdown with title at top, keep it",
    "// Derive title from first line or url (after jina fetch, first line is often the title)",
    "// If title looks like markdown heading, strip leading #",
    "// Wrap url into content if not already present (template friendly)",
    "// arXiv's JS-only HTML reader renders as a \"Report GitHub Issue\" panel",
    "// (Content selection saved...) when the article fails to hydrate.",
    "// At minimum need write scope to create notes",
    "// verifyMcpApiKey returns scopes granted at key creation time",
  ]],
  ["src/worker/routes/distill.ts", [
    "// Manual shortcut-friendly endpoint: resolves the same way as /api/capture",
    "// (session cookie or Bearer ink_ token) so the Shortcut can trigger a distill.",
    "/**\n * Cron entry: distill a small, daily-capped batch of captured notes so the\n * free-tier neuron budget isn't exhausted by expensive generation calls.\n * Only processes once per UTC day; the manual route is uncapped.\n */",
    "// Per-user daily AI budget: an over-budget member is skipped here so their",
    "// rows never starve the shared neuron pool; other users still distill.",
    "// Refresh targets already-distilled notes that have not been refreshed yet.",
    "// Returns a human-readable reason when a note must NOT be distilled, else null.",
    "// YouTube page dumps are ~90% sidebar/comments/shopping boilerplate.",
    "// Clean before distill so unrelated videos and products don't leak in.",
    "// Reserve one AI call from this user's daily budget before hitting the",
    "// shared Workers AI pool; over-budget users skip without failing others.",
    "// YouTube notes: swap the multi-KB page dump for a compact stub so the",
    "// note stays attributable without keeping sidebar/comments/shopping junk.",
    "// First distill only — refresh targets already carry a trimmed (or stub) body.",
    "/**\n * Returns the exact text of an existing distilled `## Wiki` block — from the\n * heading through the `---` separator that precedes the raw capture. Used with\n * the `replace` operation instead of `replace_section`, which only truncates at\n * the next same-level heading (`## 핵심 요점`) and would leave stale distill\n * bodies behind. Returns undefined when no such block exists.\n */",
    "// YouTube/Google bot-wall pages captured instead of the video.",
  ]],
  ["src/worker/routes/lint.test.ts", [
    "// Marker at the very start: everything after it counts.",
    "// instr() is 1-based: pos 11 skips 10 chars plus the marker.",
  ]],
  ["src/worker/routes/lint.ts", [
    "// SQL-driven health check for the wiki (no LLM calls). The manual route and",
    "// the daily cron both compute the same report; saving it as a note is opt-in.",
    "// Manual health-check endpoint: same authentication as /api/capture.",
    "/**\n * Cron entry: produce a daily lint report note per account (One account — One\n * note per UTC day). Cheap to run (SQL only), so it piggybacks on the hourly\n * scheduler but self-caps to once a day via app_meta.\n */",
    "// CKCZ-49: a title containing `|` or a newline cannot survive the wikilink",
    "// parser, so linking it would create an unresolved link and a broken list",
    "// line. Only titles that round-trip become links; the rest are flattened.",
    "// These targets are unresolved by definition, so they stay plain text.",
    "/**\n * CKCZ-31: length of the raw-capture body after the `Markdown Content:`\n * marker, computed from SQL `length()`/`instr()` so lint never pulls full\n * note contents (giant table notes included) just to measure them. Off by\n * surrounding whitespace vs the old trimmed measure — display-only.\n */",
  ]],
  ["src/worker/routes/mcp-settings.ts", [
    "// Kick off the first batch immediately; the rest is drained by the cron.",
  ]],
  ["src/worker/routes/notes.ts", [
    "// An edit that leaves the embedded head of the note alone (typing at the",
    "// end of a long note) does not need a new embedding queue write.",
  ]],
  ["src/worker/routes/push.test.ts", [
    "/** Real P-256 points — raw fill bytes are not valid curve points. */",
  ]],
  ["src/worker/routes/push.ts", [
    "/** Public key for PushManager.subscribe(); safe to expose to signed-in users. */",
    "/**\n * Sends a payload to every subscription owned by one user. Best-effort: per\n * subscription errors are counted, expired endpoints (404/410 Gone) delete\n * their row, and the whole call never throws.\n */",
    "/**\n * CKCZ-28: per-user vocab/quiz push schedule. Member-isolated (keyed by the\n * caller's user id), default off; send times are `HH:MM` in KST.\n */",
    "/** Test-send: delivers a sample notification to the caller's own devices only. */",
    "/**\n * P1 trigger payload: distill completion deep-links straight to the note.\n * Call best-effort only — push must never fail a distill.\n */",
  ]],
  ["src/worker/routes/query.ts", [
    "// top-N per index for the RRF merge",
    "// Korean/English words that carry no retrieval signal. Both the lexical and",
    "// semantic searches AND their terms together, so a bare question word like",
    "// \"뭐고\" in \"CUPED가 뭐고 언제 쓰나\" would otherwise sink real keywords.",
    "// Strip a trailing Hangul particle/suffix from latin tokens (\"adjustment이\" -> \"adjustment\").",
    "// Manual shortcut-friendly endpoint: same authentication as /api/capture and",
    "// /api/distill (session cookie or Bearer ink_ token). Retrieves wiki notes,",
    "// then lets Workers AI synthesize an answer grounded only in those notes,",
    "// citing each one inline as [[노트 제목]] wikilinks.",
    "// Retrieve: merge lexical (FTS/LIKE) and AI semantic candidates by RRF so a",
    "// note ranking well in both indexes surfaces above single-index hits.",
    "// Load the source bodies so the model grounds itself in real note content.",
    "// Per-user daily AI budget: over-budget members get a 429 instead of",
    "// burning the shared neuron pool; retrieval above already ran without AI.",
  ]],
  ["src/worker/routes/search.ts", [
    "/**\n * CKCZ-26: FTS `MATCH` + `bm25()` scores every match before LIMIT runs, so a\n * large limit multiplies rows read per query. The FTS path is capped well\n * below the old route maximum (200).\n */",
    "/** Route-level ceiling for `GET /api/search` (was 200). */",
    "/** LIKE fallback over-fetch multiplier cap (was `limit * 3` up to 600). */",
    "/**\n * How many notes whose FTS entry is still settling are read straight from\n * `notes` to supplement an FTS result. Past this window the queue is treated\n * as a genuinely stale index (bulk import, fresh database) and the LIKE scan\n * takes over.\n */",
    "/**\n * Common English + Korean words with no retrieval signal. A query made only\n * of these would score the whole FTS index and return noise, so it skips\n * MATCH scoring and falls back to a bounded title-only LIKE scan instead.\n */",
    "/** True when every query term is a stop word (or there are no terms). */",
    "/** Strip the `tag:`/`folder:`/`is:`/`in:` qualifiers parseQuery already consumed. */",
    "/** True when the raw query carries no retrieval signal beyond stop words. */",
    "// CKCZ-26: a stop-word-only query would score the whole FTS index for",
    "// noise — skip MATCH and let likeSearch do a bounded title-only scan.",
    "// Settled rows only: a note that changed moments ago is read below rather",
    "// than re-indexed here, so a search never triggers a whole-note re-index.",
    "// A note queued for re-index is usually the one being written right",
    "// now. Reading those few notes directly keeps search current without",
    "// dropping to the full-table LIKE scan for a stale queue entry.",
    "// CKCZ-26: per-user daily search-call guard — over-budget callers get a",
    "// 429 instead of burning the account's D1 rows-read quota.",
    "// CKCZ-26: stop-word-only queries scan titles only (bounded, no full-body",
    "// LIKE); real queries keep the title+content scan but with a smaller",
    "// over-fetch window than the old `limit * 3` up to 600.",
    "/**\n * Adds hits from the notes still queued for FTS indexing to an FTS result.\n * Only those note ids are scanned, so a note that is one settle window behind\n * the index still answers the query without the whole-table LIKE fallback.\n */",
    "/** LIKE match restricted to the given note ids. */",
  ]],
  ["src/worker/routes/sync.ts", [
    "// CKCZ-26 counted every poll with an app_meta UPSERT per user per day; that",
    "// per-poll D1 write is gone, so polling this endpoint now costs reads only.",
    "// A non-empty `after` key always means the caller is mid-way through a",
    "// full snapshot page chain; keep serving snapshot pages regardless of",
    "// `since`, so following the returned nextKey can never silently drop",
    "// remaining pages.",
    "// Never move the client's cursor backwards, even if it reported a",
    "// seq ahead of the server (e.g. data was trimmed).",
  ]],
  ["tests/fts-drain-burst.test.ts", [
    "// A save arrives during this drain and re-arms the window.",
  ]],
  ["tests/fts-index-skip.test.ts", [
    "/** Minimal D1 stand-in: records the statements the builder prepares. */",
    "/** Body longer than the indexed window, with the edit placed past it. */",
  ]],
  ["tests/mcp-semantic-search.test.ts", [
    "/**\n * D1 stand-in: answers each statement from the first matching route, records\n * every call, and counts the rows the code actually pulled out of it.\n */",
    "// enabled flag (1) + version probe (1) + vectors (3) + hydration (3).",
    "// The same call against the old query was enabled (1) + one joined row per",
    "// candidate (3 embeddings + 3 notes).",
    "// Second search in the same isolate: same fake database, no new vector read.",
    "// enabled flag (1) + version probe (1) + hydration (3), no vector rows.",
    "// The account indexes one more note; only that row comes back.",
  ]],
  ["vite.config.ts", [
    "// Keep optional preview renderers and their language modules behind dynamic-import boundaries.",
  ]],
])
const found = new Map()
const failures = []
const roots = ['src', 'scripts', 'tests']
const files = [
  ...roots.filter((root) => fs.existsSync(root)).flatMap((root) => [...walk(path.resolve(root))]),
  ...['vite.config.ts', 'vitest.config.ts', 'index.html', 'wrangler.toml'].map((file) => path.resolve(file)),
]

for (const file of files) {
  const extension = path.extname(file).toLowerCase()
  const text = fs.readFileSync(file, 'utf8')
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) scanScript(file, text)
  else if (extension === '.css') scanCss(file, text)
  else if (extension === '.html' && /<!--[\s\S]*?-->/.test(text)) failures.push(`${relative(file)} contains an HTML comment`)
  else if (extension === '.toml' && /^[ \t]*#/m.test(text)) failures.push(`${relative(file)} contains a TOML comment`)
}

let approvedCount = 0
for (const [file, comments] of allowed) {
  approvedCount += comments.length
  const seen = found.get(file)
  for (const comment of comments) {
    if (!seen?.has(comment)) {
      failures.push(`${file} no longer contains an approved comment; remove it from the allowlist: ${preview(comment)}`)
    }
  }
}

if (failures.length) {
  console.error(`comment policy check failed (${failures.length}):`)
  failures.forEach((failure) => console.error(`  ${failure}`))
  process.exit(1)
}

console.log(`comment policy check passed: ${approvedCount} approved English architecture notes across ${allowed.size} files and no other code comments`)

function scanScript(file, text) {
  const scriptKind = file.endsWith('.tsx') || file.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind)
  const literalRanges = []
  collectLiterals(source)
  literalRanges.sort((left, right) => left.start - right.start)

  const comments = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g
  for (const match of text.matchAll(comments)) {
    if (!insideLiteral(match.index)) check(file, match[0])
  }

  function collectLiterals(node) {
    if (
      ts.isRegularExpressionLiteral(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) literalRanges.push({ start: node.getStart(source), end: node.getEnd() })
    ts.forEachChild(node, collectLiterals)
  }

  function insideLiteral(index) {
    return literalRanges.some((range) => index >= range.start && index < range.end)
  }
}

function scanCss(file, text) {
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) check(file, match[0])
}

function check(file, comment) {
  if (DIRECTIVE.test(comment)) return
  const name = relative(file)
  if (!allowed.get(name)?.includes(comment)) {
    failures.push(`${name} contains an unapproved code comment: ${preview(comment)}`)
    return
  }
  const seen = found.get(name) ?? new Set()
  seen.add(comment)
  found.set(name, seen)
}

function preview(comment) {
  const flat = comment.replace(/\s+/g, ' ').trim()
  return flat.length > 96 ? `${flat.slice(0, 96)}...` : flat
}

function relative(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(target)
    else yield target
  }
}
