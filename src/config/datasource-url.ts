/**
 * Resolves the database datasource URL for Prisma CLI and migrations.
 *
 * In production (NODE_ENV === 'production'):
 * Strictly requires either DIRECT_URL or DATABASE_URL to be set;
 * throws an Error naming the missing variables without exposing any values.
 * Local fallbacks are NEVER applied in production.
 *
 * In non-production (development, test):
 * Falls back to the local Docker database if neither environment variable is configured.
 */
export function resolveDatasourceUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const isProduction = env['NODE_ENV'] === 'production';
  const directUrl = env['DIRECT_URL']?.trim();
  const databaseUrl = env['DATABASE_URL']?.trim();

  const url = directUrl || databaseUrl;

  if (isProduction) {
    if (!url) {
      throw new Error(
        'Missing required database URL in production environment: either DIRECT_URL or DATABASE_URL must be set',
      );
    }
    return url;
  }

  return (
    url ||
    'postgresql://api_user:api_user_local_dev_secret@localhost:5533/broke_travelers?schema=public'
  );
}
