import { getTableName } from "drizzle-orm";
import { getSupabaseAdmin } from "./supabaseAdmin";

type TableLike = Record<string, any>;
type ColumnLike = { name?: string; columnName?: string };
type Filter = { kind: "eq" | "like" | "gte" | "gt" | "lt"; column: string; value: unknown } | { kind: "and" | "or"; parts: Filter[] };
type Order = { column: string; ascending: boolean } | ColumnLike;

type Selection = Record<string, any> | undefined;
type SupabaseError = { message: string; code?: string; details?: string; hint?: string };

function throwSupabaseError(error: SupabaseError): never {
  const wrapped = new Error(error.message) as Error & { supabaseCode?: string; supabaseDetails?: string; supabaseHint?: string };
  wrapped.supabaseCode = error.code;
  wrapped.supabaseDetails = error.details;
  wrapped.supabaseHint = error.hint;
  throw wrapped;
}

const columnName = (column: ColumnLike | string) => typeof column === "string" ? column : column.name ?? column.columnName ?? "";
const tableName = (table: TableLike) => getTableName(table as any);
const postgrestValue = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "bigint" ? value.toString() : value;
const valueForFilter = (value: unknown) => {
  const normalized = postgrestValue(value);
  if (normalized === null) return "null";
  return String(normalized).replace(/[\r\n]/g, " ").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll(",", "\\,").replaceAll("(", "\\(").replaceAll(")", "\\)");
};

export const eq = (column: ColumnLike, value: unknown): Filter => ({ kind: "eq", column: columnName(column), value });
export const like = (column: ColumnLike, value: string): Filter => ({ kind: "like", column: columnName(column), value });
export const gte = (column: ColumnLike, value: unknown): Filter => ({ kind: "gte", column: columnName(column), value });
export const gt = (column: ColumnLike, value: unknown): Filter => ({ kind: "gt", column: columnName(column), value });
export const lt = (column: ColumnLike, value: unknown): Filter => ({ kind: "lt", column: columnName(column), value });
export const and = (...parts: Array<Filter | undefined>): Filter => ({ kind: "and", parts: parts.filter(Boolean) as Filter[] });
export const or = (...parts: Array<Filter | undefined>): Filter => ({ kind: "or", parts: parts.filter(Boolean) as Filter[] });
export const desc = (column: ColumnLike): Order => ({ column: columnName(column), ascending: false });
export const asc = (column: ColumnLike): Order => ({ column: columnName(column), ascending: true });
export const count = () => ({ kind: "count" as const });

function renderFilterOperand(filter: Filter): string {
  if (filter.kind === "and") return `and(${filter.parts.map(renderFilterOperand).join(",")})`;
  if (filter.kind === "or") return `or(${filter.parts.map(renderFilterOperand).join(",")})`;
  return renderPostgrestFilter(filter);
}

function applyFilter(query: any, filter?: Filter): any {
  if (!filter) return query;
  if (filter.kind === "eq") return filter.value === null ? query.is(filter.column, null) : query.eq(filter.column, postgrestValue(filter.value));
  if (filter.kind === "like") return query.ilike(filter.column, filter.value);
  if (filter.kind === "gte") return query.gte(filter.column, postgrestValue(filter.value));
  if (filter.kind === "gt") return query.gt(filter.column, postgrestValue(filter.value));
  if (filter.kind === "lt") return query.lt(filter.column, postgrestValue(filter.value));
  if (filter.kind === "and") return filter.parts.reduce((current, part) => applyFilter(current, part), query);
  if (filter.kind === "or") return query.or(filter.parts.map(renderFilterOperand).join(","));
  return query;
}

export function renderPostgrestFilter(filter: Filter): string {
  if (filter.kind === "eq") return filter.value === null ? `${filter.column}.is.null` : `${filter.column}.eq.${valueForFilter(filter.value)}`;
  if (filter.kind === "like") return `${filter.column}.ilike.${valueForFilter(filter.value)}`;
  if (filter.kind === "gte") return `${filter.column}.gte.${valueForFilter(filter.value)}`;
  if (filter.kind === "gt") return `${filter.column}.gt.${valueForFilter(filter.value)}`;
  if (filter.kind === "lt") return `${filter.column}.lt.${valueForFilter(filter.value)}`;
  if (filter.kind === "and") return `and(${filter.parts.map(renderFilterOperand).join(",")})`;
  if (filter.kind === "or") return `or(${filter.parts.map(renderFilterOperand).join(",")})`;
  return "";
}

function selectColumns(selection: Selection) {
  if (!selection) return "*";
  return Object.values(selection).map((field: any) => columnName(field)).filter(Boolean).join(",") || "*";
}

class SelectQuery {
  private source?: TableLike;
  private filter?: Filter;
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private take?: number;
  private skip = 0;
  constructor(private readonly selection?: Selection) {}
  from(table: TableLike) { this.source = table; return this; }
  where(filter: Filter) { this.filter = filter; return this; }
  orderBy(...orders: Order[]) { this.orders.push(...orders.map(order => "column" in order ? order : { column: columnName(order), ascending: true })); return this; }
  limit(value: number) { this.take = value; return this; }
  offset(value: number) { this.skip = value; return this; }
  async execute() {
    if (!this.source) throw new Error("Supabase query has no table.");
    const isCount = Object.values(this.selection ?? {}).some((field: any) => field?.kind === "count");
    let query = getSupabaseAdmin().from(tableName(this.source)).select(selectColumns(this.selection), isCount ? { count: "exact" } : undefined);
    query = applyFilter(query, this.filter);
    for (const order of this.orders) query = query.order(order.column, { ascending: order.ascending });
    if (this.take !== undefined) query = query.range(this.skip, this.skip + this.take - 1);
    else if (this.skip > 0) query = query.range(this.skip, this.skip + 9999);
    const { data, error, count: total } = await query;
    if (error) throwSupabaseError(error);
    if (isCount) {
      const alias = Object.entries(this.selection ?? {}).find(([, field]: any) => field?.kind === "count")?.[0] ?? "count";
      return [{ [alias]: total ?? data?.length ?? 0 }];
    }
    return (data ?? []).map((row: any) => this.selection ? Object.fromEntries(Object.entries(this.selection).map(([alias, field]: any) => [alias, row[columnName(field)]])) : row);
  }
  then<TResult1 = any, TResult2 = never>(onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null) { return this.execute().then(onfulfilled, onrejected); }
}

class WriteQuery {
  private source?: TableLike;
  private insertValues: any;
  private updateValues: any;
  private conflict?: string;
  private filter?: Filter;
  private returningSelection?: Selection;
  constructor(private readonly operation: "insert" | "update" | "delete") {}
  into(table: TableLike) { this.source = table; return this; }
  values(value: any) { this.insertValues = value; return this; }
  set(value: any) { this.updateValues = value; return this; }
  where(filter: Filter) { this.filter = filter; return this; }
  returning(selection: Selection) { this.returningSelection = selection; return this; }
  onConflictDoUpdate(options: { target: any; set: any }) { const targets = Array.isArray(options.target) ? options.target : [options.target]; this.conflict = targets.map(columnName).join(","); this.updateValues = options.set; return this; }
  onConflictDoNothing(options: { target: any }) { const targets = Array.isArray(options.target) ? options.target : [options.target]; this.conflict = targets.map(columnName).join(","); this.updateValues = undefined; return this; }
  onDuplicateKeyUpdate(options: { set: any }) { this.updateValues = options.set; return this; }
  async execute() {
    if (!this.source) throw new Error("Supabase write has no table.");
    const client = getSupabaseAdmin();
    const table = client.from(tableName(this.source));
    let query: any;
    if (this.operation === "insert") {
      if (this.conflict) query = table.upsert(this.insertValues, { onConflict: this.conflict, ignoreDuplicates: this.updateValues === undefined });
      else query = table.insert(this.insertValues);
    } else if (this.operation === "update") query = table.update(this.updateValues);
    else query = table.delete();
    query = applyFilter(query, this.filter);
    if (this.returningSelection) query = query.select(selectColumns(this.returningSelection));
    const { data, error } = await query;
    if (error) throwSupabaseError(error);
    if (this.returningSelection) return (data ?? []).map((row: any) => Object.fromEntries(Object.entries(this.returningSelection!).map(([alias, field]: any) => [alias, row[columnName(field)]])));
    return data ?? [];
  }
  then<TResult1 = any, TResult2 = never>(onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null) { return this.execute().then(onfulfilled, onrejected); }
}

class SupabaseDb {
  select(selection?: Selection) { return new SelectQuery(selection); }
  insert(table: TableLike) { return new WriteQuery("insert").into(table); }
  update(table: TableLike) { return new WriteQuery("update").into(table); }
  delete(table: TableLike) { return new WriteQuery("delete").into(table); }
}

export const supabaseDb = new SupabaseDb();
export type SupabaseDatabase = SupabaseDb;
