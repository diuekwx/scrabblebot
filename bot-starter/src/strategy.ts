// Bidding and word-play policy, on top of the valuation in ./engine.ts.
//
// The idea: score is total word rewards, and coins are only worth what they
// buy. A coin is worth some points (`pointsPerCoin`), so a tile the bot
// still has to buy costs its market price in points, and a letter is worth
// the points it adds to the best word the rack can reach (engine `outlook`).
// Bids turn that back into coins. Coins left at the end are wasted, so the
// richer the bot is for the auctions left, the less a coin is worth and the
// higher it bids. Words of 7+ letters get the top 3x multiplier, so shorter
// words are held back until late in the match.

import {
  closingNeeds,
  dump,
  letterIndex,
  outlook,
  playable,
  total,
  without,
  type Counts,
  type Lexicon,
  type Outlook,
  type Word,
} from "./engine.js";

export interface Params {
  // Upcoming auctions the outlook looks across, at most.
  horizon: number;
  // Share of upcoming auctions the bot expects to win.
  winRate: number;
  // Most tiles the outlook assumes the bot can buy.
  maxBuys: number;
  // The outlook also assumes no more buys than the balance covers at this
  // many coins a tile (0: no such limit).
  coinsPerBuy: number;
  // A rack shorter than this plans enough buys, over enough auctions, to
  // reach a word this long (0: plan only `maxBuys`).
  buildTo: number;
  // How much more a word is worth for each share of the match still to
  // come: its reward comes back as coins that buy more tiles, which a word
  // finished on the last auction can't do. 0.4 makes a word at the start
  // worth 1.4x, falling to 1x at the end. Off: at 0.4 it inflated high
  // letters most, and in 3 live games the bot overpaid for Z, X and Y,
  // won 6-9 tiles and placed 6th, 6th and 5th.
  reinvest: number;
  // A tile that doesn't let the bot play a 7+ letter word straight away is
  // speculation: bid at most this many times its market price at this
  // point in the match (0: no cap).
  speculativeCap: number;
  // Over the last `lateSpecWindow` auctions the cap shrinks in proportion
  // to the auctions left: with no time to build around it, a Z is worth
  // little whatever it sells for. (With 5 left and only an S, the bot bid
  // 50 on a Z, paid 30, and never used it.)
  lateSpecWindow: number;
  // Winners take about `tilePace` tiles a match. Between `boostFrom` and
  // `boostTo` auctions left, when tiles are cheapest, a bot behind that
  // pace bids `tilePaceBoost` more (0.3 = 30% more) on letters it values:
  // at its usual bids it lost most mid-match tiles by a few coins.
  tilePace: number;
  tilePaceBoost: number;
  boostFrom: number;
  boostTo: number;
  samples: number;
  // Points a coin is worth, before pacing.
  pointsPerCoin: number;
  // What winning a tile of each letter costs, in coins, A to Z.
  prices: readonly number[];
  // How prices move over a match: the multiplier on `prices` for an
  // auction with k auctions after it is `phase[k]`.
  phase: readonly number[];
  // How much of `phase` to apply: 0 for flat prices, 1 for all of it.
  phaseStrength: number;
  // Coins per remaining auction the bot expects to spend; pacing compares
  // the balance against this.
  spendRate: number;
  // Bounds on the pacing multiplier.
  paceMin: number;
  paceMax: number;
  // Coins kept back per tile the rack is still short of a 7-letter word,
  // so one big bid can't leave the bot unable to finish anything.
  reservePerTile: number;
  // Most of the balance one bid may be.
  maxBidShare: number;
  // A word under 7 letters is played only in the last `shortWordWindow`
  // auctions, and only when playing it beats holding by `holdMargin`, a
  // fraction that shrinks to 0 as the match ends.
  shortWordWindow: number;
  holdMargin: number;
  // With `cashInBalance` coins or fewer the bot can't buy its way to a
  // longer word, so it plays its best word worth `cashInReward` or more
  // whenever it has one, and spends the reward on more tiles.
  cashInBalance: number;
  cashInReward: number;
  // Samples for deciding whether to play a short word, which takes several
  // outlooks: fewer than for bids, since nothing waits on the answer.
  playSamples: number;
  // Endgame chase: in the last `chaseWindow` auctions, points that tie or
  // pass the next bot up are worth a whole place, far more than they are as
  // points. (Match 1014 ended 9 behind 1st with 37 coins; TIME, +9, was
  // there to buy.) A tile that leaves a gap-closing word 0, 1 or 2 tiles
  // away gets a bid of up to that share of the balance, in `chaseShares`,
  // and a playable gap-closer is played at once.
  chaseWindow: number;
  chaseShares: readonly number[];
  // Coins a chase keeps back for each tile its word still needs after this
  // one: about a late-match common letter.
  chaseRestCost: number;
  // With no one to catch, or no way to catch them, coins left are still
  // worth nothing at the end: chase any word worth this much. (Leading in
  // match 1077, the bot sat on 52 coins for its last 8 auctions and was
  // passed.)
  endgameTarget: number;
}

// Median price to beat per letter (the best bid of the other five bots)
// over 122 lobby matches of real bots, 330-451, leaving out the last two
// auctions of each match: roughly what it takes to outbid the field.
export const MARKET_PRICES: readonly number[] = [
  13, 19, 21, 16, 14, 23, 15, 26, 13, 33, 28, 13, 20, 13, 12, 20, 36, 14, 15,
  12, 13, 21, 20, 37, 26, 44,
];

// Price to beat relative to the letter's median, by auctions left after
// the auction (index 0 is the last auction), from the same matches,
// smoothed over 5 auctions. Openings run ~17% dear, auctions 18-55 ~8%
// cheap, and 56-65 dear again as several bots dump their coins; nobody
// wants the last tile, which can't be played.
export const PRICE_PHASE: readonly number[] = [
  0.15, 1.08, 1.17, 1.19, 1.17, 1.19, 1.15, 1.15, 1.15, 1.15, 1.08, 1.06, 1, 1,
  0.95, 0.93, 0.93, 0.95, 0.94, 0.94, 0.95, 0.95, 0.95, 0.95, 0.93, 0.92, 0.92,
  0.92, 0.91, 0.91, 0.92, 0.92, 0.92, 0.92, 0.92, 0.92, 0.92, 0.92, 0.93, 0.93,
  0.95, 0.95, 0.93, 0.93, 0.93, 0.93, 0.93, 0.93, 0.94, 0.96, 1, 1, 1, 1, 1, 1,
  1.06, 1.07, 1.08, 1.09, 1.11, 1.14, 1.15, 1.15, 1.17, 1.17, 1.18, 1.17,
];

// The phase multiplier for an auction with `left` auctions after it.
function phaseAt(left: number, params: Params): number {
  const k = Math.min(left, params.phase.length - 1);
  return 1 + params.phaseStrength * (params.phase[k]! - 1);
}

// The average phase multiplier over the auctions a purchase could come from.
function phaseOver(
  auctionsLeft: number,
  horizon: number,
  params: Params,
): number {
  if (horizon <= 0 || params.phaseStrength === 0) return 1;
  const { phase } = params;
  let sum = 0;
  for (let k = auctionsLeft - 1; k >= auctionsLeft - horizon; k--) {
    sum += phase[Math.min(k, phase.length - 1)]!;
  }
  return 1 + params.phaseStrength * (sum / horizon - 1);
}

export const DEFAULT_PARAMS: Params = {
  horizon: 12,
  winRate: 0.3,
  maxBuys: 3,
  coinsPerBuy: 0,
  buildTo: 7,
  reinvest: 0,
  speculativeCap: 1,
  lateSpecWindow: 15,
  tilePace: 15,
  tilePaceBoost: 0.3,
  boostFrom: 49,
  boostTo: 12,
  samples: 80,
  pointsPerCoin: 0.5,
  prices: MARKET_PRICES,
  phase: PRICE_PHASE,
  phaseStrength: 1,
  spendRate: 1.5,
  paceMin: 0.6,
  paceMax: 8,
  reservePerTile: 0,
  maxBidShare: 1,
  shortWordWindow: 20,
  holdMargin: 0.5,
  cashInBalance: 25,
  cashInReward: 15,
  playSamples: 30,
  chaseWindow: 8,
  chaseShares: [1, 0.6, 0.35],
  chaseRestCost: 16,
  endgameTarget: 8,
};

// Points needed to tie the next bot up, in the last few auctions, or
// undefined when there's no one to catch or it's too early to chase. Ties
// share the better place.
export function chaseGap(
  view: MatchView,
  params: Params = DEFAULT_PARAMS,
): number | undefined {
  if (!view.scores || view.auctionsLeft > params.chaseWindow) return undefined;
  const { mine, others } = view.scores;
  let next = Infinity;
  for (const s of others) if (s > mine && s < next) next = s;
  return next === Infinity ? undefined : next - mine;
}

// The points the endgame goes after: the gap to the next bot up, or, with
// no one above, `endgameTarget`. Undefined outside the endgame.
export function endgameGoal(
  view: MatchView,
  params: Params = DEFAULT_PARAMS,
): number | undefined {
  if (!view.scores || view.auctionsLeft > params.chaseWindow) return undefined;
  return chaseGap(view, params) ?? params.endgameTarget;
}

// Coins are worth less the more the bot has per auction left to spend them.
function pace(view: MatchView, params: Params): number {
  const perAuction = view.balance / (view.auctionsLeft + 1);
  return Math.min(
    params.paceMax,
    Math.max(params.paceMin, perAuction / params.spendRate),
  );
}

function pointsPerCoin(view: MatchView, params: Params): number {
  return params.pointsPerCoin / pace(view, params);
}

// What a word's reward is worth now, per point: more early in the match,
// when the coins it returns can still buy tiles for more words.
function reinvestment(view: MatchView, params: Params): number {
  const matchLength = params.phase.length - 1;
  return 1 + params.reinvest * Math.min(1, view.auctionsLeft / matchLength);
}

export interface MatchView {
  rack: Counts;
  // Tiles not yet seen this match, that later auctions could reveal.
  pool: Counts;
  // Auctions still to come after the open one (0: the open one is last).
  auctionsLeft: number;
  balance: number;
  // Tiles won at auction so far this match.
  tilesWon?: number;
  // Live scores, when known: this bot's and its opponents'.
  scores?: { mine: number; others: readonly number[] };
}

export function outlookFor(
  lex: Lexicon,
  view: MatchView,
  params: Params = DEFAULT_PARAMS,
  rng?: () => number,
): Outlook {
  let horizon = Math.min(params.horizon, view.auctionsLeft);
  let buys = Math.min(params.maxBuys, Math.round(horizon * params.winRate));
  // Three buys from a nearly empty rack only reach short words, which pay
  // less than their tiles cost, so every tile would look worthless: after
  // its first word the bot once bid 0 for 14 auctions holding 118 coins.
  // Plan instead to rebuild a long word, over as many auctions as winning
  // its tiles should take.
  // Only while there's time to win that many tiles, though: with 8
  // auctions left, planning 7 buys crowded the reachable short words out
  // of the search, so every tile looked worthless and a leading bot sat on
  // 52 coins while it was passed (match 1077).
  const toBuild = params.buildTo - total(view.rack);
  const canWin = Math.round(view.auctionsLeft * params.winRate) + 1;
  if (toBuild > buys && toBuild <= canWin) {
    horizon = Math.min(
      view.auctionsLeft,
      Math.max(horizon, Math.ceil(toBuild / params.winRate)),
    );
    buys = Math.min(toBuild, horizon);
  }
  // A broke bot can't buy the rest of a word, so it shouldn't hold out for
  // one. (With 10 coins it once sat on EEGPQRU for 20 auctions waiting for
  // a long Q word, then played QUEER at the very end.)
  if (params.coinsPerBuy > 0) {
    buys = Math.min(buys, Math.floor(view.balance / params.coinsPerBuy));
  }
  // Tiles still to buy will come from the next `horizon` auctions, at
  // those auctions' prices.
  const ppc =
    pointsPerCoin(view, params) * phaseOver(view.auctionsLeft, horizon, params);
  // Rewards worth `boost` each point now: the same as tiles costing
  // 1/boost as much, with every value then scaled back up by `boost`.
  const boost = reinvestment(view, params);
  const look = outlook(
    lex,
    view.rack,
    view.pool,
    {
      horizon,
      buys,
      samples: params.samples,
      cost: params.prices.map((p) => (p * ppc) / boost),
    },
    rng,
  );
  // A tile won now can be played in any later auction, so a gap-closing
  // word can take this tile plus one from each auction but the last. If
  // the rack already spells enough, playing it closes the gap and there's
  // nothing to chase. (Late in a match the bid goes out before the play.)
  const goal = endgameGoal(view, params);
  const closedAlready =
    goal !== undefined &&
    dump(lex, view.rack).reduce((s, w) => s + w.reward, 0) >= goal;
  const maxNeed = Math.min(params.chaseShares.length, view.auctionsLeft);
  let chaseNeeds =
    goal === undefined || closedAlready
      ? undefined
      : closingNeeds(lex, view.rack, view.pool, goal, maxNeed);
  // A gap no word can close still leaves coins to turn into points.
  if (
    chaseNeeds &&
    goal! > params.endgameTarget &&
    chaseNeeds.every((n) => n >= params.chaseShares.length)
  ) {
    chaseNeeds = closingNeeds(
      lex,
      view.rack,
      view.pool,
      params.endgameTarget,
      maxNeed,
    );
  }
  return {
    hold: look.hold * boost,
    letterValue: look.letterValue.map((v) => v * boost),
    completes: look.completes,
    chaseNeeds,
  };
}

// How much to bid for `letter`. `look` is the outlook for this view, before
// the letter is won.
export function bidFor(
  view: MatchView,
  letter: string,
  look: Outlook,
  params: Params = DEFAULT_PARAMS,
): number {
  // The match ends as the last auction closes, before its tile can be played.
  if (view.auctionsLeft <= 0) return 0;
  const l = letterIndex(letter);
  const value = look.letterValue[l] ?? 0;
  let bid = Math.round(value / pointsPerCoin(view, params));
  // Behind a winner's pace for tiles in the cheap middle of the match:
  // bid harder on what it wants. (The cap below still holds speculation to
  // market price.)
  const left = view.auctionsLeft;
  if (
    params.tilePaceBoost > 0 &&
    view.tilesWon !== undefined &&
    value > 0 &&
    left <= params.boostFrom &&
    left >= params.boostTo
  ) {
    const matchLength = params.phase.length;
    const elapsed = matchLength - 1 - left;
    if (view.tilesWon < (params.tilePace * elapsed) / matchLength) {
      // Not into cash-in range, though: spending down to there made the
      // bot cash in 4-5 letter words mid-match, over and over, instead of
      // building 7-letter ones (3 of 10 words long, against 18 of 26).
      const spare = view.balance - params.cashInBalance;
      const boosted = Math.round(bid * (1 + params.tilePaceBoost));
      bid = Math.max(bid, Math.min(boosted, spare));
    }
  }
  // A tile that only might fit a word later is worth no more than what it
  // usually costs: bidding past that bought high letters that never got
  // played, leaving too few coins for the letters the rack needed.
  const market = Math.round(params.prices[l]! * phaseAt(left, params));
  if (params.speculativeCap > 0) {
    if (!look.completes[l]) {
      const late = Math.min(1, left / params.lateSpecWindow);
      const cap = params.speculativeCap * market * late;
      bid = Math.min(bid, Math.round(cap));
    }
  }
  // Endgame chase, after the cap: a tile that brings a place-gaining word
  // within reach is worth more than its price, and coins left at the end
  // are worth nothing. The rest of the word must still come from auctions
  // before the last one.
  // At least the tile's going price, or the bid just loses: a share of a
  // late balance (often 20-40 coins) came to 7-18 against tiles clearing
  // at 12-20. But keep enough for the word's other tiles.
  const rest = look.chaseNeeds?.[l];
  if (rest !== undefined && rest < params.chaseShares.length && rest <= left - 1) {
    const share = Math.floor(view.balance * params.chaseShares[rest]!);
    const forRest = view.balance - rest * params.chaseRestCost;
    bid = Math.max(bid, Math.min(Math.max(share, market), forRest));
  }
  // Pacing makes coins look cheap whenever the bot is flush, but the
  // letter is only worth `value` if the bot can still buy the rest of the
  // word. Keep enough back for the tiles it would still lack, given this
  // one. (An empty rack bidding 84 on a Z once left it 4 coins for the
  // last 26 auctions.)
  const short = Math.min(
    view.auctionsLeft,
    Math.max(0, 7 - (total(view.rack) + 1)),
  );
  const affordable = Math.min(
    view.balance - params.reservePerTile * short,
    Math.floor(view.balance * params.maxBidShare),
  );
  return Math.max(0, Math.min(bid, affordable, view.balance));
}

// Words to play now, in order. Each is spelled from what the previous ones
// leave on the rack.
export function choosePlays(
  lex: Lexicon,
  view: MatchView,
  params: Params = DEFAULT_PARAMS,
  rng?: () => number,
): Word[] {
  if (view.auctionsLeft <= 0) return dump(lex, view.rack);
  const plays: Word[] = [];
  let rack = view.rack;
  let scores = view.scores;
  for (let n = 0; n < 4; n++) {
    const word = choosePlay(lex, { ...view, rack, scores }, params, rng);
    if (!word) break;
    plays.push(word);
    rack = without(rack, word);
    if (scores) scores = { ...scores, mine: scores.mine + word.reward };
  }
  return plays;
}

function choosePlay(
  lex: Lexicon,
  view: MatchView,
  params: Params,
  rng?: () => number,
): Word | undefined {
  const words = playable(lex, view.rack);
  if (words.length === 0) return undefined;
  const boost = reinvestment(view, params);
  // A 7+ letter word already earns the top multiplier: play one now. Of
  // several, take the one worth most net of the tiles it uses up, at what
  // they'd cost to buy back: a tile kept saves a purchase. (Comparing
  // full outlooks of the leftovers instead once held a bid back 421 ms.)
  const long = words.filter((w) => w.text.length >= 7);
  if (long.length > 0) {
    const ppc = pointsPerCoin(view, params);
    let best = long[0]!;
    let bestValue = -Infinity;
    for (const w of long) {
      let value = w.reward * boost;
      for (const l of w.letters) value -= params.prices[l]! * ppc;
      if (value > bestValue) {
        best = w;
        bestValue = value;
      }
    }
    return best;
  }

  // Endgame chase: if what the rack spells now ties or passes the next bot
  // up, play it rather than hold out for more and risk the match ending.
  // (Leading, there's no place to lock in, so the usual rules decide: they
  // won't trade QUARTE's shot at QUARTET for QUART.)
  const gap = chaseGap(view, params);
  if (gap !== undefined) {
    const now = dump(lex, view.rack);
    if (now.reduce((s, w) => s + w.reward, 0) >= gap) return now[0];
  }

  // Broke, the bot can't buy the tiles a longer word needs, so holding out
  // for one just freezes it: in 15 of 22 live cases its last word had been
  // spellable for up to 45 auctions, and it was played when its reward
  // could no longer buy anything. Cash in, unless one tile it can still
  // afford would finish a 7-letter word.
  const cashIn = words[0]!;
  // At or below: the boost stops at exactly `cashInBalance`, so with `<`
  // a bot sitting on that balance neither bid harder nor cashed in (it
  // held FLEYS for 27 auctions on exactly 25 coins).
  if (view.balance <= params.cashInBalance && cashIn.reward >= params.cashInReward) {
    const oneShort =
      total(view.rack) >= 6 &&
      outlookFor(lex, view, { ...params, samples: 1 }, rng).completes.some(
        (c, l) => c === 1 && view.balance >= params.prices[l]!,
      );
    if (!oneShort) return cashIn;
  }
  if (view.auctionsLeft > params.shortWordWindow) return undefined;

  // Otherwise play only if the word plus what the rest can still become
  // clearly beats holding everything for a longer word. This takes several
  // outlooks, so it samples less than a bid does.
  params = { ...params, samples: params.playSamples };
  const hold = outlookFor(lex, view, params, rng).hold;
  const margin =
    params.holdMargin * Math.min(1, view.auctionsLeft / params.shortWordWindow);
  let best: Word | undefined;
  let bestValue = hold * (1 + margin);
  for (const w of words.slice(0, 3)) {
    const rest = without(view.rack, w);
    const value =
      w.reward * boost +
      outlookFor(lex, { ...view, rack: rest }, params, rng).hold;
    if (value > bestValue) {
      best = w;
      bestValue = value;
    }
  }
  return best;
}
