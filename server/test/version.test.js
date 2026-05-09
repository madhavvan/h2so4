// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  compareVersions — auto-update gate. A regression here ships
//  bad updates to all 20k users OR blocks security patches forever.
//  Cover the matrix: equal, major-up, minor-up, patch-up, missing
//  components, leading 'v', prerelease suffix.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { compareVersions } from '../src/utils/version.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('3.4.9', '3.4.9')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns 1 when first is greater (major)', () => {
    expect(compareVersions('4.0.0', '3.9.9')).toBe(1);
    expect(compareVersions('10.0.0', '9.99.99')).toBe(1);
  });

  it('returns 1 when first is greater (minor)', () => {
    expect(compareVersions('3.5.0', '3.4.9')).toBe(1);
    expect(compareVersions('3.10.0', '3.9.0')).toBe(1);  // double-digit catch
  });

  it('returns 1 when first is greater (patch)', () => {
    expect(compareVersions('3.4.10', '3.4.9')).toBe(1);
    expect(compareVersions('3.4.100', '3.4.99')).toBe(1);
  });

  it('returns -1 when first is less', () => {
    expect(compareVersions('3.4.8', '3.4.9')).toBe(-1);
    expect(compareVersions('3.3.99', '3.4.0')).toBe(-1);
    expect(compareVersions('2.99.99', '3.0.0')).toBe(-1);
  });

  it('handles missing components as zero', () => {
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
    expect(compareVersions('3', '3.0.0')).toBe(0);
    expect(compareVersions('3.4', '3.4.1')).toBe(-1);
  });

  it('strips leading v', () => {
    expect(compareVersions('v3.4.9', '3.4.9')).toBe(0);
    expect(compareVersions('V3.5.0', '3.4.9')).toBe(1);
  });

  it('ignores prerelease suffix', () => {
    expect(compareVersions('3.4.9-beta.1', '3.4.9')).toBe(0);
    expect(compareVersions('3.4.10-rc1', '3.4.9')).toBe(1);
  });

  it('handles undefined/null/empty without throwing', () => {
    expect(compareVersions(undefined, '3.4.9')).toBe(-1);
    expect(compareVersions('3.4.9', null)).toBe(1);
    expect(compareVersions('', '')).toBe(0);
  });

  // Documented regression: the OLD compareVersions used .map(Number) which
  // converts '' -> NaN. NaN comparisons always return false → returns 0
  // erroneously, so 3.10.0 was reported equal to 3.9.0 in some edge cases
  // (split by '.' on a weird input). The new impl uses parseInt which
  // returns NaN but we coerce via `|| 0`. This test pins the new behavior.
  it('parseInt path: garbage strings coerce to 0, not equal', () => {
    expect(compareVersions('3.foo.9', '3.0.9')).toBe(0); // both .map → [3, 0, 9]
    expect(compareVersions('3.foo.9', '3.1.9')).toBe(-1);
  });
});
