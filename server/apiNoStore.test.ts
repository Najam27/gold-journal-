import { describe, expect, it, vi } from "vitest";
import { apiNoStore } from "./apiNoStore";

function invoke(path: string) {
  const setHeader = vi.fn();
  const next = vi.fn();
  apiNoStore({ path } as any, { setHeader } as any, next);
  return { setHeader, next };
}

describe("API no-store middleware", () => {
  it("marks tRPC and MT5 state responses private and non-cacheable", () => {
    const { setHeader, next } = invoke("/api/trpc");
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    expect(setHeader).toHaveBeenCalledWith("CDN-Cache-Control", "no-store");
    expect(setHeader).toHaveBeenCalledWith("Vary", "Authorization, Cookie");
    expect(next).toHaveBeenCalledOnce();
    expect(invoke("/api/mt5").setHeader).toHaveBeenCalledWith("Pragma", "no-cache");
    expect(invoke("/mt5").setHeader).toHaveBeenCalledWith("Expires", "0");
  });

  it("leaves static page requests available for normal asset caching", () => {
    const { setHeader, next } = invoke("/");
    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
