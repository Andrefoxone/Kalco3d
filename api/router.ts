import { createRouter, publicQuery } from "./middleware";
import { modelsRouter } from "./routers/models";
import { billingRouter } from "./routers/billing";
import { imagesRouter } from "./routers/images";
import { worldsRouter } from "./routers/worlds";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  models: modelsRouter,
  billing: billingRouter,
  images: imagesRouter,
  worlds: worldsRouter,
});

export type AppRouter = typeof appRouter;
