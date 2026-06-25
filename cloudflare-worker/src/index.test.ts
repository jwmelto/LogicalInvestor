import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchesLevel, extractTopicUrl, stripReplyPrefix, channelFromCron, findAndStorePollToken, shouldPollNow } from './index';
import { containsActionableSignal } from '@li/core';
import type { FilterItem, NotifLevel } from '@li/core';

type FeedKey = 'members-area' | 'members-forum' | 'stock-insights' | 'options-insights';

function item(feedKey: FeedKey, overrides: { author?: string; title?: string; description?: string } = {}): FilterItem {
  return {
    isMembersArea: feedKey === 'members-area',
    isStockInsights: feedKey === 'stock-insights',
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
  it('members-area always passes regardless of level', () => {
    for (const level of ['minimal', 'standard', 'all'] as NotifLevel[]) {
      expect(matchesLevel(item('members-area', { author: 'anyone', description: '' }), level, AUTHOR, MIN)).toBe(true);
    }
  });

  it('minimal blocks everything except members-area', () => {
    for (const fk of ['members-forum', 'stock-insights', 'options-insights'] as FeedKey[]) {
      expect(matchesLevel(item(fk, { description: long }), 'minimal', AUTHOR, MIN)).toBe(false);
    }
  });

  it('author filter blocks non-matching authors at standard and all', () => {
    for (const level of ['standard', 'all'] as NotifLevel[]) {
      expect(matchesLevel(item('members-forum', { author: 'Other Person', description: long }), level, AUTHOR, MIN)).toBe(false);
    }
  });

  it('all level passes when author matches regardless of content length', () => {
    expect(matchesLevel(item('members-forum', { description: 'short' }), 'all', AUTHOR, MIN)).toBe(true);
  });

  it('standard: stock-insights requires * prefix after stripping Reply To', () => {
    expect(matchesLevel(item('stock-insights', { title: '*AAPL Trade',           description: long }), 'standard', AUTHOR, MIN)).toBe(true);
    expect(matchesLevel(item('stock-insights', { title: 'Reply To: *AAPL Trade', description: long }), 'standard', AUTHOR, MIN)).toBe(true);
    expect(matchesLevel(item('stock-insights', { title: 'Discussion post',        description: long }), 'standard', AUTHOR, MIN)).toBe(false);
  });

  it('standard: members-forum requires length AND action signal', () => {
    expect(matchesLevel(item('members-forum', { description: '<p>short</p>' }),                      'standard', AUTHOR, MIN)).toBe(false); // short, no signal
    expect(matchesLevel(item('members-forum', { description: '<p>' + long + '</p>' }),               'standard', AUTHOR, MIN)).toBe(false); // long, no signal
    expect(matchesLevel(item('members-forum', { description: '<p>' + longWithSignal + '</p>' }),     'standard', AUTHOR, MIN)).toBe(true);  // long + signal
  });

  it('standard: options-insights requires length AND action signal', () => {
    expect(matchesLevel(item('options-insights', { description: 'short' }),         'standard', AUTHOR, MIN)).toBe(false); // short, no signal
    expect(matchesLevel(item('options-insights', { description: long }),            'standard', AUTHOR, MIN)).toBe(false); // long, no signal
    expect(matchesLevel(item('options-insights', { description: longWithSignal }),  'standard', AUTHOR, MIN)).toBe(true);  // long + signal
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


describe('shouldPollNow', () => {
  it('runs every invocation during trading hours (0915–1400 ET)', () => {
    expect(shouldPollNow(new Date('2025-06-04T09:15:00-04:00'))).toBe(true);
    expect(shouldPollNow(new Date('2025-06-04T09:17:00-04:00'))).toBe(true); // mid-5min interval
    expect(shouldPollNow(new Date('2025-06-04T13:55:00-04:00'))).toBe(true); // near close
  });

  it('runs hourly before 0915 ET on a weekday (overnight rate)', () => {
    expect(shouldPollNow(new Date('2025-06-04T09:00:00-04:00'))).toBe(true);  // on the hour → fires
    expect(shouldPollNow(new Date('2025-06-04T09:03:00-04:00'))).toBe(false); // not on hour → skip
  });

  it('runs every 15 min during late-day window (1400–1615 ET)', () => {
    expect(shouldPollNow(new Date('2025-06-04T14:00:00-04:00'))).toBe(true);
    expect(shouldPollNow(new Date('2025-06-04T14:05:00-04:00'))).toBe(false);
    expect(shouldPollNow(new Date('2025-06-04T14:15:00-04:00'))).toBe(true);
    expect(shouldPollNow(new Date('2025-06-04T14:30:00-04:00'))).toBe(true);
    expect(shouldPollNow(new Date('2025-06-04T14:31:00-04:00'))).toBe(false);
  });

  it('runs hourly overnight (after 1615 ET)', () => {
    expect(shouldPollNow(new Date('2025-06-04T17:00:00-04:00'))).toBe(true);
    expect(shouldPollNow(new Date('2025-06-04T17:05:00-04:00'))).toBe(false);
    expect(shouldPollNow(new Date('2025-06-04T17:30:00-04:00'))).toBe(false);
  });

  it('runs hourly on weekends regardless of time', () => {
    expect(shouldPollNow(new Date('2025-06-07T10:00:00-04:00'))).toBe(true);  // Sat, would be trading hours on weekday
    expect(shouldPollNow(new Date('2025-06-07T10:05:00-04:00'))).toBe(false);
    expect(shouldPollNow(new Date('2025-06-08T16:00:00-04:00'))).toBe(true);  // Sun, on the hour
    expect(shouldPollNow(new Date('2025-06-08T16:15:00-04:00'))).toBe(false);
  });

  it('handles EST (winter) correctly', () => {
    expect(shouldPollNow(new Date('2025-01-07T09:15:00-05:00'))).toBe(true);  // trading hours
    expect(shouldPollNow(new Date('2025-01-07T14:00:00-05:00'))).toBe(true);  // 15-min mark
    expect(shouldPollNow(new Date('2025-01-07T14:05:00-05:00'))).toBe(false);
    expect(shouldPollNow(new Date('2025-01-07T08:55:00-05:00'))).toBe(false); // before open, not on hour
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

// Verbatim excerpts from training data to guard pattern regressions.
describe('containsActionableSignal', () => {
  describe('should fire (positive training)', () => {
    it('new pick announcement', () => {
      expect(containsActionableSignal("I've got a new pick for subscribers this month that you need to get into IMMEDIATELY")).toBe(true);
    });
    it('formal tranche price line', () => {
      expect(containsActionableSignal('1st Tranche: $210 or below. (ACN is trading in the $198\'s right now).')).toBe(true);
    });
    it('third tranche urgency', () => {
      expect(containsActionableSignal("let's go ahead and ensure we get in our 3rd tranche NOW")).toBe(true);
    });
    it('fourth tranche entry', () => {
      expect(containsActionableSignal('For those that want to, you can get in a 4th tranche here/now.')).toBe(true);
    });
    it('explicit buy recommendation with price', () => {
      expect(containsActionableSignal('Buy Best Buy (BBY) at the market as long as the stock is at $66 per share or LOWER.')).toBe(true);
    });
    it('sell half of first tranche', () => {
      expect(containsActionableSignal('you can sell half of your 1st tranche and if it pulls back to your breakeven')).toBe(true);
    });
    it('sell half of remaining', () => {
      expect(containsActionableSignal("With y'all being up around 21%-22% in under 2 complete trading days, I'd consider selling half of your remaining half, now.")).toBe(true);
    });
    it('averaging down with price', () => {
      expect(containsActionableSignal('If FXY dips anywhere into the $81ish area, that\'s close enough to get your averaging down to ensure you get it')).toBe(true);
    });
    it('IMMEDIATELY urgency marker alone', () => {
      expect(containsActionableSignal('get into IMMEDIATELY and not delay')).toBe(true);
    });
  });

  describe('should not fire (negative training)', () => {
    it('educational: waiting for 4th tranche without action', () => {
      expect(containsActionableSignal("You shouldn't be waiting for a 4th tranche entry. You (or I, either one) will know the bottom when it's happen.")).toBe(false);
    });
    it('philosophical: sentiment discussion', () => {
      expect(containsActionableSignal("Sentiment is bad – a good thing. That's when value is found. It's not generally found outside of that setting.")).toBe(false);
    });
    it('Buffett quote / emotional coaching', () => {
      expect(containsActionableSignal("Emotions (in every area of life) are great followers and horrible leaders. Yet, most people allow them to lead in stock-picking")).toBe(false);
    });
    it('status update without action', () => {
      expect(containsActionableSignal('BBY up 2.08% today\n\nIf it should get to $80 or more, we may consider a sell.\n\nIf it doesn\'t get there, we\'re happy to continue to hold.')).toBe(false);
    });
    it('conditional / speculative diagonal', () => {
      expect(containsActionableSignal("BBY \"could\" be doing a \"leading diagonal\" which would look something like this. IF that happened, we'd likely sell around $80-$81ish.")).toBe(false);
    });
    it('fundamental analysis without new entry', () => {
      expect(containsActionableSignal("It's been around since 1951. 800.000 employees. $78 billion company. Forward P/E in the 8's. Almost $13 billion earned in a \"bad year\" for them, last year. Over $10 billion in cash. What's scary about that?")).toBe(false);
    });
  });
});
