export const PKT_TIME_ZONE = "Asia/Karachi";
const PKT_OFFSET = "+05:00";
const PKT_DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function partsFor(value: Date | string | number) {
  return new Intl.DateTimeFormat("en-US", { timeZone: PKT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
}

export function getPktDateKey(value: Date | string | number = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = partsFor(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isPktDateKey(value: string) {
  if (!PKT_DATE_KEY.test(value)) return false;
  const instant = new Date(`${value}T00:00:00${PKT_OFFSET}`);
  return Number.isFinite(instant.getTime()) && getPktDateKey(instant) === value;
}

export function pktDateToTimestamp(value: string, hour = 12) {
  if (!isPktDateKey(value) || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError("Invalid PKT calendar date.");
  return Date.parse(`${value}T${String(hour).padStart(2, "0")}:00:00${PKT_OFFSET}`);
}

export function addPktDays(value: string, offset: number) {
  if (!isPktDateKey(value) || !Number.isInteger(offset)) throw new RangeError("Invalid PKT calendar date adjustment.");
  return getPktDateKey(pktDateToTimestamp(value) + offset * 86_400_000);
}

export function getPktMonthKey(value: Date | string | number = new Date()) {
  return getPktDateKey(value).slice(0, 7);
}

export function isPktMonthKey(value: string) {
  return /^\d{4}-\d{2}$/.test(value) && isPktDateKey(`${value}-01`);
}

export function addPktMonths(value: string, offset: number) {
  if (!isPktMonthKey(value) || !Number.isInteger(offset)) throw new RangeError("Invalid PKT calendar month adjustment.");
  const [year, month] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function pktMonthCalendar(value: string) {
  if (!isPktMonthKey(value)) throw new RangeError("Invalid PKT calendar month.");
  const [year, month] = value.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { firstWeekday: first.getUTCDay(), days: Array.from({ length: days }, (_, index) => `${value}-${String(index + 1).padStart(2, "0")}`) };
}

export function formatPktMonth(value: string) {
  if (!isPktMonthKey(value)) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: PKT_TIME_ZONE, month: "long", year: "numeric" }).format(new Date(pktDateToTimestamp(`${value}-01`)));
}
