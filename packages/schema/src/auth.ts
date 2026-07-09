import { z } from "zod";

/**
 * M5 auth contracts. Sessions are opaque server-side tokens; the shapes here
 * cover signup/login, the current-user endpoint, extension pairing, and
 * session management. See docs/AUTH.md for the flow and threat model.
 */

export const signupRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10).max(200),
    display_name: z.string().trim().min(1).max(120).optional(),
    invite_code: z.string().max(200).optional(),
  })
  .strict();
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    current_password: z.string().min(1).max(200),
    new_password: z.string().min(10).max(200),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const pairingClaimRequestSchema = z
  .object({
    code: z.string().trim().regex(/^\d{8}$/, "pairing codes are 8 digits"),
  })
  .strict();
export type PairingClaimRequest = z.infer<typeof pairingClaimRequestSchema>;

export interface AuthUser {
  id: string;
  email: string;
  display_name: string | null;
}

/** Returned by login/signup (web session) and pairing claim (extension). */
export interface CreateSessionResponse {
  token: string;
  expires_at: string;
  user: AuthUser;
}

export interface MeResponse {
  user: AuthUser;
  session: {
    id: string;
    kind: "web" | "extension";
    created_at: string;
    expires_at: string;
  };
}

export interface PairingCodeResponse {
  code: string;
  expires_at: string;
}

export interface SessionSummary {
  id: string;
  kind: "web" | "extension";
  label: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  current: boolean;
}

export interface ListSessionsResponse {
  items: SessionSummary[];
}
