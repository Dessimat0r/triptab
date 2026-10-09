/** A calendar date in the device's zone, or in an explicitly selected IANA zone. */
export function localDate(date = new Date(), timezone?: string): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid date');
  if (timezone) return localTimestamp(date, timezone).slice(0, 10);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Keep the default time in the same zone as the default date. */
export function localTime(date = new Date(), timezone?: string): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid date');
  if (timezone) return localTimestamp(date, timezone).slice(11);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Minute-resolution wall-clock timestamp, suitable for comparing transaction inputs. */
export function localTimestamp(date: Date, timezone: string): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid date');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Stored calendar dates have no viewer time zone. */
export function formatCalendarDate(value: string, options: { year?: boolean } = {}): string {
  if (!validCalendarDate(value)) return 'Invalid date';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(options.year === false ? {} : { year: 'numeric' }), timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}
function displayInstant(value: string | Date, options: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  try { return new Intl.DateTimeFormat('en-GB', options).format(date); }
  catch { return 'Date unavailable'; }
}
export function formatInstant(value: string | Date, options: { year?: boolean; timeZone?: string } = {}): string {
  return displayInstant(value, { day: 'numeric', month: 'short', ...(options.year === false ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: options.timeZone });
}
export function formatClockTime(value: string | Date, options: { timeZone?: string } = {}): string {
  return displayInstant(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: options.timeZone });
}
export function formatInstantDay(value: string | Date, options: { timeZone?: string } = {}): string {
  return displayInstant(value, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: options.timeZone });
}
