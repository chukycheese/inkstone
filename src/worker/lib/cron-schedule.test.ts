import { describe, expect, it } from 'vitest'
import {
  HOURLY_CRON,
  MAINTENANCE_UTC_HOURS,
  cronUtcHour,
  shouldRunBackupSweep,
  shouldRunMaintenance,
} from './cron-schedule'

function utcHour(hour: number, minute = 0): number {
  return Date.UTC(2026, 10, 18, hour, minute, 0)
}

describe('cronUtcHour', () => {
  it('reads the hour from scheduledTime, not from the wall clock', () => {
    expect(cronUtcHour({ cron: HOURLY_CRON, scheduledTime: utcHour(13) }, utcHour(3))).toBe(13)
  })

  it('falls back to now when the trigger carries no usable timestamp', () => {
    expect(cronUtcHour({ cron: HOURLY_CRON }, utcHour(7))).toBe(7)
    expect(cronUtcHour({ scheduledTime: 0 }, utcHour(7))).toBe(7)
    expect(cronUtcHour({ scheduledTime: Number.NaN }, utcHour(7))).toBe(7)
  })
})

describe('shouldRunBackupSweep', () => {
  it('runs on every hourly trigger so hourly and six-hourly schedules keep their cadence', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(shouldRunBackupSweep({ cron: HOURLY_CRON, scheduledTime: utcHour(hour) })).toBe(true)
    }
  })

  it('skips the half-hourly trigger', () => {
    expect(shouldRunBackupSweep({ cron: '15,45 * * * *', scheduledTime: utcHour(1, 15) })).toBe(false)
    expect(shouldRunBackupSweep({ cron: '15,45 * * * *', scheduledTime: utcHour(13, 45) })).toBe(false)
  })
})

describe('shouldRunMaintenance', () => {
  it('runs the sweep on the hourly trigger at the configured UTC hours', () => {
    for (const hour of MAINTENANCE_UTC_HOURS) {
      expect(shouldRunMaintenance({ cron: HOURLY_CRON, scheduledTime: utcHour(hour) })).toBe(true)
    }
    expect(MAINTENANCE_UTC_HOURS).toEqual([1, 13])
  })

  it('skips the sweep on the hourly trigger at every other hour', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const expected = MAINTENANCE_UTC_HOURS.includes(hour)
      expect(
        shouldRunMaintenance({ cron: HOURLY_CRON, scheduledTime: utcHour(hour) }),
      ).toBe(expected)
    }
    expect(shouldRunMaintenance({ cron: HOURLY_CRON, scheduledTime: utcHour(2) })).toBe(false)
    expect(shouldRunMaintenance({ cron: HOURLY_CRON, scheduledTime: utcHour(12) })).toBe(false)
  })

  it('never sweeps on the half-hourly trigger, even in a maintenance hour', () => {
    for (const hour of MAINTENANCE_UTC_HOURS) {
      expect(shouldRunMaintenance({ cron: '15,45 * * * *', scheduledTime: utcHour(hour, 15) })).toBe(false)
      expect(shouldRunMaintenance({ cron: '15,45 * * * *', scheduledTime: utcHour(hour, 45) })).toBe(false)
    }
  })

  it('runs exactly twice across a full day of both triggers', () => {
    const runs: string[] = []
    for (let hour = 0; hour < 24; hour += 1) {
      for (const [cron, minute] of [[HOURLY_CRON, 0], ['15,45 * * * *', 15], ['15,45 * * * *', 45]] as const) {
        if (shouldRunMaintenance({ cron, scheduledTime: utcHour(hour, minute) })) {
          runs.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
        }
      }
    }
    expect(runs).toEqual(['01:00', '13:00'])
  })

  it('judges a trigger without a cron string by its scheduled hour', () => {
    expect(shouldRunMaintenance({ scheduledTime: utcHour(1) })).toBe(true)
    expect(shouldRunMaintenance({ scheduledTime: utcHour(13) })).toBe(true)
    expect(shouldRunMaintenance({ scheduledTime: utcHour(5) })).toBe(false)
  })
})
