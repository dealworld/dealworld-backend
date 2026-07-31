# DealWorld 2.0 — API reference

## Base URL

Right now the server only runs locally: `http://localhost:3000`. Nothing under `/api` is reachable from outside this machine until the app is deployed somewhere with a real domain (see the README's "Suggested next step"). Any external client — including a hosted Claude.ai connector — needs a public `BASE_URL` before it can call this API at all.

## Authentication

Every route under `/api/*` (except `/api/auth/*` itself) requires a logged-in session. Sessions are a JWT stored in an `httpOnly` cookie named `dw_token`, set for 30 days.

There's exactly one account (single-user tool). The flow:

1. `GET /api/auth/status` → `{ hasAccount: boolean }`. Tells you whether the one-time setup has happened yet.
2. If `hasAccount` is `false`: `POST /api/auth/setup` with `{ email, password }` (password ≥ 8 chars) creates the account and logs you in. This only works once — it 409s after that.
3. If `hasAccount` is `true`: `POST /api/auth/login` with `{ email, password }` logs in.
4. Both of the above set the `dw_token` cookie in the response. A script client needs to persist and resend that cookie on every subsequent request (curl: `-c cookies.txt` then `-b cookies.txt`; in code: a cookie jar, or read `Set-Cookie` and resend it as `Cookie` yourself).
5. `GET /api/auth/me` → `{ email }` if the session is valid, `401` if not.
6. `PATCH /api/auth/me` with `{ currentPassword, newEmail?, newPassword? }` changes email and/or password. `currentPassword` is required every time.
7. `POST /api/auth/logout` clears the cookie.

Example with curl:

```bash
# log in, save the session cookie
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}'

# use the saved cookie on every call after that
curl -b cookies.txt http://localhost:3000/api/leads
```

Any request without a valid cookie gets `401 {"error":"not authenticated"}`.

## Endpoints

All bodies/responses are JSON. Records use snake_case field names (e.g. `listing_ref`, `last_contact_at`).

| Area | Routes |
|---|---|
| Leads | `GET/POST /api/leads`, `GET/DELETE /api/leads/:id`, `PATCH /api/leads/:id/stage`, `PATCH /api/leads/:id/contact`, `PATCH /api/leads/:id/description` |
| Listings | `GET/POST /api/listings`, `GET/DELETE /api/listings/:id`, `PATCH /api/listings/:id/status`, `POST/DELETE /api/listings/:id/links[/:linkId]` |
| Notes | `POST /api/notes` (`record_type`: `lead`\|`contact`\|`provisor`), `DELETE /api/notes/:id` |
| Tasks | `GET/POST /api/tasks`, `PATCH /api/tasks/:id/toggle`, `DELETE /api/tasks/:id` |
| Documents / e-sign | `POST /api/leads/:id/documents/{nda,marketing,apa,cim}`, `POST /api/leads/:id/release-address`, `DELETE /api/documents/:id` |
| Contacts | `GET/POST /api/contacts`, `GET/DELETE /api/contacts/:id`, `PATCH /api/contacts/:id/linkedin` |
| Provisors | `GET/POST /api/provisors`, `GET/DELETE /api/provisors/:id`, `POST/DELETE /api/provisors/:id/troikas[/:troikaId]`, `POST/DELETE /api/provisors/:id/connections[/:connId]` |
| Newsletters | `GET/POST /api/newsletters`, `PATCH/DELETE /api/newsletters/:id`, `POST /api/newsletters/:id/send` **(sends real email)** |
| Mass outreach | `POST /api/outreach/{mass-email,mass-text,mass-voicemail}` **(sends real messages)** |
| Bulk import | `POST /api/import/{leads,listings,contacts,provisors}` |

The exact request/response shape for each route is easiest to read straight from [src/routes/api.js](src/routes/api.js) and [src/routes/auth.js](src/routes/auth.js) — every route body is short and un-abstracted.

## Direct database access (not recommended by default)

The API above goes through validation, the notes/tasks side effects (e.g. adding a note bumps `last_contact_at`), and now the login gate. Connecting straight to Postgres skips all of that — anyone with the connection string gets raw read/write on every table, including `users.password_hash`.

The connection string already lives in your own `.env` as `DATABASE_URL` — I'm not going to re-paste it into this chat, since that just adds a second place a production credential sits.

If you still want a database-level connection (e.g. for analytics, or a tool that needs SQL rather than REST), the safer version is a **read-only** Postgres role scoped to the tables you actually want exposed, not the same superuser-ish credential the app uses. I can generate the `CREATE ROLE ... GRANT SELECT` for that if you tell me which tables should be visible.
