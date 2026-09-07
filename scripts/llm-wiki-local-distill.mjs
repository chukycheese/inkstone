#!/usr/bin/env node
// Local distill helper: POST /api/distill via Bearer ink_ token
// Usage:
//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --dry-run
//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --dry-run --folder-id <id>
//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --limit 3
//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --note-id <note_id>
//   node scripts/llm-wiki-local-distill.mjs --base http://localhost:7712 --token ink_... --limit 1 --folder-id <id>

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  return process.argv[i + 1]
}
const base = (arg('base') ?? process.env.INKSTONE_BASE ?? 'http://localhost:7712').replace(/\/$/, '')
const token = arg('token') ?? process.env.INKSTONE_API_TOKEN ?? ''
const dryRun = process.argv.includes('--dry-run')
const noteId = arg('note-id') ?? arg('noteId')
const folderId = arg('folder-id') ?? arg('folderId')
const limit = arg('limit') ? Number(arg('limit')) : undefined

if (!token) { console.error('Missing --token or INKSTONE_API_TOKEN'); process.exit(1) }

async function call(body) {
  const res = await fetch(`${base}/api/distill`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(async () => ({ raw: await res.text().catch(()=> '') }))
  return { status: res.status, data }
}

if (dryRun) {
  const body = { dry_run: true }
  if (folderId) body.folder_id = folderId
  if (limit) body.limit = limit
  console.log(`[distill dry_run] POST ${base}/api/distill`, body)
  const { status, data } = await call(body)
  console.log(`[distill dry_run] ${status}`, JSON.stringify(data, null, 2))
  if (data?.candidates) {
    console.log(`[distill dry_run] candidates=${data.candidates.length}`)
    for (const c of data.candidates) console.log(` - ${c.title} (${c.note_id}) ${c.length} chars  excerpt: ${c.excerpt.slice(0,80)}`)
  }
  process.exit(status >= 200 && status < 300 ? 0 : 1)
}

if (noteId) {
  console.log(`[distill] note_id=${noteId}`)
  const { status, data } = await call({ note_id: noteId })
  console.log(`[distill] ${status}`, JSON.stringify(data, null, 2))
  process.exit(status >= 200 && status < 300 && data?.ok ? 0 : 1)
}

// batch — sequential to avoid neuron burst
const lim = Math.min(10, Math.max(1, limit ?? 1))
const body = { limit: lim }
if (folderId) body.folder_id = folderId
console.log(`[distill] batch limit=${lim} folder_id=${folderId ?? '(all)'} -> POST ${base}/api/distill`)
const { status, data } = await call(body)
console.log(`[distill] ${status}`, JSON.stringify(data, null, 2))
if (data?.results) {
  for (const r of data.results) {
    console.log(` ${r.ok ? '✓' : '✗'} ${r.title} (${r.note_id}) ${r.ok ? `bytes=${r.bytes} model=${r.model ?? '?'}` : `error=${r.error ?? r.reason}`}`)
  }
  console.log(`[distill] processed=${data.processed}/${data.results.length} ok=${data.ok}`)
}
process.exit(status >= 200 && status < 300 ? 0 : 1)
