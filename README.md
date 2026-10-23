# Coach AI

A personal learning coach with email accounts, persistent coursework, a weekly due-date calendar, and the local Infinite Agent coach. The local backend uses Python's standard library and SQLite.

## Start locally

1. Install Python 3.10 or newer.
2. Copy `.env.example` to `.env` and start the Infinite Agent from its folder (`npm start`), or configure the Ollama fallback variables.
3. Run `python server.py` from this folder.
4. Open <http://127.0.0.1:8000>, create an account, and ask your coach a question.

## Host the complete app

The planned web UI uses GitHub Pages from a separate public front-end repository. The Python API runs as a Render web service with a persistent disk. The Render blueprint is in `render.yaml`.

1. Create the Render service from the private `coach-ai-learning-coach` repository using `render.yaml`.
2. Set the `INFINITE_AGENT_URL` and, when using the fallback, `OLLAMA_API_KEY` secrets in Render. Set `COACH_ALLOWED_ORIGINS` to the exact GitHub Pages origin, such as `https://ectheez.github.io`.
3. Set the API URL in the Pages copy's `config.js` to the Render service URL.
4. Enable GitHub Pages for the public front-end repository from its `main` branch and root folder.

Render's free web services lose local files when they restart and sleep after inactivity. This app needs the paid web service and persistent disk declared in the blueprint for saved student data. Review current billing before creating the service.

The Infinite Agent URL and Ollama key are read by the Python server, never sent to the browser, and `.env` is excluded from Git. Set `OLLAMA_MODEL` in `.env` to change the fallback model.

## Working features

- Email and password sign-up/sign-in. Passwords are salted and hashed; sessions use an HttpOnly cookie.
- Coursework assignments and completion states stored in SQLite and scoped to each account.
- Due date calendar, priorities, filters, notes, and estimated task time.
- AI learning-coach chat routed through the Infinite Agent; direct Ollama is supported as a fallback, with coursework context.
- Learner activity and practice-session state stored per account.

## Email and security notes

Email is currently the account sign-in identifier; the app does not send email verification or password reset messages. The server uses HTTPS-only cookies in production, restricts browser origins, applies basic request limits, and stores data on the persistent disk. Before broader public use, add verified email/password recovery and a managed database. Never commit `.env` or `coachai.sqlite3`.
