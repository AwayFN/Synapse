const pad = (n: number) => String(n).padStart(2, '0');

export const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
export const DAY_SHORT = ['DIM', 'LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM'];
export const MONTH_NAMES = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
export const MONTH_SHORT = ['JAN', 'FÉV', 'MAR', 'AVR', 'MAI', 'JUN', 'JUL', 'AOÛ', 'SEP', 'OCT', 'NOV', 'DÉC'];

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function fromISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(iso: string, n: number): string {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((fromISODate(a).getTime() - fromISODate(b).getTime()) / 86400000);
}

export function isValidISODate(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = fromISODate(s);
  return toISODate(d) === s;
}

export function minutesNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

export function fmtTime(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return '--:--';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** French style "12h01" */
export function fmtTimeH(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}h${pad(m % 60)}`;
}

export function fmtDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${pad(m)}` : `${h}h`;
}

/** Duration of a slot in minutes; end <= start means it ends the next day */
export function slotDuration(start: number, end: number): number {
  if (end === start) return 1440;
  return end > start ? end - start : end + 1440 - start;
}

export function crossesMidnight(start: number, end: number): boolean {
  return end <= start;
}

/**
 * Parse a free-form time: "12h01", "12:01", "12.01", "1201", "905", "9h", "9", "9h5", "midi", "minuit".
 * Returns minutes since midnight or null.
 */
export function parseTime(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (s === 'midi') return 12 * 60;
  if (s === 'minuit') return 0;
  let h: number;
  let m = 0;
  let match = s.match(/^(\d{1,2})(?:h|:|\.)(\d{1,2})?(?:min|m)?$/);
  if (match) {
    h = parseInt(match[1], 10);
    if (match[2] !== undefined) m = parseInt(match[2], 10); // "9h5" -> 9:05
  } else if ((match = s.match(/^(\d{3,4})$/))) {
    const v = match[1].padStart(4, '0');
    h = parseInt(v.slice(0, 2), 10);
    m = parseInt(v.slice(2), 10);
  } else if ((match = s.match(/^(\d{1,2})$/))) {
    h = parseInt(match[1], 10);
  } else {
    return null;
  }
  if (h === 24 && m === 0) return 0;
  if (h > 23 || m > 59 || h < 0 || m < 0) return null;
  return h * 60 + m;
}

export function fmtDateShort(iso: string): string {
  const d = fromISODate(iso);
  return `${DAY_SHORT[d.getDay()]} ${pad(d.getDate())} ${MONTH_SHORT[d.getMonth()]}`;
}

export function fmtDateLong(iso: string): string {
  const d = fromISODate(iso);
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

export function fmtDateNum(iso: string): string {
  const d = fromISODate(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

export function relativeDay(iso: string): string | null {
  const diff = diffDays(iso, todayISO());
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Demain';
  if (diff === -1) return 'Hier';
  if (diff === 2) return 'Après-demain';
  return null;
}

/** "AUJOURD'HUI", "DEMAIN", "MAR 18 NOV" */
export function fmtDay(iso: string): string {
  return (relativeDay(iso) ?? fmtDateShort(iso)).toUpperCase();
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtStamp(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Absolute timestamp of a slot start / end */
export function slotStartTs(date: string, start: number): number {
  return fromISODate(date).getTime() + start * 60000;
}
export function slotEndTs(date: string, start: number, end: number): number {
  return slotStartTs(date, start) + slotDuration(start, end) * 60000;
}

/** A `When` without a start covers the whole day; with a start but no end it lasts one hour */
export function whenStartTs(w: { date: string; start: number | null }): number {
  return slotStartTs(w.date, w.start ?? 0);
}
export function whenEndTs(w: { date: string; start: number | null; end: number | null }): number {
  if (w.start == null) return fromISODate(addDays(w.date, 1)).getTime();
  if (w.end == null) return slotStartTs(w.date, w.start) + 60 * 60000;
  return slotEndTs(w.date, w.start, w.end);
}

/** "14:00 → 15:30" · "14:00" · "" (toute la journée) */
export function fmtHours(w: { start: number | null; end: number | null }): string {
  if (w.start == null) return '';
  return w.end == null ? fmtTime(w.start) : `${fmtTime(w.start)} → ${fmtTime(w.end)}`;
}

/** "DEMAIN 14:00", "MAR 18 NOV", "AUJOURD'HUI 09:12 → 11:47" */
export function fmtWhen(w: { date: string; start: number | null; end: number | null }): string {
  const h = fmtHours(w);
  return `${fmtDay(w.date)}${h ? ' ' + h : ''}`;
}

/** Relative "dans 1h12" / "il y a 5 min" */
export function fmtRelative(ms: number): string {
  const future = ms >= 0;
  let m = Math.round(Math.abs(ms) / 60000);
  let txt: string;
  if (m < 1) txt = "moins d'1 min";
  else if (m < 60) txt = `${m} min`;
  else if (m < 60 * 24) {
    const h = Math.floor(m / 60);
    m = m % 60;
    txt = m ? `${h}h${pad(m)}` : `${h}h`;
  } else {
    const d = Math.round(m / 1440);
    txt = `${d} j`;
  }
  return future ? `dans ${txt}` : `il y a ${txt}`;
}
