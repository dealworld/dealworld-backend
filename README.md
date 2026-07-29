# DealWorld 2.0 — Backend

This is the real, working backend for DealWorld 2.0: a Node/Express API, a Postgres schema, and the integration code for Gmail, BoldSign, Twilio, Drop Cowboy, Calendly, Fathom, and Anthropic (for drafting, reply classification, and task detection). `public/index.html` holds the frontend prototype built earlier in this conversation.

## What is real right now

- Every file in `src/` is runnable code, not pseudocode. It uses each vendor's actual public REST API or SDK, with the field names and endpoints their documentation specifies.
- The database schema (`src/schema.sql`) matches the full data model from the DealWorld 2.0 spec: leads, notes, tasks, documents, checklist items, contacts, provisors (with troikas and connections), communications, and newsletters.
- The BizBuySell email parser in `src/integrations/gmail.js` is built against the actual field layout from the screenshots you shared (Listing ID, Ref ID, Contact Name/Email/Phone/Zip, Able to Invest, Purchase Within), and handles both a direct BizBuySell email and one forwarded through your tworld inbox.
- The cron based automations (NDA reminder sequence, gone quiet digest, inbox polling, Fathom sync) are wired into `src/services/reminderScheduler.js` and start automatically when the server boots.

## What is not live yet, and why

Nothing in this project is running anywhere yet — there's no server currently deployed, no database provisioned, and no real credentials filled in. Specifically:

1. **No database exists yet.** You need a Postgres instance (Supabase's free tier is the simplest option) and need to run the migration once.
2. **Every integration needs its own credentials** — Google OAuth client, BoldSign API key and template IDs, Twilio account, Drop Cowboy account, Calendly token, Fathom API key, Anthropic API key. All of them are listed in `.env.example` with notes on where to get each one.
3. **The Fathom integration is a best effort against public documentation** rather than something tested against a live account, since I don't have a way to hit Fathom's actual API from here. Confirm the base URL and response shape in Fathom's current docs before relying on it, and adjust `src/integrations/fathom.js` if anything's changed.
4. **The frontend (`public/index.html`) still saves to Claude's in browser artifact storage**, which only works inside claude.ai. It is not yet wired to call this backend's `/api` routes. Once this backend is deployed somewhere with a real URL, the frontend's storage layer needs to be swapped for `fetch()` calls to `/api/leads`, `/api/tasks`, etc. This is the kind of change that's much safer to do against a real, running server where each change can be tested immediately — which points at Claude Code rather than this chat, since Claude Code can spin up the server locally, hit it with real requests, and iterate.
5. **The APA (asset purchase agreement) BoldSign template isn't built** since that file was never uploaded — `sendApa()` exists and is wired into a route, but `BOLDSIGN_APA_TEMPLATE_ID` has nothing to point to yet.

## Setup, start to finish

1. **Database**: create a free Supabase project (or any Postgres host), copy its connection string into `DATABASE_URL` in a real `.env` file (copy `.env.example` to `.env` first), then run:
   ```
   npm install
   npm run migrate
   ```
2. **Gmail**: create a Google Cloud project, enable the Gmail API, create OAuth credentials, fill in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`. Deploy the server, then visit `BASE_URL/auth/gmail`, sign in, and copy the refresh token it shows you into `.env` as `GOOGLE_REFRESH_TOKEN`.
3. **BoldSign**: sign up, build three templates (NDA, Marketing Agreement, and APA once you have that file) with merge fields for signer name, listing reference, and date. Copy each template ID into `.env`. In BoldSign's dashboard, point its webhook at `BASE_URL/webhooks/boldsign`.
4. **Twilio**: create an account, buy a number, fill in the three Twilio variables, and set that number's "a message comes in" webhook to `BASE_URL/webhooks/twilio/inbound`.
5. **Drop Cowboy**: create an account, record or upload your voicemail audio, and fill in the three Drop Cowboy variables plus `DROPCOWBOY_AUDIO_ID`.
6. **Calendly**: generate a Personal Access Token, fill in `CALENDLY_PERSONAL_ACCESS_TOKEN`, then run `node -e "require('./src/integrations/calendly').registerWebhook().then(console.log)"` once to subscribe your deployed URL.
7. **Fathom**: fill in `FATHOM_API_KEY` once you have one.
8. **Anthropic**: fill in `ANTHROPIC_API_KEY`.
9. **Run it**: `npm start` locally, or deploy to Render/Railway/Fly.io (any of these have a free or near free tier that's enough for a solo brokerage's traffic).

## Suggested next step

Hand this folder to Claude Code along with your actual credentials. It can install dependencies, stand up a local server against a real (or throwaway test) database, and rewire the frontend's storage calls into real API calls, testing each integration as it goes rather than guessing blind the way I've had to here without a live server or your actual account credentials to test against.
"# dealworld-backend" 
"# dealworld-backend" 
