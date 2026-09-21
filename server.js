'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ cards */

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];

function cardValue(c) {
  if (c.rank === 'JOKER') return -1;
  if (c.rank === 'A') return 1;
  if (c.rank === 'J') return 11;
  if (c.rank === 'Q') return 12;
  if (c.rank === 'K') return (c.suit === 'H' || c.suit === 'D') ? 0 : 13;
  return parseInt(c.rank, 10);
}

function cardPower(c) {
  if (c.rank === '10') return 'give';
  if (c.rank === 'J') return 'peek';
  if (c.rank === 'Q') return 'swap';
  return null;
}

function makeDeck() {
  const cards = [];
  for (const s of SUITS) for (const r of RANKS) cards.push({ rank: r, suit: s });
  cards.push({ rank: 'JOKER', suit: 'R' });
  cards.push({ rank: 'JOKER', suit: 'B' });
  for (const c of cards) c.uid = crypto.randomBytes(8).toString('hex');
  return shuffle(cards);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ rooms */

const rooms = new Map();

function makeRoom(code) {
  const room = {
    code,
    cardsPerPlayer: 4,
    seats: [null, null],
    scores: [0, 0],
    history: [],
    roundNo: 0,
    nextFirst: null,
    round: null,
    log: []
  };
  rooms.set(code, room);
  return room;
}

function seatOf(room, token) {
  return room.seats.findIndex(s => s && s.token === token);
}

function other(seat) { return seat === 0 ? 1 : 0; }

function pushLog(room, text) {
  room.log.push(text);
  if (room.log.length > 120) room.log.shift();
}

/* ------------------------------------------------------------------ round */

function startRound(room) {
  const n = room.cardsPerPlayer;
  const deck = makeDeck();
  const lines = [[], []];
  for (let i = 0; i < n; i++) { lines[0].push(deck.pop()); lines[1].push(deck.pop()); }

  const first = room.nextFirst === null ? crypto.randomInt(2) : room.nextFirst;

  room.roundNo += 1;
  room.round = {
    deck,
    discard: [],
    lines,
    spent: new Set(),
    phase: 'peek',
    peekDone: [false, false],
    turn: first,
    drawn: null,
    drawnSource: null,
    pending: null,
    dutchBy: null,
    over: false,
    result: null
  };
  room.log = [];
  pushLog(room, `Round ${room.roundNo} dealt, ${n} cards each. ${seatName(room, first)} starts.`);
}

function seatName(room, seat) {
  return (room.seats[seat] && room.seats[seat].name) || (seat === 0 ? 'Player 1' : 'Player 2');
}

function drawFromDeck(room) {
  const r = room.round;
  if (r.deck.length === 0) {
    if (r.discard.length <= 1) return null;
    const top = r.discard.pop();
    r.deck = shuffle(r.discard);
    r.discard = [top];
    pushLog(room, 'Draw pile empty. Discards reshuffled, powers stay spent.');
  }
  return r.deck.pop() || null;
}

// Puts a card on the discard pile and fires its power if that exact card
// has not been discarded yet this round.
function discardCard(room, card, actor) {
  const r = room.round;
  r.discard.push(card);
  const p = cardPower(card);
  const fresh = !r.spent.has(card.uid);
  r.spent.add(card.uid);
  if (!p || !fresh) return false;

  if (p === 'give') {
    const victim = other(actor);
    const extra = drawFromDeck(room);
    if (extra) {
      r.lines[victim].push(extra);
      pushLog(room, `${seatName(room, actor)} played a 10. ${seatName(room, victim)} takes an extra card.`);
    }
    return false;
  }
  r.pending = { type: p, owner: actor, picks: [] };
  pushLog(room, `${seatName(room, actor)} played a ${card.rank === 'J' ? 'Jack' : 'Queen'}.`);
  return true;
}

function afterAction(room, seat) {
  const r = room.round;
  if (r.over) return;
  if (r.pending) { r.phase = 'power'; return; }
  if (r.dutchBy !== null) { revealRound(room); return; }
  r.phase = 'dutch_offer';
  r.offerTo = seat;
}

function nextTurn(room) {
  const r = room.round;
  r.turn = other(r.turn);
  r.phase = 'idle';
  r.offerTo = null;
}

function sumLine(room, seat) {
  return room.round.lines[seat].reduce((t, c) => t + cardValue(c), 0);
}

function revealRound(room) {
  const r = room.round;
  const sums = [sumLine(room, 0), sumLine(room, 1)];
  let winner;
  if (r.dutchBy !== null) {
    const caller = r.dutchBy;
    winner = sums[caller] < sums[other(caller)] ? caller : other(caller);
  } else {
    winner = sums[0] <= sums[1] ? 0 : 1;
  }
  finishRound(room, winner, sums, r.dutchBy !== null
    ? `${seatName(room, r.dutchBy)} called Dutch. ${sums[0]} to ${sums[1]}.`
    : `Reveal. ${sums[0]} to ${sums[1]}.`);
}

function finishRound(room, winner, sums, reason) {
  const r = room.round;
  r.over = true;
  r.phase = 'over';
  r.pending = null;
  r.drawn = null;
  room.scores[winner] += 1;
  r.result = { winner, sums, reason };
  room.history.push({ round: room.roundNo, winner, sums, reason });
  room.nextFirst = winner;
  pushLog(room, `${reason} ${seatName(room, winner)} wins the round.`);
}

function checkEmpty(room, seat) {
  if (room.round.lines[seat].length === 0) {
    finishRound(room, seat, [sumLine(room, 0), sumLine(room, 1)], `${seatName(room, seat)} emptied their line.`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ views */

function publicCard(c) { return { uid: c.uid, rank: c.rank, suit: c.suit, value: cardValue(c) }; }

function stateFor(room, seat) {
  const r = room.round;
  const base = {
    type: 'state',
    code: room.code,
    you: seat,
    names: [seatName(room, 0), seatName(room, 1)],
    connected: [!!(room.seats[0] && room.seats[0].ws), !!(room.seats[1] && room.seats[1].ws)],
    scores: room.scores,
    history: room.history,
    cardsPerPlayer: room.cardsPerPlayer,
    roundNo: room.roundNo,
    log: room.log.slice(-40),
    inRound: !!r
  };
  if (!r) return base;

  const showAll = r.over;
  base.round = {
    phase: r.phase,
    turn: r.turn,
    offerTo: (r.offerTo === 0 || r.offerTo === 1) ? r.offerTo : null,
    deckCount: r.deck.length,
    discardTop: r.discard.length ? publicCard(r.discard[r.discard.length - 1]) : null,
    discardCount: r.discard.length,
    dutchBy: r.dutchBy,
    peekDone: r.peekDone,
    lines: [0, 1].map(s => r.lines[s].map(c => showAll ? publicCard(c) : { uid: c.uid })),
    pending: r.pending ? { type: r.pending.type, owner: r.pending.owner, picks: r.pending.picks.length } : null,
    drawn: (r.drawn && r.turn === seat) ? publicCard(r.drawn) : (r.drawn ? { hidden: true } : null),
    drawnSource: r.drawnSource,
    result: r.result
  };
  return base;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  for (let s = 0; s < 2; s++) {
    const p = room.seats[s];
    if (p && p.ws) send(p.ws, stateFor(room, s));
  }
}

function reveal(room, seat, entries, ms) {
  const p = room.seats[seat];
  if (p && p.ws) send(p.ws, { type: 'reveal', cards: entries, ms: ms || 7000 });
}

function findCard(room, seat, uid) {
  const line = room.round.lines[seat];
  const i = line.findIndex(c => c.uid === uid);
  return i === -1 ? null : { index: i, card: line[i] };
}

/* ----------------------------------------------------------------- actions */

function handle(room, seat, msg) {
  const r = room.round;

  if (msg.t === 'setCards') {
    if (r && !r.over) return;
    const n = Math.max(2, Math.min(8, parseInt(msg.n, 10) || 4));
    room.cardsPerPlayer = n;
    pushLog(room, `Cards per player set to ${n}.`);
    return;
  }

  if (msg.t === 'newRound') {
    if (!room.seats[0] || !room.seats[1]) return;
    if (r && !r.over) return;
    startRound(room);
    return;
  }

  if (msg.t === 'resetMatch') {
    room.scores = [0, 0];
    room.history = [];
    room.roundNo = 0;
    room.nextFirst = null;
    room.round = null;
    room.log = [];
    pushLog(room, 'Match reset.');
    return;
  }

  if (!r || r.over) return;

  /* ---- opening peek ---- */
  if (msg.t === 'peek') {
    if (r.phase !== 'peek' || r.peekDone[seat]) return;
    const uids = Array.isArray(msg.uids) ? msg.uids.slice(0, 2) : [];
    const picked = [];
    for (const uid of uids) {
      const f = findCard(room, seat, uid);
      if (f) picked.push({ seat, uid: f.card.uid, card: publicCard(f.card) });
    }
    if (picked.length !== 2) return;
    r.peekDone[seat] = true;
    reveal(room, seat, picked, 10000);
    pushLog(room, `${seatName(room, seat)} looked at two cards.`);
    if (r.peekDone[0] && r.peekDone[1]) {
      r.phase = 'idle';
      pushLog(room, `${seatName(room, r.turn)} to play.`);
    }
    return;
  }

  /* ---- quick discard, out of turn, any time except during a power ---- */
  if (msg.t === 'slap') {
    if (!['idle', 'drawn', 'dutch_offer'].includes(r.phase)) return;
    if (!r.discard.length) return;
    const f = findCard(room, seat, msg.uid);
    if (!f) return;
    const top = r.discard[r.discard.length - 1];
    if (f.card.rank === top.rank) {
      r.lines[seat].splice(f.index, 1);
      r.discard.push(f.card);
      pushLog(room, `${seatName(room, seat)} quick discarded a ${f.card.rank}.`);
      if (checkEmpty(room, seat)) return;
      const fresh = !r.spent.has(f.card.uid);
      r.spent.add(f.card.uid);
      const p = cardPower(f.card);
      if (p && fresh) {
        if (p === 'give') {
          const extra = drawFromDeck(room);
          if (extra) {
            r.lines[other(seat)].push(extra);
            pushLog(room, `${seatName(room, other(seat))} takes an extra card.`);
          }
        } else {
          r.pending = { type: p, owner: seat, picks: [], resume: r.phase };
          r.phase = 'power';
        }
      }
    } else {
      const pen = drawFromDeck(room);
      if (pen) r.lines[seat].push(pen);
      pushLog(room, `${seatName(room, seat)} slapped a ${f.card.rank} by mistake and takes a penalty card.`);
    }
    return;
  }

  /* ---- power resolution ---- */
  if (msg.t === 'power') {
    if (r.phase !== 'power' || !r.pending || r.pending.owner !== seat) return;
    const pend = r.pending;
    const tSeat = msg.seat === 1 ? 1 : 0;
    const f = findCard(room, tSeat, msg.uid);
    if (!f) return;

    if (pend.type === 'peek') {
      reveal(room, seat, [{ seat: tSeat, uid: f.card.uid, card: publicCard(f.card) }], 7000);
      pushLog(room, `${seatName(room, seat)} looked at a card of ${seatName(room, tSeat)}.`);
      r.pending = null;
      resumeAfterPower(room, seat, pend);
      return;
    }

    if (pend.type === 'swap') {
      if (pend.picks.length === 0) {
        pend.picks.push({ seat: tSeat, uid: f.card.uid });
        return;
      }
      const a = pend.picks[0];
      if (a.uid === f.card.uid) { pend.picks = []; return; }
      const fa = findCard(room, a.seat, a.uid);
      if (!fa) { r.pending = null; resumeAfterPower(room, seat, pend); return; }
      const tmp = r.lines[a.seat][fa.index];
      r.lines[a.seat][fa.index] = r.lines[tSeat][f.index];
      r.lines[tSeat][f.index] = tmp;
      pushLog(room, `${seatName(room, seat)} swapped two cards blind.`);
      r.pending = null;
      resumeAfterPower(room, seat, pend);
      return;
    }
    return;
  }

  /* ---- turn actions ---- */
  if (r.turn !== seat) return;

  if (msg.t === 'drawDeck') {
    if (r.phase !== 'idle') return;
    const c = drawFromDeck(room);
    if (!c) return;
    r.drawn = c; r.drawnSource = 'deck'; r.phase = 'drawn';
    return;
  }

  if (msg.t === 'takeDiscard') {
    if (r.phase !== 'idle' || !r.discard.length) return;
    r.drawn = r.discard.pop(); r.drawnSource = 'discard'; r.phase = 'drawn';
    pushLog(room, `${seatName(room, seat)} took the ${r.drawn.rank} from the discard pile.`);
    return;
  }

  if (msg.t === 'place') {
    if (r.phase !== 'drawn' || !r.drawn) return;
    const f = findCard(room, seat, msg.uid);
    if (!f) return;
    const displaced = r.lines[seat][f.index];
    r.lines[seat][f.index] = r.drawn;
    r.drawn = null;
    pushLog(room, `${seatName(room, seat)} swapped a card in and discarded a ${displaced.rank}.`);
    discardCard(room, displaced, seat);
    afterAction(room, seat);
    return;
  }

  if (msg.t === 'discardDrawn') {
    if (r.phase !== 'drawn' || !r.drawn || r.drawnSource !== 'deck') return;
    const c = r.drawn; r.drawn = null;
    pushLog(room, `${seatName(room, seat)} discarded the ${c.rank} straight away.`);
    discardCard(room, c, seat);
    afterAction(room, seat);
    return;
  }

  if (msg.t === 'dutch') {
    if (r.phase !== 'dutch_offer' || r.offerTo !== seat) return;
    r.dutchBy = seat;
    pushLog(room, `${seatName(room, seat)} called Dutch. One last turn.`);
    nextTurn(room);
    return;
  }

  if (msg.t === 'pass') {
    if (r.phase !== 'dutch_offer' || r.offerTo !== seat) return;
    nextTurn(room);
    return;
  }
}

function resumeAfterPower(room, seat, pend) {
  const r = room.round;
  if (pend.resume) { r.phase = pend.resume; return; }
  afterAction(room, seat);
}

/* ------------------------------------------------------------------ server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      const code = String(msg.code || '').trim().toUpperCase().slice(0, 8);
      if (!code) { send(ws, { type: 'error', message: 'Enter a room code.' }); return; }
      const room = rooms.get(code) || makeRoom(code);
      const name = String(msg.name || '').trim().slice(0, 16) || 'Player';
      const token = String(msg.token || '') || crypto.randomBytes(12).toString('hex');

      let seat = seatOf(room, token);
      if (seat === -1) {
        seat = room.seats.findIndex(s => !s);
        if (seat === -1) { send(ws, { type: 'error', message: 'This room already has two players.' }); return; }
        room.seats[seat] = { token, name, ws };
        pushLog(room, `${name} joined.`);
      } else {
        room.seats[seat].ws = ws;
        room.seats[seat].name = name;
        pushLog(room, `${name} reconnected.`);
      }
      ws.room = room; ws.seat = seat;
      send(ws, { type: 'joined', token, seat, code });
      broadcast(room);
      return;
    }

    const room = ws.room;
    if (!room || ws.seat === undefined) return;
    try { handle(room, ws.seat, msg); } catch (e) { console.error(e); }
    broadcast(room);
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    const s = ws.seat;
    if (room.seats[s] && room.seats[s].ws === ws) {
      room.seats[s].ws = null;
      pushLog(room, `${seatName(room, s)} disconnected.`);
      broadcast(room);
    }
    setTimeout(() => {
      const empty = room.seats.every(p => !p || !p.ws);
      if (empty) rooms.delete(room.code);
    }, 1000 * 60 * 60);
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`Dutch running on http://localhost:${PORT}`));
