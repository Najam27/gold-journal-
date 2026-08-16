import type { Session } from './types';

export const SESSION_WINDOWS: Array<[number, number, Session]> = [
  [0, 3, 'Post-NY'], [3, 5, 'Pre-Asian'], [5, 8, 'Asian'], [8, 10, 'Post-Asian'], [10, 12, 'Pre-London'], [12, 14, 'London'], [14, 16, 'Post-London'], [16, 17, 'Pre-NY'], [17, 20, 'New York'], [20, 24, 'Post-NY'],
];

export function pktParts(date: Date | string) {
  const d = new Date(date);
  const formatted = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (name: string) => Number(formatted.find((p) => p.type === name)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

export function sessionForDate(date: Date | string): Session {
  const { hour } = pktParts(date);
  return SESSION_WINDOWS.find(([from, to]) => hour >= from && hour < to)?.[2] || 'Post-NY';
}

export function currentPktDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()); }
export function utcFromMt5(value: string | number, brokerOffsetHours = 3) { const raw = new Date(value); if (Number.isNaN(raw.valueOf())) return new Date(value).toISOString(); return new Date(raw.getTime() - brokerOffsetHours * 3600000).toISOString(); }
export function dateInputValue(date: Date | string = new Date()) { const d = typeof date === 'string' ? new Date(date) : date; return d.toISOString().slice(0, 10); }
