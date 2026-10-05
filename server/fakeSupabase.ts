/**
 * Shared in-memory Supabase mock for server tests.
 *
 * A tiny in-memory PostgREST + Storage replacement. Extracted from
 * tradePersistence.test.ts so environment-isolation suites can reuse the same
 * fake without duplicating it.
 */

export type Row = Record<string, any>;

type Filter =
  | { kind: "eq" | "like" | "gte" | "gt" | "lt"; column: string; value: unknown }
  | { kind: "and" | "or"; parts: Filter[] };

const asComparable = (value: unknown): number | string =>
  value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? value : Date.parse(String(value));

function matches(row: Row, filter: Filter | null | undefined): boolean {
  if (!filter) return true;
  if (filter.kind === "and") return filter.parts.every(part => matches(row, part));
  if (filter.kind === "or") return filter.parts.some(part => matches(row, part));
  // Leaf filter from here on.
  const leaf = filter as { kind: "eq" | "like" | "gte" | "gt" | "lt"; column: string; value: unknown };
  const actual = row[leaf.column];
  if (leaf.kind === "eq") {
    if (leaf.value === null) return actual === null || actual === undefined;
    return String(actual) === String(leaf.value);
  }
  if (leaf.kind === "like") {
    const needle = String(leaf.value).replaceAll("%", "").toLowerCase();
    return String(actual ?? "").toLowerCase().includes(needle);
  }
  const left = asComparable(actual);
  const right = asComparable(leaf.value);
  if (leaf.kind === "gte") return left >= right;
  if (leaf.kind === "gt") return left > right;
  return left < right;
}

/** Parses the `column.op.value,...` clause that `applyFilter` renders for `or()`. */
function parseCondition(clause: string): Filter {
  const [column, op, ...rest] = clause.split(".");
  const value = rest.join(".");
  if (op === "eq") return { kind: "eq", column, value: value === "null" ? null : value };
  if (op === "ilike") return { kind: "like", column, value };
  if (op === "gte") return { kind: "gte", column, value };
  if (op === "gt") return { kind: "gt", column, value };
  if (op === "lt") return { kind: "lt", column, value };
  return { kind: "eq", column, value };
}

function parseOrClause(clause: string): Filter {
  const parts: Filter[] = [];
  let current = "";
  for (let index = 0; index < clause.length; index += 1) {
    const char = clause[index];
    if (char === "\\") {
      current += clause[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (char === ",") {
      parts.push(parseCondition(current));
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(parseCondition(current));
  return { kind: "or", parts };
}

export class FakeQuery {
  private action: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private conflictTargets: string[] = [];
  private ignoreDuplicates = false;
  private filter: Filter | null = null;
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private take?: number;
  private skip = 0;
  private returning = false;
  private wantCount = false;

  constructor(private readonly db: FakeSupabase, private readonly name: string) {}

  select(_columns?: string, options?: { count?: string }) {
    if (this.action === "select") this.wantCount = Boolean(options?.count);
    else this.returning = true;
    return this;
  }
  insert(values: Row | Row[]) {
    this.action = "insert";
    this.payload = values;
    return this;
  }
  upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.action = "upsert";
    this.payload = values;
    this.conflictTargets = String(options?.onConflict ?? "").split(",").filter(Boolean);
    this.ignoreDuplicates = Boolean(options?.ignoreDuplicates);
    return this;
  }
  update(values: Row) {
    this.action = "update";
    this.payload = values;
    return this;
  }
  delete() {
    this.action = "delete";
    return this;
  }
  eq(column: string, value: unknown) { return this.and({ kind: "eq", column, value }); }
  is(column: string, value: unknown) { return this.and({ kind: "eq", column, value }); }
  ilike(column: string, value: string) { return this.and({ kind: "like", column, value }); }
  gte(column: string, value: unknown) { return this.and({ kind: "gte", column, value }); }
  gt(column: string, value: unknown) { return this.and({ kind: "gt", column, value }); }
  lt(column: string, value: unknown) { return this.and({ kind: "lt", column, value }); }
  or(clause: string) { return this.and(parseOrClause(clause)); }
  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.skip = from;
    this.take = to - from + 1;
    return this;
  }

  private and(filter: Filter) {
    this.filter = this.filter ? { kind: "and", parts: [this.filter, filter] } : filter;
    return this;
  }

  private run(): { data: Row[] | null; error: { message: string; code?: string } | null; count: number | null } {
    const rows = this.db.table(this.name);
    if (this.action === "insert" || this.action === "upsert") {
      const values = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const written: Row[] = [];
      for (const value of values) {
        const existing =
          this.action === "upsert" && this.conflictTargets.length
            ? rows.find(row => this.conflictTargets.every(column => String(row[column]) === String((value as Row)[column])))
            : undefined;
        if (existing) {
          if (!this.ignoreDuplicates) Object.assign(existing, value);
          written.push(existing);
          continue;
        }
        const inserted: Row = { ...value, id: (value as Row).id ?? this.db.nextId() };
        rows.push(inserted);
        written.push(inserted);
      }
      return { data: this.returning ? written : null, error: null, count: null };
    }
    const matched = rows.filter(row => matches(row, this.filter));
    if (this.action === "update") {
      for (const row of matched) Object.assign(row, this.payload as Row);
      // PostgREST hands back fresh row snapshots, never live references, so a
      // caller that reads a row before an update must not observe the update.
      return { data: matched.map(row => ({ ...row })), error: null, count: null };
    }
    if (this.action === "delete") {
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      return { data: matched, error: null, count: null };
    }
    const ordered = [...matched].sort((left, right) => {
      for (const order of this.orders) {
        const a = asComparable(left[order.column]);
        const b = asComparable(right[order.column]);
        if (a === b) continue;
        const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
        return order.ascending ? comparison : -comparison;
      }
      return 0;
    });
    const page = this.take === undefined ? ordered.slice(this.skip) : ordered.slice(this.skip, this.skip + this.take);
    return { data: page.map(row => ({ ...row })), error: null, count: this.wantCount ? matched.length : null };
  }

  then(onFulfilled?: any, onRejected?: any) {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

export class FakeSupabase {
  private readonly tables = new Map<string, Row[]>();
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  private sequence = 1_000;

  constructor(seed: Record<string, Row[]>) {
    for (const [name, rows] of Object.entries(seed)) this.tables.set(name, rows.map(row => ({ ...row })));
  }

  table(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }
  rows(name: string) { return this.table(name); }
  nextId() { this.sequence += 1; return this.sequence; }

  from(name: string) { return new FakeQuery(this, name); }

  rpc(name: string, args: Row = {}) {
    if (name === "gj_account_cash_net") return Promise.resolve({ data: 0, error: null });
    if (name === "gj_account_trade_summary") {
      // The real RPC scopes by environment (default LIVE). The mock mirrors
      // that: rows without an environment count as LIVE.
      const env = args.target_environment ?? "LIVE";
      const trades = this.table("gj_trades").filter(row => (row.environment ?? "LIVE") === env);
      const pnl = trades.reduce((total, row) => total + Number(row.pnl ?? 0), 0);
      const wins = trades.filter(row => row.result === "WIN").length;
      const losses = trades.filter(row => row.result === "LOSS").length;
      return Promise.resolve({ data: [{ total_trades: trades.length, closed_trades: trades.length, win_trades: wins, loss_trades: losses, pnl }], error: null });
    }
    // Account-scoped destructive transactions, modelled closely enough to prove
    // that the account-wide paths delete exactly one account's rows.
    if (name === "gj_clear_account_journal_data") {
      const env = args.target_environment ?? "LIVE";
      const owned = (row: Row) => Number(row.userId) === Number(args.target_user_id) && Number(row.accountId) === Number(args.target_account_id) && (row.environment ?? "LIVE") === env;
      const trades = this.table("gj_trades");
      trades.splice(0, trades.length, ...trades.filter(row => !owned(row)));
      return Promise.resolve({ data: true, error: null });
    }
    if (name === "gj_remove_account") {
      const owned = (row: Row) => Number(row.userId) === Number(args.target_user_id) && Number(row.accountId) === Number(args.target_account_id);
      const accounts = this.table("gj_accounts");
      const index = accounts.findIndex(row => Number(row.id) === Number(args.target_account_id) && Number(row.userId) === Number(args.target_user_id));
      if (index >= 0) accounts.splice(index, 1);
      const trades = this.table("gj_trades");
      trades.splice(0, trades.length, ...trades.filter(row => !owned(row)));
      const replacement = accounts.find(row => Number(row.userId) === Number(args.target_user_id));
      return Promise.resolve({ data: [{ replacement_account_id: replacement?.id ?? null }], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  storage = {
    from: () => ({
      upload: (key: string, bytes: Buffer, options: { contentType: string }) => {
        if (this.objects.has(key)) return Promise.resolve({ data: null, error: { message: "The resource already exists" } });
        this.objects.set(key, { bytes: Buffer.from(bytes), contentType: options.contentType });
        return Promise.resolve({ data: { path: key }, error: null });
      },
      remove: (keys: string[]) => {
        for (const key of keys) this.objects.delete(key);
        return Promise.resolve({ data: null, error: null });
      },
      createSignedUrl: (key: string, expiresIn: number) =>
        this.objects.has(key)
          ? Promise.resolve({ data: { signedUrl: `https://signed.test/${key}?expires=${expiresIn}` }, error: null })
          : Promise.resolve({ data: null, error: { message: "Object not found" } }),
    }),
  };
}
