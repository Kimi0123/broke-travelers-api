const PLACEHOLDERS = new Set([
  'changeme',
  'placeholder',
  'secret',
  'xxx',
  'your-secret',
  'your-password',
  'todo',
  'undefined',
  'null',
]);

const VALID_LOG_LEVELS = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

export function isPlaceholderOrBlank(val: string | undefined): boolean {
  if (val === undefined || val === null) return true;
  const trimmed = val.trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDERS.has(trimmed.toLowerCase());
}

export function parseServiceAccountJson(val: string | undefined): {
  valid: boolean;
  normalized?: string;
} {
  if (isPlaceholderOrBlank(val)) {
    return { valid: false };
  }
  const str = val!.trim();
  try {
    const parsed: unknown = JSON.parse(str);
    if (typeof parsed === 'object' && parsed !== null) {
      return { valid: true, normalized: str };
    }
  } catch {
    try {
      const decoded = Buffer.from(str, 'base64').toString('utf8');
      const parsed: unknown = JSON.parse(decoded);
      if (typeof parsed === 'object' && parsed !== null) {
        return { valid: true, normalized: decoded };
      }
    } catch {
      // not valid json
    }
  }
  return { valid: false };
}

export interface AppConfig {
  readonly NODE_ENV: 'development' | 'production' | 'test';
  readonly PORT: number;
  readonly LOG_LEVEL: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly TRUST_PROXY_HOPS: number;
  readonly REQUIRE_VERIFIED_EMAIL: boolean;
  readonly DATABASE_URL: string;
  readonly DIRECT_URL?: string | undefined;
  readonly TEST_DATABASE_URL?: string | undefined;
  readonly TEST_DIRECT_URL?: string | undefined;
  readonly FIREBASE_PROJECT_ID?: string | undefined;
  readonly FIREBASE_SERVICE_ACCOUNT_JSON?: string | undefined;
  readonly FIREBASE_AUTH_EMULATOR_HOST?: string | undefined;
}

/**
 * Loads and validates environment variables.
 * If validation fails, throws an Error listing only the invalid variable NAMES (never values).
 */
export function loadConfig(
  rawEnv: Record<string, string | undefined> = process.env,
): AppConfig {
  const invalidNames: string[] = [];

  // 1. NODE_ENV
  const rawNodeEnv = rawEnv['NODE_ENV'] ?? 'development';
  let nodeEnv: 'development' | 'production' | 'test' = 'development';
  if (
    rawNodeEnv === 'development' ||
    rawNodeEnv === 'production' ||
    rawNodeEnv === 'test'
  ) {
    nodeEnv = rawNodeEnv;
  } else {
    invalidNames.push('NODE_ENV');
  }

  const isProduction = nodeEnv === 'production';

  // 2. PORT
  let port = 3000;
  const rawPort = rawEnv['PORT'];
  if (rawPort !== undefined) {
    if (isPlaceholderOrBlank(rawPort)) {
      invalidNames.push('PORT');
    } else {
      const parsed = Number.parseInt(rawPort, 10);
      if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        invalidNames.push('PORT');
      } else {
        port = parsed;
      }
    }
  }

  // 3. LOG_LEVEL
  let logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' =
    'info';
  const rawLogLevel = rawEnv['LOG_LEVEL'];
  if (isProduction) {
    if (
      !rawLogLevel ||
      isPlaceholderOrBlank(rawLogLevel) ||
      !VALID_LOG_LEVELS.has(rawLogLevel)
    ) {
      invalidNames.push('LOG_LEVEL');
    } else {
      logLevel = rawLogLevel as typeof logLevel;
    }
  } else if (rawLogLevel !== undefined) {
    if (
      isPlaceholderOrBlank(rawLogLevel) ||
      !VALID_LOG_LEVELS.has(rawLogLevel)
    ) {
      invalidNames.push('LOG_LEVEL');
    } else {
      logLevel = rawLogLevel as typeof logLevel;
    }
  }

  // 4. TRUST_PROXY_HOPS
  let trustProxyHops = 1;
  const rawTrustProxy = rawEnv['TRUST_PROXY_HOPS'];
  if (isProduction) {
    if (!rawTrustProxy || isPlaceholderOrBlank(rawTrustProxy)) {
      invalidNames.push('TRUST_PROXY_HOPS');
    } else {
      const parsed = Number.parseInt(rawTrustProxy, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        invalidNames.push('TRUST_PROXY_HOPS');
      } else {
        trustProxyHops = parsed;
      }
    }
  } else if (rawTrustProxy !== undefined) {
    if (isPlaceholderOrBlank(rawTrustProxy)) {
      invalidNames.push('TRUST_PROXY_HOPS');
    } else {
      const parsed = Number.parseInt(rawTrustProxy, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        invalidNames.push('TRUST_PROXY_HOPS');
      } else {
        trustProxyHops = parsed;
      }
    }
  }

  // 5. REQUIRE_VERIFIED_EMAIL
  let requireVerifiedEmail = false;
  const rawReqVerified = rawEnv['REQUIRE_VERIFIED_EMAIL'];
  if (
    rawReqVerified === undefined ||
    isPlaceholderOrBlank(rawReqVerified) ||
    (rawReqVerified !== 'true' && rawReqVerified !== 'false')
  ) {
    invalidNames.push('REQUIRE_VERIFIED_EMAIL');
  } else {
    requireVerifiedEmail = rawReqVerified === 'true';
  }

  // 6. DATABASE_URL
  const rawDbUrl = rawEnv['DATABASE_URL'];
  if (!rawDbUrl || isPlaceholderOrBlank(rawDbUrl)) {
    invalidNames.push('DATABASE_URL');
  }

  // 7. FIREBASE_PROJECT_ID
  const rawProjectId = rawEnv['FIREBASE_PROJECT_ID'];
  if (isProduction) {
    if (!rawProjectId || isPlaceholderOrBlank(rawProjectId)) {
      invalidNames.push('FIREBASE_PROJECT_ID');
    }
  } else if (rawProjectId !== undefined && isPlaceholderOrBlank(rawProjectId)) {
    invalidNames.push('FIREBASE_PROJECT_ID');
  }

  // 8. FIREBASE_SERVICE_ACCOUNT_JSON
  let normalizedServiceAccountJson: string | undefined;
  const rawServiceAccountJson = rawEnv['FIREBASE_SERVICE_ACCOUNT_JSON'];
  if (isProduction) {
    if (!rawServiceAccountJson || isPlaceholderOrBlank(rawServiceAccountJson)) {
      invalidNames.push('FIREBASE_SERVICE_ACCOUNT_JSON');
    } else {
      const parsedSa = parseServiceAccountJson(rawServiceAccountJson);
      if (!parsedSa.valid) {
        invalidNames.push('FIREBASE_SERVICE_ACCOUNT_JSON');
      } else {
        normalizedServiceAccountJson = parsedSa.normalized;
      }
    }
  } else if (rawServiceAccountJson !== undefined) {
    if (isPlaceholderOrBlank(rawServiceAccountJson)) {
      invalidNames.push('FIREBASE_SERVICE_ACCOUNT_JSON');
    } else {
      const parsedSa = parseServiceAccountJson(rawServiceAccountJson);
      if (!parsedSa.valid) {
        invalidNames.push('FIREBASE_SERVICE_ACCOUNT_JSON');
      } else {
        normalizedServiceAccountJson = parsedSa.normalized;
      }
    }
  }

  // Check optional fields for placeholder values
  for (const key of [
    'DIRECT_URL',
    'TEST_DATABASE_URL',
    'TEST_DIRECT_URL',
    'FIREBASE_AUTH_EMULATOR_HOST',
  ]) {
    const val = rawEnv[key];
    if (val !== undefined && isPlaceholderOrBlank(val)) {
      invalidNames.push(key);
    }
  }

  if (invalidNames.length > 0) {
    const uniqueNames = Array.from(new Set(invalidNames));
    throw new Error(
      `Invalid or missing environment variables: ${uniqueNames.join(', ')}`,
    );
  }

  return {
    NODE_ENV: nodeEnv,
    PORT: port,
    LOG_LEVEL: logLevel,
    TRUST_PROXY_HOPS: trustProxyHops,
    REQUIRE_VERIFIED_EMAIL: requireVerifiedEmail,
    DATABASE_URL: rawDbUrl!,
    DIRECT_URL: rawEnv['DIRECT_URL'],
    TEST_DATABASE_URL: rawEnv['TEST_DATABASE_URL'],
    TEST_DIRECT_URL: rawEnv['TEST_DIRECT_URL'],
    FIREBASE_PROJECT_ID: rawProjectId,
    FIREBASE_SERVICE_ACCOUNT_JSON: normalizedServiceAccountJson,
    FIREBASE_AUTH_EMULATOR_HOST: rawEnv['FIREBASE_AUTH_EMULATOR_HOST'],
  };
}
