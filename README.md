# Coach AI — Infinite Agent

A local-first student coach deployed with the Infinite Agent dashboard. for study planning, projects, calendars, fitness tracking, and AI guidance.

## Run it

Requires Node.js 18+.

```powershell
cd C:\Users\chinl\Documents\Codex\2026-10-19\bu\outputs\infinite-agent
npm start
```

Open http://localhost:4173. The app stores projects, study sessions, calendar events, and workouts in `data/student-state.json`.

## AI setup

The server uses Ollama Cloud''s chat API. Set these before starting it:

```powershell
$env:OLLAMA_API_KEY = "your-ollama-key"
$env:OLLAMA_MODEL = "gemma4:31b"
npm start
```

The browser never receives the API key; AI requests are proxied through the local Node server.
## Deploy

The Render service runs `server.mjs` and serves the same dashboard used by GitHub Pages. Set `OLLAMA_API_KEY` and `COACH_ALLOWED_ORIGINS` in Render. GitHub Pages uses `config.js` to call the Render API.
