import { XMLParser } from 'fast-xml-parser';
import { extractRssItems } from '../index';

// Same config both feedService.ts (app) and cloudflare-worker/src/index.ts use.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Sanitized, but structurally faithful to a real Members Forum feed response: CDATA-wrapped
// title/description, WordPress-style HTML-entity-encoded content inside that CDATA, a plain
// (non-#text) guid, dc:creator, and an RFC 2822 pubDate.
const MULTI_ITEM_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>Logical Investor &#187; All Posts</title>
<item>
  <guid>https://logicalinvestor.net/forums/topic/example-pick/page/2/#post-1001</guid>
  <title><![CDATA[Reply To: XYZ: Example Pick]]></title>
  <link>https://logicalinvestor.net/forums/topic/example-pick/page/2/#post-1001</link>
  <pubDate>Wed, 08 Jul 2026 18:26:47 +0000</pubDate>
  <dc:creator>Jane Analyst</dc:creator>
  <description><![CDATA[
    <p>Up 3.6% now &#8212; isn&#8217;t that great?</p>
    <p>&nbsp;</p>
  ]]></description>
</item>
<item>
  <guid>https://logicalinvestor.net/forums/topic/other-topic/#post-1002</guid>
  <title><![CDATA[Other Topic]]></title>
  <link>https://logicalinvestor.net/forums/topic/other-topic/#post-1002</link>
  <pubDate>Wed, 08 Jul 2026 18:24:00 +0000</pubDate>
  <dc:creator>Sam Trader</dc:creator>
  <description><![CDATA[<p>Tom &amp; Jerry discuss the market.</p>]]></description>
</item>
</channel>
</rss>`;

const SINGLE_ITEM_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<item>
  <guid>https://logicalinvestor.net/forums/topic/solo/#post-2001</guid>
  <title><![CDATA[Solo Topic]]></title>
  <link>https://logicalinvestor.net/forums/topic/solo/#post-2001</link>
  <pubDate>Tue, 07 Jul 2026 15:05:01 +0000</pubDate>
  <dc:creator>Taylor Limited</dc:creator>
  <description><![CDATA[<p>Just one post.</p>]]></description>
</item>
</channel>
</rss>`;

const EMPTY_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Empty</title></channel></rss>`;

describe('extractRssItems (realistic feed shape)', () => {
  it('extracts every field correctly across multiple items', () => {
    const items = extractRssItems(parser.parse(MULTI_ITEM_RSS));

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      guid: 'https://logicalinvestor.net/forums/topic/example-pick/page/2/#post-1001',
      title: 'XYZ: Example Pick', // "Reply To: " stripped
      author: 'Jane Analyst',
      description: 'Up 3.6% now — isn’t that great?', // tags stripped, entities decoded, whitespace collapsed
      link: 'https://logicalinvestor.net/forums/topic/example-pick/page/2/#post-1001',
      pubDate: new Date('Wed, 08 Jul 2026 18:26:47 +0000'),
    });
    expect(items[1]).toEqual({
      guid: 'https://logicalinvestor.net/forums/topic/other-topic/#post-1002',
      title: 'Other Topic', // no prefix to strip, passes through untouched
      author: 'Sam Trader',
      description: 'Tom & Jerry discuss the market.',
      link: 'https://logicalinvestor.net/forums/topic/other-topic/#post-1002',
      pubDate: new Date('Wed, 08 Jul 2026 18:24:00 +0000'),
    });
  });

  // fast-xml-parser collapses a lone <item> into a plain object instead of a one-element array —
  // extractRssItems must still return an array.
  it('normalizes a single <item> (not wrapped in an array by the parser) into a one-element array', () => {
    const items = extractRssItems(parser.parse(SINGLE_ITEM_RSS));
    expect(items).toHaveLength(1);
    expect(items[0].guid).toBe('https://logicalinvestor.net/forums/topic/solo/#post-2001');
  });

  it('returns an empty array for a feed with no items', () => {
    expect(extractRssItems(parser.parse(EMPTY_RSS))).toEqual([]);
  });

  it('uses the guid as a plain string as this feed sends it (no isPermaLink attribute, no #text wrapping)', () => {
    const items = extractRssItems(parser.parse(SINGLE_ITEM_RSS));
    expect(typeof items[0].guid).toBe('string');
  });

  it('falls back to the current time for a missing/unparseable pubDate', () => {
    const rss = SINGLE_ITEM_RSS.replace(/<pubDate>.*<\/pubDate>/, '');
    const items = extractRssItems(parser.parse(rss));
    expect(Date.now() - items[0].pubDate.getTime()).toBeLessThan(1000);
  });
});
