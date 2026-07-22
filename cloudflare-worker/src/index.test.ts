import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { matchesFilter, stripReplyPrefix, channelFromCron, findAndStorePollToken, shouldPollNow, getIntervalMinutes, registerDevice, timingSafeEqualStr, CHANNEL_FEEDS, advanceDaily, DEFAULT_TOKENS_TTL_DAYS } from './index';
import { FeedKeys, containsActionableSignal, FEEDKEY_TO_CHANNEL } from '@li/core';
import type { FeedKey, FilterItem } from '@li/core';

const FK = FeedKeys;
const DEFAULT_TOKENS_TTL_SECONDS = DEFAULT_TOKENS_TTL_DAYS * 60 * 60 * 24;

function item(feedKey: FeedKey, overrides: { author?: string; title?: string; description?: string } = {}): FilterItem {
  return {
    feedKey,
    author: overrides.author ?? 'Sean Hyman',
    title: overrides.title ?? '',
    content: overrides.description ?? '',
  };
}

const AUTHOR = 'sean hyman';
const ACTIONABLE_AUTHORS = ['sean hyman'];
const MIN = 200;
const long = 'x'.repeat(210);
const longWithSignal = 'new pick — ' + 'x'.repeat(200);
const longNegative = 'we may consider a sell ' + 'x'.repeat(200);

const RSS_WITH_ITEM = '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>1</guid><title>t</title><link>l</link><description>d</description></item></channel></rss>';
const RSS_EMPTY     = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';

// Matches production's getETDate() exactly, for fixtures that need advanceDaily() to accumulate
// onto "today" rather than reset (which happens whenever the fixture's date doesn't match).
const TODAY_ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

// Builds a scheduled() event mock. Each call gets a unique scheduledTime by default, so
// sequential calls in a test are never mistaken for duplicate dispatches of the same tick —
// tests exercising the duplicate-dispatch guard itself pass an explicit scheduledTime instead.
let scheduledTimeSeq = 0;
function scheduledEvent(cron: string, scheduledTime = ++scheduledTimeSeq): any {
  return { cron, scheduledTime, noRetry: vi.fn() };
}

// Builds a `run:<channel>` KV value (the merged stats+seen+daily blob) for test fixtures that
// need pre-existing seen state. `lastRun: ''` means "never polled" (shouldPollNow always fires).
function runState(seen: Record<string, string[]>): string {
  return JSON.stringify({
    stats: { lastRun: '', lastNotified: null, itemsFetched: 0, numNewItems: 0, sent: 0 },
    seen,
    daily: { date: '1970-01-01', runs: 0, itemsFetched: 0, numNewItems: 0, sent: 0 },
  });
}

beforeEach(() => { vi.restoreAllMocks(); });

// matchesFilter(item, filter, authors, minLength, actionableAuthors) is the one function a
// device's alerting decision goes through. One describe block per tier, each covering only what
// that tier requires.
describe('matchesFilter', () => {
  describe('members tier', () => {
    it.each([
      ['no content', item(FK.membersArea, { description: '' })],
      ['long content', item(FK.membersArea, { description: long })],
      ['actionable-signal content', item(FK.membersArea, { description: longWithSignal })],
      ['negative-pattern content', item(FK.membersArea, { description: longNegative })],
    ])('a Members Area post (%s) alerts regardless of author', (_desc, testItem) => {
      expect(matchesFilter(testItem, 'members', ['someone else'], MIN, ACTIONABLE_AUTHORS)).toBe(true);
      expect(matchesFilter(testItem, 'members', [], MIN, ACTIONABLE_AUTHORS)).toBe(true);
    });

    it('a post outside Members Area does not alert', () => {
      expect(matchesFilter(item(FK.membersForum, { description: longWithSignal }), 'members', [AUTHOR], MIN, ACTIONABLE_AUTHORS)).toBe(false);
    });
  });

  describe('actionable tier', () => {
    it('an actionable-signal post by an ACTIONABLE_AUTHORS author alerts', () => {
      const post = item(FK.membersForum, { author: 'Sean Hyman', description: longWithSignal });
      expect(matchesFilter(post, 'actionable', [], MIN, ACTIONABLE_AUTHORS)).toBe(true);
    });

    it('an actionable-signal post by an author outside ACTIONABLE_AUTHORS does not alert', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: longWithSignal });
      expect(matchesFilter(post, 'actionable', [], MIN, ACTIONABLE_AUTHORS)).toBe(false);
    });

    it('a non-actionable post does not alert, regardless of author', () => {
      expect(matchesFilter(item(FK.membersForum, { author: 'Sean Hyman', description: long }), 'actionable', [], MIN, ACTIONABLE_AUTHORS)).toBe(false);
      expect(matchesFilter(item(FK.membersForum, { author: 'Joe Blow', description: long }), 'actionable', [], MIN, ACTIONABLE_AUTHORS)).toBe(false);
    });

    it('ACTIONABLE_AUTHORS is a live parameter: changing it changes who can alert', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: longWithSignal });
      expect(matchesFilter(post, 'actionable', [], MIN, ['sean hyman'])).toBe(false);
      expect(matchesFilter(post, 'actionable', [], MIN, ['joe blow'])).toBe(true);
    });

    it("a device's personal author whitelist does not restrict the actionable tier", () => {
      const post = item(FK.membersForum, { author: 'Sean Hyman', description: longWithSignal });
      expect(matchesFilter(post, 'actionable', ['someone else entirely'], MIN, ACTIONABLE_AUTHORS)).toBe(true);
    });

    it.each([FK.stockInsights, FK.optionsInsights])('%s requires a starred title to alert', (feedKey) => {
      const starred = item(feedKey, { title: '*AAPL Trade', description: longWithSignal });
      const unstarred = item(feedKey, { title: 'Discussion post', description: longWithSignal });
      expect(matchesFilter(starred, 'actionable', [AUTHOR], MIN, ACTIONABLE_AUTHORS)).toBe(true);
      expect(matchesFilter(unstarred, 'actionable', [AUTHOR], MIN, ACTIONABLE_AUTHORS)).toBe(false);
    });

    it('a negative-pattern post does not alert at the actionable tier, but can still alert at the length tier', () => {
      const post = item(FK.membersForum, { author: 'Sean Hyman', description: longNegative });
      expect(matchesFilter(post, 'actionable', [], MIN, ACTIONABLE_AUTHORS)).toBe(false);
      expect(matchesFilter(post, 'length', [], MIN, ACTIONABLE_AUTHORS)).toBe(true);
    });
  });

  describe('length tier', () => {
    it('a long-enough post by a whitelisted author alerts', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: long });
      expect(matchesFilter(post, 'length', ['joe blow'], MIN, ACTIONABLE_AUTHORS)).toBe(true);
    });

    it('a long-enough post by a non-whitelisted author does not alert', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: long });
      expect(matchesFilter(post, 'length', [AUTHOR], MIN, ACTIONABLE_AUTHORS)).toBe(false);
    });

    it('an empty author whitelist means no author restriction', () => {
      const post = item(FK.membersForum, { author: 'Anyone At All', description: long });
      expect(matchesFilter(post, 'length', [], MIN, ACTIONABLE_AUTHORS)).toBe(true);
    });

    it('a post shorter than minLength does not alert, even from a whitelisted author', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: 'short' });
      expect(matchesFilter(post, 'length', ['joe blow'], MIN, ACTIONABLE_AUTHORS)).toBe(false);
    });

    it('length is a strict superset of actionable: an actionable post alerts even if the whitelist would otherwise exclude its author', () => {
      const post = item(FK.membersForum, { author: 'Sean Hyman', description: longWithSignal });
      expect(matchesFilter(post, 'length', ['someone else entirely'], MIN, ACTIONABLE_AUTHORS)).toBe(true);
    });
  });
});

describe('stripReplyPrefix', () => {
  it('strips "Reply To: " from the start', () => {
    expect(stripReplyPrefix('Reply To: *AAPL Trade')).toBe('*AAPL Trade');
  });
  it('leaves titles without the prefix unchanged', () => {
    expect(stripReplyPrefix('*AAPL Trade')).toBe('*AAPL Trade');
    expect(stripReplyPrefix('Market update')).toBe('Market update');
  });
  it('trims whitespace', () => {
    expect(stripReplyPrefix('  Market update  ')).toBe('Market update');
  });
});

describe('CHANNEL_FEEDS consistency with @li/core FEEDKEY_TO_CHANNEL', () => {
  it('every feed is listed under the channel FEEDKEY_TO_CHANNEL says it belongs to', () => {
    for (const [channel, feeds] of Object.entries(CHANNEL_FEEDS) as [string, { feedKey: FeedKey }[]][]) {
      for (const { feedKey } of feeds) {
        expect(FEEDKEY_TO_CHANNEL[feedKey]).toBe(channel);
      }
    }
  });

  it('every feedKey in FEEDKEY_TO_CHANNEL is represented in CHANNEL_FEEDS', () => {
    const listed = new Set(Object.values(CHANNEL_FEEDS).flat().map((f) => f.feedKey));
    for (const feedKey of Object.keys(FEEDKEY_TO_CHANNEL) as FeedKey[]) {
      expect(listed.has(feedKey)).toBe(true);
    }
  });
});

describe('channelFromCron', () => {
  it('maps all three cron expressions to the correct channels', () => {
    expect(channelFromCron('0,5,10,15,20,25,30,35,40,45,50,55 * * * *')).toBe('members');
    expect(channelFromCron('1,6,11,16,21,26,31,36,41,46,51,56 * * * *')).toBe('stock');
    expect(channelFromCron('2,7,12,17,22,27,32,37,42,47,52,57 * * * *')).toBe('options');
  });

  it('falls back to members for unknown cron', () => {
    expect(channelFromCron('99 * * * *')).toBe('members');
  });
});


describe('getIntervalMinutes', () => {
  it('returns trading interval (5) during market hours', () => {
    expect(getIntervalMinutes(new Date('2025-06-04T09:15:00-04:00'))).toBe(5);
    expect(getIntervalMinutes(new Date('2025-06-04T13:55:00-04:00'))).toBe(5);
  });

  it('returns lateday interval (15) during late-day window', () => {
    expect(getIntervalMinutes(new Date('2025-06-04T14:00:00-04:00'))).toBe(15);
    expect(getIntervalMinutes(new Date('2025-06-04T16:14:00-04:00'))).toBe(15);
  });

  it('returns overnight interval (60) before open and after close on weekdays', () => {
    expect(getIntervalMinutes(new Date('2025-06-04T08:00:00-04:00'))).toBe(60);
    expect(getIntervalMinutes(new Date('2025-06-04T17:00:00-04:00'))).toBe(60);
  });

  it('returns overnight interval (60) on weekends', () => {
    expect(getIntervalMinutes(new Date('2025-06-07T10:00:00-04:00'))).toBe(60);
    expect(getIntervalMinutes(new Date('2025-06-08T14:00:00-04:00'))).toBe(60);
  });
});

describe('shouldPollNow', () => {
  const t = (iso: string) => new Date(iso);
  const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('always polls when lastRun is null', () => {
    expect(shouldPollNow(t('2025-06-04T09:15:00-04:00'), null, 5)).toBe(true);
    expect(shouldPollNow(t('2025-06-04T14:00:00-04:00'), null, 15)).toBe(true);
  });

  it('polls when elapsed time meets or exceeds interval', () => {
    const now = t('2025-06-04T14:30:00-04:00');
    expect(shouldPollNow(now, ago(now, 15), 15)).toBe(true);
    expect(shouldPollNow(now, ago(now, 60), 60)).toBe(true);
  });

  it('skips when elapsed time is less than interval', () => {
    const now = t('2025-06-04T14:30:00-04:00');
    expect(shouldPollNow(now, ago(now, 14), 15)).toBe(false);
    expect(shouldPollNow(now, ago(now, 59), 60)).toBe(false);
  });

  it('works correctly for stock/options channel offset (lastRun 1 min after boundary)', () => {
    // Stock cron fires at :01, :16, :31, :46 — simulate lastRun at 14:01, now is 14:16
    const lastRun = t('2025-06-04T14:01:00-04:00');
    const now     = t('2025-06-04T14:16:00-04:00');
    expect(shouldPollNow(now, lastRun, 15)).toBe(true); // 15 min elapsed
  });
});

describe('findAndStorePollToken', () => {
  function mockEnv(keys: { name: string; metadata?: { feedToken?: string } }[], statePut = vi.fn()) {
    return {
      TOKENS: { list: vi.fn().mockResolvedValue({ keys, list_complete: true }) },
      STATE:  { put: statePut },
    } as any;
  }

  it('returns null when no registered tokens have a feedToken', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = await findAndStorePollToken('stock', mockEnv([
      { name: 'stock:ExponentPushToken[abc]', metadata: { } },
    ]));
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null when all feedTokens return 0 items (all stale)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, text: () => Promise.resolve(RSS_EMPTY),
    }));
    const result = await findAndStorePollToken('stock', mockEnv([
      { name: 'stock:token1', metadata: { feedToken: 'stale' } },
    ]));
    expect(result).toBeNull();
  });

  it('returns and stores the first feedToken that returns items', async () => {
    const statePut = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(RSS_EMPTY) })    // first token stale
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }) // second token valid
    );
    const result = await findAndStorePollToken('stock', mockEnv([
      { name: 'stock:token1', metadata: { feedToken: 'stale-token' } },
      { name: 'stock:token2', metadata: { feedToken: 'valid-token' } },
    ], statePut));
    expect(result).toBe('valid-token');
    expect(statePut).toHaveBeenCalledWith('poll:stock', 'valid-token');
  });

  it('skips tokens where fetch fails', async () => {
    const statePut = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) })
    );
    const result = await findAndStorePollToken('options', mockEnv([
      { name: 'options:token1', metadata: { feedToken: 'broken' } },
      { name: 'options:token2', metadata: { feedToken: 'working' } },
    ], statePut));
    expect(result).toBe('working');
    expect(statePut).toHaveBeenCalledWith('poll:options', 'working');
  });
});

describe('registerDevice (logic, plain-object inputs)', () => {
  function mockEnv(tokensTtlDays?: string) {
    return {
      TOKENS: { put: vi.fn().mockResolvedValue(undefined) },
      STATE: { put: vi.fn().mockResolvedValue(undefined) },
      TOKENS_TTL_DAYS: tokensTtlDays,
    } as any;
  }

  it('rejects an optional-channel registration whose feed_token has no access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }));
    const env = mockEnv();
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', filter: 'actionable', authors: [], minLength: 200, feedToken: 'unauthorized' }, env);
    expect(res.status).toBe(403);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('accepts an optional-channel registration whose feed_token has access, and stores it as the poll token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv();
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', filter: 'actionable', authors: [], minLength: 200, feedToken: 'valid' }, env);
    expect(res.status).toBe(200);
    expect(env.STATE.put).toHaveBeenCalledWith('poll:options', 'valid');
    expect(env.TOKENS.put).toHaveBeenCalledWith('options:push1', '1', { metadata: { feedToken: 'valid', filter: 'actionable', authors: [], minLength: 200 }, expirationTtl: DEFAULT_TOKENS_TTL_SECONDS });
  });

  it('honors TOKENS_TTL_DAYS when set, overriding the default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv('7');
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', filter: 'actionable', authors: [], minLength: 200, feedToken: 'valid' }, env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith('options:push1', '1', { metadata: { feedToken: 'valid', filter: 'actionable', authors: [], minLength: 200 }, expirationTtl: 7 * 60 * 60 * 24 });
  });

  it('lowercases authors before storing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv();
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', filter: 'length', authors: ['Sean Hyman'], minLength: 0, feedToken: 'valid' }, env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith('options:push1', '1', { metadata: { feedToken: 'valid', filter: 'length', authors: ['sean hyman'], minLength: 0 }, expirationTtl: DEFAULT_TOKENS_TTL_SECONDS });
  });

  it('members channel verifies feedToken against Members Forum, and stores it as the poll token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
    vi.stubGlobal('fetch', fetchMock);
    const env = mockEnv();
    const res = await registerDevice({ channel: 'members', pushToken: 'push1', filter: 'actionable', authors: [], minLength: 200, feedToken: 'valid' }, env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('members-forum'));
    expect(env.STATE.put).toHaveBeenCalledWith('poll:members', 'valid');
    expect(env.TOKENS.put).toHaveBeenCalledWith('members:push1', '1', { metadata: { feedToken: 'valid', filter: 'actionable', authors: [], minLength: 200 }, expirationTtl: DEFAULT_TOKENS_TTL_SECONDS });
  });

  it('rejects a members registration with an expired or invalid feed_token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }));
    const env = mockEnv();
    const res = await registerDevice({ channel: 'members', pushToken: 'push1', filter: 'actionable', authors: [], minLength: 200, feedToken: 'expired' }, env);
    expect(res.status).toBe(403);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('returns 503 (not 403) when the access check itself fails, and does not store anything (issue #42)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));
    const env = mockEnv();
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', filter: 'actionable', authors: [], minLength: 200, feedToken: 'valid' }, env);
    expect(res.status).toBe(503);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
    expect(env.STATE.put).not.toHaveBeenCalled();
  });
});

describe('/register endpoint validation (HTTP boundary)', () => {
  function mockEnv() {
    return {
      TOKENS: { put: vi.fn().mockResolvedValue(undefined) },
      STATE: { put: vi.fn().mockResolvedValue(undefined) },
    } as any;
  }

  function registerRequest(body: Record<string, unknown>) {
    return new Request('https://worker.test/register', { method: 'POST', body: JSON.stringify(body) });
  }

  it('rejects a missing token', async () => {
    const res = await worker.fetch(registerRequest({ channel: 'members', filter: 'actionable', authors: [], minLength: 200 }), mockEnv());
    expect(res.status).toBe(400);
  });

  it('rejects a missing or unknown channel', async () => {
    const res = await worker.fetch(registerRequest({ token: 'push1', filter: 'actionable', authors: [], minLength: 200 }), mockEnv());
    expect(res.status).toBe(400);
    const res2 = await worker.fetch(registerRequest({ token: 'push1', channel: 'bogus', filter: 'actionable', authors: [], minLength: 200 }), mockEnv());
    expect(res2.status).toBe(400);
  });

  it('rejects a missing or invalid filter rather than silently defaulting it', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', authors: [], minLength: 200 }), env);
    expect(res.status).toBe(400);
    const res2 = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', filter: 'bogus', authors: [], minLength: 200 }), env);
    expect(res2.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid authors', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', filter: 'actionable', minLength: 200 }), env);
    expect(res.status).toBe(400);
    const res2 = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', filter: 'actionable', authors: 'sean', minLength: 200 }), env);
    expect(res2.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid minLength', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', filter: 'actionable', authors: [] }), env);
    expect(res.status).toBe(400);
    const res2 = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', filter: 'actionable', authors: [], minLength: -1 }), env);
    expect(res2.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('valid members registration reaches registerDevice and succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', filter: 'actionable', authors: [], minLength: 200, feed_token: 'anything' }), env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith('members:push1', '1', { metadata: { feedToken: 'anything', filter: 'actionable', authors: [], minLength: 200 }, expirationTtl: DEFAULT_TOKENS_TTL_SECONDS });
  });

  it('rejects an empty-string feed_token', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'options', filter: 'actionable', authors: [], minLength: 200, feed_token: '' }), env);
    expect(res.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('rejects a missing feed_token for the members channel', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', filter: 'actionable', authors: [], minLength: 200 }), env);
    expect(res.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });
});

describe('runChannel (via scheduled) — stale registration pruning', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'; // maps to 'options', see channelFromCron tests
  const itemWithAuthor = (guid: string, author: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${guid}</guid><title>t</title><link>l</link><dc:creator>${author}</dc:creator><description>d</description></item></channel></rss>`;

  function mockEnv() {
    const stateStore: Record<string, string | null> = {
      'run:options': runState({ optionsInsights: ['old-guid'] }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const tokensDelete = vi.fn().mockResolvedValue(undefined);
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [
            { name: 'options:good-push', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'good-device-token' } },
            { name: 'options:bad-push',  metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'bad-device-token' } },
          ],
          list_complete: true,
        }),
        delete: tokensDelete,
      },
    } as any;
    return { env, statePut, tokensDelete };
  }

  it('prunes a device whose feedToken lost access, and excludes it from the push', async () => {
    const { env, tokensDelete } = mockEnv();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('feed_token=poll-token')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('1', 'Sean Hyman')) });
      }
      if (url.includes('feed_token=good-device-token')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
      }
      if (url.includes('feed_token=bad-device-token')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_EMPTY) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }); // exp.host push send
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(tokensDelete).toHaveBeenCalledWith('options:bad-push');

    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    expect(pushCall).toBeDefined();
    const body = JSON.parse(pushCall![1]!.body as string);
    expect(body.flatMap((m: { to: string[] }) => m.to)).toEqual(['good-push']);
  });

  it('does not prune a device on a transient access-check failure (issue #42)', async () => {
    const { env, tokensDelete } = mockEnv();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('feed_token=poll-token')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('1', 'Sean Hyman')) });
      }
      if (url.includes('feed_token=good-device-token')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
      }
      if (url.includes('feed_token=bad-device-token')) {
        return Promise.reject(new Error('network blip'));
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }); // exp.host push send
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(tokensDelete).not.toHaveBeenCalled();

    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    expect(pushCall).toBeDefined();
    const body = JSON.parse(pushCall![1]!.body as string);
    expect(body.flatMap((m: { to: string[] }) => m.to).sort()).toEqual(['bad-push', 'good-push']);
  });
});

describe('runChannel — registrations predating filter/authors/minLength are skipped', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  const itemWithAuthor = (guid: string, author: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${guid}</guid><title>t</title><link>l</link><dc:creator>${author}</dc:creator><description>d</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;

  // "Legacy" here means a TOKENS entry written before this schema existed — simulated directly
  // via metadata containing only feedToken, since there's no migration path that produces one
  // (see docs/notification-filter-design.md: such entries age out on next re-registration).
  it('a malformed registration (missing filter/authors/minLength) receives no push', async () => {
    const stateStore: Record<string, string | null> = {
      'run:options': runState({ optionsInsights: ['old-guid'] }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'options:legacy-push', metadata: { feedToken: 'legacy-token' } }], // no filter/authors/minLength
          list_complete: true,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('1', 'Sean Hyman')) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(fetchMock.mock.calls.some(([url]) => (url as string).includes('exp.host'))).toBe(false);
  });
});

describe('runChannel — seen-tracking (early exit on first-seen guid)', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  // Realistic shape: a real pubDate on every item, like the actual feed always sends. guids are
  // listed newest-first, each one minute older than the last, matching the feed's real ordering.
  const rssWithItems = (guids: string[], descriptions?: string[]) =>
    `<?xml version="1.0"?><rss version="2.0"><channel>${guids.map((g, i) =>
      `<item><guid>${g}</guid><title>t</title><link>l</link><dc:creator>Sean Hyman</dc:creator><description>${descriptions?.[i] ?? 'x'.repeat(210)}</description><pubDate>${new Date(Date.now() - i * 60_000).toUTCString()}</pubDate></item>`
    ).join('')}</channel></rss>`;

  function mockEnv(seenList: string[] | undefined, keys: { name: string; metadata: Record<string, unknown> }[] = []) {
    const stateStore: Record<string, string | null> = {
      'run:options': seenList === undefined ? null : runState({ optionsInsights: seenList }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: { list: vi.fn().mockResolvedValue({ keys, list_complete: true }), delete: vi.fn() },
    } as any;
    return { env, stateStore };
  }

  it('first-ever poll for a feed seeds seen guids without treating anything as new', async () => {
    const { env, stateStore } = mockEnv(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(rssWithItems(['a', 'b', 'c'])) }));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const state = JSON.parse(stateStore['run:options']!);
    expect(state.stats.numNewItems).toBe(0);
    expect(state.seen.optionsInsights).toEqual(['a', 'b', 'c']);
  });

  it('stops walking as soon as it reaches an already-seen guid, newest-first', async () => {
    // Feed returns newest-first: c, b, a. 'b' was already seen, so only 'c' is new — 'a' is
    // never even inspected, matching the reverse-chronological early-exit assumption.
    const { env, stateStore } = mockEnv(['b', 'a']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(rssWithItems(['c', 'b', 'a'])) }));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const state = JSON.parse(stateStore['run:options']!);
    expect(state.stats.numNewItems).toBe(1);
    // newly-seen guid is prepended, ahead of the previous seen list.
    expect(state.seen.optionsInsights).toEqual(['c', 'b', 'a']);
  });

  it('honors a configured MAX_ALERT_ITEMS_PER_FEED cap, whatever its value', async () => {
    // The specific number (25) the upstream feed happens to return today isn't the constraint
    // under test — the cap itself, and that it's configurable, is. A small override (3) proves
    // the mechanism without coupling the test to today's feed behavior.
    const many = Array.from({ length: 10 }, (_, i) => `item-${i}`); // newest first
    const { env, stateStore } = mockEnv(['item-9']); // the oldest of the 10 was already seen
    env.MAX_ALERT_ITEMS_PER_FEED = '3';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(rssWithItems(many)) }));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const state = JSON.parse(stateStore['run:options']!);
    // Only the configured 3 are ever considered, so item-9 (the actual seen boundary) is never
    // reached — every considered item counts as "new."
    expect(state.stats.itemsFetched).toBe(3);
    expect(state.stats.numNewItems).toBe(3);
  });

  it('alerts oldest-to-newest, not newest-first, when multiple new items exist', async () => {
    const { env } = mockEnv(['old-guid'], [
      { name: 'options:push1', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'device-token' } },
    ]);
    // Feed returns newest-first: c, b, a — all three are new. description carries the guid so
    // push message order is directly observable below.
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(rssWithItems(['c', 'b', 'a'], ['c', 'b', 'a'])) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    const messages = JSON.parse(pushCall![1]!.body as string);
    expect(messages.map((m: { body: string }) => m.body)).toEqual(['a', 'b', 'c']);
  });
});

// "Bucket" = the runtime grouping in index.ts's runChannel: devices sharing an identical
// filter|authors|minLength signature share one eligibility check and one push-send call.
describe('runChannel — push-send failure does not abort remaining buckets (issue #42)', () => {
  const MEMBERS_CRON = '0,5,10,15,20,25,30,35,40,45,50,55 * * * *';
  const itemWithAuthor = (guid: string, author: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${guid}</guid><title>t</title><link>l</link><dc:creator>${author}</dc:creator><description>d</description></item></channel></rss>`;

  it('still attempts every notification bucket, and still writes final stats, after one bucket\'s push-send throws', async () => {
    const stateStore: Record<string, string | null> = {
      'run:members': runState({ membersArea: ['old-guid'] }),
      'poll:members': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [
            { name: 'members:push-a', metadata: { filter: 'members', authors: [], minLength: 0, feedToken: 'device-a' } },
            { name: 'members:push-b', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'device-b' } },
          ],
          list_complete: true,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    let pushCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) {
        pushCalls += 1;
        if (pushCalls === 1) return Promise.reject(new Error('exp.host down'));
        return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      }
      if (url.includes('members-forum')) {
        // Main poll (feed_token=poll-token) sees no forum items; per-device access re-checks
        // (feed_token=device-a/device-b) see an item, so neither device is treated as revoked.
        if (url.includes('feed_token=poll-token')) return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_EMPTY) });
        return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
      }
      // Members Area main feed: one new post — unconditional, notifies both buckets.
      return Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('new-guid', 'Sean Hyman')) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(worker.scheduled(scheduledEvent(MEMBERS_CRON), env, {} as any)).resolves.not.toThrow();

    const pushSendCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes('exp.host'));
    expect(pushSendCalls).toHaveLength(2); // both buckets attempted despite the first throwing

    const finalState = JSON.parse(stateStore['run:members']!);
    expect(finalState.stats.sent).toBe(1); // only the second (successful) bucket counted
  });
});

describe('runChannel — claims lastRun before slow notify work (cron double-dispatch race)', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  const NEW_ITEM_RSS = '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>new-guid</guid><title>t</title><link>l</link><dc:creator>Sean Hyman</dc:creator><description>d</description></item></channel></rss>';

  it('writes an updated stats:<channel> before sending any push', async () => {
    const stateStore: Record<string, string | null> = {
      'run:options': runState({ optionsInsights: ['old-guid'] }),
      'poll:options': 'poll-token',
    };
    const callOrder: string[] = [];
    const statePut = vi.fn((key: string, value: string) => {
      stateStore[key] = value;
      if (key === 'run:options' && JSON.parse(value).stats.lastRun) callOrder.push('stats-claimed');
      return Promise.resolve();
    });
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'options:push1', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'device-token' } }],
          list_complete: true,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) {
        callOrder.push('push-sent');
        return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      }
      // Both the main-feed poll and the per-device access re-check resolve to the same item.
      return Promise.resolve({ ok: true, text: () => Promise.resolve(NEW_ITEM_RSS) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    // run:options gets claimed early (before the slow notify work) and written again at the
    // end with final counts — both are expected. What matters is the *first* claim lands before
    // the push send, narrowing the window a concurrent dispatch could race through.
    expect(callOrder.indexOf('stats-claimed')).toBeLessThan(callOrder.indexOf('push-sent'));
  });
});

describe('runChannel — daily counters survive a concurrent duplicate-dispatch write', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  const NEW_ITEM_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>new-guid</guid><title>t</title><link>l</link><dc:creator>Sean Hyman</dc:creator><description>d</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;

  it('bases the final daily write on a fresh read, not the stale pre-slow-work snapshot (issue #32 follow-up)', async () => {
    const stateStore: Record<string, string | null> = {
      'run:options': JSON.stringify({
        stats: { lastRun: '', lastNotified: null, itemsFetched: 0, numNewItems: 0, sent: 0 },
        seen: { optionsInsights: ['old-guid'] },
        daily: { date: TODAY_ET, runs: 5, itemsFetched: 10, numNewItems: 2, sent: 1 },
      }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: {
        // No registered devices, so buckets stay empty — but building that (empty) bucket set is
        // still the "slow work" between the early claim and the final write. A concurrent
        // duplicate cron dispatch finishing its own write lands right here in a real race.
        list: vi.fn().mockImplementation(() => {
          stateStore['run:options'] = JSON.stringify({
            stats: { lastRun: new Date().toISOString(), lastNotified: null, itemsFetched: 1, numNewItems: 1, sent: 0 },
            seen: { optionsInsights: ['old-guid', 'concurrent-guid'] },
            daily: { date: TODAY_ET, runs: 6, itemsFetched: 11, numNewItems: 3, sent: 1 },
          });
          return Promise.resolve({ keys: [], list_complete: true });
        }),
        delete: vi.fn(),
      },
    } as any;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(NEW_ITEM_RSS) }));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const finalState = JSON.parse(stateStore['run:options']!);
    // Built on the concurrent invocation's runs:6 (fresh read) → 7. A stale base (runs:5,
    // captured before the slow work) would have produced 6, silently losing the concurrent
    // invocation's contribution.
    expect(finalState.daily.runs).toBe(7);
  });
});

describe('runChannel — duplicate cron dispatch is skipped (Cloudflare at-least-once delivery)', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  const DUPLICATE_TICK = 1751000000000;
  // Just past getIntervalMinutes()'s longest bucket (overnight, 60min default) — enough for
  // shouldPollNow() to pass regardless of which interval window the test happens to run in.
  // What's under test here is the duplicate-scheduledTime guard specifically, not the throttle,
  // so this only needs to clear that gate, not model a realistic poll cadence.
  const PAST_LONGEST_INTERVAL_MS = 65 * 60 * 1000;

  it('a second dispatch of an already-claimed scheduledTime does no fetch, no write, and calls noRetry()', async () => {
    const stateStore: Record<string, string | null> = {
      'run:options': JSON.stringify({
        stats: {
          lastRun: new Date(Date.now() - PAST_LONGEST_INTERVAL_MS).toISOString(),
          lastNotified: null, itemsFetched: 3, numNewItems: 1, sent: 1,
          lastScheduledTime: DUPLICATE_TICK,
        },
        seen: { optionsInsights: ['old-guid'] },
        daily: { date: TODAY_ET, runs: 1, itemsFetched: 3, numNewItems: 1, sent: 1 },
      }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn();
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: { list: vi.fn(), delete: vi.fn() },
    } as any;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const event = scheduledEvent(OPTIONS_CRON, DUPLICATE_TICK);

    await worker.scheduled(event, env, {} as any);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(statePut).not.toHaveBeenCalled();
    expect(event.noRetry).toHaveBeenCalledTimes(1);
  });

  it('a dispatch with a new scheduledTime proceeds normally, even with the same lastRun history', async () => {
    const stateStore: Record<string, string | null> = {
      'run:options': JSON.stringify({
        stats: {
          lastRun: new Date(Date.now() - PAST_LONGEST_INTERVAL_MS).toISOString(),
          lastNotified: null, itemsFetched: 3, numNewItems: 1, sent: 1,
          lastScheduledTime: DUPLICATE_TICK,
        },
        seen: { optionsInsights: ['old-guid'] },
        daily: { date: TODAY_ET, runs: 1, itemsFetched: 3, numNewItems: 1, sent: 1 },
      }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: { list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }), delete: vi.fn() },
    } as any;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }));
    const event = scheduledEvent(OPTIONS_CRON, DUPLICATE_TICK + 300_000); // a genuinely later tick

    await worker.scheduled(event, env, {} as any);

    expect(event.noRetry).not.toHaveBeenCalled();
    expect(statePut).toHaveBeenCalled();
  });
});

describe('runChannel — staleness gate on push (issue #48)', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  const itemWithPubDate = (guid: string, pubDate: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${guid}</guid><title>t</title><link>l</link><dc:creator>Sean Hyman</dc:creator><description>d</description><pubDate>${pubDate}</pubDate></item></channel></rss>`;

  function mockEnv(mainFeedRss: string) {
    const stateStore: Record<string, string | null> = {
      'run:options': runState({ optionsInsights: ['old-guid'] }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'options:push1', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'device-token' } }],
          list_complete: true,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      MAX_PUSH_AGE_MINUTES: '120',
    } as any;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(mainFeedRss) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { env, stateStore, fetchMock };
  }

  it('does not push an item older than the 2h window, but still marks it seen', async () => {
    const staleDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toUTCString();
    const { env, stateStore, fetchMock } = mockEnv(itemWithPubDate('stale-guid', staleDate));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(fetchMock.mock.calls.some(([url]) => (url as string).includes('exp.host'))).toBe(false);
    expect(JSON.parse(stateStore['run:options']!).seen.optionsInsights).toContain('stale-guid');
  });

  it('pushes an item within the 2h window', async () => {
    const freshDate = new Date(Date.now() - 30 * 60 * 1000).toUTCString();
    const { env, fetchMock } = mockEnv(itemWithPubDate('fresh-guid', freshDate));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    expect(pushCall).toBeDefined();
  });

  it('MAX_PUSH_AGE_MINUTES widens the window when set higher than the default', async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toUTCString();
    const { env, fetchMock } = mockEnv(itemWithPubDate('old-but-allowed-guid', fourHoursAgo));
    env.MAX_PUSH_AGE_MINUTES = '300';

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    expect(pushCall).toBeDefined();
  });
});

describe('scheduled — heartbeat dead-man\'s-switch (issue #24)', () => {
  const MEMBERS_CRON = '0,5,10,15,20,25,30,35,40,45,50,55 * * * *';
  const STOCK_CRON = '1,6,11,16,21,26,31,36,41,46,51,56 * * * *';
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';

  function mockEnv(urls: { members?: string; stock?: string; options?: string } = {}) {
    return {
      STATE: { get: vi.fn().mockResolvedValue(null) },
      HEARTBEAT_URL_MEMBERS: urls.members,
      HEARTBEAT_URL_STOCK: urls.stock,
      HEARTBEAT_URL_OPTIONS: urls.options,
    } as any;
  }

  it.each([
    [MEMBERS_CRON, 'members', 'https://hc-ping.com/members'],
    [STOCK_CRON, 'stock', 'https://hc-ping.com/stock'],
    [OPTIONS_CRON, 'options', 'https://hc-ping.com/options'],
  ])('pings each channel\'s own HEARTBEAT_URL via ctx.waitUntil (%s)', async (cron, channel, url) => {
    const waitUntil = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await worker.scheduled(scheduledEvent(cron), mockEnv({ [channel]: url }), { waitUntil } as any);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(fetch).toHaveBeenCalledWith(url);
  });

  it('does not ping a channel whose own HEARTBEAT_URL is unset, even if others are set', async () => {
    const waitUntil = vi.fn();
    await worker.scheduled(scheduledEvent(STOCK_CRON), mockEnv({ members: 'https://hc-ping.com/members' }), { waitUntil } as any);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe('advanceDaily', () => {
  const stats = (overrides: Partial<{ itemsFetched: number; numNewItems: number; sent: number }> = {}) => ({
    lastRun: '2026-01-01T00:00:00.000Z', lastNotified: null,
    itemsFetched: 5, numNewItems: 2, sent: 1, ...overrides,
  });

  it('starts a fresh record when there is no prior state', () => {
    expect(advanceDaily(undefined, '2026-01-01', stats())).toEqual({ date: '2026-01-01', runs: 1, itemsFetched: 5, numNewItems: 2, sent: 1 });
  });

  it('accumulates onto the same ET date', () => {
    const first = advanceDaily(undefined, '2026-01-01', stats());
    const second = advanceDaily(first, '2026-01-01', stats({ itemsFetched: 3, numNewItems: 0, sent: 0 }));
    expect(second).toEqual({ date: '2026-01-01', runs: 2, itemsFetched: 8, numNewItems: 2, sent: 1 });
  });

  it('resets counters when the ET date rolls over', () => {
    const yesterday = advanceDaily(undefined, '2026-01-01', stats());
    const today = advanceDaily(yesterday, '2026-01-02', stats({ itemsFetched: 1, numNewItems: 1, sent: 0 }));
    expect(today).toEqual({ date: '2026-01-02', runs: 1, itemsFetched: 1, numNewItems: 1, sent: 0 });
  });
});

describe('timingSafeEqualStr', () => {
  it('true for identical strings', () => {
    expect(timingSafeEqualStr('same-secret', 'same-secret')).toBe(true);
  });
  it('false for different strings of the same length', () => {
    expect(timingSafeEqualStr('secret-aaaa', 'secret-bbbb')).toBe(false);
  });
  it('false for different-length strings (no throw)', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-secret')).toBe(false);
  });
  it('false against an empty string', () => {
    expect(timingSafeEqualStr('', 'non-empty')).toBe(false);
  });
});

describe('GET /status auth', () => {
  function mockEnv(feedToken: string) {
    return {
      FEED_TOKEN: feedToken,
      TOKENS: { list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) },
      STATE: { get: vi.fn().mockResolvedValue(null) },
    } as any;
  }

  function statusRequest(authHeader?: string) {
    return new Request('https://worker.test/status', {
      headers: authHeader ? { Authorization: authHeader } : {},
    });
  }

  it('rejects a missing Authorization header', async () => {
    const res = await worker.fetch(statusRequest(), mockEnv('real-secret'));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer secret', async () => {
    const res = await worker.fetch(statusRequest('Bearer wrong-secret'), mockEnv('real-secret'));
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer secret', async () => {
    const res = await worker.fetch(statusRequest('Bearer real-secret'), mockEnv('real-secret'));
    expect(res.status).toBe(200);
  });

  it('rejects the secret passed as a query string', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/status?secret=real-secret'),
      mockEnv('real-secret'),
    );
    expect(res.status).toBe(401);
  });
});

// Synthetic inputs covering the learned patterns — update when pattern logic changes.
describe('containsActionableSignal', () => {
  describe('should fire (positive training)', () => {
    it('new pick announcement', () => {
      expect(containsActionableSignal("I've got a new pick that you need to get into IMMEDIATELY")).toBe(true);
    });
    it('formal tranche price line', () => {
      expect(containsActionableSignal('1st Tranche: $50 or below.')).toBe(true);
    });
    it('third tranche urgency', () => {
      expect(containsActionableSignal("let's go ahead and ensure we get in our 3rd tranche NOW")).toBe(true);
    });
    it('fourth tranche entry', () => {
      expect(containsActionableSignal('For those that want to, you can get in a 4th tranche here/now.')).toBe(true);
    });
    it('explicit buy recommendation with price', () => {
      expect(containsActionableSignal('Buy XYZ at the market as long as the stock is at $50 per share or LOWER.')).toBe(true);
    });
    it('sell half of first tranche', () => {
      expect(containsActionableSignal('you can sell half of your 1st tranche and if it pulls back to your breakeven')).toBe(true);
    });
    it('sell half of remaining', () => {
      expect(containsActionableSignal("You're up over 20%. I'd consider selling half of your remaining half, now.")).toBe(true);
    });
    it('averaging down with price', () => {
      expect(containsActionableSignal("If XYZ dips into the $50ish area, that's close enough to get your averaging down")).toBe(true);
    });
    it('IMMEDIATELY urgency marker alone', () => {
      expect(containsActionableSignal('get into IMMEDIATELY and not delay')).toBe(true);
    });
  });

  describe('should not fire (negative training)', () => {
    it('educational: waiting for 4th tranche without action', () => {
      expect(containsActionableSignal("You shouldn't be waiting for a 4th tranche entry. You (or I, either one) will know the bottom when it happens.")).toBe(false);
    });
    it('philosophical: sentiment discussion', () => {
      expect(containsActionableSignal("Sentiment is bad – a good thing. That's when value is found. It's not generally found outside of that setting.")).toBe(false);
    });
    it('emotional coaching', () => {
      expect(containsActionableSignal("Emotions are great followers and horrible leaders. Yet most people allow them to lead in stock-picking.")).toBe(false);
    });
    it('status update without action', () => {
      expect(containsActionableSignal('XYZ up today\n\nIf it gets to a target, we may consider a sell.\n\nIf not, happy to hold.')).toBe(false);
    });
    it('conditional / speculative pattern', () => {
      expect(containsActionableSignal("The stock could be forming a pattern. IF that happened, we'd likely sell around the target.")).toBe(false);
    });
    it('fundamental analysis without new entry', () => {
      expect(containsActionableSignal("Large established company. Strong earnings, lots of cash, low forward P/E. What's scary about that?")).toBe(false);
    });
  });
});
