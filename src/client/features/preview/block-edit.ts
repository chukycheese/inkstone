/** Pure helpers for per-block click-to-edit inside the reading preview.
 *
 * Blocks map to Markdown source lines: the renderer stamps top-level preview
 * elements with `data-line` (0-based start line). The end line is derived from
 * the next sibling block's start line, falling back to the total line count.
 * All edits splice plain source lines so the existing revision-safe
 * `editContent` path stays the single writer.
 */

export function splitContentLines(source: string): string[] {
  if (source === '') return [];
  return source.split('\n');
}

export function countContentLines(source: string): number {
  if (source === '') return 0;
  return source.split('\n').length;
}

/** Slice the half-open `[startLine, endLine)` range; out-of-range ends clamp. */
export function sliceBlockLines(source: string, startLine: number, endLine: number): string {
  const lines = splitContentLines(source);
  const from = clampLine(startLine, 0, lines.length);
  const to = clampLine(endLine, from, lines.length);
  return lines.slice(from, to).join('\n');
}

/**
 * Replace the half-open `[startLine, endLine)` range with draft lines.
 * Returns the original source untouched when the range is invalid, so callers
 * can never corrupt a note from a stale block anchor.
 */
export function replaceBlockLines(
  source: string,
  startLine: number,
  endLine: number,
  draft: string,
): string {
  const lines = splitContentLines(source);
  const total = lines.length;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return source;
  if (startLine < 0 || endLine < startLine || startLine > total) return source;
  const to = Math.min(endLine, total);
  const draftLines = draft === '' ? [] : draft.replace(/\r\n?/g, '\n').split('\n');
  return [...lines.slice(0, startLine), ...draftLines, ...lines.slice(to)].join('\n');
}

/** End line for the block starting at `startLine`: next sibling start or EOF. */
export function resolveBlockEnd(startLines: number[], startLine: number, totalLines: number): number {
  let next: number | null = null;
  for (const line of startLines) {
    if (line > startLine && (next === null || line < next)) next = line;
  }
  return Math.max(startLine + 1, next ?? Math.max(totalLines, startLine + 1));
}

export function collectBlockStartLines(host: HTMLElement): number[] {
  const starts: number[] = [];
  for (const child of host.children) {
    if (!(child instanceof HTMLElement)) continue;
    const value = Number(child.dataset.line);
    if (Number.isInteger(value) && value >= 0) starts.push(value);
  }
  return starts;
}

/**
 * Map a click target to the top-level preview block being edited. Nested
 * `data-line` elements (tables, callouts) ascend to the direct child of the
 * preview host so one tap edits exactly the visible block.
 */
export function findEditableBlock(host: HTMLElement, target: HTMLElement): HTMLElement | null {
  const anchored = target.closest('[data-line]');
  if (!(anchored instanceof HTMLElement) || !host.contains(anchored)) return null;
  let node: HTMLElement = anchored;
  while (node.parentElement && node.parentElement !== host) {
    const parent = node.parentElement;
    if (!(parent instanceof HTMLElement)) return null;
    node = parent;
  }
  if (node.parentElement !== host || !node.hasAttribute('data-line')) return null;
  return node;
}

const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'img',
  '[role="tab"]',
  '[data-tab-button]',
  '[data-copy]',
  '[data-code-collapse]',
  '[data-mermaid-retry]',
  '[data-wikilink]',
  '[data-block-ref]',
  '[data-tag]',
].join(', ');

/** Links, media, tasks, tabs and toolbar buttons keep their own behavior. */
export function isInteractivePreviewTarget(target: HTMLElement): boolean {
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

function clampLine(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
