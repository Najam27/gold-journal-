import type { RequestHandler } from "express";

/**
 * Workspace, authentication, and MT5 ingest responses contain current user/account state.
 * They must never be retained by a browser, CDN, or intermediary after a live EA event.
 */
export const apiNoStore: RequestHandler = (req, res, next) => {
  if (req.path === "/mt5" || req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    res.setHeader("CDN-Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Vary", "Authorization, Cookie");
  }
  next();
};
