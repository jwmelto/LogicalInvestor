import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { matchesLevel, extractTopicUrl, stripReplyPrefix, channelFromCron, findAndStorePollToken, shouldPollNow, getIntervalMinutes, registerDevice, timingSafeEqualStr } from './index';
import { FeedKeys, containsActionableSignal } from '@li/core';
import type { FeedKey, FilterItem, NotifLevel } from '@li/core';

const FK = FeedKeys;

function item(feedKey: FeedKey, overrides: { author?: string; title?: string; description?: string } = {}): FilterItem {
  return {
    feedKey,
    author: overrides.author ?? 'Sean Hyman',
    title: overrides.title ?? '',
    content: overrides.description ?? '',
  };
}

const AUTHOR = 'sean hyman';
const MIN = 200;
const long = 'x'.repeat(210);
// Long content with an action signal: satisfies both the length and semantic requirements.
const longWithSignal = 'new pick — ' + 'x'.repeat(200);

const RSS_WITH_ITEM = '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>1</guid><title>t</title><link>l</link><description>d</description></item></channel></rss>';
const RSS_EMPTY     = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';

beforeEach(() => { vi.restoreAllMocks(); });

describe('matchesLevel', () => {
  it('none blocks everything including members-area', () => {
    for (const fk of [FK.membersArea, FK.membersForum, FK.stockInsights, FK.optionsInsights] as FeedKey[]) {
      expect(matchesLevel(item(fk, { description: long }), 'none', AUTHOR, MIN)).toBe(false);
    }
  });

  it('members-area always passes for minimal/standard/all', () => {
    for (const level of ['minimal', 'standard', 'all'] as NotifLevel[]) {
      expect(matchesLevel(item(FK.membersArea, { author: 'anyone', description: '' }), level, AUTHOR, MIN)).toBe(true);
    }
  });

  it('minimal blocks everything except members-area', () => {
    for (const fk of [FK.membersForum, FK.stockInsights, FK.optionsInsights] as FeedKey[]) {
      expect(matchesLevel(item(fk, { description: long }), 'minimal', AUTHOR, MIN)).toBe(false);
    }
  });

  it('author filter blocks non-matching authors at standard and all', () => {
    for (const level of ['standard', 'all'] as NotifLevel[]) {
      expect(matchesLevel(item(FK.membersForum, { author: 'Other Person', description: long }), level, AUTHOR, MIN)).toBe(false);
    }
  });

  it('all level passes when author matches regardless of content length', () => {
    expect(matchesLevel(item(FK.membersForum, { description: 'short' }), 'all', AUTHOR, MIN)).toBe(true);
  });

  it('standard: stock-insights requires * prefix AND an action signal — a starred topic does not excuse a "good job" reply', () => {
    expect(matchesLevel(item(FK.stockInsights, { title: '*AAPL Trade',           description: long }),            'standard', AUTHOR, MIN)).toBe(false); // starred but no signal
    expect(matchesLevel(item(FK.stockInsights, { title: '*AAPL Trade',           description: longWithSignal }),  'standard', AUTHOR, MIN)).toBe(true);
    expect(matchesLevel(item(FK.stockInsights, { title: 'Reply To: *AAPL Trade', description: longWithSignal }),  'standard', AUTHOR, MIN)).toBe(true);
    expect(matchesLevel(item(FK.stockInsights, { title: 'Discussion post',        description: longWithSignal }), 'standard', AUTHOR, MIN)).toBe(false); // no star at all
  });

  it('standard: members-forum requires action signal only (length irrelevant)', () => {
    expect(matchesLevel(item(FK.membersForum, { description: '<p>no signal</p>' }),                  'standard', AUTHOR, MIN)).toBe(false); // no signal
    expect(matchesLevel(item(FK.membersForum, { description: '<p>new pick IMMEDIATELY</p>' }),       'standard', AUTHOR, MIN)).toBe(true);  // short but has signal
    expect(matchesLevel(item(FK.membersForum, { description: '<p>' + long + '</p>' }),               'standard', AUTHOR, MIN)).toBe(false); // long, no signal
    expect(matchesLevel(item(FK.membersForum, { description: '<p>' + longWithSignal + '</p>' }),     'standard', AUTHOR, MIN)).toBe(true);  // long + signal
  });

  it('standard: options-insights requires * prefix AND an action signal — a starred topic does not excuse a "good job" reply', () => {
    expect(matchesLevel(item(FK.optionsInsights, { title: '*SPY Trade',            description: long }),           'standard', AUTHOR, MIN)).toBe(false); // starred but no signal
    expect(matchesLevel(item(FK.optionsInsights, { title: '*SPY Trade',            description: longWithSignal }), 'standard', AUTHOR, MIN)).toBe(true);
    expect(matchesLevel(item(FK.optionsInsights, { title: 'Reply To: *SPY Trade', description: longWithSignal }),  'standard', AUTHOR, MIN)).toBe(true);
    expect(matchesLevel(item(FK.optionsInsights, { title: 'Discussion post',       description: longWithSignal }), 'standard', AUTHOR, MIN)).toBe(false); // no star at all
  });
});

describe('extractTopicUrl', () => {
  it('extracts topic base URL from a post link', () => {
    expect(extractTopicUrl('https://logicalinvestor.net/forums/topic/nvo/#post-12345'))
      .toBe('https://logicalinvestor.net/forums/topic/nvo/');
  });
  it('extracts from a paginated link', () => {
    expect(extractTopicUrl('https://logicalinvestor.net/forums/topic/ewz-update/page/2/'))
      .toBe('https://logicalinvestor.net/forums/topic/ewz-update/');
  });
  it('returns null for non-topic links', () => {
    expect(extractTopicUrl('https://logicalinvestor.net/2024/01/some-post/')).toBeNull();
    expect(extractTopicUrl('https://logicalinvestor.net/forums/forum/members-forum/')).toBeNull();
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
  function mockEnv(existingMeta: Record<string, unknown> | null = null) {
    return {
      TOKENS: {
        put: vi.fn().mockResolvedValue(undefined),
        getWithMetadata: vi.fn().mockResolvedValue({ value: existingMeta ? '1' : null, metadata: existingMeta }),
      },
      STATE: { put: vi.fn().mockResolvedValue(undefined) },
    } as any;
  }

  it('rejects an optional-channel registration with no feed_token and no prior registration', async () => {
    const env = mockEnv(null);
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', level: 'standard' }, env);
    expect(res.status).toBe(403);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('rejects an optional-channel registration whose feed_token has no access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_EMPTY) }));
    const env = mockEnv(null);
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', level: 'standard', feedToken: 'unauthorized' }, env);
    expect(res.status).toBe(403);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('accepts an optional-channel registration whose feed_token has access, and stores it as the poll token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(RSS_WITH_ITEM) }));
    const env = mockEnv(null);
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', level: 'standard', feedToken: 'valid' }, env);
    expect(res.status).toBe(200);
    expect(env.STATE.put).toHaveBeenCalledWith('poll:options', 'valid');
    expect(env.TOKENS.put).toHaveBeenCalledWith('options:push1', '1', { metadata: { level: 'standard', feedToken: 'valid' } });
  });

  it('allows a level-only update (no feed_token) for a device already registered, carrying its stored feedToken forward', async () => {
    const env = mockEnv({ level: 'standard', feedToken: 'valid' });
    const res = await registerDevice({ channel: 'options', pushToken: 'push1', level: 'all' }, env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith('options:push1', '1', { metadata: { level: 'all', feedToken: 'valid' } });
  });

  it('members channel never requires a feed_token', async () => {
    const env = mockEnv(null);
    const res = await registerDevice({ channel: 'members', pushToken: 'push1', level: 'standard' }, env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith('members:push1', '1', { metadata: { level: 'standard' } });
  });
});

describe('/register endpoint validation (HTTP boundary)', () => {
  function mockEnv() {
    return {
      TOKENS: { put: vi.fn().mockResolvedValue(undefined), getWithMetadata: vi.fn() },
      STATE: { put: vi.fn().mockResolvedValue(undefined) },
    } as any;
  }

  function registerRequest(body: Record<string, string>) {
    return new Request('https://worker.test/register', { method: 'POST', body: JSON.stringify(body) });
  }

  it('rejects a missing token', async () => {
    const res = await worker.fetch(registerRequest({ channel: 'members', level: 'standard' }), mockEnv());
    expect(res.status).toBe(400);
  });

  it('rejects a missing or unknown channel', async () => {
    const res = await worker.fetch(registerRequest({ token: 'push1', level: 'standard' }), mockEnv());
    expect(res.status).toBe(400);
    const res2 = await worker.fetch(registerRequest({ token: 'push1', channel: 'bogus', level: 'standard' }), mockEnv());
    expect(res2.status).toBe(400);
  });

  it('rejects a missing or invalid level rather than silently defaulting it', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'members' }), env);
    expect(res.status).toBe(400);
    const res2 = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', level: 'bogus' }), env);
    expect(res2.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
  });

  it('valid members registration reaches registerDevice and succeeds', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'members', level: 'standard' }), env);
    expect(res.status).toBe(200);
    expect(env.TOKENS.put).toHaveBeenCalledWith('members:push1', '1', { metadata: { level: 'standard' } });
  });

  it('rejects an empty-string feed_token instead of silently treating it as absent', async () => {
    const env = mockEnv();
    const res = await worker.fetch(registerRequest({ token: 'push1', channel: 'options', level: 'standard', feed_token: '' }), env);
    expect(res.status).toBe(400);
    expect(env.TOKENS.put).not.toHaveBeenCalled();
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

  it('no longer accepts the secret via query string', async () => {
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
