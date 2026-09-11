import { classifySignal, actionableStrategyFor, FeedKeys } from '../index';

const OPTIONS_PATTERNS = actionableStrategyFor(FeedKeys.optionsInsights).posPatterns;

describe('classifySignal — negative patterns (checked first)', () => {
  test('fail-personal-advice: "in your case"', () => {
    expect(classifySignal('This is fine in your case but not generally')).toBe('fail-personal-advice');
  });

  test('fail-personal-advice: "I\'d personally"', () => {
    expect(classifySignal("Christopher, I'd personally sell half")).toBe('fail-personal-advice');
  });

  test('fail-hypothetical: "we may consider"', () => {
    expect(classifySignal('If it gets to $80 or more, we may consider a sell')).toBe('fail-hypothetical');
  });

  test('fail-hypothetical: "we\'d likely"', () => {
    expect(classifySignal("IF that happened, we'd likely sell around $80-$81ish")).toBe('fail-hypothetical');
  });

  test('fail-hypothetical: "if it should"', () => {
    expect(classifySignal('If it should get to $80 we may act')).toBe('fail-hypothetical');
  });

  // Real false alarm: pass-buy-with-price matched the standalone "enter" + nearby $80 inside an
  // illustrative example explaining a general rule, not a live call.
  test('fail-hypothetical: "for instance, if we enter..." illustrative example, not a live call', () => {
    expect(classifySignal("For instance, if we enter a stock at $80 and someone enters a 1st tranche at $50, they can use the 10% rule.")).toBe('fail-hypothetical');
  });

  test('fail-hypothetical: "for example" also suppresses an otherwise-matching buy-with-price', () => {
    expect(classifySignal("For example, if you enter a position at $80, that changes the math.")).toBe('fail-hypothetical');
  });

  test('fail-historical: "I was urging"', () => {
    expect(classifySignal("Yeah, I was urging everyone to get it while close to $80/averaging down")).toBe('fail-historical');
  });

  // Real reported false positive: restates a contract already given in an earlier post. Would
  // otherwise match pass-options-contract (strike + expiry both present) -- checked against the
  // options pattern set specifically, since that's where this incident occurred.
  test('fail-historical: "see my post above" restates a prior post rather than issuing a new call', () => {
    expect(classifySignal('No, see my post above: March $75 strike put 2027 expiry', OPTIONS_PATTERNS)).toBe('fail-historical');
  });

  test('fail-hypothetical: "could either...or" two-sided hedge', () => {
    expect(classifySignal('Yep, could either tank to an averaging down level (good) or rally after the earnings report with our present tranche (good)')).toBe('fail-hypothetical');
  });

  // #72
  test('fail-generic-practice: "good practice" habitual framing', () => {
    expect(classifySignal("Glad you're in. Yeah, it's good to have both averaging down orders in from the very beginning, after your 1st tranche fills. Just a good practice to get into.")).toBe('fail-generic-practice');
  });

  // #75
  test('fail-generic-practice: "I always say" habitual framing', () => {
    expect(classifySignal("That's why I always say to put in both averaging down orders after your 1st tranche fills. Then you don't have to worry about missing it.")).toBe('fail-generic-practice');
  });

  // #79
  test('fail-negated-instruction: "not buy" negation', () => {
    expect(classifySignal("I'd not encourage entries this high up above 200-day and 200-week moving averages. I'd either hold what you've got or sell some more but not buy anything more. We're ultimately looking to exit at $18ish.")).toBe('fail-negated-instruction');
  });

  // A full real post: a rhetorical aside about consumer purchases ("if you don't buy their
  // product...") used the same negation-adjacent-to-buy shape #79 fixed, but conditional "if you
  // don't" framing describes a hypothetical, not the reader's own position — it shouldn't
  // suppress a genuine tranche-price directive appearing later in the same post.
  test('pass-tranche-price: an unrelated "if you don\'t buy X" aside does not suppress a real directive later in the post', () => {
    expect(classifySignal("So, if you don't buy their product, then you're not funding them. 2nd tranche: $121.")).toBe('pass-tranche-price');
  });

  test('fail-negated-instruction: still fires for a direct declarative negation (not conditional)', () => {
    expect(classifySignal("I'd either hold what you've got or sell some more but not buy anything more.")).toBe('fail-negated-instruction');
  });

  // "You can sell half if you wish" would otherwise match pass-sell-fraction outright —
  // permissive, take-it-or-leave-it framing isn't a directive.
  test('fail-hypothetical: "if you wish" permissive framing suppresses sell-fraction match', () => {
    expect(classifySignal('Good. You can sell half if you wish. Our ultimate target is $18ish.')).toBe('fail-hypothetical');
  });

  test('fail-hypothetical: "nothing wrong with/if" permissive framing', () => {
    expect(classifySignal("There's nothing wrong if you want to sell all, but we're not doing that officially.")).toBe('fail-hypothetical');
  });

  // Third-person variant of the same permissive framing: "wants to choose to" describes an
  // optional individual choice, not a directive, even though "sell half" appears literally.
  test('fail-hypothetical: "wants to choose to" third-person permissive framing', () => {
    expect(classifySignal("If someone is up 20-30% in a short period of time and they want to choose to sell half, they can always do that, even without confirmation from me.")).toBe('fail-hypothetical');
  });

  // No action verb anywhere -- necessary-condition gate resolves this directly.
  test('fail-no-action-verb: no pattern match and no trade-action verb present', () => {
    expect(classifySignal('general portfolio discussion')).toBe('fail-no-action-verb');
  });

  // Real post-deploy false alarm this gate resolves directly: the exact leave-one-out case
  // chased for most of a session, sharing dense topical vocabulary (tranches, moving averages)
  // with a genuine directive elsewhere in the calibration set, but containing no action verb of
  // its own.
  test('fail-no-action-verb: status update with no action verb, despite shared topical vocabulary', () => {
    expect(classifySignal("I'm keeping my eye on it to see if we need to keep it at $145. Our 3rd tranche still doesn't make it down to the lowest shaded zone, but that zone is a mile below the 200-week moving average.")).toBe('fail-no-action-verb');
  });

  // "buy recommendation" is a noun-phrase reference to the historical call, not a live verb --
  // must not falsely clear the gate on the literal string "buy" alone.
  test('fail-no-action-verb: "buy recommendation" does not count as a live action verb', () => {
    expect(classifySignal('All 3 tranches are known from the original buy recommendation in the newsletter.')).toBe('fail-no-action-verb');
  });

  // Real post-deploy false alarm: "Good job. Congrats!" had no other signal, so it reached
  // nearest-neighbor and matched purely on generic congratulatory tone.
  test('fail-acknowledgment: "good job" reacting to a reported outcome, not a directive', () => {
    expect(classifySignal('Good job. Congrats!')).toBe('fail-acknowledgment');
  });

  // "Congrats" alone is deliberately not a marker -- an existing true positive opens with it
  // before the real directive.
  test('pass-sell-fraction: "Congrats" alone does not suppress a real directive that follows', () => {
    expect(classifySignal("Congrats. Earnings on 9/10 after the bell. If you haven't sold half, you might.")).toBe('pass-sell-fraction');
  });

  // Real post-deploy false alarm: "Yes, but it depends on where your last /2nd tranche is." --
  // conditional-on-individual-circumstances framing, same category as "in your case".
  test('fail-personal-advice: "it depends" frames the answer as conditional on the individual', () => {
    expect(classifySignal('Yes, but it depends on where your last 2nd tranche is.')).toBe('fail-personal-advice');
  });

  // #82
  test('fail-hypothetical: "any one of these paths" scenario-branching hedge', () => {
    expect(classifySignal("Because it can still take any one of these paths, you might sell half (since you're up 30%) and keep the rest and that sets you up better in case the lower scenarios unfold.")).toBe('fail-hypothetical');
  });

  // #82
  test('fail-historical: "we\'ve already sold half" retrospective status report', () => {
    expect(classifySignal("Glad you did well, but here's our official stance on it: Since we've already sold half, we're officially still holding what we've got. If it continues higher, great, we'll reap more profits. If it pulls back, great, we can re-establish our half sold around $22ish and if it drops further, great, we can get in averaging downs at $20 and $15. So, we're poised to do well if it rockets higher from here or pulls back, because of how we allocate capital to it and because of how we've managed risks (by selling half).")).toBe('fail-historical');
  });
});

describe('classifySignal — negative patterns override positive matches', () => {
  test('personal-advice suppresses sell-fraction match', () => {
    // "sell half" would match pass-sell-fraction, but personal advice takes priority
    expect(classifySignal("Christopher, I'd personally sell half of your position")).toBe('fail-personal-advice');
  });

  test('historical suppresses averaging-down match', () => {
    // "get your averaging down" would match pass-averaging-down, but historical reference takes priority
    expect(classifySignal("Yeah, I was urging you to get your averaging down orders in near $80")).toBe('fail-historical');
  });
});

describe('classifySignal — positive patterns', () => {
  test('pass-new-pick', () => {
    expect(classifySignal("I've got a new pick for subscribers this month that you need to get into IMMEDIATELY")).toBe('pass-new-pick');
  });

  test('pass-tranche-price: 1st tranche', () => {
    expect(classifySignal('1st Tranche: $210 or below. FQ is trading in the $198s right now.')).toBe('pass-tranche-price');
  });

  test('pass-tranche-price: 3rd tranche', () => {
    expect(classifySignal('3rd Tranche: $145. It may go lower but the upside is huge.')).toBe('pass-tranche-price');
  });

  test('pass-get-in-tranche', () => {
    expect(classifySignal("FQ is SO stretched below its 200-week MA, let's go ahead and ensure we get in our 3rd tranche NOW")).toBe('pass-get-in-tranche');
  });

  test('pass-buy-with-price', () => {
    expect(classifySignal('Buy Quixtol (QTPZ) at the market as long as the stock is at $66 per share or LOWER')).toBe('pass-buy-with-price');
  });

  // A longer company name shouldn't change the result — the gap between the verb and the price is
  // bounded by sentence, not a fixed character count, so this must match exactly like the shorter
  // "Quixtol" case above despite the extra ~20 characters before reaching the price.
  test('pass-buy-with-price: still matches with a longer company name in between', () => {
    expect(classifySignal('Buy Quantum Tech Parts Zone (QTPZ) at the market as long as the stock is at $66 per share or LOWER')).toBe('pass-buy-with-price');
  });

  // The verb and the price sitting in different sentences should NOT match, even though an
  // unbounded character window would happily bridge them — this is what actually motivates
  // "same sentence" over "N characters" as the real discriminator.
  test('fail-no-signal: buy/enter and a price in unrelated sentences do not combine', () => {
    expect(classifySignal("I was chatting about the ask/buy quote mechanics earlier today. Completely unrelated topic: our rent is $1200 this month.")).toBe('fail-no-signal');
  });

  test('pass-sell-fraction', () => {
    expect(classifySignal('With y\'all being up 21%-22% in under 2 trading days, I\'d consider selling half of your remaining half')).toBe('pass-sell-fraction');
  });

  // Past tense: "hasn't sold half" is a real reported phrasing the bare sell(?:ing)? alternation
  // missed entirely (fail-no-signal). The one negative example using "sold half" ("we've already
  // sold half...") is already caught earlier by the more specific fail-historical pattern, so
  // widening the verb form here doesn't risk it.
  test('pass-sell-fraction: past tense "sold half"', () => {
    expect(classifySignal("If anyone hasn't sold half, it's a good time to do that, now, as long as you're up at least 20% or more.")).toBe('pass-sell-fraction');
  });

  test('pass-averaging-down', () => {
    expect(classifySignal('If GHK dips anywhere into the $81ish area, that\'s close enough to get your averaging down')).toBe('pass-averaging-down');
  });

  // #76: a clearer broadcast-framed anchor alongside the existing, more ambiguous case above
  // (that one reads equally well as addressed to one replied-to subscriber or to anyone holding
  // the stock — see #76 for the open "individual vs. broadcast" design question, not resolved here).
  test('pass-averaging-down: explicit broadcast framing', () => {
    expect(classifySignal('Everyone, if it dips into the $81ish area again, that is close enough to get your averaging down orders in.')).toBe('pass-averaging-down');
  });

  // #78 case 3: abstract description of a downturn's general effects, no directive verb anywhere
  // near "averaging down" — the fourth independent real-world false positive on this one pattern.
  test('fail-no-signal: "averaging down" as abstract market commentary, no directive', () => {
    expect(classifySignal("Yep, love those times too, y'all. There will be times when the market downturn gets so strong that it affects most all stocks (including ours). But in some cases, that'll give us averaging down opportunities and higher blended dividend yields while we wait. The good thing is that institutions have to remain mostly invested at all times. Therefore, they've got to look for safer places to hide out. And our type of stocks meet that criteria.")).toBe('fail-no-signal');
  });

  // #78 case 3's other gap: "leave ... in place" describes the status quo, no change, and still
  // has no directive verb near "averaging down" — now also fixed by the same tightened pattern.
  test('fail-no-signal: "averaging down" describing an unchanged status quo', () => {
    expect(classifySignal("Yes, if it goes back to $22ish, you can put back on what you sold. Correct. And we'd leave present averaging down orders in place.")).toBe('fail-no-signal');
  });

  test('pass-immediately', () => {
    expect(classifySignal('You need to get into this position IMMEDIATELY and not delay.')).toBe('pass-immediately');
  });

  // Deliberately generous, unlike the rest of this pattern list -- see its comment in index.ts.
  // This text carries no other pattern's trigger (no "sell"/"buy"/"tranche"/"averaging down"), so
  // it isolates pass-close-enough specifically rather than incidentally passing via a different
  // pattern that happens to also be present.
  test('pass-close-enough', () => {
    expect(classifySignal('The setup looks close enough now that I think we should move on it.')).toBe('pass-close-enough');
  });

  // Real reported miss: pass-get-in-tranche assumes "get in [object] tranche" word order and
  // doesn't match the equally natural reversed order "get [object] in ... now". Isolated the same
  // way as pass-close-enough above -- no other pattern's trigger word present.
  test('pass-get-now: catches the split "get [object] in ... now" word order pass-get-in-tranche misses', () => {
    expect(classifySignal("Just to make sure we don't miss it, let's go ahead and get our 2nd tranche in now. It's in the high-$121's.")).toBe('pass-get-now');
  });

  test('pass-get-now: does not depend on "tranche" -- any "get ... now" immediacy framing', () => {
    expect(classifySignal("Let's get our shares now while the price is right.")).toBe('pass-get-now');
  });

  // #73: price mentioned before the buy/enter verb (re-entry phrasing) now matches too
  test('pass-buy-with-price: price-then-enter re-entry phrasing', () => {
    expect(classifySignal("MNP hit $41 for a split second but that was probably on the bid/sell quote and not the ask/buy quote, would be my assumption. If it gets back fairly close to $41ish again, you can enter if you didn't get filled already.")).toBe('pass-buy-with-price');
  });

  // #78 case 2: true-positive anchor, kept passing so future NEG_PATTERNS tightening doesn't
  // start suppressing it.
  test('pass-sell-fraction: #78 anchor — "close enough now" immediacy', () => {
    expect(classifySignal("In fact, it's close enough now to $28ish, that I'd SELL HALF here/now.")).toBe('pass-sell-fraction');
  });

  // #78 case 5: true-positive anchor — a genuine present-tense directive up front, even though
  // followed by retrospective color commentary in the same style as #78's case-4 false positive.
  test('pass-sell-fraction: #78 anchor — directive followed by retrospective color', () => {
    expect(classifySignal("You can sell half now. We'll eye it a lot closer between $90ish and $100ish. Also, its got earnings coming out on 8/05 before the bell.")).toBe('pass-sell-fraction');
  });

  test('fail-no-action-verb: general discussion, no trade-action verb present', () => {
    expect(classifySignal('Warren Buffett talks about how the world is yours if you can keep your head about you when others lose theirs')).toBe('fail-no-action-verb');
  });

  // #82: true-positive anchor — direct "sell half" instruction, kept passing so future
  // NEG_PATTERNS tightening doesn't start suppressing it.
  test('pass-sell-fraction: #82 anchor — "sell half" ahead of an earnings date', () => {
    expect(classifySignal("If you've not done a \"sell half\" on VNP yet and you're up 20%+, I'd go ahead and do that now, with them reporting earnings tomorrow before the bell and we don't know if it'll rally or sell-off, near-term.")).toBe('pass-sell-fraction');
  });

  // #82: missed alert — "sell it all" has a pronoun between the verb and the fraction word,
  // which the original bare-adjacency regex missed entirely (fail-no-signal).
  test('pass-sell-fraction: "sell it all" with an intervening pronoun', () => {
    expect(classifySignal("No prob. Also, if VNP gets to $90-$91ish, I'm fine for us to officially sell it all, We'd be up minimally 30%, for those who only got in one tranche. For those who got in two tranches, it's even more.")).toBe('pass-sell-fraction');
  });
});

describe('classifySignal — Options Insights pattern set (actionableStrategyFor)', () => {
  test('pass-options-contract: strike + put + literal "expiry" together, no verb required', () => {
    expect(classifySignal('Yes, correct. JCI PUT MAR 2026 $95 strike, 2026 expiry.', OPTIONS_PATTERNS)).toBe('pass-options-contract');
  });

  test('pass-options-contract: strike + call + month/year expiry, no literal "expiry" word', () => {
    expect(classifySignal('Yes, correct. JCI CALL MAR 2026 $95 strike', OPTIONS_PATTERNS)).toBe('pass-options-contract');
  });

  test('pass-options-contract: strike/put/expiry split across sentences still matches', () => {
    expect(classifySignal('The January $90 strike put has enough liquidity for our purposes. 2026 expiry. It can be entered now.', OPTIONS_PATTERNS)).toBe('pass-options-contract');
  });

  test('a bare 4-digit year does not satisfy the expiry token on its own', () => {
    expect(classifySignal('WMB down 4% in 2026, still holding the $95 strike put.', OPTIONS_PATTERNS)).not.toBe('pass-options-contract');
  });

  test('educational content about strike/put mechanics, with no expiry mentioned, is not a contract signal', () => {
    expect(classifySignal("The put's strike price and the buy/sell price are two different things.", OPTIONS_PATTERNS)).not.toBe('pass-options-contract');
  });

  test('stock-pick vocabulary ("new pick") is not recognized against the options pattern set', () => {
    expect(classifySignal("I've got a new pick for subscribers this month.", OPTIONS_PATTERNS)).not.toBe('pass-new-pick');
  });

  test('"capture profits" clears the action-verb gate and reaches the ambiguous bucket instead of failing outright', () => {
    const result = classifySignal('Anyone else up a quick 20% in such a short time can capture profits as well.', OPTIONS_PATTERNS);
    expect(result).not.toBe('fail-no-action-verb');
  });

  test('"buy to open"/"buy-to-open" mechanics explanations resolve to fail-no-signal, not a false positive', () => {
    // Options Insights has no pass-buy-with-price pattern at all (that's stock-pick vocabulary),
    // so a $ near "buy" here can't resolve as a definitive positive regardless.
    const result = classifySignal('$9.89 would be 25% up from your buy to open price. If you bought and the contract filled, then the ask quote/price hit your buy-to-open buy limit order.', OPTIONS_PATTERNS);
    expect(result).toBe('fail-no-signal');
  });
});
