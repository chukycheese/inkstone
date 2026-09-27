/**
 * Helpers for YouTube captures.
 *
 * Raw YouTube page dumps are ~90% boilerplate: nav chrome, sidebar
 * recommendation cards, comments, shopping shelves and transcript sidebars.
 * Feeding all of that to distill wastes neurons and leaks unrelated video
 * titles/products into the summary. These pure helpers keep the header +
 * description (+ a real transcript when present) and drop the rest.
 */

const YOUTUBE_URL_RE = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?[^ \n]*v=|youtu\.be\/)[\w-]{6,}/i

export function isYouTubeCapture(title: string, content: string): boolean {
  return YOUTUBE_URL_RE.test(title ?? '') || YOUTUBE_URL_RE.test(content ?? '')
}

export function extractUrlSource(content: string): string | undefined {
  const match = /^URL Source:\s*(\S+)/m.exec(content ?? '')
  return match?.[1]
}

const DESCRIPTION_HEADING_RE = /^##\s+Description\s*$/
const TRANSCRIPT_HEADING_RE = /^##\s+Transcript\s*$/

/** Markers where the useful body ends and sidebar/chrome begins. */
const CUT_MARKERS: RegExp[] = [
  /^##\s+(Comments|Products|Shop)\b/,
  /^##\s+In this video\b/,
  /^Shop the .* store\b/,
  /^How this was made\b/,
  /^Show less\b/,
]

const MORE_TAIL_RE = /^(\.\.\.more.*|…+\s*more.*|Show more.*)$/i
const IMAGE_ONLY_LINE_RE = /^!\[Image \d+[^\]]*\]\([^)]*\)\s*$/
const BARE_LINK_LINE_RE = /^\[.*\]\(https?:\/\/[^)]*\)\s*$/
const NAV_JUNK_RE =
  /^(Back|Skip navigation|Search|Search with your voice|Tap to unmute|Cancel|Confirm|Share|Copy link|Info|Shopping|Subscribe(d)?|Like|Dislike|Save|Download)\s*(\[.*\})?\s*$/

function isCutLine(line: string): boolean {
  const trimmed = line.trim()
  return CUT_MARKERS.some((re) => re.test(trimmed)) || MORE_TAIL_RE.test(trimmed)
}

/**
 * Pull a real transcript out of the dump when one exists.
 * Placeholder dumps ("NaN / NaN") and stubs under 200 chars are ignored.
 */
export function extractTranscript(body: string, maxChars = 3000): string | undefined {
  const lines = (body ?? '').split('\n')
  const idx = lines.findIndex((line) => TRANSCRIPT_HEADING_RE.test(line.trim()))
  if (idx < 0) return undefined
  const kept: string[] = []
  let size = 0
  for (let i = idx + 1; i < lines.length && size < maxChars; i++) {
    const trimmed = lines[i].trim()
    if (/^##\s+\S/.test(trimmed) || isCutLine(lines[i])) break
    if (!trimmed) continue
    kept.push(lines[i])
    size += lines[i].length + 1
  }
  const text = kept.join('\n').trim()
  if (text.length < 200 || /^NaN\b/.test(text)) return undefined
  return text.slice(0, maxChars)
}

/**
 * Keep the capture header + description, drop sidebar/comments/shopping
 * cards and image-only thumbnail lines. Appends a salvaged transcript when
 * the dump actually contains one.
 */
export function cleanYoutubeBody(body: string): string {
  const lines = (body ?? '').split('\n')
  const descIdx = lines.findIndex((line) => DESCRIPTION_HEADING_RE.test(line.trim()))

  let end = lines.length
  const scanFrom = descIdx >= 0 ? descIdx + 1 : 0
  for (let i = scanFrom; i < lines.length; i++) {
    // Never cut inside the transcript here — it is salvaged separately.
    if (TRANSCRIPT_HEADING_RE.test(lines[i].trim())) continue
    if (isCutLine(lines[i])) {
      end = i
      break
    }
  }

  const head = lines
    .slice(0, end)
    .filter((line) => !IMAGE_ONLY_LINE_RE.test(line.trim()))
    .filter((line, index) => {
      // Drop nav chrome / bare links only before the description starts.
      if (descIdx >= 0 && index >= descIdx) return true
      const trimmed = line.trim()
      return !NAV_JUNK_RE.test(trimmed) && !BARE_LINK_LINE_RE.test(trimmed)
    })

  const transcript = extractTranscript(body)
  const out = head.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return transcript ? `${out}\n\n## Transcript\n${transcript}`.trim() : out
}

/**
 * Compact replacement for the raw capture after a successful distill.
 * Keeps title + source URL so the note stays attributable and re-capturable,
 * and removes the multi-KB page dump.
 */
export function buildTrimmedStub(title: string, urlSource: string | undefined, originalChars: number): string {
  const lines = [`Title: ${title}`.trim()]
  if (urlSource) lines.push('', `URL Source: ${urlSource}`)
  lines.push(
    '',
    `> Raw capture trimmed after distill (was ${originalChars} chars). Re-capture the URL to restore the full body.`,
  )
  return lines.join('\n')
}
