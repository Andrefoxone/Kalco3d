import { createRouter, publicQuery } from "./middleware";
import { modelsRouter } from "./routers/models";
import { billingRouter } from "./routers/billing";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  models: modelsRouter,
  billing: billingRouter,
});

export type AppRouter = typeof appRouter;
