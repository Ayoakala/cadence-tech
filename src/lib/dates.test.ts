import {describe, expect, it} from 'vitest';
import {
  daysPriorTo,
  formatCalendarDay,
  isWithinWindow,
  parseCalendarDay,
} from './dates.js';

/** Helper that asserts a parse succeeded, so the tests read without `!`. */
function day(value: string) {
  const parsed = parseCalendarDay(value);
  if (parsed === null) throw new Error(`expected ${value} to parse`);
  return parsed;
}

describe('parseCalendarDay', () => {
  it('parses a bare date', () => {
    expect(formatCalendarDay(day('2026-02-19'))).toBe('2026-02-19');
  });

  it('parses an ISO instant by taking its date part', () => {
    expect(formatCalendarDay(day('2026-02-21T08:10:00Z'))).toBe('2026-02-21');
  });

  // A late-evening UTC timestamp parsed via `new Date()` in a negative-offset
  // timezone lands on the previous local day, which would shift boundary cases
  // by one. Parsing the text directly keeps the answer machine-independent.
  it('is independent of the host timezone', () => {
    expect(formatCalendarDay(day('2026-02-21T23:59:59Z'))).toBe('2026-02-21');
    expect(formatCalendarDay(day('2026-02-21T00:00:00Z'))).toBe('2026-02-21');
  });

  it.each([null, undefined, '', 'not a date', '2026-02', '02-19-2026'])(
    'rejects %j',
    value => {
      expect(parseCalendarDay(value)).toBeNull();
    }
  );

  it('rejects a date that would roll over', () => {
    expect(parseCalendarDay('2026-02-31')).toBeNull();
    expect(parseCalendarDay('2026-13-01')).toBeNull();
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(formatCalendarDay(day('2024-02-29'))).toBe('2024-02-29');
    expect(parseCalendarDay('2026-02-29')).toBeNull();
  });
});

describe('daysPriorTo', () => {
  it('counts whole days before the procedure', () => {
    expect(daysPriorTo(day('2026-03-03'), day('2026-01-30'))).toBe(32);
    expect(daysPriorTo(day('2026-03-01'), day('2026-02-19'))).toBe(10);
  });

  it('spans a month boundary correctly', () => {
    expect(daysPriorTo(day('2026-03-01'), day('2026-02-28'))).toBe(1);
  });

  it('is negative for a record dated after the procedure', () => {
    expect(daysPriorTo(day('2026-03-01'), day('2026-03-05'))).toBe(-4);
  });
});

describe('isWithinWindow', () => {
  // The policy says "within 30 days", so exactly 30 is inside and 31 is not.
  it('treats the limit as inclusive', () => {
    expect(isWithinWindow(day('2026-03-03'), day('2026-02-01'), 30)).toBe(true);
    expect(isWithinWindow(day('2026-03-03'), day('2026-01-31'), 30)).toBe(
      false
    );
  });

  it('accepts a record dated after the procedure', () => {
    // The window guards against stale evidence, not against evidence that
    // postdates the procedure date, so this is not a staleness failure.
    expect(isWithinWindow(day('2026-03-01'), day('2026-03-05'), 30)).toBe(true);
  });

  it('applies the 14-day window for high risk', () => {
    expect(isWithinWindow(day('2026-03-01'), day('2026-02-15'), 14)).toBe(true);
    expect(isWithinWindow(day('2026-03-01'), day('2026-02-14'), 14)).toBe(
      false
    );
  });
});
