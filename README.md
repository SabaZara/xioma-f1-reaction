# XIOMA F1 Reaction

Server-authoritative F1 reaction duel with live WebSocket PvP, private friend rooms, bot practice, solo time attack, demo wallet, and leaderboard.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Play With Friends

1. Open the app.
2. Go to `Play`.
3. Use `CREATE INVITE` in PvP Duel.
4. Send the generated link to a friend.
5. Both players choose the same stake and press `FIND OPPONENT`.

The room code is carried in the URL as `?room=CODE`, so only players with that link match together.

## Deploy Online

This app needs a Node host that supports WebSockets. GitHub Pages cannot run the multiplayer server by itself.

### Temporary public tunnel

For quick friend testing from your laptop:

```bash
PORT=3001 npm start
npm run tunnel
```

Keep both commands running while friends play. The tunnel URL can change each time you restart it.

### Render

The included `render.yaml` is ready for Render Blueprint deploys:

1. Push this repo to GitHub.
2. In Render, create a new Blueprint from the repo.
3. Render will run `npm ci`, start `npm start`, and health-check `/healthz`.

### Docker

```bash
docker build -t xioma-f1-reaction .
docker run -p 3000:3000 xioma-f1-reaction
```

## Smoke Tests

Start the server, then run:

```bash
npm run smoke
```
