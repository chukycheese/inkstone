import { describe, expect, it } from 'vitest'
import { DISTILL_SOURCE_MARKER, pendingDistillLength, renderReportMarkdown, type LintReport } from './lint'

describe('pendingDistillLength (CKCZ-31)', () => {
  it('measures the body after the marker without reading content', () => {
    const markerLen = DISTILL_SOURCE_MARKER.length
    // Marker at the very start: everything after it counts.
    expect(pendingDistillLength(100, 1)).toBe(100 - markerLen)
    // instr() is 1-based: pos 11 skips 10 chars plus the marker.
    expect(pendingDistillLength(100, 11)).toBe(100 - 10 - markerLen)
  })

  it('falls back to the full length when the marker position is missing', () => {
    expect(pendingDistillLength(100, 0)).toBe(100)
    expect(pendingDistillLength(100, -5)).toBe(100)
  })

  it('clamps garbage to zero instead of going negative', () => {
    expect(pendingDistillLength(5, 100)).toBe(0)
    expect(pendingDistillLength(0, 1)).toBe(0)
    expect(pendingDistillLength(-3, 1)).toBe(0)
    expect(pendingDistillLength(Number.NaN, 1)).toBe(0)
  })
})

function reportWith(orphans: Array<{ note_id: string; title: string; updated_at: number }>): LintReport {
  return {
    generated_at: Date.UTC(2026, 10, 19),
    total_notes: 1,
    total_words: 10,
    uncategorized: 0,
    by_folder: [],
    pending_distill: [],
    broken_notes: [],
    orphan_notes: orphans,
    unresolved_links: 0,
    ai_budget: { day: '2026-11-19', used: 0, cap: 30, remaining: 30 },
    search_budget: { day: '2026-11-19', used: 0, cap: 500, remaining: 500 },
    sync_polls: { day: '2026-11-19', count: 0 },
  }
}

describe('renderReportMarkdown orphan links (CKCZ-49)', () => {
  const orphan = (title: string) => ({ note_id: 'n1', title, updated_at: 0 })

  it('links a title that survives the wikilink parser', () => {
    const markdown = renderReportMarkdown(reportWith([orphan('The product loop')]))
    expect(markdown).toContain('- [[The product loop]]')
  })

  it('does not emit a broken link when the title contains a pipe', () => {
    const markdown = renderReportMarkdown(reportWith([orphan('The product loop | Confidence by Spotify')]))
    expect(markdown).not.toContain('[[')
    expect(markdown).toContain('- The product loop | Confidence by Spotify')
  })

  it('flattens a newline title onto one plain-text line', () => {
    const markdown = renderReportMarkdown(
      reportWith([orphan('Source: Data Makes Our Future\nhttps://share.google/rC6Qb9wfCUTYN8MK6')]),
    )
    expect(markdown).not.toContain('[[')
    expect(markdown).toContain('- Source: Data Makes Our Future https://share.google/rC6Qb9wfCUTYN8MK6')
  })

  it('labels an empty title instead of rendering [[ ]]', () => {
    const markdown = renderReportMarkdown(reportWith([orphan('')]))
    expect(markdown).not.toContain('[[')
    expect(markdown).toContain('- _(제목 없음)_')
  })
})
