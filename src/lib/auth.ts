import { createContext, useContext } from "react";

export interface AuthState {
  email: string | null;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({ email: null, signOut: async () => {} });

export function useAuth() {
  return useContext(AuthContext);
}
