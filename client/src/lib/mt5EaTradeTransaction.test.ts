import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/public/GoldJournal_EA.mq5"), "utf8");
/** Comments explain the rule; only real code is allowed to reference members. */
const codeOnly = source
  .split("\n")
  .map(line => line.replace(/\/\/.*$/, ""))
  .join("\n");

/**
 * The exact member list from the MQL5 reference for MqlTradeTransaction
 * (mql5.com/en/docs/constants/structures/mqltradetransaction). The build that
 * produced no .ex5 read `transaction.entry`, which is not a member of the
 * structure: MetaEditor fails with an undeclared-member error, emits no
 * compiled EA, and the Navigator therefore lists nothing.
 */
const DOCUMENTED_TRANSACTION_MEMBERS = new Set([
  "deal",
  "order",
  "symbol",
  "type",
  "order_type",
  "order_state",
  "deal_type",
  "time_type",
  "time_expiration",
  "price",
  "price_trigger",
  "price_sl",
  "price_tp",
  "volume",
  "position",
  "position_by",
]);

describe("GoldJournal EA trade transaction handling", () => {
  it("only reads documented MqlTradeTransaction members", () => {
    const fields = Array.from(new Set(Array.from(codeOnly.matchAll(/\btransaction\.([A-Za-z_][A-Za-z0-9_]*)/g), match => match[1])));

    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(
        DOCUMENTED_TRANSACTION_MEMBERS.has(field),
        `transaction.${field} is not a documented MqlTradeTransaction member`
      ).toBe(true);
    }
    expect(codeOnly).not.toMatch(/transaction\.entry\b/);
  });

  it("derives the deal entry type and the lifecycle identifier from the deal", () => {
    // transaction.position is the POSITION TICKET, so the entry type and the
    // lifecycle identifier must both come from the deal itself.
    expect(codeOnly).toContain("if(transaction.deal == 0) return;");
    expect(codeOnly).toContain("if(!HistoryDealSelect(transaction.deal)) return;");
    expect(codeOnly).toContain("ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(transaction.deal, DEAL_ENTRY);");
    expect(codeOnly).toContain("ulong position_identifier = (ulong)HistoryDealGetInteger(transaction.deal, DEAL_POSITION_ID);");
    expect(codeOnly).not.toContain("transaction.position");
  });

  it("only asks for history reconstruction on a closing deal", () => {
    expect(codeOnly).toContain("if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) return;");
    expect(codeOnly).toContain("if(position_identifier == 0) return;");
    expect(codeOnly).toContain("RequestIncrementalHistory();");
  });

  it("never treats a position identifier as a position ticket", () => {
    // HistorySelectByPosition() needs the identifier, while the open-position
    // stream is keyed by the current ticket; the two lookups are separate.
    expect(codeOnly).toContain("bool IsPositionIdentifierOpen(ulong position_identifier)");
    expect(codeOnly).toContain("ulong PositionTicketByIdentifier(ulong position_identifier)");
    expect(codeOnly).toContain("if((ulong)PositionGetInteger(POSITION_IDENTIFIER) == position_identifier) return true;");
    expect(codeOnly).toContain("if(IsPositionIdentifierOpen(position_id)) return \"\";");
    expect(codeOnly).not.toMatch(/PositionSelectByTicket\(\s*position_id\s*\)/);
    // A partial close must stay OPEN, so reconstruction is guarded by the
    // identifier scan rather than by the position row selected for a ticket.
    expect(codeOnly).toContain("if(!HistorySelectByPosition(position_id)) {");
  });

  it("keeps position snapshots keyed by the current position ticket", () => {
    expect(codeOnly).toContain("ulong ticket = PositionGetTicket(i);");
    expect(codeOnly).toContain("string PositionJson(ulong ticket)");
    expect(codeOnly).toContain("PositionSelectByTicket(ticket)");
  });
});
