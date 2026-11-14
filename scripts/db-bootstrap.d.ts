export interface BootstrapConfig {
  directUrl: string;
  apiUserPassword: string;
  roleName: string;
  host: string;
  database: string;
}

export function isPlaceholderOrBlank(val: unknown): boolean;
export function validateBootstrapEnv(
  env?: Record<string, string | undefined>,
): BootstrapConfig;
export function runBootstrap(
  env?: Record<string, string | undefined>,
): Promise<void>;
