import { describe, expect, it } from 'vitest';
import { elapsedText } from '../src/progress-ui.js';

describe('review progress', () => {
  it('formats elapsed time for a quick read', () => {
    expect(elapsedText(0)).toBe('0 s');
    expect(elapsedText(45_900)).toBe('45 s');
    expect(elapsedText(125_000)).toBe('2 min 05 s');
    expect(elapsedText(-5)).toBe('0 s');
  });
});
