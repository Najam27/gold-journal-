import { describe, expect, it } from 'vitest';
import { sessionForDate } from '../lib/time';
import { tradeSchema, skippedTradeSchema } from '../lib/validation';

const pkt = (date: string) => new Date(`${date}+05:00`);

describe('Pakistan session classification', () => {
  it('classifies 05:30 PKT as Asian', () => expect(sessionForDate(pkt('2026-08-16T05:30:00'))).toBe('Asian'));
  it('classifies 01:30 PKT as Post-NY', () => expect(sessionForDate(pkt('2026-08-16T01:30:00'))).toBe('Post-NY'));
  it('classifies every boundary without gaps', () => {
    expect(sessionForDate(pkt('2026-08-16T03:00:00'))).toBe('Pre-Asian');
    expect(sessionForDate(pkt('2026-08-16T12:00:00'))).toBe('London');
    expect(sessionForDate(pkt('2026-08-16T20:00:00'))).toBe('Post-NY');
  });
});

describe('required blank form protection', () => {
  it('rejects a trade without direction and result', () => {
    const parsed = tradeSchema.safeParse({ trade_at_utc: new Date().toISOString(), pkt_session: 'Asian', source: 'manual', direction: '', result: '', risk_usd: 100, planned_reward_usd: null, realized_pnl: null, behavior_tags: [] });
    expect(parsed.success).toBe(false);
  });
  it('rejects a missed trade without direction, reason, confidence, and outcome', () => {
    const parsed = skippedTradeSchema.safeParse({ skipped_at: new Date().toISOString(), pkt_session: 'Asian', direction: '', reason: '', confidence: '', later_outcome: '', estimated_missed_pnl: null });
    expect(parsed.success).toBe(false);
  });
});
