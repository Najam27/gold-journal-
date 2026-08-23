import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

function parseNormalizedBody(req: Request, next: NextFunction) {
  if (!Buffer.isBuffer(req.body)) return next();
  const normalized = req.body
    .toString("utf8")
    .replace(/\u0000+$/g, "")
    .trim();
  if (!normalized) {
    req.body = {};
    return next();
  }
  try {
    req.body = JSON.parse(normalized);
    next();
  } catch (error) {
    const parseError =
      error instanceof SyntaxError
        ? error
        : new SyntaxError("Malformed JSON request body.");
    Object.assign(parseError, {
      body: normalized,
      type: "entity.parse.failed",
    });
    next(parseError);
  }
}

/**
 * MQL5 StringToCharArray includes a terminating NUL when WHOLE_ARRAY is used.
 * Express's JSON parser correctly rejects that byte, so MT5 uses this narrow
 * raw-body adapter before normal server-side Zod validation.
 */
export function mt5JsonBody(req: Request, res: Response, next: NextFunction) {
  return express.raw({ type: "application/json", limit: "256kb" })(
    req,
    res,
    error => {
      if (error) return next(error);
      return parseNormalizedBody(req, next);
    }
  );
}
