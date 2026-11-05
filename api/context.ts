import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { supabaseAdmin } from "./lib/storage";

export interface AuthUser {
  id: string;
  email: string | null;
}

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  /** utente Supabase autenticato (null se manca o non è valido il token) */
  user: AuthUser | null;
};

/** Verifica il token Supabase dell'header Authorization: Bearer <access_token>. */
async function userFromRequest(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}

export async function createContext(opts: FetchCreateContextFnOptions): Promise<TrpcContext> {
  return { req: opts.req, resHeaders: opts.resHeaders, user: await userFromRequest(opts.req) };
}
