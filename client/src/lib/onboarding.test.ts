import { describe, expect, it } from "vitest";
import { isDetailedTrade, onboardingProgress } from "./onboarding";

describe("isDetailedTrade", () => {
  it("counts any single detail field as detailed", () => {
    expect(isDetailedTrade({ mistake: "FOMO" })).toBe(true);
    expect(isDetailedTrade({ notes: "Waited for retest" })).toBe(true);
    expect(isDetailedTrade({ emotionBefore: "calm" })).toBe(true);
    expect(isDetailedTrade({ planFollowScore: 4 })).toBe(true);
    expect(isDetailedTrade({ planFollowScore: "3" })).toBe(true);
  });

  it("rejects empty/blank fields and out-of-range scores", () => {
    expect(isDetailedTrade({})).toBe(false);
    expect(isDetailedTrade({ mistake: "   ", notes: "", emotionBefore: null })).toBe(false);
    expect(isDetailedTrade({ planFollowScore: 0 })).toBe(false);
    expect(isDetailedTrade({ planFollowScore: 6 })).toBe(false);
    expect(isDetailedTrade({ planFollowScore: "n/a" })).toBe(false);
  });
});

describe("onboardingProgress", () => {
  it("starts empty with a phase-1 next action", () => {
    const p = onboardingProgress({ trades: [], weeklyReviewCount: 0, planCount: 0 });
    expect(p.totalTrades).toBe(0);
    expect(p.complete).toBe(false);
    expect(p.phases.map((ph) => ph.done)).toEqual([0, 0, 0]);
    expect(p.nextAction).toBe("Log 10 more trades to finish phase 1.");
  });

  it("tracks partial phase 1 with singular/plural wording", () => {
    const trades = Array.from({ length: 9 }, () => ({}));
    const p = onboardingProgress({ trades, weeklyReviewCount: 0, planCount: 0 });
    expect(p.phases[0]).toMatchObject({ id: "log", target: 10, done: 9, complete: false });
    expect(p.nextAction).toBe("Log 1 more trade to finish phase 1.");
  });

  it("caps phase 1 at 10 even with more trades", () => {
    const trades = Array.from({ length: 25 }, () => ({}));
    const p = onboardingProgress({ trades, weeklyReviewCount: 0, planCount: 0 });
    expect(p.phases[0].done).toBe(10);
    expect(p.phases[0].complete).toBe(true);
    expect(p.nextAction).toContain("phase 2");
  });

  it("phase 2 counts detailed trades, capped at 10", () => {
    const trades = [
      { mistake: "FOMO" },
      { notes: "good entry" },
      { emotionBefore: "nervous" },
      { planFollowScore: 5 },
      {},
      { planFollowScore: 0 },
      {},
      {},
      {},
      {},
    ];
    const p = onboardingProgress({ trades, weeklyReviewCount: 0, planCount: 0 });
    expect(p.phases[1]).toMatchObject({ id: "detail", target: 10, done: 4, complete: false });
    expect(p.nextAction).toBe("Add detail (mistake, notes, emotion, or plan score) to 6 more trades to finish phase 2.");
  });

  it("phase 1 takes priority over phase 2 in nextAction", () => {
    const trades = Array.from({ length: 5 }, () => ({ mistake: "FOMO" }));
    const p = onboardingProgress({ trades, weeklyReviewCount: 0, planCount: 0 });
    expect(p.nextAction).toBe("Log 5 more trades to finish phase 1.");
  });

  it("phase 3 splits review and plan into two steps", () => {
    const trades = Array.from({ length: 10 }, () => ({ mistake: "FOMO" }));
    const noReview = onboardingProgress({ trades, weeklyReviewCount: 0, planCount: 0 });
    expect(noReview.phases[2].done).toBe(0);
    expect(noReview.nextAction).toBe("Complete your first weekly review to finish phase 3.");

    const reviewOnly = onboardingProgress({ trades, weeklyReviewCount: 1, planCount: 0 });
    expect(reviewOnly.phases[2]).toMatchObject({ done: 1, complete: false });
    expect(reviewOnly.nextAction).toBe("Save your first trading plan to finish phase 3.");

    const planOnly = onboardingProgress({ trades, weeklyReviewCount: 0, planCount: 3 });
    expect(planOnly.phases[2].done).toBe(1);
  });

  it("clamps negative counts to zero", () => {
    const trades = Array.from({ length: 10 }, () => ({ mistake: "x" }));
    const p = onboardingProgress({ trades, weeklyReviewCount: -2, planCount: -1 });
    expect(p.phases[2].done).toBe(0);
  });

  it("completes the program with the finishing message", () => {
    const trades = Array.from({ length: 30 }, () => ({ notes: "logged with detail", planFollowScore: 4 }));
    const p = onboardingProgress({ trades, weeklyReviewCount: 2, planCount: 1 });
    expect(p.totalTrades).toBe(30);
    expect(p.phases.every((ph) => ph.complete)).toBe(true);
    expect(p.complete).toBe(true);
    expect(p.nextAction).toBe("You've finished the First 30 — the habits are yours now.");
  });
});
