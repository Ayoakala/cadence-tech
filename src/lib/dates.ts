/**
 * Calendar-date helpers.
 *
 * Every date in a submission is either a bare `YYYY-MM-DD` (documents) or an
 * ISO-8601 instant (`labs[].effective_at`, `vitals[].date`). The policy only
 * ever asks "how many days before the procedure was this?", so we reduce
 * everything to a UTC calendar day and diff whole days. Parsing the date part
 * textually — rather than via `new Date()` — keeps the answer independent of
 * the machine's local timezone, which would otherwise shift a boundary case by
 * a day depending on where the code runs.
 */

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/** A calendar day, as days since the Unix epoch. */
export type CalendarDay = number & {readonly __brand: 'CalendarDay'};

export function parseCalendarDay(
  value: string | null | undefined
): CalendarDay | null {
  if (typeof value !== 'string') return null;
  const match = DATE_PREFIX.exec(value.trim());
  if (!match) return null;

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utc = Date.UTC(year, month - 1, day);
  if (Number.isNaN(utc)) return null;

  // Reject dates that rolled over (e.g. 2026-02-31 -> Mar 3).
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  return (utc / 86_400_000) as CalendarDay;
}

/** Whole days from `earlier` to `later`. Negative if `later` precedes `earlier`. */
export function daysBetween(earlier: CalendarDay, later: CalendarDay): number {
  return later - earlier;
}

/**
 * How many days before the procedure a record was captured. Positive means the
 * record predates the procedure, which is the normal case for pre-op evidence.
 */
export function daysPriorTo(
  procedureDate: CalendarDay,
  recordDate: CalendarDay
): number {
  return daysBetween(recordDate, procedureDate);
}

/**
 * Is a record within `limit` days before the procedure?
 *
 * A record dated *after* the procedure date is not "outside the window" in the
 * stale sense the policy is guarding against, so it is accepted; the policy
 * only constrains how old evidence may be.
 */
export function isWithinWindow(
  procedureDate: CalendarDay,
  recordDate: CalendarDay,
  limitDays: number
): boolean {
  return daysPriorTo(procedureDate, recordDate) <= limitDays;
}

/** Format a calendar day back to `YYYY-MM-DD`. */
export function formatCalendarDay(day: CalendarDay): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}
