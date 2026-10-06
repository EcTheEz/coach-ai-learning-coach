# Coach AI

A personal learning coach prototype with email accounts, persistent coursework, a weekly due-date calendar, and a server-side Gemini AI coach. The app uses only Python's standard library and browser APIs.

## Start locally

1. Install Python 3.10 or newer.
2. Copy `.env.example` to `.env` and add your Gemini API key to `GEMINI_API_KEY`.
3. Run `python server.py` from this folder.
4. Open <http://127.0.0.1:8000>, create an account, and ask your coach a question.

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey). The key is read by the Python server, never sent to the browser, and `.env` is excluded from Git. Set `GEMINI_MODEL` in `.env` to change the model.

## Working features

- Email and password sign-up/sign-in. Passwords are salted and hashed; sessions use an HttpOnly cookie.
- Coursework assignments and completion states stored in SQLite and scoped to each account.
- Due date calendar, priorities, filters, notes, and estimated task time.
- AI learning-coach chat routed through the server to Gemini, with coursework context.
- Learner activity and practice-session state stored per account.

## Before deploying publicly

This is a local-first MVP. It does not send email verification or password reset messages, and it is not configured for public hosting. Before exposing it to the internet, add verified email/password recovery, HTTPS and secure cookies, rate limiting, CSRF protection, database backups, and a production web server. Never commit `.env` or `coachai.sqlite3`.
