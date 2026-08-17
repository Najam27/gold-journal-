create extension if not exists pgcrypto;

create table if not exists public.users (
  "id" serial primary key,
  "openId" varchar(128) not null unique,
  "name" text,
  "email" varchar(320),
  "loginMethod" varchar(64),
  "role" varchar(16) not null default 'user',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "lastSignedIn" timestamptz not null default now()
);

create table if not exists public.gj_accounts (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "name" varchar(100) not null,
  "bootstrapKey" varchar(32),
  "startingBalance" numeric(14,2) not null default 0,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("userId", "bootstrapKey")
);
create index if not exists gj_accounts_user_idx on public.gj_accounts("userId");

create table if not exists public.gj_trades (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "accountId" integer not null references public.gj_accounts("id") on delete cascade,
  "tradeDate" timestamptz not null,
  "session" varchar(40) not null,
  "direction" varchar(8) not null check ("direction" in ('BUY','SELL')),
  "result" varchar(16) not null check ("result" in ('WIN','LOSS','BREAK_EVEN','OPEN')),
  "level" varchar(100) default '',
  "timeframe" varchar(20) default '',
  "setupQuality" varchar(40) default '',
  "executionType" varchar(80) default '',
  "marketCondition" varchar(40) default '',
  "biasAlignment" varchar(40) default '',
  "confirmationType" varchar(60) default '',
  "slPlacement" varchar(60) default '',
  "tpPlacement" varchar(60) default '',
  "mistake" varchar(80) default '',
  "holdQuality" varchar(60) default '',
  "patienceScore" integer,
  "risk" numeric(14,2),
  "reward" numeric(14,2),
  "pnl" numeric(14,2) not null default 0,
  "notes" text,
  "emotionBefore" text,
  "emotionDuring" text,
  "emotionAfter" text,
  "screenshotKey" varchar(500),
  "screenshotName" varchar(255),
  "mt5Ticket" bigint,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("accountId", "mt5Ticket")
);
create index if not exists gj_trades_owner_account_date_idx on public.gj_trades("userId", "accountId", "tradeDate");

create table if not exists public.gj_cash_movements (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "accountId" integer not null references public.gj_accounts("id") on delete cascade,
  "movementDate" timestamptz not null,
  "type" varchar(16) not null check ("type" in ('DEPOSIT','WITHDRAW')),
  "amount" numeric(14,2) not null,
  "note" text,
  "createdAt" timestamptz not null default now()
);
create index if not exists gj_cash_owner_account_idx on public.gj_cash_movements("userId", "accountId");

create table if not exists public.gj_goals (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "accountId" integer not null references public.gj_accounts("id") on delete cascade,
  "name" varchar(120) not null,
  "description" text,
  "period" varchar(16) not null check ("period" in ('DAILY','WEEKLY','MONTHLY')),
  "metric" varchar(80) not null,
  "comparison" varchar(8) not null check ("comparison" in ('GTE','LTE')),
  "target" numeric(14,2) not null,
  "notify" boolean not null default true,
  "active" boolean not null default true,
  "isCustom" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists gj_goals_owner_account_idx on public.gj_goals("userId", "accountId");

create table if not exists public.gj_skipped_trades (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "accountId" integer not null references public.gj_accounts("id") on delete cascade,
  "tradeDate" timestamptz not null,
  "session" varchar(40) not null,
  "level" varchar(100) default '',
  "timeframe" varchar(20) default '',
  "direction" varchar(8) not null check ("direction" in ('BUY','SELL')),
  "skipReason" varchar(120) not null,
  "confidence" integer not null,
  "outcome" varchar(80) not null,
  "estimatedMissed" numeric(14,2) not null default 0,
  "notes" text,
  "createdAt" timestamptz not null default now()
);
create index if not exists gj_skipped_owner_account_idx on public.gj_skipped_trades("userId", "accountId");

create table if not exists public.gj_daily_plans (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "accountId" integer not null references public.gj_accounts("id") on delete cascade,
  "planDate" timestamptz not null,
  "preBias" varchar(40) default '',
  "marketContext" text,
  "keyLevels" text,
  "sessionFocus" jsonb,
  "eventRisk" text,
  "longScenario" text,
  "shortScenario" text,
  "noTradeCondition" text,
  "invalidationLevel" text,
  "riskLimit" varchar(40) default '',
  "maxTrades" integer,
  "sizingPlan" text,
  "planNotes" text,
  "rulesPlanned" jsonb,
  "emotionStart" text,
  "emotionEnd" text,
  "executionScore" integer,
  "rulesFollowed" jsonb,
  "whatWentWell" text,
  "whatWentWrong" text,
  "executionNotes" text,
  "planDeviation" text,
  "lessons" text,
  "tomorrowFocus" text,
  "overallRating" integer,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("userId", "accountId", "planDate")
);
create index if not exists gj_daily_plan_owner_account_idx on public.gj_daily_plans("userId", "accountId");

create table if not exists public.gj_option_lists (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "category" varchar(80) not null,
  "value" varchar(160) not null,
  "active" boolean not null default true,
  "createdAt" timestamptz not null default now(),
  unique ("userId", "category", "value")
);
create index if not exists gj_option_list_owner_idx on public.gj_option_lists("userId");

create table if not exists public.gj_notification_settings (
  "id" serial primary key,
  "userId" integer not null unique references public.users("id") on delete cascade,
  "goalAlerts" boolean not null default true,
  "emailAlerts" boolean not null default false,
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.gj_notification_history (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "accountId" integer references public.gj_accounts("id") on delete cascade,
  "type" varchar(60) not null,
  "message" text not null,
  "readAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create index if not exists gj_notification_owner_idx on public.gj_notification_history("userId", "createdAt");

create table if not exists public.gj_mt5_connections (
  "id" serial primary key,
  "userId" integer not null references public.users("id") on delete cascade,
  "accountId" integer not null unique references public.gj_accounts("id") on delete cascade,
  "apiKey" varchar(96) not null unique,
  "label" varchar(120) not null default 'MT5 Connection',
  "active" boolean not null default true,
  "brokerUtcOffsetMinutes" integer not null default 180,
  "lastPing" timestamptz,
  "mt5Login" bigint,
  "brokerServer" varchar(160),
  "currency" varchar(16),
  "balance" numeric(14,2),
  "equity" numeric(14,2),
  "margin" numeric(14,2),
  "freeMargin" numeric(14,2),
  "floatingPnl" numeric(14,2),
  "journalDataResetAt" timestamptz,
  "lastHistorySync" timestamptz,
  "historySyncedCount" integer not null default 0,
  "lastHistoryAttempt" timestamptz,
  "lastHistoryStatus" varchar(32),
  "lastHistoryMessage" varchar(255),
  "lastHistoryBatchSize" integer,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists gj_mt5_connection_owner_idx on public.gj_mt5_connections("userId", "accountId");

create table if not exists public.gj_mt5_live_positions (
  "id" serial primary key,
  "accountId" integer not null references public.gj_accounts("id") on delete cascade,
  "ticket" bigint not null,
  "symbol" varchar(32) not null,
  "direction" varchar(8) not null check ("direction" in ('BUY','SELL')),
  "lots" numeric(14,2) not null,
  "openPrice" numeric(18,6) not null,
  "closePrice" numeric(18,6),
  "slPrice" numeric(18,6),
  "tpPrice" numeric(18,6),
  "riskUsd" numeric(14,2) not null default 0,
  "rewardUsd" numeric(14,2) not null default 0,
  "rrRatio" numeric(14,2) not null default 0,
  "floatingPnl" numeric(14,2) not null default 0,
  "realizedPnl" numeric(14,2),
  "result" varchar(16),
  "openTime" timestamptz not null,
  "closeTime" timestamptz,
  "status" varchar(8) not null default 'OPEN' check ("status" in ('OPEN','CLOSED')),
  "updatedAt" timestamptz not null default now(),
  unique ("accountId", "ticket")
);
create index if not exists gj_mt5_live_account_status_idx on public.gj_mt5_live_positions("accountId", "status", "updatedAt");

insert into storage.buckets (id, name, public)
values ('trade-screenshots', 'trade-screenshots', false)
on conflict (id) do nothing;

-- The Netlify Function uses the service role for database/storage access and
-- enforces ownership through the source server routers. Keep the bucket private.
