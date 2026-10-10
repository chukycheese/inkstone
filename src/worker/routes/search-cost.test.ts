import { describe, expect, it } from 'vitest'
import {
  FTS_MAX_LIMIT,
  isStopwordOnlyQuery,
  isStopwordOnlyRaw,
  LIKE_CANDIDATE_HARD_CAP,
  LIKE_CANDIDATE_MULTIPLIER,
  parseQuery,
  SEARCH_ROUTE_MAX_LIMIT,
} from './search'

describe('FTS cost caps (CKCZ-26)', () => {
  it('caps the FTS path and the route below the old 200 limit', () => {
    expect(FTS_MAX_LIMIT).toBeLessThanOrEqual(50)
    expect(SEARCH_ROUTE_MAX_LIMIT).toBeLessThanOrEqual(50)
  })

  it('bounds the LIKE fallback over-fetch window', () => {
    expect(LIKE_CANDIDATE_MULTIPLIER).toBeLessThanOrEqual(2)
    expect(LIKE_CANDIDATE_HARD_CAP).toBeLessThanOrEqual(100)
  })
})

describe('isStopwordOnlyQuery', () => {
  it('flags single common-word queries in English and Korean', () => {
    expect(isStopwordOnlyQuery(parseQuery('the'))).toBe(true)
    expect(isStopwordOnlyQuery(parseQuery('what is'))).toBe(true)
    expect(isStopwordOnlyQuery(parseQuery('무엇'))).toBe(true)
    expect(isStopwordOnlyQuery(parseQuery('이'))).toBe(true)
  })

  it('keeps real queries on the FTS path', () => {
    expect(isStopwordOnlyQuery(parseQuery('cuped 분산'))).toBe(false)
    expect(isStopwordOnlyQuery(parseQuery('the quicksilver notebook'))).toBe(false)
    expect(isStopwordOnlyQuery(parseQuery('tag:ai 회의'))).toBe(false)
  })

  it('treats an empty query as stop-word-only', () => {
    expect(isStopwordOnlyQuery(parseQuery(''))).toBe(true)
  })
})

describe('isStopwordOnlyRaw', () => {
  it('detects stop-word-only raw input before parsing', () => {
    expect(isStopwordOnlyRaw('the')).toBe(true)
    expect(isStopwordOnlyRaw('  ')).toBe(true)
    expect(isStopwordOnlyRaw('CUPED가 뭐고 언제 쓰나')).toBe(false)
  })
})
