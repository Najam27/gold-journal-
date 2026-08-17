export const CANONICAL_UTC_OFFSET_MINUTES = 5 * 60;
export const DEFAULT_BROKER_UTC_OFFSET_MINUTES = 3 * 60;
export const MT5_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export class Mt5TimestampError extends Error {
  constructor(public readonly code: "INVALID_MT5_TIMESTAMP" | "FUTURE_TRADE") {
    super(code);
  }
}

export type RawMt5Timestamp = string | number;

function assertBrokerOffsetMinutes(offset: number) {
  if (!Number.isInteger(offset) || offset < -12 * 60 || offset > 14 * 60) {
    throw new Mt5TimestampError("INVALID_MT5_TIMESTAMP");
  }
  return offset;
}

function parseUnixTimestamp(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Mt5TimestampError("INVALID_MT5_TIMESTAMP");
  const milliseconds = value >= 100_000_000_000 ? value : value * 1_000;
  const parsed = new Date(milliseconds);
  if (Number.isNaN(parsed.getTime())) throw new Mt5TimestampError("INVALID_MT5_TIMESTAMP");
  return parsed;
}

function parseOffsetFreeBrokerTime(value: string, brokerUtcOffsetMinutes: number) {
  const match = value.match(/^(\d{4})[.-](\d{2})[.-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
  if (!match) throw new Mt5TimestampError("INVALID_MT5_TIMESTAMP");
  const [, year, month, day, hour, minute, second = "0", fractional = "0"] = match;
  const milliseconds = Number(fractional.padEnd(3, "0"));
  const localAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds);
  const parsed = new Date(localAsUtc - brokerUtcOffsetMinutes * 60_000);
  if (Number.isNaN(parsed.getTime())) throw new Mt5TimestampError("INVALID_MT5_TIMESTAMP");
  return parsed;
}

/**
 * Returns an absolute instant. Gold Journal derives all business date/session components
 * from this instant in its fixed UTC+5 timezone; no browser or server-local timezone is used.
 */
export function normalizeMt5TimestampToUtcPlus5(raw: RawMt5Timestamp, brokerUtcOffsetMinutes = DEFAULT_BROKER_UTC_OFFSET_MINUTES, now = Date.now()) {
  const offset = assertBrokerOffsetMinutes(brokerUtcOffsetMinutes);
  let parsed: Date;
  if (typeof raw === "number") {
    parsed = parseUnixTimestamp(raw);
  } else {
    const value = raw.trim();
    if (!value || value.length > 40) throw new Mt5TimestampError("INVALID_MT5_TIMESTAMP");
    if (/^\d{10,13}$/.test(value)) {
      parsed = parseUnixTimestamp(Number(value));
    } else {
      const isoLike = value.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3").replace(" ", "T");
      if (/[zZ]|[+-]\d\d:?\d\d$/.test(isoLike)) {
        parsed = new Date(isoLike);
        if (Number.isNaN(parsed.getTime())) throw new Mt5TimestampError("INVALID_MT5_TIMESTAMP");
      } else {
        parsed = parseOffsetFreeBrokerTime(value, offset);
      }
    }
  }
  if (parsed.getTime() > now + MT5_FUTURE_CLOCK_SKEW_MS) throw new Mt5TimestampError("FUTURE_TRADE");
  return parsed;
}

export function formatUtcPlus5(date: Date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Etc/GMT-5",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date).replace(" ", "T") + "+05:00";
}
