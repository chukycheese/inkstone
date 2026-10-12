import { describe, expect, it } from 'vitest';
import {
  collectBlockStartLines,
  countContentLines,
  findEditableBlock,
  isInteractivePreviewTarget,
  replaceBlockLines,
  resolveBlockEnd,
  sliceBlockLines,
  splitContentLines,
} from './block-edit';

describe('preview block editing', () => {
  it('slices and replaces a middle block without touching neighbors', () => {
    const source = '# Title\n\nFirst paragraph\nstill first\n\nSecond paragraph\n';
    expect(sliceBlockLines(source, 2, 4)).toBe('First paragraph\nstill first');
    const next = replaceBlockLines(source, 2, 4, 'Rewritten');
    expect(next).toBe('# Title\n\nRewritten\n\nSecond paragraph\n');
  });

  it('expands a block when the draft grows and shrinks it when it shrinks', () => {
    const source = 'a\n\nb\n\nc';
    expect(replaceBlockLines(source, 2, 3, 'b1\nb2\nb3')).toBe('a\n\nb1\nb2\nb3\n\nc');
    expect(replaceBlockLines(source, 0, 1, '')).toBe('\nb\n\nc');
  });

  it('normalizes CRLF drafts and never corrupts on invalid ranges', () => {
    const source = 'a\nb';
    expect(replaceBlockLines(source, 1, 2, 'x\r\ny')).toBe('a\nx\ny');
    expect(replaceBlockLines(source, -1, 1, 'x')).toBe(source);
    expect(replaceBlockLines(source, 2, 1, 'x')).toBe(source);
    expect(replaceBlockLines(source, 9, 10, 'x')).toBe(source);
    expect(replaceBlockLines(source, 0, 99, 'only')).toBe('only');
  });

  it('counts and splits lines consistently, including empty notes', () => {
    expect(splitContentLines('')).toEqual([]);
    expect(countContentLines('')).toBe(0);
    expect(countContentLines('a\nb\n')).toBe(3);
    expect(sliceBlockLines('', 0, 0)).toBe('');
  });

  it('resolves block ends from sibling starts or EOF', () => {
    expect(resolveBlockEnd([0, 2, 5], 2, 8)).toBe(5);
    expect(resolveBlockEnd([0, 2, 5], 5, 8)).toBe(8);
    expect(resolveBlockEnd([], 0, 0)).toBe(1);
    expect(resolveBlockEnd([0], 0, 3)).toBe(3);
  });

  it('maps clicks to the top-level block and skips interactive targets', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<h1 data-line="0">Title <a data-wikilink="eA" href="#">link</a></h1>' +
      '<div class="table-wrap" data-line="2"><table><tr><td>cell</td></tr></table></div>' +
      '<p data-line="5">plain</p>';
    const [starts, cell, link, plain] = [
      collectBlockStartLines(host),
      host.querySelector('td')!,
      host.querySelector('a')!,
      host.querySelector('p')!,
    ];
    expect(starts).toEqual([0, 2, 5]);
    expect(findEditableBlock(host, cell)?.dataset.line).toBe('2');
    expect(findEditableBlock(host, plain)?.dataset.line).toBe('5');
    expect(findEditableBlock(host, host)).toBeNull();
    expect(isInteractivePreviewTarget(link)).toBe(true);
    expect(isInteractivePreviewTarget(cell)).toBe(false);
    expect(isInteractivePreviewTarget(plain)).toBe(false);
    const outsider = document.createElement('span');
    expect(findEditableBlock(host, outsider)).toBeNull();
  });
});
