import { z } from 'zod';

const RawEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    PORT: z
      .string()
      .default('3000')
      .transform((val, ctx) => {
        const parsed = Number.parseInt(val, 10);
        if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid port',
          });
          return z.NEVER;
        }
        return parsed;
      }),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default('info'),
    TRUST_PROXY_HOPS: z
      .string()
      .default('1')
      .transform((val, ctx) => {
        const parsed = Number.parseInt(val, 10);
        if (Number.isNaN(parsed) || parsed < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid trust proxy hops',
          });
          return z.NEVER;
        }
        return parsed;
      }),
    REQUIRE_VERIFIED_EMAIL: z
      .string()
      .refine((val) => val === 'true' || val === 'false', {
        message: 'REQUIRE_VERIFIED_EMAIL must be "true" or "false"',
      })
      .transform((val) => val === 'true'),
    DATABASE_URL: z.string().min(1),
    DIRECT_URL: z.string().optional(),
    TEST_DATABASE_URL: z.string().optional(),
    TEST_DIRECT_URL: z.string().optional(),
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (
        !data.FIREBASE_PROJECT_ID ||
        data.FIREBASE_PROJECT_ID.trim().length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FIREBASE_PROJECT_ID'],
          message: 'FIREBASE_PROJECT_ID is required in production',
        });
      }
      if (
        !data.FIREBASE_SERVICE_ACCOUNT_JSON ||
        data.FIREBASE_SERVICE_ACCOUNT_JSON.trim().length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FIREBASE_SERVICE_ACCOUNT_JSON'],
          message: 'FIREBASE_SERVICE_ACCOUNT_JSON is required in production',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof RawEnvSchema>;

/**
 * Loads and validates environment variables.
 * If validation fails, throws an Error listing only the invalid variable NAMES (never values).
 */
export function loadConfig(
  rawEnv: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = RawEnvSchema.safeParse(rawEnv);

  if (!result.success) {
    const invalidNames = Array.from(
      new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ).filter((name) => name.length > 0);

    throw new Error(
      `Invalid or missing environment variables: ${invalidNames.join(', ')}`,
    );
  }

  return result.data;
}
