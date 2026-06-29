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
    expect(classifySignal(pad('1st Tranche: $210 or below. ACN is trading in the $198s right now.'), MIN)).toBe('pass-tranche-price');
  });

  test('pass-tranche-price: 3rd tranche', () => {
    expect(classifySignal(pad('3rd Tranche: $145. It may go lower but the upside is huge.'), MIN)).toBe('pass-tranche-price');
  });

  test('pass-get-in-tranche', () => {
    expect(classifySignal(pad("ACN is SO stretched below its 200-week MA, let's go ahead and ensure we get in our 3rd tranche NOW"), MIN)).toBe('pass-get-in-tranche');
  });

  test('pass-buy-with-price', () => {
    expect(classifySignal(pad('Buy Best Buy (BBY) at the market as long as the stock is at $66 per share or LOWER'), MIN)).toBe('pass-buy-with-price');
  });

  test('pass-sell-fraction', () => {
    expect(classifySignal(pad('With y\'all being up 21%-22% in under 2 trading days, I\'d consider selling half of your remaining half'), MIN)).toBe('pass-sell-fraction');
  });

  test('pass-averaging-down', () => {
    expect(classifySignal(pad('If FXY dips anywhere into the $81ish area, that\'s close enough to get your averaging down'), MIN)).toBe('pass-averaging-down');
  });

  test('pass-immediately', () => {
    expect(classifySignal(pad('You need to get into this position IMMEDIATELY and not delay.'), MIN)).toBe('pass-immediately');
  });

  test('fail-no-signal: general discussion', () => {
    expect(classifySignal(pad('Warren Buffett talks about how the world is yours if you can keep your head about you when others lose theirs'), MIN)).toBe('fail-no-signal');
  });
});
