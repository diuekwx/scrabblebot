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
  // While rebuilding that way, a coin counts as at most this many points
  // (0: no cap; see `pointsPerCoin`).
  rebuildPointsPerCoin: number;
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
  // With more than `cheapLongLeft` auctions left, a best long word worth
  // under `cheapLongReward` is played only if that beats holding for a
  // better one (0: always play). Games whose first long word was under 40
  // averaged ~4th place; over 50, ~2nd.
  cheapLongReward: number;
  cheapLongLeft: number;
  // With more than `holdLongLeft` auctions left, a 7+ letter word waits
  // until the rack holds `holdLongRack` tiles (0: off), as bro and Ambees
  // do: neither plays before auction 17, and both sit on 8-9 tiles through
  // mid-match, against coconut's ~4.4 (live matches 8333-12447).
  holdLongRack: number;
  holdLongLeft: number;
  // A wanted letter bid at `focusFrom` or more of its market price, but
  // under it, is raised to market + 1 (0: off). Mid-match the bot lost a
  // quarter of the auctions it bid on by 2 coins or less.
  focusFrom: number;
  // With no one to catch, or no way to catch them, coins left are still
  // worth nothing at the end: chase any word worth this much. (Leading in
  // match 1077, the bot sat on 52 coins for its last 8 auctions and was
  // passed.)
  endgameTarget: number;
  // First-price auctions (the winner pays its own bid, not the runner-up's;
  // a tournament can be set up that way): a bid at or under the market
  // price is shaded to `firstPriceShade` of itself, and the part of a bid
  // above market is cut to `firstPriceExcess` of itself. Bidding the whole
  // value pays the whole value: coconut bids ~17 a tile where it pays ~14.
  // (0: bid as if second-price.)
  firstPriceShade: number;
  firstPriceExcess: number;
  // Play the endgame for what the tournament stage scores (see
  // `Objective`) rather than always for place.
  stageObjectives: boolean;
}

// What a match's endgame plays for. "place": finish as high as possible
// (lobby and Swiss matches). "survive": don't finish last (elimination
// matches, where only last place goes out, and the last game of the final,
// where two bots' scores over the final are compared). "points": score as
// much as possible (earlier games of the final, which only add to a sum).
export type Objective = "place" | "survive" | "points";

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
  rebuildPointsPerCoin: 0,
  reinvest: 0,
  speculativeCap: 1,
  lateSpecWindow: 6,
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
  chaseWindow: 12,
  chaseShares: [1, 0.6, 0.35],
  chaseRestCost: 16,
  endgameTarget: 8,
  cheapLongReward: 0,
  cheapLongLeft: 30,
  holdLongRack: 0,
  holdLongLeft: 28,
  focusFrom: 0,
  firstPriceShade: 0,
  firstPriceExcess: 0.35,
  stageObjectives: false,
};

// Named strategies, picked with PROFILE=<name>. "classic" is the strategy
// of the morning of 2026-10-24 (speculative cap, cash-in, rack building)
// without what came after: the tile-pace boost, the endgame chase and
// defend, and the late-shrinking cap. Same code otherwise, so a head-to-head
// compares strategy alone.
export const PROFILES: Readonly<Record<string, Params>> = {
  current: DEFAULT_PARAMS,
  // A cheaper coin while rebuilding after a word: tied with current in a
  // 6-vs-6 live head-to-head (2.83rd vs 3.0th).
  rebuild: { ...DEFAULT_PARAMS, rebuildPointsPerCoin: 0.3 },
  // Commit 767b6fc, before buying more late became the default: endgame
  // spending from 8 auctions left and the cap shrinking over the last 15.
  // Buying more late (as the top bots do: Nijello wins 3.7 tiles in the
  // last 12 auctions, against coconut's 1.9) scored +6 a game over 50
  // simulated games and +4 over 6 live head-to-head games.
  v767b6fc: { ...DEFAULT_PARAMS, chaseWindow: 8, lateSpecWindow: 15 },
  // On test: hold cheap early long words; bid near-market letters up.
  quality: { ...DEFAULT_PARAMS, cheapLongReward: 36 },
  focus: { ...DEFAULT_PARAMS, focusFrom: 0.6 },
  qualityFocus: { ...DEFAULT_PARAMS, cheapLongReward: 36, focusFrom: 0.6 },
  // On test: hold 7+ letter words until the rack has 8 tiles or auction 40
  // of 68 has opened.
  holdRack: { ...DEFAULT_PARAMS, holdLongRack: 8 },
  // For the tournament: current, plus shaded bids in first-price auctions
  // and endgames played for what each stage scores. Over 60 simulated
  // first-price games current scored 70.8 (89.9 when second-price); shading
  // at 0.95/0.5 scored 76.0, 1/0.4 74.1, 0.9/0.35 70.9, 0.8/0.6 59.0. Over
  // 120, 0.95/0.5 scored 74.0 (3.46th) against current's 69.7 (3.68th).
  tourney: {
    ...DEFAULT_PARAMS,
    firstPriceShade: 0.95,
    firstPriceExcess: 0.5,
    stageObjectives: true,
  },
  classic: {
    ...DEFAULT_PARAMS,
    tilePaceBoost: 0,
    chaseWindow: -1,
    lateSpecWindow: 0,
  },
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
  const objective = params.stageObjectives ? (view.objective ?? "place") : "place";
  // Only the sum counts: a place gained in this game is worth nothing.
  if (objective === "points") return undefined;
  // Only last goes out: pass the lowest of the others, and above them
  // there's no one to chase. Pass, not tie: a tie for last goes to the
  // tournament's total score, which can go either way.
  if (objective === "survive") {
    if (others.length === 0) return undefined;
    const lowest = Math.min(...others);
    return mine <= lowest ? lowest - mine + 1 : undefined;
  }
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
  const ppc = params.pointsPerCoin / pace(view, params);
  // Rebuilding from a short rack, coins can only become points by buying
  // its tiles, and are worth nothing left over. Priced by pacing alone, a
  // middling balance made every rebuild look like a loss: with 58 coins
  // and 43 left, 7 tiles at market came to ~48 points for a ~36-point
  // word, so the bot bid ~0 for 29 auctions.
  if (params.rebuildPointsPerCoin > 0 && rebuilding(view, params)) {
    return Math.min(ppc, params.rebuildPointsPerCoin);
  }
  return ppc;
}

// Whether the outlook plans to rebuild a long word from a short rack: the
// rack is further from `buildTo` than the usual buys reach, and there are
// auctions enough to win the tiles.
function rebuilding(view: MatchView, params: Params): boolean {
  const horizon = Math.min(params.horizon, view.auctionsLeft);
  const buys = Math.min(params.maxBuys, Math.round(horizon * params.winRate));
  const toBuild = params.buildTo - total(view.rack);
  const canWin = Math.round(view.auctionsLeft * params.winRate) + 1;
  return toBuild > buys && toBuild <= canWin;
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
  // Live scores, when known: this bot's and its opponents'. In the last
  // game of a tournament final, they include the final's earlier games.
  scores?: { mine: number; others: readonly number[] };
  // Whether the winner pays its own bid rather than the runner-up's.
  firstPrice?: boolean;
  // What the endgame plays for (default "place").
  objective?: Objective;
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
  if (rebuilding(view, params)) {
    const toBuild = params.buildTo - total(view.rack);
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
  // Letters that can't help close the gap still leave coins to turn into
  // points: for each letter, the nearer of a gap-closing word and any word
  // worth `endgameTarget`. (Falling back only when no letter at all could
  // close the gap left common letters out whenever a Z or X could: down 14
  // with an empty rack and 51 coins, the bot bid 0-7 for its last 8
  // auctions.)
  if (chaseNeeds && goal! > params.endgameTarget) {
    const scoring = closingNeeds(
      lex,
      view.rack,
      view.pool,
      params.endgameTarget,
      maxNeed,
    );
    chaseNeeds = chaseNeeds.map((n, l) => Math.min(n, scoring[l]!));
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
  // Nearly the going price loses as surely as nothing does: if the bot
  // wants the letter that much, bid enough to get it. (The cap below still
  // holds letters that finish nothing to their market price.)
  if (
    params.focusFrom > 0 &&
    value > 0 &&
    bid >= params.focusFrom * market &&
    bid < market
  ) {
    bid = market + 1;
  }
  if (params.speculativeCap > 0) {
    if (!look.completes[l]) {
      const late =
        params.lateSpecWindow > 0 ? Math.min(1, left / params.lateSpecWindow) : 1;
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
  // First price: every coin bid is a coin paid, so a bid of the letter's
  // whole value wins it for nothing gained. The others' best bid is about
  // `market`, so stay near it: a little under for a letter worth no more,
  // and only part of the way to the value for one worth more. (Chase bids
  // too: 60% of 40 coins, paid in full, leaves nothing for the next gap.)
  if (view.firstPrice && params.firstPriceShade > 0) {
    bid =
      bid <= market
        ? Math.round(bid * params.firstPriceShade)
        : Math.round(market + (bid - market) * params.firstPriceExcess);
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
  let balance = view.balance;
  for (let n = 0; n < 4; n++) {
    const word = choosePlay(lex, { ...view, rack, scores, balance }, params, rng);
    if (!word) break;
    plays.push(word);
    rack = without(rack, word);
    balance += word.reward;
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
  // Without a coin the bot can't win a tile, so the rack can't change:
  // holding scores no more later, and playing now returns coins to bid
  // with. (At 0 coins with 7 auctions left it held HEIR, +10, to the last
  // auction, in match 8310.)
  if (view.balance <= 0) return dump(lex, view.rack)[0];
  const boost = reinvestment(view, params);
  // A 7+ letter word already earns the top multiplier: play one now. Of
  // several, take the one worth most net of the tiles it uses up, at what
  // they'd cost to buy back: a tile kept saves a purchase. (Comparing
  // full outlooks of the leftovers instead once held a bid back 421 ms.)
  const long = words.filter((w) => w.text.length >= 7);
  if (
    long.length > 0 &&
    total(view.rack) < params.holdLongRack &&
    view.auctionsLeft > params.holdLongLeft
  ) {
    return undefined;
  }
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
    // Early on, a cheap one spends 7 tiles on few points: play it only if
    // that, plus what's left, beats holding for a better word.
    if (
      params.cheapLongReward > 0 &&
      view.auctionsLeft > params.cheapLongLeft &&
      long[0]!.reward < params.cheapLongReward
    ) {
      const quick = { ...params, samples: params.playSamples };
      const hold = outlookFor(lex, view, quick, rng).hold;
      const rest = without(view.rack, best);
      const play =
        best.reward * boost + outlookFor(lex, { ...view, rack: rest }, quick, rng).hold;
      if (hold > play) return undefined;
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
