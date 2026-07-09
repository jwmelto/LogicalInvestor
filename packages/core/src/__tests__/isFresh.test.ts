import { isFresh } from '../index';

describe('isFresh', () => {
  test('true for a pubDate within the window', () => {
    const pubDate = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    expect(isFresh(pubDate, 2 * 60 * 60 * 1000)).toBe(true);
  });

  test('false for a pubDate older than the window', () => {
    const pubDate = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago
    expect(isFresh(pubDate, 2 * 60 * 60 * 1000)).toBe(false);
  });
});
