import { XMLParser } from 'fast-xml-parser';
import { decodeHtmlEntities, stripHtml } from '../index';

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeHtmlEntities('isn&#8217;t')).toBe('isn’t');
  });

  it('decodes hex numeric entities', () => {
    expect(decodeHtmlEntities('isn&#x2019;t')).toBe('isn’t');
  });

  // The gap that motivated moving off a hand-rolled 7-entry dictionary onto the `he` library:
  // &nbsp; is not one of the 5 predefined XML entities, and a real feed sample used it as a
  // paragraph-spacer (`<p>&nbsp;</p>`). A hand-rolled table missed it; `he` doesn't.
  it('decodes non-XML HTML entities like &nbsp;', () => {
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
  });
});

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>world</b></p>')).toBe('Hello world');
  });

  it('decodes entities after tags are already gone', () => {
    expect(stripHtml('<p>I&#8217;m up &amp; running</p>')).toBe('I’m up & running');
  });

  // Order matters: strip tags first (while entities are still escaped as text, e.g. "&lt;"),
  // THEN decode. Decoding first would turn an escaped, literal "&lt;script&gt;" into a real
  // "<script>" string, which the tag-stripping regex would then wrongly remove as if it were markup.
  it('does not treat a decoded entity as a tag to strip', () => {
    expect(stripHtml('See &lt;script&gt; tags explained here')).toBe('See <script> tags explained here');
  });
});

// This is the actual discovery that justifies extractRssItems() doing its own entity-decode pass
// at all, rather than relying on fast-xml-parser: this feed's <title>/<description> are CDATA-
// wrapped, and CDATA content is (per XML spec) never entity-processed by the parser, even with
// `htmlEntities: true`. WordPress still HTML-entity-encodes the CDATA'd content, so if
// extractRssItems didn't decode it, entities like &#8217;/&nbsp; would reach every consumer as
// literal, undecoded text forever.
describe('fast-xml-parser does not decode entities inside CDATA (why extractRssItems must)', () => {
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[Reply To: HPQ]]></title>
    <description><![CDATA[<p>I&#8217;m up &amp; running &nbsp; here</p>]]></description>
  </item></channel></rss>`;

  it('leaves entities un-decoded in CDATA even with htmlEntities:true', () => {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true });
    const item = parser.parse(xml).rss.channel.item;
    expect(item.description).toContain('&#8217;');
    expect(item.description).toContain('&nbsp;');
  });

  it('does decode entities in plain (non-CDATA) text nodes with htmlEntities:true', () => {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true });
    const plainXml = '<?xml version="1.0"?><rss><channel><title>A &amp; B &#187; C</title></channel></rss>';
    expect(parser.parse(plainXml).rss.channel.title).toBe('A & B » C');
  });
});
