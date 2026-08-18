import { goldRouter } from "./goldRouter";
import { systemRouter } from "./_core/systemRouter";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "./_core/trpc";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => { if (opts.ctx.authError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Secure profile sync is temporarily unavailable." }); return opts.ctx.user; }),
    logout: publicProcedure.mutation(() => ({ success: true } as const)),
  }),
  ...goldRouter._def.record,
});

export type AppRouter = typeof appRouter;
