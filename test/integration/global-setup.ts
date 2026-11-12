import { verifyTestEnvironment } from './setup.js';

export async function setup(): Promise<void> {
  await verifyTestEnvironment();
}
