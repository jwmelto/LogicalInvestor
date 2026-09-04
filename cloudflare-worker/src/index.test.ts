import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { matchesFilter, stripReplyPrefix, channelFromCron, findAndStorePollToken, shouldPollNow, getIntervalMinutes, registerDevice, sendTestPush, timingSafeEqualStr, advanceDaily, needsRevalidation } from './index';
import { CHANNEL_FEEDS } from './config';
import { FeedKeys, containsActionableSignal, FEEDKEY_TO_CHANNEL, isActionablePost, ACTIONABLE_CALIBRATION_EXAMPLES, OPTIONS_CALIBRATION_EXAMPLES } from '@li/core';
import type { FeedKey, FilterItem, ItemClassification } from '@li/core';

const FK = FeedKeys;

const ACTIONABLE_AUTHORS = ['sean hyman'];

function item(feedKey: FeedKey, overrides: { author?: string; title?: string; description?: string } = {}): FilterItem {
  return {
    feedKey,
    author: overrides.author ?? ACTIONABLE_AUTHORS[0],
    title: overrides.title ?? '',
    content: overrides.description ?? '',
  };
}

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

// classify() mirrors the once-per-item, regex-only computation runChannel() does before the
// bucket loop (the non-hybrid path — these tests exercise tier dispatch and regex-driven
// actionable-ness, not the live embedding call, which is covered separately below).
function classify(testItem: FilterItem, actionableAuthors: string[]): ItemClassification {
  const members = testItem.feedKey === FK.membersArea;
  return members ? { members: true, actionable: false } : { members: false, actionable: isActionablePost(testItem, actionableAuthors) };
}

// matchesFilter(item, filter, authors, minLength, classification) is the one function a device's
// alerting decision goes through. One describe block per tier, each covering only what that tier
// requires.
describe('matchesFilter', () => {
  describe('members tier', () => {
    it.each([
      ['no content', item(FK.membersArea, { description: '' })],
      ['long content', item(FK.membersArea, { description: long })],
      ['actionable-signal content', item(FK.membersArea, { description: longWithSignal })],
      ['negative-pattern content', item(FK.membersArea, { description: longNegative })],
    ])('a Members Area post (%s) alerts regardless of author', (_desc, testItem) => {
      expect(matchesFilter(testItem, 'members', ['someone else'], MIN, classify(testItem, ACTIONABLE_AUTHORS))).toBe(true);
      expect(matchesFilter(testItem, 'members', [], MIN, classify(testItem, ACTIONABLE_AUTHORS))).toBe(true);
    });

    it('a post outside Members Area does not alert', () => {
      const post = item(FK.membersForum, { description: longWithSignal });
      expect(matchesFilter(post, 'members', [ACTIONABLE_AUTHORS[0]], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(false);
    });
  });

  describe('actionable tier', () => {
    it('an actionable-signal post by an ACTIONABLE_AUTHORS author alerts', () => {
      const post = item(FK.membersForum, { author: ACTIONABLE_AUTHORS[0], description: longWithSignal });
      expect(matchesFilter(post, 'actionable', [], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(true);
    });

    it('an actionable-signal post by an author outside ACTIONABLE_AUTHORS does not alert', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: longWithSignal });
      expect(matchesFilter(post, 'actionable', [], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(false);
    });

    it('a non-actionable post does not alert, regardless of author', () => {
      const signed = item(FK.membersForum, { author: ACTIONABLE_AUTHORS[0], description: long });
      const other = item(FK.membersForum, { author: 'Joe Blow', description: long });
      expect(matchesFilter(signed, 'actionable', [], MIN, classify(signed, ACTIONABLE_AUTHORS))).toBe(false);
      expect(matchesFilter(other, 'actionable', [], MIN, classify(other, ACTIONABLE_AUTHORS))).toBe(false);
    });

    it('ACTIONABLE_AUTHORS is a live parameter: changing it changes who can alert', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: longWithSignal });
      expect(matchesFilter(post, 'actionable', [], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(false);
      expect(matchesFilter(post, 'actionable', [], MIN, classify(post, ['joe blow']))).toBe(true);
    });

    // Each feed's own signal text: stock-pick vocabulary ("new pick") only resolves against
    // STOCK_POS_PATTERNS, options vocabulary (strike/put/expiry) only against OPTIONS_POS_PATTERNS
    // -- see actionableStrategyFor (@li/core).
    it.each([
      [FK.stockInsights, longWithSignal],
      [FK.optionsInsights, 'You can get into the January $55 strike put, 2026 expiry now.'],
    ])('%s requires a starred title to alert', (feedKey, description) => {
      const starred = item(feedKey, { title: '*VUTS Trade', description });
      const unstarred = item(feedKey, { title: 'Discussion post', description });
      expect(matchesFilter(starred, 'actionable', [ACTIONABLE_AUTHORS[0]], MIN, classify(starred, ACTIONABLE_AUTHORS))).toBe(true);
      expect(matchesFilter(unstarred, 'actionable', [ACTIONABLE_AUTHORS[0]], MIN, classify(unstarred, ACTIONABLE_AUTHORS))).toBe(false);
    });

    it('a negative-pattern post does not alert at the actionable tier, but can still alert at the length tier', () => {
      const post = item(FK.membersForum, { author: ACTIONABLE_AUTHORS[0], description: longNegative });
      expect(matchesFilter(post, 'actionable', [], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(false);
      expect(matchesFilter(post, 'length', [], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(true);
    });
  });

  describe('length tier', () => {
    it('a long-enough post by a whitelisted author alerts', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: long });
      expect(matchesFilter(post, 'length', ['joe blow'], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(true);
    });

    it('a long-enough post by a non-whitelisted author does not alert', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: long });
      expect(matchesFilter(post, 'length', [ACTIONABLE_AUTHORS[0]], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(false);
    });

    it('an empty author whitelist means no author restriction', () => {
      const post = item(FK.membersForum, { author: 'Anyone At All', description: long });
      expect(matchesFilter(post, 'length', [], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(true);
    });

    it('a post shorter than minLength does not alert, even from a whitelisted author', () => {
      const post = item(FK.membersForum, { author: 'Joe Blow', description: 'short' });
      expect(matchesFilter(post, 'length', ['joe blow'], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(false);
    });
  });

  // Spans both tiers deliberately: each verifies a different formula (the actionable-tier
  // shortcut vs. the length-tier OR) independently, so parameterizing doesn't drop coverage — it
  // removes what would otherwise be two byte-for-byte-identical test bodies.
  it.each(['actionable', 'length'] as const)(
    "a device's personal author whitelist does not restrict an actionable post at the %s tier",
    (filter) => {
      const post = item(FK.membersForum, { author: ACTIONABLE_AUTHORS[0], description: longWithSignal });
      expect(matchesFilter(post, filter, ['someone else entirely'], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(true);
    }
  );

  // matchesFilter's Members Area bypass runs unconditionally, before any tier is even consulted
  // — structurally immune to the boolean-distribution mistake the test above guards against, but
  // only if that bypass stays a hard early return. A future refactor moving it inside tier
  // dispatch would break this silently without a test spanning all three tiers explicitly.
  it.each(['members', 'actionable', 'length'] as const)(
    'a Members Area post alerts at the %s tier, regardless of author or content',
    (filter) => {
      const post = item(FK.membersArea, { author: 'nobody in particular', description: '' });
      expect(matchesFilter(post, filter, ['someone else entirely'], MIN, classify(post, ACTIONABLE_AUTHORS))).toBe(true);
    }
  );
});

describe('stripReplyPrefix', () => {
  it('strips "Reply To: " from the start', () => {
    expect(stripReplyPrefix('Reply To: *VUTS Trade')).toBe('*VUTS Trade');
  });
  it('leaves titles without the prefix unchanged', () => {
    expect(stripReplyPrefix('*VUTS Trade')).toBe('*VUTS Trade');
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
  function mockEnv() {
    return {
      TOKENS: { put: vi.fn().mockResolvedValue(undefined) },
      STATE: { put: vi.fn().mockResolvedValue(undefined) },
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
    expect(env.TOKENS.put).toHaveBeenCalledWith('options:push1', '1', { metadata: { feedToken: 'valid', filter: 'actionable', authors: [], minLength: 200, lastValidated: expect.any(Number) } });
  });

  it('lowercases and trims authors before storing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv();
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', filter: 'length', authors: ['  Sean Hyman  '], minLength: 0, feedToken: 'valid' }, env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith('options:push1', '1', { metadata: { feedToken: 'valid', filter: 'length', authors: ['sean hyman'], minLength: 0, lastValidated: expect.any(Number) } });
  });

  it('members channel verifies feedToken against Members Forum, and stores it as the poll token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
    vi.stubGlobal('fetch', fetchMock);
    const env = mockEnv();
    const res = await registerDevice({ channel: 'members', pushToken: 'push1', filter: 'actionable', authors: [], minLength: 200, feedToken: 'valid' }, env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('members-forum'));
    expect(env.STATE.put).toHaveBeenCalledWith('poll:members', 'valid');
    expect(env.TOKENS.put).toHaveBeenCalledWith('members:push1', '1', { metadata: { feedToken: 'valid', filter: 'actionable', authors: [], minLength: 200, lastValidated: expect.any(Number) } });
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
    expect(env.TOKENS.put).toHaveBeenCalledWith('members:push1', '1', { metadata: { feedToken: 'anything', filter: 'actionable', authors: [], minLength: 200, lastValidated: expect.any(Number) } });
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

// The web-push registration page sends `subscription` instead of `token`. Channel, filter,
// authors, minLength, and feed_token validation are all shared with the Expo path above.
describe('/register endpoint validation — webpush subscription path', () => {
  function mockEnv() {
    return {
      TOKENS: { put: vi.fn().mockResolvedValue(undefined) },
      STATE: { put: vi.fn().mockResolvedValue(undefined) },
    } as any;
  }

  function registerRequest(body: Record<string, unknown>) {
    return new Request('https://worker.test/register', { method: 'POST', body: JSON.stringify(body) });
  }

  const validSubscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p256dh-value', auth: 'auth-value' } };

  it('accepts a well-formed subscription in place of token, and stores it under a web:-namespaced key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ subscription: validSubscription, channel: 'members', filter: 'actionable', authors: [], minLength: 200, feed_token: 'anything' }), env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith(
      'members:web:https://fcm.googleapis.com/fcm/send/abc',
      '1',
      { metadata: { feedToken: 'anything', filter: 'actionable', authors: [], minLength: 200, kind: 'webpush', subscription: { endpoint: validSubscription.endpoint, expirationTime: null, keys: validSubscription.keys }, lastValidated: expect.any(Number) } },
    );
  });

  it.each([
    ['missing endpoint', { keys: { p256dh: 'p256dh-value', auth: 'auth-value' } }],
    ['missing keys.p256dh', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { auth: 'auth-value' } }],
    ['missing keys.auth', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p256dh-value' } }],
    ['missing keys entirely', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }],
  ])('rejects a malformed subscription (%s)', async (_desc, subscription) => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ subscription, channel: 'members', filter: 'actionable', authors: [], minLength: 200, feed_token: 'anything' }), env);
    expect(res.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('rejects when neither token nor subscription is present', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ channel: 'members', filter: 'actionable', authors: [], minLength: 200, feed_token: 'anything' }), env);
    expect(res.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });
});

describe('sendTestPush (logic, plain-object inputs)', () => {
  const validSubscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-id',
    expirationTime: null,
    keys: {
      p256dh: 'BELwtddmVvbvOEHadf6IA9Jj2Gx2u6K9Yoj-0TOzGPDJWfQbUprGpFpfOKvULdsyl9m5LwdBLqG6t9zUajeGN8A',
      auth: 'wUSvE5FxCS7VqmXHVW79FQ',
    },
  };
  function envWithQueue(sendBatch = vi.fn().mockResolvedValue(undefined)) {
    return { WEBPUSH_QUEUE: { sendBatch } } as any;
  }

  it('rejects when feed_token has no access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }));
    const res = await sendTestPush({ channel: 'options', pushToken: 'push1', feedToken: 'unauthorized' }, envWithQueue());
    expect(res.status).toBe(403);
  });

  it('returns 503 (not 403) when the access check itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));
    const res = await sendTestPush({ channel: 'options', pushToken: 'push1', feedToken: 'valid' }, envWithQueue());
    expect(res.status).toBe(503);
  });

  it('sends via exp.host for an Expo pushToken and returns ok', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendTestPush({ channel: 'options', pushToken: 'push1', feedToken: 'valid' }, envWithQueue());
    expect(res.status).toBe(200);
    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    const messages = JSON.parse(pushCall![1]!.body as string);
    expect(messages).toEqual([{ to: 'push1', title: 'Test notification', body: 'If you can see this, push notifications are working.' }]);
  });

  it('reports 502 when the Expo send itself fails', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendTestPush({ channel: 'options', pushToken: 'push1', feedToken: 'valid' }, envWithQueue());
    expect(res.status).toBe(502);
  });

  it('enqueues via WEBPUSH_QUEUE for a subscription and returns ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const res = await sendTestPush({ channel: 'options', pushToken: validSubscription.endpoint, subscription: validSubscription, feedToken: 'valid' }, envWithQueue(sendBatch));
    expect(res.status).toBe(200);
    expect(sendBatch).toHaveBeenCalledWith([{ body: { channel: 'options', subscription: validSubscription, title: 'Test notification', body: 'If you can see this, push notifications are working.' } }]);
  });

  it('reports 502 when the enqueue itself fails, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const sendBatch = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const res = await sendTestPush({ channel: 'options', pushToken: validSubscription.endpoint, subscription: validSubscription, feedToken: 'valid' }, envWithQueue(sendBatch));
    expect(res.status).toBe(502);
  });

  // A cryptographically malformed subscription is no longer caught here: enqueueing doesn't
  // validate key material, only the queue() consumer's buildPushPayload call does — and that
  // failure is swallowed there the same way a real alert's would be (see queue() tests). This
  // endpoint reporting the same "ok, queued" outcome regardless of key validity is the point:
  // it now proves the operational path, not a shortcut that could pass while that path is broken.
  it('enqueues even a cryptographically malformed subscription — validation happens in the consumer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const malformed = { endpoint: 'https://fcm.googleapis.com/fcm/send/bad', expirationTime: null, keys: { p256dh: 'not-a-real-key', auth: 'not-a-real-auth' } };
    const res = await sendTestPush({ channel: 'options', pushToken: malformed.endpoint, subscription: malformed, feedToken: 'valid' }, envWithQueue());
    expect(res.status).toBe(200);
  });
});

describe('/test-push endpoint validation (HTTP boundary)', () => {
  function mockEnv() { return { WEBPUSH_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) } } as any; }
  function testPushRequest(body: Record<string, unknown>) {
    return new Request('https://worker.test/test-push', { method: 'POST', body: JSON.stringify(body) });
  }

  it('rejects a missing feed_token', async () => {
    const res = await worker.fetch(testPushRequest({ token: 'push1', channel: 'members' }), mockEnv());
    expect(res.status).toBe(400);
  });

  it('rejects an empty-string feed_token', async () => {
    const res = await worker.fetch(testPushRequest({ token: 'push1', channel: 'members', feed_token: '' }), mockEnv());
    expect(res.status).toBe(400);
  });

  it('a valid Expo token request reaches sendTestPush and succeeds', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(testPushRequest({ token: 'push1', channel: 'members', feed_token: 'valid' }), mockEnv());
    expect(res.status).toBe(200);
  });

  it('a valid subscription request reaches sendTestPush, enqueues it, and succeeds', async () => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-id', keys: { p256dh: 'BELwtddmVvbvOEHadf6IA9Jj2Gx2u6K9Yoj-0TOzGPDJWfQbUprGpFpfOKvULdsyl9m5LwdBLqG6t9zUajeGN8A', auth: 'wUSvE5FxCS7VqmXHVW79FQ' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv();
    const res = await worker.fetch(testPushRequest({ subscription, channel: 'members', feed_token: 'valid' }), env);
    expect(res.status).toBe(200);
    expect(env.WEBPUSH_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
  });
});

// The registration page could be served from a different origin than the Worker's own API
// domain. Today it's same-origin, via Static Assets, and CORS_ALLOWED_ORIGIN exists for if that
// ever changes.
//
// CORS only matters for the cross-origin case. A browser never sends an Origin header for a
// same-origin request, and never enforces these headers there either. That's why none of the
// other tests in this file needed to change when this was added — none of them set Origin.
describe('CORS', () => {
  const CONFIGURED_ORIGIN = 'https://example.com';

  function mockEnv(overrides: Record<string, unknown> = {}) {
    return {
      TOKENS: { list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) },
      STATE: { get: vi.fn().mockResolvedValue(null) },
      FEED_TOKEN: 'secret',
      ...overrides,
    } as any;
  }

  it('OPTIONS from the configured origin gets a preflight response with the right headers', async () => {
    const env = mockEnv({ CORS_ALLOWED_ORIGIN: CONFIGURED_ORIGIN });
    const req = new Request('https://worker.test/register', { method: 'OPTIONS', headers: { Origin: CONFIGURED_ORIGIN } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CONFIGURED_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
  });

  it('OPTIONS from an unconfigured origin gets no Access-Control-Allow-Origin', async () => {
    const env = mockEnv({ CORS_ALLOWED_ORIGIN: CONFIGURED_ORIGIN });
    const req = new Request('https://worker.test/register', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('a real request from the configured origin gets Access-Control-Allow-Origin on the response', async () => {
    const env = mockEnv({ CORS_ALLOWED_ORIGIN: CONFIGURED_ORIGIN });
    const req = new Request('https://worker.test/status', { headers: { Origin: CONFIGURED_ORIGIN, Authorization: 'Bearer secret' } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CONFIGURED_ORIGIN);
  });

  it('a real request with no Origin header (same-origin) gets no CORS header, and is unaffected', async () => {
    const env = mockEnv({ CORS_ALLOWED_ORIGIN: CONFIGURED_ORIGIN });
    const req = new Request('https://worker.test/status', { headers: { Authorization: 'Bearer secret' } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not alter the response status or body for a real request', async () => {
    const env = mockEnv({ CORS_ALLOWED_ORIGIN: CONFIGURED_ORIGIN });
    const req = new Request('https://worker.test/status', { headers: { Origin: CONFIGURED_ORIGIN, Authorization: 'Bearer wrong' } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401); // unrelated auth failure still surfaces correctly through the CORS wrapper
  });

  it('denies every origin when CORS_ALLOWED_ORIGIN is unset', async () => {
    const env = mockEnv({ VAPID_PUBLIC_KEY: 'pub' }); // no CORS_ALLOWED_ORIGIN
    for (const origin of [CONFIGURED_ORIGIN, 'https://evil.example.com', 'https://logicalinvestor.net']) {
      const req = new Request('https://worker.test/vapid-public-key', { headers: { Origin: origin } });
      expect((await worker.fetch(req, env)).headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('honors a configured CORS_ALLOWED_ORIGIN, and denies any other origin', async () => {
    const env = mockEnv({ VAPID_PUBLIC_KEY: 'pub', CORS_ALLOWED_ORIGIN: CONFIGURED_ORIGIN });
    const allowed = new Request('https://worker.test/vapid-public-key', { headers: { Origin: CONFIGURED_ORIGIN } });
    expect((await worker.fetch(allowed, env)).headers.get('Access-Control-Allow-Origin')).toBe(CONFIGURED_ORIGIN);

    const notAllowed = new Request('https://worker.test/vapid-public-key', { headers: { Origin: 'https://logicalinvestor.net' } });
    expect((await worker.fetch(notAllowed, env)).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('runChannel (via scheduled) — enqueues stale registrations for revalidation (issue #86)', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'; // maps to 'options', see channelFromCron tests
  const itemWithAuthor = (guid: string, author: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${guid}</guid><title>t</title><link>l</link><dc:creator>${author}</dc:creator><description>d</description></item></channel></rss>`;

  function mockEnv(keys: { name: string; metadata: Record<string, unknown> }[]) {
    const stateStore: Record<string, string | null> = {
      'run:options': runState({ optionsInsights: ['old-guid'] }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: { list: vi.fn().mockResolvedValue({ keys, list_complete: true }), delete: vi.fn().mockResolvedValue(undefined) },
      VALIDATION_QUEUE: { sendBatch },
    } as any;
    return { env, stateStore, sendBatch };
  }

  const pushFetch = (extra: (url: string) => { ok: boolean; text?: () => Promise<string> } | undefined = () => undefined) =>
    vi.fn((url: string, _init?: RequestInit) => {
      const custom = extra(url);
      if (custom) return Promise.resolve(custom);
      if (url.includes('feed_token=poll-token')) return Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('1', 'Sean Hyman')) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }); // exp.host push send
    });

  it('notifies every registered device regardless of stored access state — validation is fully decoupled from the notify path', async () => {
    const { env } = mockEnv([
      { name: 'options:good-push', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'good-device-token' } },
      { name: 'options:bad-push',  metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'bad-device-token' } },
    ]);
    const fetchMock = pushFetch();
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    // No feedTokenHasAccess fetch happens inline anymore — only the poll fetch and the push send.
    expect(fetchMock.mock.calls.every(([url]) => (url as string).includes('feed_token=poll-token') || (url as string).includes('exp.host'))).toBe(true);
    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    const body = JSON.parse(pushCall![1]!.body as string);
    expect(body.flatMap((m: { to: string[] }) => m.to).sort()).toEqual(['bad-push', 'good-push']);
  });

  it('enqueues one VALIDATION_QUEUE message per registration with a feedToken, each carrying its own channel', async () => {
    const { env, sendBatch } = mockEnv([
      { name: 'options:good-push', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'good-device-token' } },
      { name: 'options:bad-push',  metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'bad-device-token' } },
    ]);
    vi.stubGlobal('fetch', pushFetch());

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const [messages] = sendBatch.mock.calls[0];
    expect(messages).toHaveLength(2);
    expect(messages.map((m: any) => m.body.tokenKey).sort()).toEqual(['options:bad-push', 'options:good-push']);
    expect(messages.every((m: any) => m.body.channel === 'options')).toBe(true);
  });

  it('does not enqueue a registration validated less than 24h ago', async () => {
    const { env, sendBatch } = mockEnv([
      { name: 'options:fresh-push', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'fresh-token', lastValidated: Date.now() - 60_000 } },
    ]);
    vi.stubGlobal('fetch', pushFetch());

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('enqueues a registration last validated more than 24h ago', async () => {
    const { env, sendBatch } = mockEnv([
      { name: 'options:stale-push', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'stale-token', lastValidated: Date.now() - 25 * 60 * 60 * 1000 } },
    ]);
    vi.stubGlobal('fetch', pushFetch());

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const [messages] = sendBatch.mock.calls[0];
    expect(messages[0].body.tokenKey).toBe('options:stale-push');
  });

  it('does not enqueue at all once this channel has already been scanned in the last ~24h', async () => {
    const { env, stateStore, sendBatch } = mockEnv([
      { name: 'options:never-validated', metadata: { filter: 'length', authors: [], minLength: 0, feedToken: 'device-token' } },
    ]);
    stateStore['run:options'] = JSON.stringify({
      ...JSON.parse(runState({ optionsInsights: ['old-guid'] })),
      lastValidationEnqueueDate: Date.now() - 60_000,
    });
    vi.stubGlobal('fetch', pushFetch());

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe('queue() — token validation (issue #86)', () => {
  function messageBatch(bodies: { channel: string; tokenKey: string; meta: Record<string, unknown> }[]): any {
    return { queue: 'token-validation', messages: bodies.map((body) => ({ body, ack: vi.fn() })) };
  }

  it('stamps lastValidated on a confirmed-access token, without setting any expirationTtl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const tokensPut = vi.fn().mockResolvedValue(undefined);
    const env = { TOKENS: { put: tokensPut, delete: vi.fn() } } as any;
    const meta = { feedToken: 'valid-token', filter: 'length', authors: [], minLength: 0 };

    await worker.queue(messageBatch([{ channel: 'options', tokenKey: 'options:push1', meta }]), env);

    expect(tokensPut).toHaveBeenCalledTimes(1);
    const [key, value, opts] = tokensPut.mock.calls[0];
    expect(key).toBe('options:push1');
    expect(value).toBe('1');
    const { lastValidated, ...restMetadata } = opts.metadata;
    expect(restMetadata).toEqual(meta);
    // A real epoch-millisecond stamp taken during this call, not a calendar-day string.
    expect(lastValidated).toBeGreaterThan(Date.now() - 5000);
    expect(lastValidated).toBeLessThanOrEqual(Date.now());
    // Registrations don't expire on a timer — cleanup relies entirely on gone-detection and
    // access-revalidation (issue #60), so a successful validation never sets expirationTtl.
    expect(opts.expirationTtl).toBeUndefined();
  });

  it('deletes a token whose access was revoked, without stamping lastValidated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }));
    const tokensPut = vi.fn().mockResolvedValue(undefined);
    const tokensDelete = vi.fn().mockResolvedValue(undefined);
    const env = { TOKENS: { put: tokensPut, delete: tokensDelete } } as any;

    await worker.queue(messageBatch([{ channel: 'options', tokenKey: 'options:push1', meta: { feedToken: 'revoked-token', filter: 'length', authors: [], minLength: 0 } }]), env);

    expect(tokensDelete).toHaveBeenCalledWith('options:push1');
    expect(tokensPut).not.toHaveBeenCalled();
  });

  it('leaves a token untouched on a transient access-check failure, so it is retried next sweep', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));
    const tokensPut = vi.fn().mockResolvedValue(undefined);
    const tokensDelete = vi.fn().mockResolvedValue(undefined);
    const env = { TOKENS: { put: tokensPut, delete: tokensDelete } } as any;

    await worker.queue(messageBatch([{ channel: 'options', tokenKey: 'options:push1', meta: { feedToken: 'device-token', filter: 'length', authors: [], minLength: 0 } }]), env);

    expect(tokensDelete).not.toHaveBeenCalled();
    expect(tokensPut).not.toHaveBeenCalled();
  });

  it('validates a stock registration against the Stock Insights URL, not Members Forum or Options Insights', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) });
    vi.stubGlobal('fetch', fetchMock);
    const env = { TOKENS: { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn() } } as any;

    await worker.queue(messageBatch([{ channel: 'stock', tokenKey: 'stock:push1', meta: { feedToken: 'shared-token', filter: 'length', authors: [], minLength: 0 } }]), env);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(CHANNEL_FEEDS.stock[0].url));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining(CHANNEL_FEEDS.options[0].url));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining(CHANNEL_FEEDS.members[0].url));
  });

  it('acks every message regardless of outcome, so Cloudflare does not auto-retry it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = { TOKENS: { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn() } } as any;
    const batch = messageBatch([{ channel: 'options', tokenKey: 'options:push1', meta: { feedToken: 'device-token', filter: 'length', authors: [], minLength: 0 } }]);

    await worker.queue(batch, env);

    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
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

// The hybrid classifier applies to every non-Members-Area feed's content whose regex check is
// genuinely undecided — see runChannel's classification loop and actionableStrategyFor (@li/core).
// These tests exercise that loop end to end via worker.scheduled(), mocking env.AI.run rather than
// calling the classifier functions directly, since the "classify once per poll cycle, not once per
// bucket" property only exists at the runChannel level.
describe('runChannel — hybrid actionable classification', () => {
  const MEMBERS_CRON = '0,5,10,15,20,25,30,35,40,45,50,55 * * * *';
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  // Deliberately free of every NEG_PATTERN/POS_PATTERN keyword -- classifySignal returns
  // fail-no-signal for this text, which is what makes it a hybrid candidate in the first place.
  // Has a real action verb ("enter") so it clears the necessary-condition gate and genuinely
  // reaches the AI candidacy path -- neither NEG_PATTERNS nor POS_PATTERNS match it either way.
  const AMBIGUOUS = 'Thinking about whether to enter over the next few weeks.';
  const itemXml = (guid: string, description: string, title = 't') =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${guid}</guid><title>${title}</title><link>l</link><dc:creator>Sean Hyman</dc:creator><description>${description}</description></item></channel></rss>`;

  function membersEnv(aiRun: ReturnType<typeof vi.fn>) {
    const stateStore: Record<string, string | null> = { 'run:members': runState({ membersForum: [] }), 'poll:members': 'poll-token' };
    return {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: vi.fn((k: string, v: string) => { stateStore[k] = v; return Promise.resolve(); }) },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'members:push-a', metadata: { filter: 'actionable', authors: [], minLength: 0 } }],
          list_complete: true,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      AI: { run: aiRun },
    } as any;
  }

  it('a Members Forum post with an ambiguous regex verdict becomes an AI candidate, and a positive hybrid result drives the alert', async () => {
    const knownExample = ACTIONABLE_CALIBRATION_EXAMPLES.find((e) => e.isActionable)!;
    const aiRun = vi.fn().mockResolvedValue({ data: [knownExample.vector] });
    const env = membersEnv(aiRun);
    let pushCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) { pushCalls += 1; return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }); }
      if (url.includes('members-forum')) return Promise.resolve({ ok: true, text: () => Promise.resolve(itemXml('forum-guid', AMBIGUOUS)) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }); // Members Area: nothing new
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(MEMBERS_CRON), env, {} as any);

    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(aiRun.mock.calls[0][1].text).toEqual([AMBIGUOUS]);
    expect(pushCalls).toBe(1); // the 'actionable' bucket alerted on the hybrid-positive result
  });

  it('an AI call failure falls back to not-actionable without throwing', async () => {
    const aiRun = vi.fn().mockRejectedValue(new Error('Workers AI unavailable'));
    const env = membersEnv(aiRun);
    let pushCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) { pushCalls += 1; return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }); }
      if (url.includes('members-forum')) return Promise.resolve({ ok: true, text: () => Promise.resolve(itemXml('forum-guid', AMBIGUOUS)) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_EMPTY) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(worker.scheduled(scheduledEvent(MEMBERS_CRON), env, {} as any)).resolves.not.toThrow();

    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(pushCalls).toBe(0); // fell back to not-actionable, same as pre-wiring regex-only behavior
  });

  it('zero candidates means env.AI.run is never called', async () => {
    const aiRun = vi.fn();
    const env = membersEnv(aiRun);
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }); // nothing new anywhere
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(MEMBERS_CRON), env, {} as any);

    expect(aiRun).not.toHaveBeenCalled();
  });

  it('an Options Insights post with an ambiguous regex verdict becomes an AI candidate, resolved against its own calibration set', async () => {
    const knownExample = OPTIONS_CALIBRATION_EXAMPLES.find((e) => e.isActionable)!;
    const aiRun = vi.fn().mockResolvedValue({ data: [knownExample.vector] });
    const stateStore: Record<string, string | null> = { 'run:options': runState({ optionsInsights: [] }), 'poll:options': 'poll-token' };
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: vi.fn((k: string, v: string) => { stateStore[k] = v; return Promise.resolve(); }) },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'options:push-a', metadata: { filter: 'actionable', authors: [], minLength: 0 } }],
          list_complete: true,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      AI: { run: aiRun },
    } as any;
    let pushCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) { pushCalls += 1; return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }); }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(itemXml('opt-guid', AMBIGUOUS, '*Starred Trade')) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(aiRun.mock.calls[0][1].text).toEqual([AMBIGUOUS]);
    expect(pushCalls).toBe(1); // the 'actionable' bucket alerted on the hybrid-positive result
  });

  it('multiple buckets sharing one ambiguous Members Forum item result in exactly one env.AI.run call', async () => {
    const knownExample = ACTIONABLE_CALIBRATION_EXAMPLES.find((e) => e.isActionable)!;
    const aiRun = vi.fn().mockResolvedValue({ data: [knownExample.vector] });
    const stateStore: Record<string, string | null> = { 'run:members': runState({ membersForum: [] }), 'poll:members': 'poll-token' };
    const env = {
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: vi.fn((k: string, v: string) => { stateStore[k] = v; return Promise.resolve(); }) },
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [
            { name: 'members:push-a', metadata: { filter: 'actionable', authors: [], minLength: 0 } },
            { name: 'members:push-b', metadata: { filter: 'length', authors: [], minLength: 0 } },
          ],
          list_complete: true,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      AI: { run: aiRun },
    } as any;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      if (url.includes('members-forum')) return Promise.resolve({ ok: true, text: () => Promise.resolve(itemXml('forum-guid', AMBIGUOUS)) });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(RSS_EMPTY) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(MEMBERS_CRON), env, {} as any);

    expect(aiRun).toHaveBeenCalledTimes(1); // shared across both buckets, not once each
  });
});

// Throwaway test-only key material, same shapes exercised (and validated against real
// buildPushPayload crypto) in webpush.test.ts.
const VAPID_ENV = {
  VAPID_SUBJECT: 'mailto:test@example.com',
  VAPID_PUBLIC_KEY: 'BPCnUQ9J_eoysTmL_P7DlsBAv5zaU2aylMaMl2VzAKzk_FbMuvA20mC8cjW6EwDXa6oAgFRf_FDHGE6N5OZZzp0',
  VAPID_PRIVATE_KEY: 'id36_WQR8FiP-75gk_Na8OgU9YsWSZWcMxCicgWTfTo',
};
const WEBPUSH_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/fake-endpoint-id';
const webpushSubscription = {
  endpoint: WEBPUSH_ENDPOINT,
  expirationTime: null,
  keys: {
    p256dh: 'BELwtddmVvbvOEHadf6IA9Jj2Gx2u6K9Yoj-0TOzGPDJWfQbUprGpFpfOKvULdsyl9m5LwdBLqG6t9zUajeGN8A',
    auth: 'wUSvE5FxCS7VqmXHVW79FQ',
  },
};

// runChannel never sends a webpush notification itself — it only enqueues one
// WebPushQueueMessage per (subscriber, item) pair onto WEBPUSH_QUEUE. The queue() consumer
// (tested separately below) does the actual encrypted send, in its own invocation with its own
// subrequest budget — see wrangler.toml's queues.consumers max_batch_size.
describe('runChannel — web push queuing', () => {
  const OPTIONS_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';
  const itemWithAuthor = (guid: string, author: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>${guid}</guid><title>t</title><link>l</link><dc:creator>${author}</dc:creator><description>d</description></item></channel></rss>`;

  function mockEnv(keys: { name: string; metadata: Record<string, unknown> }[]) {
    const stateStore: Record<string, string | null> = {
      'run:options': runState({ optionsInsights: ['old-guid'] }),
      'poll:options': 'poll-token',
    };
    const statePut = vi.fn((key: string, value: string) => { stateStore[key] = value; return Promise.resolve(); });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = {
      ...VAPID_ENV,
      STATE: { get: vi.fn((key: string) => Promise.resolve(stateStore[key] ?? null)), put: statePut },
      TOKENS: { list: vi.fn().mockResolvedValue({ keys, list_complete: true }), delete: vi.fn().mockResolvedValue(undefined) },
      WEBPUSH_QUEUE: { sendBatch },
    } as any;
    return { env, stateStore, sendBatch };
  }

  it('enqueues one message for a registered browser subscription', async () => {
    const { env, sendBatch } = mockEnv([
      { name: `options:web:${WEBPUSH_ENDPOINT}`, metadata: { filter: 'length', authors: [], minLength: 0, kind: 'webpush', subscription: webpushSubscription } },
    ]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('new-guid', 'Sean Hyman')) })));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const [messages] = sendBatch.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toMatchObject({ channel: 'options', subscription: webpushSubscription, title: expect.any(String) });
    const finalState = JSON.parse((await env.STATE.get('run:options'))!);
    expect(finalState.stats.sent).toBeGreaterThan(0);
  });

  it('enqueuing a webpush recipient does not block an Expo recipient in the same bucket', async () => {
    const { env } = mockEnv([
      { name: `options:web:${WEBPUSH_ENDPOINT}`, metadata: { filter: 'length', authors: [], minLength: 0, kind: 'webpush', subscription: webpushSubscription } },
      { name: 'options:good-push', metadata: { filter: 'length', authors: [], minLength: 0 } },
    ]);
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('new-guid', 'Sean Hyman')) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    expect(pushCall).toBeDefined();
  });

  it('chunks sendBatch calls at 100 messages', async () => {
    const manySubs = Array.from({ length: 150 }, (_, i) => ({
      name: `options:web:endpoint-${i}`,
      metadata: { filter: 'length', authors: [], minLength: 0, kind: 'webpush', subscription: { ...webpushSubscription, endpoint: `endpoint-${i}` } },
    }));
    const { env, sendBatch } = mockEnv(manySubs);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('new-guid', 'Sean Hyman')) })));

    await worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any);

    expect(sendBatch).toHaveBeenCalledTimes(2); // 150 messages -> batches of 100 + 50
    expect(sendBatch.mock.calls[0][0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1][0]).toHaveLength(50);
  });

  it('a WEBPUSH_QUEUE.sendBatch failure in one bucket does not abort another bucket\'s Expo send', async () => {
    const { env } = mockEnv([
      { name: `options:web:${WEBPUSH_ENDPOINT}`, metadata: { filter: 'members', authors: [], minLength: 0, kind: 'webpush', subscription: webpushSubscription } },
      { name: 'options:good-push', metadata: { filter: 'length', authors: [], minLength: 0 } },
    ]);
    env.WEBPUSH_QUEUE.sendBatch.mockRejectedValue(new Error('queue unavailable'));
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('exp.host')) return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: true, text: () => Promise.resolve(itemWithAuthor('new-guid', 'Sean Hyman')) });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(worker.scheduled(scheduledEvent(OPTIONS_CRON), env, {} as any)).resolves.not.toThrow();

    const pushCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('exp.host'));
    expect(pushCall).toBeDefined();
  });
});

describe('queue() — web push delivery', () => {
  function messageBatch(bodies: { channel: string; subscription: typeof webpushSubscription; title: string; body: string; url?: string }[]): any {
    return { queue: 'webpush-notifications', messages: bodies.map((body) => ({ body, ack: vi.fn() })) };
  }

  it('sends a webpush notification for a queued message, and acks it', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...VAPID_ENV, TOKENS: { delete: vi.fn() } } as any;
    const batch = messageBatch([{ channel: 'options', subscription: webpushSubscription, title: 't', body: 'b' }]);

    await worker.queue(batch, env);

    expect(fetchMock).toHaveBeenCalledWith(WEBPUSH_ENDPOINT, expect.anything());
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
  });

  // Cloudflare Queues auto-retries any message that isn't explicitly ack'd or retry'd, even a
  // successfully-sent one — without this, every push would go out up to max_retries times.
  it('acks a message even when the send fails, so Cloudflare does not auto-retry it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const env = { ...VAPID_ENV, TOKENS: { delete: vi.fn() } } as any;
    const batch = messageBatch([{ channel: 'options', subscription: webpushSubscription, title: 't', body: 'b' }]);

    await worker.queue(batch, env);

    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
  });

  it('prunes a webpush subscription that returns 410 Gone, without affecting other messages', async () => {
    const goneEndpoint = 'https://fcm.googleapis.com/fcm/send/gone-endpoint';
    const fetchMock = vi.fn((url: string) => Promise.resolve(url === goneEndpoint ? { ok: false, status: 410 } : { ok: true, status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const tokensDelete = vi.fn().mockResolvedValue(undefined);
    const env = { ...VAPID_ENV, TOKENS: { delete: tokensDelete } } as any;

    await worker.queue(messageBatch([
      { channel: 'options', subscription: { ...webpushSubscription, endpoint: goneEndpoint }, title: 't', body: 'b' },
      { channel: 'options', subscription: webpushSubscription, title: 't', body: 'b' },
    ]), env);

    expect(tokensDelete).toHaveBeenCalledWith(`options:web:${goneEndpoint}`);
    expect(tokensDelete).toHaveBeenCalledTimes(1); // the still-valid subscription is untouched
  });

  it('a webpush network failure does not throw or abort the batch', async () => {
    const failEndpoint = 'https://fcm.googleapis.com/fcm/send/fails-endpoint';
    const fetchMock = vi.fn((url: string) => url === failEndpoint ? Promise.reject(new Error('network blip')) : Promise.resolve({ ok: true, status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...VAPID_ENV, TOKENS: { delete: vi.fn() } } as any;

    await expect(worker.queue(messageBatch([
      { channel: 'options', subscription: { ...webpushSubscription, endpoint: failEndpoint }, title: 't', body: 'b' },
      { channel: 'options', subscription: webpushSubscription, title: 't', body: 'b' },
    ]), env)).resolves.not.toThrow();

    expect(fetchMock).toHaveBeenCalledWith(WEBPUSH_ENDPOINT, expect.anything()); // second message still sent
  });
});

describe('queue() — unrecognized queue name', () => {
  it('acks every message without acting on it, rather than misrouting into either handler', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ack = vi.fn();
    const batch = { queue: 'some-future-queue', messages: [{ body: { unexpected: 'shape' }, ack }] } as any;
    const env = { ...VAPID_ENV, TOKENS: { put: vi.fn(), delete: vi.fn() } } as any;

    await expect(worker.queue(batch, env)).resolves.not.toThrow();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled(); // neither handler's fetch logic ran
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

describe('needsRevalidation', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('needs revalidation when never validated before', () => {
    expect(needsRevalidation(undefined, Date.now())).toBe(true);
  });
  it('does not need revalidation less than 24h since the last one', () => {
    const now = Date.now();
    expect(needsRevalidation(now - DAY_MS + 1000, now)).toBe(false);
  });
  it('needs revalidation again once 24h have elapsed', () => {
    const now = Date.now();
    expect(needsRevalidation(now - DAY_MS, now)).toBe(true);
  });
  // Two timestamps a few minutes apart, straddling midnight, must not both read as "needs
  // revalidation" just because the calendar date changed — that was the exact bug in the
  // calendar-date-string version this replaced.
  it('does not treat timestamps minutes apart as needing revalidation, even across a calendar-day boundary', () => {
    const justBeforeMidnight = new Date('2026-01-01T23:58:00-05:00').getTime();
    const justAfterMidnight = new Date('2026-01-02T00:02:00-05:00').getTime();
    expect(needsRevalidation(justBeforeMidnight, justAfterMidnight)).toBe(false);
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

describe('GET /status — version metadata', () => {
  it('surfaces CF_VERSION_METADATA verbatim so a live response traces back to its deploy', async () => {
    const versionMetadata = { id: 'abc123', tag: 'a1b2c3d', timestamp: '2026-08-28T00:00:00Z' };
    const env = {
      FEED_TOKEN: 'secret',
      CF_VERSION_METADATA: versionMetadata,
      TOKENS: { list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) },
      STATE: { get: vi.fn().mockResolvedValue(null) },
    } as any;

    const res = await worker.fetch(
      new Request('https://worker.test/status', { headers: { Authorization: 'Bearer secret' } }),
      env,
    );

    const body = await res.json() as { version: unknown };
    expect(body.version).toEqual(versionMetadata);
  });
});

describe('GET /status — registration counts by delivery kind', () => {
  it('splits registeredTokens into registeredExpo and registeredWebpush per channel', async () => {
    const env = {
      FEED_TOKEN: 'secret',
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [
            { name: 'members:expo-a', metadata: { filter: 'length', authors: [], minLength: 0 } },
            { name: 'members:expo-b', metadata: { filter: 'length', authors: [], minLength: 0 } },
            { name: 'members:web:endpoint-a', metadata: { filter: 'length', authors: [], minLength: 0, kind: 'webpush' } },
          ],
          list_complete: true,
        }),
      },
      STATE: { get: vi.fn().mockResolvedValue(null) },
    } as any;

    const res = await worker.fetch(
      new Request('https://worker.test/status', { headers: { Authorization: 'Bearer secret' } }),
      env,
    );
    const body = await res.json() as any;

    expect(body.members.registeredTokens).toBe(3);
    expect(body.members.registeredExpo).toBe(2);
    expect(body.members.registeredWebpush).toBe(1);
  });

  it('reports zero webpush registrations for a channel with only Expo devices', async () => {
    const env = {
      FEED_TOKEN: 'secret',
      TOKENS: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: 'options:expo-a', metadata: { filter: 'length', authors: [], minLength: 0 } }],
          list_complete: true,
        }),
      },
      STATE: { get: vi.fn().mockResolvedValue(null) },
    } as any;

    const res = await worker.fetch(
      new Request('https://worker.test/status', { headers: { Authorization: 'Bearer secret' } }),
      env,
    );
    const body = await res.json() as any;

    expect(body.options.registeredExpo).toBe(1);
    expect(body.options.registeredWebpush).toBe(0);
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
