// ScrabbleBot bot.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`. (In PowerShell:
// `$env:BOT_NAME = '<name>'; npm start`.)
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
// `NO_LOBBY=1` keeps it out of lobby matches, so it plays only the
// tournament. `MAX_MATCHES=<n>` makes it exit after n matches.
//
// The bidding and word-play policy is in ./strategy.ts.

import {
  DbConnection,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAG,
  buildLexicon,
  emptyCounts,
  letterIndex,
  total,
  without,
  type Counts,
} from "./engine.js";
import {
  bidFor,
  choosePlays,
  DEFAULT_PARAMS,
  outlookFor,
  type MatchView,
} from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const NO_LOBBY = process.env.NO_LOBBY === "1";
// Stop after this many matches, e.g. for a short live test.
const MAX_MATCHES = Number(process.env.MAX_MATCHES ?? Infinity);
let matchesPlayed = 0;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
// `fileURLToPath`, not `URL.pathname`: on Windows the pathname is
// `/C:/...`, which resolves to a path that doesn't exist.
const dictionaryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
// Without a dictionary the bot bids but never plays a word, so fail loudly.
if (!fs.existsSync(dictionaryPath)) {
  console.error(`wordlist not found at ${dictionaryPath}`);
  process.exit(1);
}
const LEXICON = buildLexicon(
  fs.readFileSync(dictionaryPath, "utf8").split("\n"),
);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<bigint>();
// Matches this bot has a seat in.
const myMatches = new Set<bigint>();
// When each open auction of ours was first seen, to log how long bids take.
const seenAt = new Map<bigint, number>();
// The rack and stretch of the match each match's plays were last decided
// for: deciding again with nothing changed only burns time.
const decidedFor = new Map<bigint, string>();
// Matches with words submitted but not yet applied: the rack the bot sees
// still has their tiles, so it waits rather than spend them twice.
const playsInFlight = new Set<bigint>();

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(conn: DbConnection, matchId: bigint): Counts {
  const rack = emptyCounts();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack[letterIndex(h.letter)]! += h.count;
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// Tiles this match could still put up for auction, as far as the bot can
// tell: the bag, less every tile auctioned so far, less the starting tiles
// it knows of (its own, and opponents' once they play them in words).
// Opponents' unplayed starting tiles stay in, so it slightly overcounts.
function unseenPool(
  conn: DbConnection,
  matchId: bigint,
  rack: Counts,
  openLetter: string | undefined,
): Counts {
  const pool = Int16Array.from(BAG);
  const won = new Map<bigint, Counts>();
  const played = new Map<bigint, Counts>();
  const add = (m: Map<bigint, Counts>, bot: bigint, letters: string) => {
    let c = m.get(bot);
    if (!c) m.set(bot, (c = emptyCounts()));
    for (const ch of letters) c[letterIndex(ch)]!++;
  };
  for (const r of conn.db.auctionResult.iter()) {
    if (r.matchId !== matchId) continue;
    pool[letterIndex(r.letter)]!--;
    if (r.winnerBotId !== undefined) add(won, r.winnerBotId, r.letter);
  }
  if (openLetter) pool[letterIndex(openLetter)]!--;
  for (const w of conn.db.wordPlay.iter()) {
    if (w.matchId === matchId) add(played, w.botId, w.word);
  }
  // Tiles a bot has held beyond those it won were dealt to it at the start.
  // For this bot that's its rack plus what it played; for others, only
  // what they played.
  const mine = played.get(myBotId!) ?? emptyCounts();
  for (let i = 0; i < 26; i++) mine[i]! += rack[i]!;
  played.set(myBotId!, mine);
  for (const [bot, letters] of played) {
    const w = won.get(bot);
    for (let i = 0; i < 26; i++) {
      const dealt = letters[i]! - (w ? w[i]! : 0);
      if (dealt > 0) pool[i]! -= dealt;
    }
  }
  for (let i = 0; i < 26; i++) if (pool[i]! < 0) pool[i] = 0;
  return pool;
}

const fmt = (c: Counts) =>
  [...c].map((n, i) => String.fromCharCode(65 + i).repeat(n)).join("");

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

// Look at every running match this bot is in, and bid and play words as
// the strategy says. Runs once after each batch of updates from the server.
function act(conn: DbConnection) {
  if (myBotId === null) return;
  for (const matchId of myMatches) {
    const m = conn.db.matchState.id.find(matchId);
    if (m?.status.tag !== "Running") continue;
    actInMatch(conn, matchId, m.bagTotal, m.currentAuctionId);
  }
}

// Warn when something blocks the event loop long enough to risk an
// auction: nothing else runs, bids included, until it lets go.
const STALL_CHECK_MS = 50;
const STALL_WARN_MS = 250;
let lastCheck = performance.now();
setInterval(() => {
  const now = performance.now();
  const late = now - lastCheck - STALL_CHECK_MS;
  lastCheck = now;
  if (late > STALL_WARN_MS) {
    console.warn(`[${BOT_NAME}] event loop blocked for ${late.toFixed(0)}ms`);
  }
}, STALL_CHECK_MS).unref();

function actInMatch(
  conn: DbConnection,
  matchId: bigint,
  bagTotal: number,
  currentAuctionId: bigint | undefined,
) {
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const auction =
    currentAuctionId !== undefined
      ? conn.db.auction.id.find(currentAuctionId)
      : undefined;
  // Between auctions there's nothing to decide. (Playing as if the match
  // were over would throw away tiles that could still make long words.)
  if (auction?.status.tag !== "Open") return;
  const open = auction;
  let rack = rackForMatch(conn, matchId);
  let balance = participant.balance;
  const view: MatchView = {
    rack,
    pool: unseenPool(conn, matchId, rack, open.letter),
    // Each auction draws a tile, so the bag holds one per auction to come.
    auctionsLeft: bagTotal,
    balance,
  };

  const play = () => {
    if (playsInFlight.has(matchId)) return;
    // Re-decide when the rack changes, and every few auctions as the end
    // nears, not after every auction: late in a match deciding takes
    // several outlooks, and doing it each auction froze the bot for up to
    // 570 ms at a time. The last auction always decides: everything left
    // is played then.
    const when = view.auctionsLeft === 0 ? "last" : Math.ceil(view.auctionsLeft / 4);
    const key = `${rack.join(",")}/${when}`;
    if (decidedFor.get(matchId) === key) return;
    decidedFor.set(matchId, key);
    const plays = choosePlays(LEXICON, { ...view, rack });
    if (plays.length === 0) return;
    playsInFlight.add(matchId);
    let pending = plays.length;
    for (const w of plays) {
      rack = without(rack, w);
      balance += w.reward;
      console.log(
        `[${BOT_NAME}] match ${matchId}: playing ${w.text} (+${w.reward})`,
      );
      conn.reducers
        .submitWord({ matchId, word: w.text })
        .catch(logFailure(`playing '${w.text}'`))
        .finally(() => {
          if (--pending === 0) playsInFlight.delete(matchId);
        });
    }
  };

  // Early on, deciding plays is quick (only a 7+ letter word gets played),
  // so play first and bid for the rack the bot will actually hold. Late on
  // it weighs short words, which takes longer, so bid first: a bid that
  // misses its auction's one second is worth nothing.
  const playFirst = view.auctionsLeft > DEFAULT_PARAMS.shortWordWindow;
  if (playFirst) play();

  if (!bidsByAuction.has(open.id)) {
    bidsByAuction.add(open.id);
    const after: MatchView = { ...view, rack, balance: participant.balance };
    const look = outlookFor(LEXICON, after);
    const amount = bidFor(after, open.letter, look);
    const took = performance.now() - (seenAt.get(open.id) ?? performance.now());
    seenAt.delete(open.id);
    console.log(
      `[${BOT_NAME}] match ${matchId} '${open.letter}' bid ${amount}` +
        ` (bal ${participant.balance}, left ${view.auctionsLeft}, rack ${fmt(rack)}, ${took.toFixed(0)}ms)`,
    );
    if (amount > 0) {
      const sent = performance.now();
      conn.reducers
        .submitBid({ auctionId: open.id, amount: BigInt(amount) })
        .catch((err: unknown) =>
          logFailure(
            `bid on auction ${open.id} (sent ${took.toFixed(0)}ms after it` +
              ` arrived, refused ${(performance.now() - sent).toFixed(0)}ms later)`,
          )(err),
        );
    }
  }

  if (!playFirst) play();
}

// Coalesce the row callbacks of one server update into a single `act`.
let actScheduled = false;
function scheduleAct(conn: DbConnection) {
  if (actScheduled) return;
  actScheduled = true;
  setImmediate(() => {
    actScheduled = false;
    try {
      act(conn);
    } catch (err) {
      console.error(`[${BOT_NAME}] act failed:`, err);
    }
  });
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

  // Only this bot's matches need a decision. Every match on the server
  // sends updates, and deciding on each of them kept the bot busy enough
  // to miss auctions.
  conn.db.auction.onInsert((_ctx, a) => {
    if (!myMatches.has(a.matchId)) return;
    seenAt.set(a.id, performance.now());
    scheduleAct(conn);
  });
  conn.db.matchState.onUpdate((_ctx, _old, m) => {
    if (myMatches.has(m.id)) scheduleAct(conn);
  });
  conn.db.myRack.onInsert(() => scheduleAct(conn));
  conn.db.myRack.onUpdate(() => scheduleAct(conn));
  conn.db.myRack.onDelete(() => scheduleAct(conn));
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (myBotId !== null && p.botId === myBotId) {
      myMatches.add(p.matchId);
      scheduleAct(conn);
    }
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((ctx, r) => {
    // The initial sync replays every past auction; only report new ones.
    if (ctx.event.tag === "SubscribeApplied") return;
    if (myBotId === null || r.winnerBotId !== myBotId) return;
    console.log(
      `[${BOT_NAME}] match ${r.matchId}: won '${r.letter}' for ${r.paid}`,
    );
  });

  // When a match this bot was in ends, report and hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const mine = Array.from(conn.db.matchParticipant.iter()).filter(
        (p) => p.matchId === neu.id,
      );
      const me = mine.find((p) => p.botId === myBotId);
      if (me) {
        const ranked = mine.map((p) => Number(p.score)).sort((a, b) => b - a);
        const place = ranked.indexOf(Number(me.score)) + 1;
        const leftover = total(rackForMatch(conn, neu.id));
        console.log(
          `[${BOT_NAME}] match ${neu.id} ended: score ${me.score}, place ${place}/${mine.length},` +
            ` best ${ranked[0]}, coins left ${me.balance}, tiles left ${leftover}`,
        );
        if (++matchesPlayed >= MAX_MATCHES) {
          console.log(`[${BOT_NAME}] played ${matchesPlayed} matches; exiting`);
          process.exit(0);
        }
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null || NO_LOBBY) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId === myBotId) myMatches.add(p.matchId);
  }
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  scheduleAct(conn);
}

// A bot that drops out of a tournament still gets seated and loses every
// auction, so reconnect, waiting longer after each failure in a row.
const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000];
let failures = 0;

function reconnect(why: string) {
  const wait = RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)]!;
  failures++;
  console.warn(`[${BOT_NAME}] ${why}; reconnecting in ${wait / 1000}s`);
  setTimeout(connect, wait);
}

function connect() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    // After a nonce is redeemed, the saved token is the bot's identity.
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect((conn, identity, token) => {
      failures = 0;
      onConnect(conn, identity, token);
    })
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      reconnect(`connect error: ${err.message}`),
    )
    .onDisconnect(() => reconnect("disconnected"))
    .build();
}

console.log(
  `[${BOT_NAME}] ${LEXICON.words.length} words; params ` +
    JSON.stringify({ ...DEFAULT_PARAMS, prices: undefined, phase: undefined }),
);
connect();
