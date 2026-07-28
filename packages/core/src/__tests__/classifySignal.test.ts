import { classifySignal } from '../index';

const MIN = 200;

function pad(s: string): string {
  return s.padEnd(MIN + 1, ' .');
}

describe('classifySignal — negative patterns (checked first)', () => {
  test('fail-personal-advice: "in your case"', () => {
    expect(classifySignal(pad('This is fine in your case but not generally'), MIN)).toBe('fail-personal-advice');
  });

  test('fail-personal-advice: "I\'d personally"', () => {
    expect(classifySignal(pad("Christopher, I'd personally sell half"), MIN)).toBe('fail-personal-advice');
  });

  test('fail-hypothetical: "we may consider"', () => {
    expect(classifySignal(pad('If it gets to $80 or more, we may consider a sell'), MIN)).toBe('fail-hypothetical');
  });

  test('fail-hypothetical: "we\'d likely"', () => {
    expect(classifySignal(pad("IF that happened, we'd likely sell around $80-$81ish"), MIN)).toBe('fail-hypothetical');
  });

  test('fail-hypothetical: "if it should"', () => {
    expect(classifySignal(pad('If it should get to $80 we may act'), MIN)).toBe('fail-hypothetical');
  });

  test('fail-historical: "I was urging"', () => {
    expect(classifySignal(pad("Yeah, I was urging everyone to get it while close to $80/averaging down"), MIN)).toBe('fail-historical');
  });

  test('fail-hypothetical: "could either...or" two-sided hedge', () => {
    expect(classifySignal(pad('Yep, could either tank to an averaging down level (good) or rally after the earnings report with our present tranche (good)'), MIN)).toBe('fail-hypothetical');
  });

  // #72
  test('fail-generic-practice: "good practice" habitual framing', () => {
    expect(classifySignal(pad("Glad you're in. Yeah, it's good to have both averaging down orders in from the very beginning, after your 1st tranche fills. Just a good practice to get into."), MIN)).toBe('fail-generic-practice');
  });

  // #75
  test('fail-generic-practice: "I always say" habitual framing', () => {
    expect(classifySignal(pad("That's why I always say to put in both averaging down orders after your 1st tranche fills. Then you don't have to worry about missing it."), MIN)).toBe('fail-generic-practice');
  });

  // #79
  test('fail-negated-instruction: "not buy" negation', () => {
    expect(classifySignal(pad("I'd not encourage entries this high up above 200-day and 200-week moving averages. I'd either hold what you've got or sell some more but not buy anything more. We're ultimately looking to exit at $18ish."), MIN)).toBe('fail-negated-instruction');
  });

  test('fail-too-short: no pattern match and below minLength', () => {
    expect(classifySignal('general portfolio discussion', MIN)).toBe('fail-too-short');
  });
});

describe('classifySignal — negative patterns override positive matches', () => {
  test('personal-advice suppresses sell-fraction match', () => {
    // "sell half" would match pass-sell-fraction, but personal advice takes priority
    expect(classifySignal(pad("Christopher, I'd personally sell half of your position"), MIN)).toBe('fail-personal-advice');
  });

  test('historical suppresses averaging-down match', () => {
    // "averaging down" would match pass-averaging-down, but historical reference takes priority
    expect(classifySignal(pad("Yeah, I was urging everyone to get it because of averaging down near $80"), MIN)).toBe('fail-historical');
  });
});

describe('classifySignal — positive patterns', () => {
  test('pass-new-pick', () => {
    expect(classifySignal(pad("I've got a new pick for subscribers this month that you need to get into IMMEDIATELY"), MIN)).toBe('pass-new-pick');
  });

  test('pass-tranche-price: 1st tranche', () => {
    expect(classifySignal(pad('1st Tranche: $210 or below. FQ is trading in the $198s right now.'), MIN)).toBe('pass-tranche-price');
  });

  test('pass-tranche-price: 3rd tranche', () => {
    expect(classifySignal(pad('3rd Tranche: $145. It may go lower but the upside is huge.'), MIN)).toBe('pass-tranche-price');
  });

  test('pass-get-in-tranche', () => {
    expect(classifySignal(pad("FQ is SO stretched below its 200-week MA, let's go ahead and ensure we get in our 3rd tranche NOW"), MIN)).toBe('pass-get-in-tranche');
  });

  test('pass-buy-with-price', () => {
    expect(classifySignal(pad('Buy QTPZ at the market as long as the stock is at $66 per share or LOWER'), MIN)).toBe('pass-buy-with-price');
  });

  test('pass-sell-fraction', () => {
    expect(classifySignal(pad('With y\'all being up 21%-22% in under 2 trading days, I\'d consider selling half of your remaining half'), MIN)).toBe('pass-sell-fraction');
  });

  test('pass-averaging-down', () => {
    expect(classifySignal(pad('If GHK dips anywhere into the $81ish area, that\'s close enough to get your averaging down'), MIN)).toBe('pass-averaging-down');
  });

  // #76: a clearer broadcast-framed anchor alongside the existing, more ambiguous case above
  // (that one reads equally well as addressed to one replied-to subscriber or to anyone holding
  // the stock — see #76 for the open "individual vs. broadcast" design question, not resolved here).
  test('pass-averaging-down: explicit broadcast framing', () => {
    expect(classifySignal(pad('Everyone, if it dips into the $81ish area again, that is close enough to get your averaging down orders in.'), MIN)).toBe('pass-averaging-down');
  });

  test('pass-immediately', () => {
    expect(classifySignal(pad('You need to get into this position IMMEDIATELY and not delay.'), MIN)).toBe('pass-immediately');
  });

  // #73: price mentioned before the buy/enter verb (re-entry phrasing) now matches too
  test('pass-buy-with-price: price-then-enter re-entry phrasing', () => {
    expect(classifySignal(pad("MNP hit $41 for a split second but that was probably on the bid/sell quote and not the ask/buy quote, would be my assumption. If it gets back fairly close to $41ish again, you can enter if you didn't get filled already."), MIN)).toBe('pass-buy-with-price');
  });

  // #78 case 2: true-positive anchor, kept passing so future NEG_PATTERNS tightening doesn't
  // start suppressing it — only 70 chars, correctly fires because 'actionable' never checks length.
  test('pass-sell-fraction: #78 anchor — "close enough now" immediacy', () => {
    expect(classifySignal("In fact, it's close enough now to $28ish, that I'd SELL HALF here/now.", MIN)).toBe('pass-sell-fraction');
  });

  // #78 case 5: true-positive anchor — a genuine present-tense directive up front, even though
  // followed by retrospective color commentary in the same style as #78's case-4 false positive.
  test('pass-sell-fraction: #78 anchor — directive followed by retrospective color', () => {
    expect(classifySignal(pad("You can sell half now. We'll eye it a lot closer between $90ish and $100ish. Also, its got earnings coming out on 8/05 before the bell."), MIN)).toBe('pass-sell-fraction');
  });

  test('fail-no-signal: general discussion', () => {
    expect(classifySignal(pad('Warren Buffett talks about how the world is yours if you can keep your head about you when others lose theirs'), MIN)).toBe('fail-no-signal');
  });
});
