/**
 * Autosave scheduling for the editor.
 *
 * Short notes save on the user's own `autoSaveDelay`. Long notes add delay as
 * they grow: every save sends the whole body and queues a full-text re-index of
 * it, so typing at the end of a 100k-character note would otherwise cost the
 * same as a fresh paragraph every time the writer pauses. The extra delay is
 * bounded, and content is written to the local outbox on every keystroke, so a
 * longer debounce never risks the draft.
 */

/** Notes at or below this size save exactly on the user's configured delay. */
export const AUTOSAVE_LONG_NOTE_CHARS = 8_000
/** Characters of growth that add one `AUTOSAVE_GROWTH_STEP_MS` of delay. */
export const AUTOSAVE_GROWTH_CHARS = 8_000
export const AUTOSAVE_GROWTH_STEP_MS = 250
/** Ceiling on the added delay. */
export const AUTOSAVE_EXTRA_MAX_MS = 1_500

export function autosaveDelayMs(baseDelayMs: number, contentChars: number): number {
  const base = Number.isFinite(baseDelayMs) ? Math.max(100, Math.trunc(baseDelayMs)) : 100
  if (!Number.isFinite(contentChars) || contentChars <= AUTOSAVE_LONG_NOTE_CHARS) return base
  const steps = Math.floor((contentChars - AUTOSAVE_LONG_NOTE_CHARS) / AUTOSAVE_GROWTH_CHARS) + 1
  return base + Math.min(AUTOSAVE_EXTRA_MAX_MS, steps * AUTOSAVE_GROWTH_STEP_MS)
}
