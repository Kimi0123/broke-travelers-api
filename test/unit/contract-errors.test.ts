import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES } from '../../src/http/errors.js';

describe('API Contract Error Codes Alignment', () => {
  const contractPath = path.resolve(__dirname, '../../docs/api-contract.md');
  const contractContent = fs.readFileSync(contractPath, 'utf-8');
  const contractLines = contractContent.split('\n');

  // Extract error codes from lines matching `- **Errors**:`
  const endpointErrorLines = contractLines.filter((line) =>
    line.trim().startsWith('- **Errors**:'),
  );

  const endpointErrorCodes: string[] = [];
  for (const line of endpointErrorLines) {
    // Matches backtick identifiers like `unauthenticated`, `invalid_token_claims`
    const matches = line.matchAll(/`([a-z0-9_]+)`/g);
    for (const match of matches) {
      if (match[1]) {
        endpointErrorCodes.push(match[1]);
      }
    }
  }

  // Extract error codes from Appendix table: | `code` | <status> | ... |
  const appendixTableCodes: string[] = [];
  const appendixRowRegex = /^\|\s*`([a-z0-9_]+)`\s*\|\s*(\d{3})\s*\|/;
  for (const line of contractLines) {
    const match = line.trim().match(appendixRowRegex);
    if (match && match[1]) {
      appendixTableCodes.push(match[1]);
    }
  }

  it('extracts non-empty sets of error codes from docs', () => {
    expect(endpointErrorCodes.length).toBeGreaterThan(5);
    expect(appendixTableCodes.length).toBeGreaterThan(30);
  });

  it('guarantees every error code in endpoint - **Errors**: is defined in ERROR_MESSAGES', () => {
    for (const code of endpointErrorCodes) {
      expect(
        ERROR_MESSAGES,
        `Expected error code '${code}' from endpoint documentation to be defined in ERROR_MESSAGES`,
      ).toHaveProperty(code);
    }
  });

  it('guarantees every error code in the Appendix table is defined in ERROR_MESSAGES', () => {
    for (const code of appendixTableCodes) {
      expect(
        ERROR_MESSAGES,
        `Expected error code '${code}' from Appendix table to be defined in ERROR_MESSAGES`,
      ).toHaveProperty(code);
    }
  });

  it('ensures cannot_demote_last_treasurer has been replaced with cannot_remove_last_treasurer', () => {
    expect(contractContent).not.toContain('cannot_demote_last_treasurer');
    expect(appendixTableCodes).toContain('cannot_remove_last_treasurer');
    expect(endpointErrorCodes).toContain('cannot_remove_last_treasurer');
  });

  it('ensures unauthenticated is documented in both endpoints and appendix', () => {
    expect(endpointErrorCodes).toContain('unauthenticated');
    expect(appendixTableCodes).toContain('unauthenticated');
  });
});
