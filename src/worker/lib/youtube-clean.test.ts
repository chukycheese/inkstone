import { describe, expect, it } from 'vitest'
import {
  buildTrimmedStub,
  cleanYoutubeBody,
  extractTranscript,
  extractUrlSource,
  isYouTubeCapture,
} from './youtube-clean'

const SAMPLE_BODY = [
  'Title: 15 Min Morning Mobility | The Only Yoga Routine You Need',
  '',
  'URL Source: http://www.youtube.com/watch?v=UBj5mc7MHCw',
  '',
  'Markdown Content:',
  'Back [![Image 1](http://www.youtube.com/watch?v=UBj5mc7MHCw)](http://www.youtube.com/ "YouTube Home") PH',
  '',
  'Skip navigation',
  '',
  '[](http://www.youtube.com/watch?v=UBj5mc7MHCw)',
  '',
  '## 15 Min Morning Mobility | The Only Yoga Routine You Need',
  '',
  'Pacific Yoga 53K views 1mo ago',
  '',
  '## Description',
  '',
  'A gentle morning routine to wake up the whole body in 15 minutes.',
  '',
  '...more Show less',
  '',
  '## Transcript',
  '',
  'NaN / NaN',
  '',
  '[![Image 15](https://i.ytimg.com/vi/abc/hqdefault.jpg)](http://www.youtube.com/watch?v=abc)',
  '',
  '### [Unrelated Video](http://www.youtube.com/watch?v=abc)',
  '',
  'Some Channel 100K views',
  '',
  '## Comments',
  '',
  '## Comments 5',
  '',
  '## Products',
  '',
  'Breathe and Flow tagged products below.',
].join('\n')

describe('isYouTubeCapture', () => {
  it('detects watch and youtu.be URLs in title or content', () => {
    expect(isYouTubeCapture('https://youtube.com/watch?v=abc123&si=x', '')).toBe(true)
    expect(isYouTubeCapture('', 'see https://youtu.be/abc123 for details')).toBe(true)
    expect(isYouTubeCapture('https://example.com/article', 'plain text')).toBe(false)
  })
})

describe('extractUrlSource', () => {
  it('pulls the URL Source line', () => {
    expect(extractUrlSource(SAMPLE_BODY)).toBe('http://www.youtube.com/watch?v=UBj5mc7MHCw')
    expect(extractUrlSource('no source here')).toBeUndefined()
  })
})

describe('cleanYoutubeBody', () => {
  it('keeps header and description while dropping sidebar, comments and products', () => {
    const cleaned = cleanYoutubeBody(SAMPLE_BODY)
    expect(cleaned).toContain('A gentle morning routine')
    expect(cleaned).toContain('Pacific Yoga 53K views')
    expect(cleaned).not.toContain('Unrelated Video')
    expect(cleaned).not.toContain('## Comments')
    expect(cleaned).not.toContain('tagged products below')
    expect(cleaned).not.toContain('![Image 15]')
    expect(cleaned).not.toContain('Skip navigation')
  })
})

describe('extractTranscript', () => {
  it('ignores placeholder transcripts', () => {
    expect(extractTranscript(SAMPLE_BODY)).toBeUndefined()
  })

  it('keeps real transcripts up to the cap', () => {
    const talk = Array.from({ length: 60 }, (_, i) => `sentence number ${i} about mobility and breath`).join('\n')
    const body = `## Transcript\n\n${talk}\n\n## Comments\n\nnoise`
    const result = extractTranscript(body, 500)
    expect(result).toBeDefined()
    expect(result!.length).toBeLessThanOrEqual(500)
    expect(result).toContain('sentence number 0')
    expect(result).not.toContain('noise')
  })
})

describe('buildTrimmedStub', () => {
  it('keeps title and source while recording the trimmed size', () => {
    const stub = buildTrimmedStub('Some Video', 'http://www.youtube.com/watch?v=xyz', 31234)
    expect(stub).toContain('Title: Some Video')
    expect(stub).toContain('URL Source: http://www.youtube.com/watch?v=xyz')
    expect(stub).toContain('31234')
    expect(stub).not.toContain('Markdown Content:')
  })
})
