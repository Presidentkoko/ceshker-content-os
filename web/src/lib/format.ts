import { utcToZonedParts } from '../../../shared/time';

export const APP_TZ_FALLBACK = 'America/Chicago';

export function fmtDateTime(iso: string | null | undefined, tz = APP_TZ_FALLBACK) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function fmtDate(iso: string | null | undefined, tz = APP_TZ_FALLBACK) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
}
export function fmtTime(iso: string | null | undefined, tz = APP_TZ_FALLBACK) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function fmtRelative(iso: string | null | undefined) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const abs = Math.abs(s);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return rtf.format(-Math.round(s), 'second');
  if (abs < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  return fmtDate(iso);
}
export function toLocalInput(iso: string | null | undefined, tz: string) {
  if (!iso) return { date: '', time: '' };
  return utcToZonedParts(iso, tz);
}
export function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
