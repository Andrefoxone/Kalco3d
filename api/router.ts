import { createRouter, publicQuery } from "./middleware";
import { modelsRouter } from "./routers/models";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  models: modelsRouter,
});

export type AppRouter = typeof appRouter;
