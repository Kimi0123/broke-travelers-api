import { describe, expect, it } from 'vitest';
import { createWallClock } from '../../src/domain/wall-clock.js';
import {
  dateOnlyToWallClock,
  nptWallClockToUtcInstant,
  systemClockUtc,
  utcInstantToNptWallClock,
  wallClockToDateOnly,
} from '../../src/infrastructure/time/npt.js';

describe('NPT time helpers (+05:45 fixed offset)', () => {
  it('round-trips arbitrary timestamps between UTC Date and NPT WallClock', () => {
    const dates = [
      new Date('2026-11-11T12:00:00.000Z'),
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2024-02-29T18:15:00.000Z'),
      new Date('2023-08-15T23:59:59.999Z'),
    ];

    for (const original of dates) {
      const wc = utcInstantToNptWallClock(original);
      const reconstructed = nptWallClockToUtcInstant(wc);
      expect(reconstructed.getTime()).toBe(original.getTime());
    }
  });

  it('handles midnight boundaries correctly', () => {
    // 00:00:00 UTC is 05:45:00 NPT on the same date
    const utcMidnight = new Date('2026-06-15T00:00:00.000Z');
    const nptFromUtcMidnight = utcInstantToNptWallClock(utcMidnight);
    expect(nptFromUtcMidnight).toEqual({
      y: 2026,
      m: 6,
      d: 15,
      h: 5,
      mi: 45,
      s: 0,
      ms: 0,
    });

    // 00:00:00 NPT is 18:15:00 UTC on the previous calendar date
    const nptMidnight = createWallClock(2026, 6, 15, 0, 0, 0, 0);
    const utcFromNptMidnight = nptWallClockToUtcInstant(nptMidnight);
    expect(utcFromNptMidnight.toISOString()).toBe('2026-06-14T18:15:00.000Z');
  });

  it('correctly maps 23:59 NPT to the previous/same UTC date', () => {
    // 23:59:00 NPT is 18:14:00 UTC on the SAME calendar day (since offset is +05:45)
    const nptEnd = createWallClock(2024, 2, 29, 23, 59, 0, 0);
    const utcInstant = nptWallClockToUtcInstant(nptEnd);
    expect(utcInstant.toISOString()).toBe('2024-02-29T18:14:00.000Z');

    // Early morning NPT (04:00:00 NPT) maps to previous UTC calendar day (22:15:00 UTC)
    const nptEarly = createWallClock(2024, 3, 1, 4, 0, 0, 0);
    const utcEarly = nptWallClockToUtcInstant(nptEarly);
    expect(utcEarly.toISOString()).toBe('2024-02-29T22:15:00.000Z');
  });

  it('preserves leap day 2024-02-29 through conversions', () => {
    const leapDayUtc = new Date('2024-02-29T10:00:00.000Z');
    const wc = utcInstantToNptWallClock(leapDayUtc);
    expect(wc.y).toBe(2024);
    expect(wc.m).toBe(2);
    expect(wc.d).toBe(29);
    expect(wc.h).toBe(15);
    expect(wc.mi).toBe(45);

    const backToUtc = nptWallClockToUtcInstant(wc);
    expect(backToUtc.toISOString()).toBe('2024-02-29T10:00:00.000Z');
  });

  it('round-trips date-only conversions', () => {
    const wcDate = createWallClock(2026, 11, 1, 0, 0, 0, 0);
    const dateObj = wallClockToDateOnly(wcDate);
    expect(dateObj.toISOString()).toBe('2026-11-01T00:00:00.000Z');

    const mappedBack = dateOnlyToWallClock(dateObj);
    expect(mappedBack).toEqual(wcDate);
  });

  it('systemClockUtc provides current NPT wall-clock both directly and via method', () => {
    const directWc = systemClockUtc();
    expect(directWc.y).toBeGreaterThanOrEqual(2024);
    expect(directWc.m).toBeGreaterThanOrEqual(1);
    expect(directWc.m).toBeLessThanOrEqual(12);

    const methodWc = systemClockUtc.nowWallClock();
    expect(methodWc.y).toBe(directWc.y);
  });
});
