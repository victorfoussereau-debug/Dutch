# Dutch

Two-player online Dutch. Node server holding the game state, browser client, live sync over WebSocket.

## Run it on your PC

Requires Node 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Pick a room code, your friend opens the same address and types the same code.

Localhost is only reachable from your own machine. To let your friend in from abroad without deploying, run a tunnel in a second terminal:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

It prints a public https URL. Send it to him. The URL dies when you stop the command, and your PC has to stay on.

## Deploy it instead (recommended)

1. Put this folder in a Git repository and push it to GitHub.
2. On render.com, New > Web Service, connect the repo.
3. Build command `npm install`, start command `npm start`, instance type Free.
4. Deploy. You get a permanent `https://something.onrender.com` URL.

Nothing else to configure. The server reads `PORT` from the environment, which Render sets. Free instances sleep after inactivity, so the first load after a pause takes about thirty seconds.

## How the code is laid out

- `server.js`, the whole game engine plus the WebSocket layer. State lives in memory, one object per room, no database.
- `public/index.html`, the client. All markup, styles and script in one file.

The server never sends a card's value to a player who should not know it. Face-down cards travel as opaque ids that are regenerated every round, so nothing is readable from the browser console. Revealed cards are pushed as one-off messages and hidden again after a few seconds, which means you still have to remember them yourself.

Disconnecting does not lose your seat. The browser keeps a token, so reloading or losing wifi puts you back in the same room with the same cards.

## Rules as implemented

Deck of 52 plus 2 jokers. Cards in a line, same number each, four by default, adjustable from two to eight before a round starts. Each player looks at two of their own cards at the start, whatever the line length.

Values: joker -1, red king 0, black king 13, ace 1, jack 11, queen 12, others face value.

Powers, which fire only when the card leaves the draw pile or a player's line, and only the first time that exact physical card reaches the discard pile in a round:

- 10, the opponent takes an extra card from the draw pile and keeps playing with a longer line.
- Jack, look at any card on the table.
- Queen, swap any two cards on the table, blind.

On your turn, draw from the pile then either swap it into your line or throw it away, or take the top discard and swap it in. A card taken from the discard pile gives no power, but the card it displaces does.

Quick discard at any time on a card matching the rank of the top discard. Right, the card is gone and your line is shorter, and it fires its power. Wrong, the card goes back and you take a penalty card. You may slap a card you discarded yourself, and slap several in a row. A quick discarded card sits on the discard pile, so you can take it back on your turn.

Empty your line and you win the round outright, whatever the other total is.

Otherwise, at the end of your turn you may call Dutch. Your opponent plays one more turn, then both lines are revealed. The caller must be strictly lower, a tie goes to the opponent. No extra penalty, the caller simply loses the round.

One point for the round winner, zero for the loser, running tally kept in the match panel. The winner starts the next round, the first round is drawn at random.

Two deviations you should know about: no card is turned face up to start the discard pile, so the first player must draw from the deck, and quick discard is locked for the few seconds while a Jack or Queen is being resolved.
