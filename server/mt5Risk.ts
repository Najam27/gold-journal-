import { mt5Connections } from "../drizzle/schema";
import { calculateRisk, type RiskInput } from "@shared/riskCalculator";
import { getDb } from "./db";
import { getOwnedAccount } from "./goldDb";
import { and, eq } from "./supabaseQuery";

const number = (value: unknown) => Number(value ?? NaN);
export async function calculateAccountMt5Risk(userId: number, accountId: number, input: RiskInput) {
  await getOwnedAccount(userId, accountId);
  const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly.");
  const [connection] = await db.select().from(mt5Connections).where(and(eq(mt5Connections.userId, userId), eq(mt5Connections.accountId, accountId), eq(mt5Connections.active, true))).limit(1);
  if (!connection) return calculateRisk(input, null, null);
  const account = { balance: number(connection.balance), equity: number(connection.equity), margin: number(connection.margin), freeMargin: number(connection.freeMargin), currency: connection.currency };
  const values = { tickSize: number(connection.riskTickSize), tickValueLoss: number(connection.riskTickValueLoss), contractSize: number(connection.riskContractSize), volumeMin: number(connection.riskVolumeMin), volumeMax: number(connection.riskVolumeMax), volumeStep: number(connection.riskVolumeStep) };
  const spec = connection.riskSymbol && Object.values(values).every(value => Number.isFinite(value) && value > 0) ? { symbol: connection.riskSymbol, ...values } : null;
  return calculateRisk(input, account, spec);
}
