# Treasure Tiles

The Bitcoin Shipshow's game night: a pirate cannon game where everyone guesses a **block height**.
A picture of a famous moment is painted on a sea cliff and covered in rock slabs. Players sail
ships in the lagoon, fire their cannons to knock slabs off, and dial in the Bitcoin block height
at the moment the picture shows. Closer and faster scores more. Three rounds, then the top three
battle in the **3 Ship Showdown** for the treasure (paid in sats over Lightning) and the
Bitcoin Ship Show Hardcore Championship Belt (a Nostr badge).

## The three pages

- `/play`: players (phone or computer). Sign in with Nostr, or just pick a pirate name and avatar.
- `/board`: the broadcast screen (OBS browser source, 1920×1080).
- `/host`: the host console (password printed at startup, saved in `DATA_DIR/host-token.txt`).

## Run it

    npm install
    node build.mjs       # builds the pages into public/build
    npm start            # http://localhost:8090

Settings come from `.env` (or the environment):

| Setting | What it's for |
|---|---|
| `PORT` | default 8090 |
| `PUBLIC_URL` | the address players reach (used for the QR code and Nostr badges), e.g. `https://game.bitcoinship.show` |
| `DATA_DIR` | where the game keeps its state, keys and the game wallet connection (default `data`) |
| `PUZZLES_FILE` | the show's rounds (default `puzzles/show.json`, else `puzzles/show.example.json`) |

## The rounds are private

The real rounds would give the answers away, so they are **not in this repo**:

- `puzzles/show.json`: the rounds, in order (the last one with `"finalOnly": true` is the Showdown).
  See `puzzles/show.example.json` for the format.
- `puzzles/images/<id>.png` (or .jpg/.webp): each round's picture.

Copy both onto the server next to the code. Without them the game runs the example rounds with
placeholder pictures.

## The game wallet

The winner is paid from the game's own Lightning wallet, connected with Nostr Wallet Connect: paste
the `nostr+walletconnect://…` string on the host page under **Game wallet**. It is stored in
`DATA_DIR/wallet-nwc.txt` and never sent to players. The winner either scans a QR with their
wallet (LNURL-withdraw) or enters a Lightning address.

## Tests

    npm test
