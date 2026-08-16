import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const attempts = new Map<string, { count: number; reset: number }>();
const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const validText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[<>\u0000-\u001F]/.test(value);

export async function handler(event: any) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const ip = event.headers?.['x-nf-client-connection-ip'] || 'unknown'; const now = Date.now(); const current = attempts.get(ip); if (!current || current.reset < now) attempts.set(ip, { count: 1, reset: now + 60000 }); else if (current.count >= 60) return json(429, { error: 'Try again later' }); else current.count += 1;
  let body: any; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request' }); }
  if (!validText(body.apiKey, 180) || !validText(body.connectionId, 80) || !body.account || !Array.isArray(body.positions)) return json(400, { error: 'Invalid request' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(503, { error: 'Service unavailable' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const verifier = sha256(body.apiKey);
  const { data: connection, error: connectionError } = await db.from('mt5_connections').select('*').eq('id', body.connectionId).single();
  const storedVerifier = connection?.api_key_verifier || ''; if (connectionError || !connection || storedVerifier.length !== verifier.length || !timingSafeEqual(Buffer.from(verifier), Buffer.from(storedVerifier))) return json(401, { error: 'Invalid credentials' });
  const balance = Number(body.account.balance); const equity = Number(body.account.equity); const floating = Number(body.account.floatingPnl); if (![balance, equity, floating].every(Number.isFinite)) return json(400, { error: 'Invalid account metrics' });
  const brokerOffset = Number.isFinite(Number(body.brokerUtcOffset)) ? Number(body.brokerUtcOffset) : 3;
  const normalize = (value: unknown) => { const date = new Date(String(value)); return Number.isNaN(date.valueOf()) ? null : new Date(date.getTime() - brokerOffset * 3600000).toISOString(); }; const pktSession = (utcIso: string | null) => { if (!utcIso) return 'Post-NY'; const h = new Date(new Date(utcIso).getTime() + 5 * 3600000).getUTCHours(); if (h < 3 || h >= 20) return 'Post-NY'; if (h < 5) return 'Pre-Asian'; if (h < 8) return 'Asian'; if (h < 10) return 'Post-Asian'; if (h < 12) return 'Pre-London'; if (h < 14) return 'London'; if (h < 16) return 'Post-London'; if (h < 17) return 'Pre-NY'; return 'New York'; };
  const positions = body.positions.slice(0, 500).filter((p: any) => Number.isSafeInteger(Number(p.ticket)) && ['Long', 'Short'].includes(p.direction) && ['open', 'closed'].includes(p.status)).map((p: any) => ({ connection_id: connection.id, account_id: connection.account_id, mt5_position_ticket: Number(p.ticket), opened_at_utc: normalize(p.openedAt), closed_at_utc: normalize(p.closedAt), direction: p.direction, status: p.status, risk_usd: Number.isFinite(Number(p.risk)) ? Number(p.risk) : null, planned_reward_usd: Number.isFinite(Number(p.reward)) ? Number(p.reward) : null, realized_pnl: Number.isFinite(Number(p.pnl)) ? Number(p.pnl) : null, payload_hash: sha256(JSON.stringify(p)) }));
  const { error: upsertError } = await db.from('mt5_positions').upsert(positions, { onConflict: 'account_id,mt5_position_ticket' }); if (upsertError) return json(500, { error: 'Could not synchronize positions' });
  const closed = positions.filter((p: any) => p.status === 'closed'); for (const position of closed) { const { data: existing } = await db.from('trades').select('id').eq('account_id', connection.account_id).eq('mt5_ticket', position.mt5_position_ticket).maybeSingle(); const trade = { account_id: connection.account_id, trade_at_utc: position.closed_at_utc || position.opened_at_utc || new Date().toISOString(), pkt_session: pktSession(position.closed_at_utc || position.opened_at_utc), source: 'mt5', mt5_ticket: position.mt5_position_ticket, direction: position.direction, result: Number(position.realized_pnl || 0) > 0 ? 'Win' : Number(position.realized_pnl || 0) < 0 ? 'Loss' : 'Breakeven', risk_usd: position.risk_usd, planned_reward_usd: position.planned_reward_usd, realized_pnl: position.realized_pnl, behavior_tags: [] }; if (existing?.id) await db.from('trades').update(trade).eq('id', existing.id); else await db.from('trades').insert(trade); }
  await db.from('mt5_connections').update({ status: 'connected', last_seen: new Date().toISOString(), broker_balance: balance, broker_equity: equity, floating_pnl: floating }).eq('id', connection.id);
  return json(200, { ok: true, synchronized: positions.length });
}
