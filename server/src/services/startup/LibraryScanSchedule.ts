import { RecurrenceRule } from 'node-schedule';

export function dailyLibraryScanRule(
  time: string | null,
  timeZone: string | null,
): RecurrenceRule | undefined {
  if (time === null && timeZone === null) {
    return undefined;
  }
  if (time === null || timeZone === null) {
    throw new Error(
      'Set both TUNARR_LIBRARY_SCAN_DAILY_TIME and TUNARR_LIBRARY_SCAN_TIME_ZONE',
    );
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(
      'TUNARR_LIBRARY_SCAN_DAILY_TIME must use HH:mm (00:00–23:59)',
    );
  }
  try {
    if (/^[+-]/.test(timeZone)) {
      throw new Error('Numeric offsets are not IANA time zones');
    }
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch (cause) {
    throw new Error(
      'TUNARR_LIBRARY_SCAN_TIME_ZONE must be a valid IANA time zone',
      {
        cause,
      },
    );
  }

  const rule = new RecurrenceRule();
  rule.hour = Number(time.slice(0, 2));
  rule.minute = Number(time.slice(3));
  rule.second = 0;
  rule.tz = timeZone;
  return rule;
}
