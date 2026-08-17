import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { ENV } from "./_core/env";
import { goldRouter } from "./goldRouter";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";

const OAUTH_PROBE_TIMEOUT_MS = 2_500;

async function oauthServiceAvailable() {
  if (!ENV.oAuthServerUrl) return false;
  return new Promise(resolve => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(false); }, OAUTH_PROBE_TIMEOUT_MS);
    void fetch(ENV.oAuthServerUrl, { method: "GET", redirect: "manual", signal: controller.signal })
      .then(() => { clearTimeout(timer); resolve(true); })
      .catch(() => { clearTimeout(timer); resolve(false); });
  });
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    oauthStatus: publicProcedure.query(async () => ({ available: await oauthServiceAvailable() })),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  ...goldRouter._def.record,
});

export type AppRouter = typeof appRouter;
