import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { correlationIdOf } from "../persistenceDiagnostics";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // A persistence failure carries its correlation id on the cause (see
    // server/persistenceDiagnostics). Lift it into the wire payload so the UI
    // can show a reference that matches the server log line exactly, without
    // ever leaking the provider's raw error text to the browser.
    const correlationId = correlationIdOf(error.cause) ?? correlationIdOf(error);
    const withCorrelation = correlationId ? { ...shape, data: { ...shape.data, correlationId } } : shape;
    if (process.env.NODE_ENV === "production" && shape.data.code === "INTERNAL_SERVER_ERROR") {
      return {
        ...withCorrelation,
        message: correlationId
          ? `An unexpected server error occurred. Quote reference ${correlationId} when reporting this.`
          : "An unexpected server error occurred. Please retry.",
        data: { ...withCorrelation.data, stack: undefined },
      };
    }
    return withCorrelation;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
