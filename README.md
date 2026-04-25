# StartGG Overlay

Local Node.js overlay server for OBS that queries Start.gg and broadcasts via WebSockets.

Setup

1. Copy `.env.example` to `.env` and set `STARTGG_API_KEY`.
2. Install dependencies:

```bash
npm install
```

Run

```bash
npm start
# or
npm run dev
```

Open `http://localhost:3000/control.html` to search and `http://localhost:3000/overlay.html` in an OBS Browser source.
