import { describe, expect, it } from 'vitest';
import { dueDateFor } from '../../src/domain/due-dates.js';
import { adaptWallClock, loadVectorFile } from '../support/vector-loader.js';

interface DueDateInput {
  dueDay: number;
  month: number;
  year: number;
}

interface DueDateExpected {
  dueDate: {
    y: number;
    m: number;
    d: number;
    h: number;
    mi: number;
    s: number;
    ms: number;
  };
}

describe('due_dates golden vectors', () => {
  const file = loadVectorFile<DueDateInput, DueDateExpected>('due_dates');

  it('contains expected number of cases', () => {
    expect(file.cases.length).toBe(32);
  });

  it.each(file.cases)('executes case: $name', (c) => {
    const actual = dueDateFor(c.input.year, c.input.month, c.input.dueDay);
    const expected = adaptWallClock(c.expected.dueDate);
    expect(actual).toEqual(expected);
  });
});
