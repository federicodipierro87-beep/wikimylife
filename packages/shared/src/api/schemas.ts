import { z } from "zod";

/**
 * Contratto HTTP dell'autenticazione. Stessi schemi su entrambi i lati: le
 * rotte di `apps/api` li usano per validare l'ingresso, il client tipizzato per
 * validare cio' che torna. Una divergenza rompe la compilazione, non un test in
 * produzione.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

/**
 * 12 caratteri minimi, nessun requisito di composizione. Le regole "almeno una
 * maiuscola e un simbolo" spingono verso password piu' corte e piu' prevedibili:
 * la lunghezza e' l'unico parametro che paghi davvero.
 */
export const passwordSchema = z.string().min(12).max(256);

export const signupRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    locale: z.string().min(2).max(35).optional(),
  })
  .strict();

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    // Non `passwordSchema`: le regole di lunghezza sui vecchi account non
    // devono trasformarsi in un rifiuto di login (e in un oracolo su quali
    // password esistono).
    password: z.string().min(1).max(256),
  })
  .strict();

/**
 * Cambio password.
 *
 * `currentPassword` c'e' anche se la rotta sta dietro `requireAuth`: il token
 * dice «questa e' una sessione aperta», non «di la' dallo schermo c'e' il
 * proprietario». Senza questo campo, un telefono lasciato sbloccato per due
 * minuti basterebbe a prendersi l'account, e la password ricordata a memoria
 * smetterebbe di servire a qualcosa.
 *
 * Le due regole di lunghezza sono deliberatamente diverse. `currentPassword`
 * segue `loginRequestSchema` — permissiva, perche' una password vecchia piu'
 * corta di dodici caratteri esiste e deve poter essere digitata proprio nel
 * momento in cui la si sta sostituendo; rifiutarla qui vorrebbe dire
 * condannare quegli account a tenersela. `newPassword` segue `passwordSchema`,
 * perche' cio' che entra da oggi rispetta la regola di oggi.
 */
export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
  })
  .strict();

export const refreshRequestSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

export const logoutRequestSchema = refreshRequestSchema;

export const publicUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    locale: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const authTokensSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    /** Secondi di vita residua dell'access token. */
    expiresIn: z.number().int(),
    tokenType: z.literal("Bearer"),
  })
  .strict();

export const authSessionSchema = z
  .object({
    user: publicUserSchema,
    tokens: authTokensSchema,
  })
  .strict();

export const meResponseSchema = z
  .object({
    user: publicUserSchema,
  })
  .strict();

export const logoutResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const healthResponseSchema = z
  .object({
    status: z.union([z.literal("ok"), z.literal("degraded")]),
    db: z.union([z.literal("up"), z.literal("down")]),
    uptimeSeconds: z.number(),
    version: z.string(),
  })
  .strict();

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AuthTokens = z.infer<typeof authTokensSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
