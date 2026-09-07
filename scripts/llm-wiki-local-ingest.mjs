#!/usr/bin/env node
// Local ingest helper: POST /api/capture via Bearer ink_ token
// Usage:
//   node scripts/llm-wiki-local-ingest.mjs --base http://localhost:7712 --token ink_... --url https://example.com
//   node scripts/llm-wiki-local-ingest.mjs --base http://localhost:7712 --token ink_... --file ./draft.md --title "My Concept" --folder-id <id>

import { readFileSync } from 'node:fs'

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  return process.argv[i + 1]
}
function has(name) { return process.argv.includes(`--${name}`) }

const base = (arg('base') ?? process.env.INKSTONE_BASE ?? 'http://localhost:7712').replace(/\/$/, '')
const token = arg('token') ?? process.env.INKSTONE_API_TOKEN ?? ''
const url = arg('url')
const file = arg('file')
const title = arg('title')
const folderId = arg('folder-id') ?? arg('folderId') ?? null

if (!token) {
  console.error('Missing --token or INKSTONE_API_TOKEN (ink_...)')
  process.exit(1)
}
if (!url && !file) {
  console.error('Provide --url https://... or --file ./path.md')
  process.exit(1)
}

let content
if (file) {
  content = readFileSync(file, 'utf8')
  if (!content.trim()) { console.error(`Empty file: ${file}`); process.exit(1) }
}

const body = {}
if (url) body.url = url
if (content) body.content = content
if (title) body.title = title
if (folderId) body.folderId = folderId

console.log(`[ingest] POST ${base}/api/capture`, JSON.stringify({ ...body, content: content ? `${content.slice(0,60)}...(${content.length})` : undefined }))

const res = await fetch(`${base}/api/capture`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const data = await res.json().catch(() => null)
console.log(`[ingest] ${res.status}`, JSON.stringify(data, null, 2))
if (!res.ok) process.exit(1)
if (data?.note?.id) console.log(`[ingest] note: ${base}/n/${data.note.id}  id=${data.note.id}`)
