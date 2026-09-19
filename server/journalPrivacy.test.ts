import { describe, expect, it } from "vitest";
import { toSafeAccount, toSafeJournalRecord, toSafeTrade } from "./journalPrivacy";

describe("journal browser-data privacy", () => {
  it("removes ownership, storage path, and audit metadata while preserving screenshot availability and its filename", () => {
    const safe = toSafeTrade({ id: 7, userId: 21, accountId: 3, screenshotKey: "journal-owner/accounts/3/trades/7/abc.png", screenshotName: "private-entry.png", createdAt: new Date(), updatedAt: new Date(), session: "London", pnl: "60" });
    expect(safe).toMatchObject({ id: 7, session: "London", pnl: "60", hasScreenshot: true, screenshotName: "private-entry.png" });
    // The private object key is the one field that must never reach the browser:
    // the UI renders a freshly signed, short-lived URL instead, and the stable
    // key stays the database's business. The original filename is not sensitive
    // and is what labels the stored attachment in the Trade Log.
    ["userId", "accountId", "screenshotKey", "createdAt", "updatedAt"].forEach(field => expect(safe).not.toHaveProperty(field));
  });

  it("keeps the trade's own MT5 ticket for the Trade Card and the PDF export, as a string", () => {
    const safe = toSafeTrade({ id: 7, userId: 21, accountId: 3, mt5Ticket: BigInt("123456789"), session: "London" });
    expect(safe.mt5Ticket).toBe("123456789");
    expect(toSafeTrade({ id: 8, session: "London" }).mt5Ticket).toBeNull();
  });

  it("keeps only the public account and journal fields that the interface requires", () => {
    const account = toSafeAccount({ id: 3, userId: 21, name: "Funded Gold", startingBalance: "1000", createdAt: new Date(), updatedAt: new Date() });
    const plan = toSafeJournalRecord({ id: 4, userId: 21, accountId: 3, planDate: new Date(), planNotes: "Wait for London", createdAt: new Date(), updatedAt: new Date() });
    expect(account).toMatchObject({ id: 3, name: "Funded Gold" });
    expect(plan).toMatchObject({ id: 4, planNotes: "Wait for London" });
    [account, plan].forEach(record => ["userId", "accountId", "createdAt", "updatedAt"].forEach(field => expect(record).not.toHaveProperty(field)));
  });
});
