import compression from "compression";

/**
 * Compress sufficiently large text/JSON responses while leaving already
 * encoded or incompressible content untouched through compression's default
 * negotiation and filter behavior.
 */
export const httpCompression = compression({ threshold: "1kb" });
