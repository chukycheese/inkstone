/**
 * Cron gating for the scheduled handler.
 *
 * `wrangler.toml` registers `0 * * * *` and `15,45 * * * *`, so `scheduled()`
 * runs 72 times a day and used to re-run every maintenance job each time:
 * backups, four purges, the OAuth provider purge, AI and FTS queue drains,
 * distill, wiki lint and vocab push, each reading and writing D1 rows even
 * when it has nothing to do.
 *
 * Two cadences replace that:
 * - Backups keep an hourly slot on the hourly trigger, because the per-account
 *   schedule setting goes down to `hourly` and `sixHourly` is the default
 *   (BACKUP_INTERVALS); the sweep itself decides who is due.
 * - Everything else is not minute-critical and runs twice a day, at 01:00 and
 *   13:00 UTC (10:00 and 22:00 KST).
 * Vocab pushes are not gated at all: their KST slots need minute punctuality.
 */

export const HOURLY_CRON = '0 * * * *'

export const MAINTENANCE_UTC_HOURS: readonly number[] = [1, 13]

export interface CronTriggerLike {
  cron?: string
  scheduledTime?: number
}

export function cronUtcHour(event: CronTriggerLike, now: number = Date.now()): number {
  const scheduledTime = event.scheduledTime
  const ms =
    typeof scheduledTime === 'number' && Number.isFinite(scheduledTime) && scheduledTime > 0
      ? scheduledTime
      : now
  return new Date(ms).getUTCHours()
}

function isHourlyTrigger(event: CronTriggerLike): boolean {
  return !event.cron || event.cron === HOURLY_CRON
}

export function shouldRunBackupSweep(event: CronTriggerLike): boolean {
  return isHourlyTrigger(event)
}

export function shouldRunMaintenance(event: CronTriggerLike, now: number = Date.now()): boolean {
  return isHourlyTrigger(event) && MAINTENANCE_UTC_HOURS.includes(cronUtcHour(event, now))
}
