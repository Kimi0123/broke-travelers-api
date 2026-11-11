import { v7 as uuidv7 } from 'uuid';

/**
 * Generates a time-ordered UUIDv7 string.
 *
 * All primary keys and entity IDs in Broke Travelers use UUIDv7 to ensure
 * monotonically increasing B-tree index locality and temporal sortability.
 */
export function generateId(): string {
  return uuidv7();
}
