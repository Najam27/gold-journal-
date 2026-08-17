import { describe, expect, it } from "vitest";
import { toSafeAccount, toSafeJournalRecord, toSafeTrade } from "./journalPrivacy";

describe("journal browser-data privacy", () => {
  it("removes ownership, storage, filename, and audit metadata while preserving a screenshot availability flag", () => {
    const safe = toSafeTrade({ id: 7, userId: 21, accountId: 3, screenshotKey: "gold-journal/21/trades/7.png", screenshotName: "private-entry.png", createdAt: new Date(), updatedAt: new Date(), session: "London", pnl: "60" });
    expect(safe).toMatchObject({ id: 7, session: "London", pnl: "60", hasScreenshot: true });
    ["userId", "accountId", "screenshotKey", "screenshotName", "createdAt", "updatedAt"].forEach(field => expect(safe).not.toHaveProperty(field));
  });

  it("keeps only the public account and journal fields that the interface requires", () => {
    const account = toSafeAccount({ id: 3, userId: 21, name: "Funded Gold", startingBalance: "1000", createdAt: new Date(), updatedAt: new Date() });
    const plan = toSafeJournalRecord({ id: 4, userId: 21, accountId: 3, planDate: new Date(), planNotes: "Wait for London", createdAt: new Date(), updatedAt: new Date() });
    expect(account).toMatchObject({ id: 3, name: "Funded Gold" });
    expect(plan).toMatchObject({ id: 4, planNotes: "Wait for London" });
    [account, plan].forEach(record => ["userId", "accountId", "createdAt", "updatedAt"].forEach(field => expect(record).not.toHaveProperty(field)));
  });
});
