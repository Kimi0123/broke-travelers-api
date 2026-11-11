import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const EXPECTED_VECTOR_FILES: Record<string, number> = {
  'approval_rules.json': 18,
  'due_dates.json': 32,
  'ledger_math.json': 15,
  'obligation_status.json': 14,
  'payment_reference.json': 22,
  'reports.json': 7,
  'transaction_validation.json': 27,
};

const TOTAL_EXPECTED_CASES = 135;

describe('Golden Vector Coverage', () => {
  const vectorsDir = path.resolve(process.cwd(), 'test', 'vectors');

  it('contains exactly the 7 expected vector files and README.md', () => {
    const files = fs
      .readdirSync(vectorsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    expect(files).toEqual(Object.keys(EXPECTED_VECTOR_FILES).sort());
  });

  for (const [fileName, expectedCount] of Object.entries(
    EXPECTED_VECTOR_FILES,
  )) {
    it(`${fileName} exists, is valid JSON, and has exactly ${expectedCount} cases`, () => {
      const filePath = path.join(vectorsDir, fileName);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content.endsWith('\n')).toBe(true);

      const parsed = JSON.parse(content) as {
        schemaVersion: number;
        domain: string;
        source: string;
        cases: unknown[];
      };

      expect(parsed.schemaVersion).toBe(1);
      expect(typeof parsed.domain).toBe('string');
      expect(typeof parsed.source).toBe('string');
      expect(Array.isArray(parsed.cases)).toBe(true);
      expect(parsed.cases.length).toBe(expectedCount);
      expect(parsed.cases.length).toBeGreaterThan(0);
    });
  }

  it(`total cases across all 7 vector files equals exactly ${TOTAL_EXPECTED_CASES}`, () => {
    const allFiles = Object.keys(EXPECTED_VECTOR_FILES);
    const sum = allFiles.reduce((acc, f) => {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(vectorsDir, f), 'utf-8'),
      ) as { cases: unknown[] };
      return acc + parsed.cases.length;
    }, 0);

    expect(sum).toBe(TOTAL_EXPECTED_CASES);
  });
});
