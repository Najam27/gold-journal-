import { getPktDateKey } from "@shared/pktDate";

export const sessions = ["Pre-Asian", "Asian", "Post-Asian", "Pre-London", "London", "Post-London", "Pre-NY", "New York", "Post-NY"];
export const levels = ["SBR/TJL1", "RBS/TJL1", "TJL2", "QML", "FIB", "LVL4", "LVL2"];
export const executionTypes = ["Manual Direct", "Limit Order", "Stop Order", "Manual After Confirmation"];
export const results = ["WIN", "LOSS", "BREAK_EVEN", "OPEN"] as const;

export function formatDate(value: Date | string | number | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

export function getPktDateInput(value: Date | string | number = new Date()) {
  return getPktDateKey(value);
}

export function isFuturePktDate(value: string, now: Date | string | number = new Date()) {
  return !/^\d{4}-\d{2}-\d{2}$/.test(value) || value > getPktDateInput(now);
}

export function formatMoney(value: number | string | null | undefined) {
  const numeric = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(numeric);
}

export function formatRr(risk: number | string | null | undefined, reward: number | string | null | undefined) {
  const riskValue = Number(risk);
  const rewardValue = Number(reward);
  if (!Number.isFinite(riskValue) || !Number.isFinite(rewardValue) || riskValue <= 0) return "—";
  return `1 : ${(rewardValue / riskValue).toFixed(2)}`;
}

export function getPktSession(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", hour: "2-digit", hour12: false }).format(date));
  if (hour < 3 || hour >= 20) return "Post-NY";
  if (hour >= 3 && hour < 5) return "Pre-Asian";
  if (hour < 8) return "Asian";
  if (hour < 10) return "Post-Asian";
  if (hour < 12) return "Pre-London";
  if (hour < 14) return "London";
  if (hour < 16) return "Post-London";
  if (hour < 17) return "Pre-NY";
  if (hour < 20) return "New York";
  return "Post-NY";
}

export function toNumber(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
