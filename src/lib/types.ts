export type Theme = 'dark' | 'light';
export type Direction = 'Long' | 'Short';
export type Result = 'Win' | 'Loss' | 'Breakeven' | 'Open';
export type TradeSource = 'manual' | 'mt5';
export type Session = 'Post-NY' | 'Pre-Asian' | 'Asian' | 'Post-Asian' | 'Pre-London' | 'London' | 'Post-London' | 'Pre-NY' | 'New York';
export type PageKey = 'trade-log' | 'missed' | 'analysis' | 'goals' | 'calendar' | 'plan' | 'mentor' | 'mt5' | 'options';

export interface Profile { id: string; display_name: string | null; theme_preference: Theme; created_at: string; updated_at: string; }
export interface TradingAccount { id: string; owner_id: string; name: string; broker_name: string | null; base_currency: string; starting_balance: number | null; is_active: boolean; is_archived: boolean; created_at: string; updated_at: string; }
export interface Trade {
  id: string; account_id: string; trade_at_utc: string; pkt_session: Session; source: TradeSource; mt5_ticket: number | null;
  direction: Direction | null; result: Result | null; risk_usd: number | null; planned_reward_usd: number | null; realized_pnl: number | null;
  bias: string | null; level: string | null; timeframe: string | null; setup_quality: string | null; execution_type: string | null;
  market_condition: string | null; confirmation_type: string | null; sl_placement: string | null; tp_placement: string | null;
  behavior_tags: string[]; hold_quality: number | null; patience_score: number | null; emotion_before: string | null; emotion_during: string | null; emotion_after: string | null; notes: string | null;
  created_at: string; updated_at: string;
}
export interface TradeScreenshot { id: string; trade_id: string; account_id: string; object_path: string; original_filename: string; mime_type: string; display_order: number; created_at: string; signed_url?: string; }
export interface MissedTrade { id: string; account_id: string; skipped_at: string; pkt_session: Session; direction: Direction | null; reason: string | null; confidence: string | null; later_outcome: Result | null; estimated_missed_pnl: number | null; notes: string | null; created_at: string; updated_at: string; }
export interface DailyPlan { id: string; account_id: string; plan_date: string; pre_market_plan: string | null; thesis: string | null; key_levels: string | null; scenarios: string | null; invalidation: string | null; news_context: string | null; risk_limits: string | null; selected_rules: string[]; execution_checklist: Record<string, boolean>; post_session_score: number | null; review_notes: string | null; is_archived: boolean; created_at: string; updated_at: string; }
export type GoalMetric = 'realized_pnl' | 'loss_streak' | 'trade_count' | 'rule_violations' | 'fomo_tags' | 'revenge_tags' | 'screenshot_rate' | 'plan_completion';
export interface TraderGoal { id: string; account_id: string; title: string; period: 'daily' | 'weekly' | 'monthly'; metric: GoalMetric; comparator: 'at_most' | 'at_least'; target: number; strategy_scope: string | null; is_active: boolean; notification_enabled: boolean; template_key: string | null; created_at: string; updated_at: string; }
export interface Notification { id: string; account_id: string; category: string; title: string; body: string; is_read: boolean; created_at: string; }
export interface OptionList { id: string; account_id: string; category: string; label: string; enabled: boolean; sort_order: number; created_at: string; updated_at: string; }
export interface TradingRule { id: string; account_id: string; title: string; is_active: boolean; sort_order: number; created_at: string; updated_at: string; }
export interface Mt5Connection { id: string; account_id: string; terminal_label: string; status: 'pending' | 'connected' | 'stale' | 'error'; last_seen: string | null; broker_balance: number | null; broker_equity: number | null; floating_pnl: number | null; created_at: string; updated_at: string; }
export interface MentorReport { id: string; account_id: string; date_from: string; date_to: string; prompt_summary: string; result: string; model_metadata: Record<string, unknown>; created_at: string; }
export interface CashMovement { id: string; account_id: string; movement_type: 'deposit' | 'withdrawal'; amount: number; note: string | null; moved_at: string; }

export interface OptionCatalog { levels: string[]; timeframes: string[]; setupQualities: string[]; executionTypes: string[]; marketConditions: string[]; confirmations: string[]; slPlacements: string[]; tpPlacements: string[]; emotions: string[]; behaviorTags: string[]; biases: string[]; reasons: string[]; confidence: string[]; }
export interface DashboardStats { trades: number; wins: number; losses: number; breakevens: number; winRate: number; pnl: number; avgR: number; expectancy: number; balance: number; }
export interface AppState { userId: string | null; profile: Profile | null; accounts: TradingAccount[]; activeAccountId: string | null; theme: Theme; online: boolean; }

export const EMPTY_TRADE: Partial<Trade> = { direction: null, result: null, source: 'manual', risk_usd: null, planned_reward_usd: null, realized_pnl: null, bias: null, level: null, timeframe: null, setup_quality: null, execution_type: null, market_condition: null, confirmation_type: null, sl_placement: null, tp_placement: null, behavior_tags: [], hold_quality: null, patience_score: null, emotion_before: null, emotion_during: null, emotion_after: null, notes: null };
export const EMPTY_MISSED: Partial<MissedTrade> = { direction: null, reason: null, confidence: null, later_outcome: null, estimated_missed_pnl: null, notes: null };

export function formatMoney(value: number | null | undefined, currency = 'USD') { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2, signDisplay: 'auto' }).format(Number(value || 0)); }
export function formatDate(value: string | Date | null | undefined) { if (!value) return '—'; return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value)); }
export function formatDateTime(value: string | Date | null | undefined) { if (!value) return '—'; return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
export function realizedR(trade: Pick<Trade, 'realized_pnl' | 'risk_usd'>) { return trade.risk_usd && trade.risk_usd !== 0 ? Number(trade.realized_pnl || 0) / Number(trade.risk_usd) : null; }
export function riskFloor(input: number) { return -Math.abs(Number(input || 0)); }
