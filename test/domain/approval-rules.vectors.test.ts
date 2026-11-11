import { describe, expect, it } from 'vitest';
import {
  isApprovalExpired,
  resolveOpenStatus,
  votesNeeded,
} from '../../src/domain/approval-rules.js';
import { adaptWallClock, loadVectorFile } from '../support/vector-loader.js';

interface VotesNeededInput {
  eligible: number;
}

interface ResolveStatusInput {
  eligible: number;
  approvals: number;
  rejections: number;
}

interface ExpiryInput {
  createdAt: Parameters<typeof adaptWallClock>[0];
  now: Parameters<typeof adaptWallClock>[0];
}

type ApprovalRulesInput = VotesNeededInput | ResolveStatusInput | ExpiryInput;

interface ApprovalRulesExpected {
  votesNeeded?: number;
  status?: string;
}

describe('approval_rules golden vectors', () => {
  const file = loadVectorFile<ApprovalRulesInput, ApprovalRulesExpected>(
    'approval_rules',
  );

  it('contains expected number of cases', () => {
    expect(file.cases.length).toBe(18);
  });

  it.each(file.cases)('executes case: $name', (c) => {
    if ('votesNeeded' in c.expected) {
      const input = c.input as VotesNeededInput;
      const actual = votesNeeded(input.eligible);
      expect(actual).toBe(c.expected.votesNeeded);
    } else if ('approvals' in c.input) {
      const input = c.input;
      const actual = resolveOpenStatus(input);
      expect(actual).toBe(c.expected.status);
    } else if ('createdAt' in c.input) {
      const input = c.input;
      const createdAt = adaptWallClock(input.createdAt);
      const now = adaptWallClock(input.now);
      const isExpired = isApprovalExpired(createdAt, now);
      const actual = isExpired ? 'expired' : 'open';
      expect(actual).toBe(c.expected.status);
    } else {
      throw new Error(`Unrecognized case shape in approval_rules: ${c.name}`);
    }
  });
});
