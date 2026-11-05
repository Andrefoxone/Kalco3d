import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import { QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import type { AppRouter } from "../../api/router";
import type { ReactNode } from "react";
import { accessToken } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";

export const trpc = createTRPCReact<AppRouter>();

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      // ogni chiamata porta il token Supabase dell'utente
      async headers() {
        const token = await accessToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});

export function TRPCProvider({ children }: { children: ReactNode }) {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
