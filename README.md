# Google Drive URL Uploader

Queues remote file URLs in Firestore, then streams each one straight into a
Google Drive folder from a GitHub Actions runner — the file never touches your
machine.

Two pieces:

| Piece | Entry point | Runs |
|---|---|---|
| **Job** — drains the queue, uploads to Drive | `FileUploader.js` | GitHub Actions |
| **Console** — web UI to queue links, watch status, start a run | `server.js` | Wherever you host it |

```
Console (browser)                    GitHub Actions
   │                                      │
   ├─ add link ──────► Firestore ◄────────┤ listPending() → download → Drive
   │                   (queue)            │ writes status back to the doc
   └─ "Run" ─────────► POST /api/run ─────┘ workflow_dispatch
```

## Requirements

**Node 22 or newer.** `firebase-admin@14` declares `node >= 22`, and it pulls
`@google-cloud/firestore` in as an *optional* dependency gated on the same
engine. On older Node, `npm install` silently skips it and the app dies at
runtime with `Cannot find module '@google-cloud/firestore'` rather than failing
at install time. If you see that error, check `node -v` first.

## Setup

```bash
nvm use                # reads .nvmrc -> Node 22
npm install
cp .env.example .env   # then fill it in
npm start              # http://localhost:3000
```

`.env` is gitignored. The values are documented inline in `.env.example`; the
ones specific to the console are:

| Variable | Purpose |
|---|---|
| `APP_KEY` | The key you type on the login screen. Use a long random string. |
| `JWT_SECRET` | Signs session cookies. Changing it signs everyone out. |
| `JWT_EXPIRES_IN` | Session lifetime (`30m`, `2h`, `12h`…). Default `2h`. |
| `GITHUB_TOKEN` | PAT used only to fire `workflow_dispatch`. |
| `GITHUB_REPO` | `owner/repo`. |

The Firestore and Drive variables are the same ones the workflow already uses as
repository secrets.

### GitHub token scope

The token needs permission to start workflow runs and nothing more:

- **Fine-grained** → Repository permissions → **Actions: Read and write**
- **Classic** → `repo` scope (`public_repo` if the repo is public)

### Behind a TLS-intercepting proxy

If **Run pending links** fails with `fetch failed (SELF_SIGNED_CERT_IN_CHAIN)`,
you are on a network that re-signs TLS (common on corporate machines). `curl`
works because it trusts the system CA store; Node ships its own bundle and
rejects the proxy's root. Point Node at the system store:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start
```

`--use-openssl-ca` does *not* fix this — only `NODE_EXTRA_CA_CERTS` does. This
affects the console only; the workflow runs on a GitHub runner with no proxy.

### Auth model

Login posts `APP_KEY` to `/api/login`, which compares it in constant time and,
on a match, returns an **httpOnly / SameSite=Lax** cookie holding a signed JWT.
Every `/api/*` route except login requires that cookie; any 401 — expired,
missing, or tampered — drops the UI back to the login screen with a reason.
Failed logins are throttled to 8 per IP per 5 minutes, in memory.

`GET /` is rendered per request from that cookie: the server stamps which screen
starts visible into `views/index.html`, so the first paint is already correct and
the page makes no auth round trip on load. It is sent `no-store` + `Vary: Cookie`
so no cache can serve the signed-in shell to a signed-out visitor.

This is a UX measure, not a security boundary — the page is an empty shell and
all data comes from the cookie-gated `/api/*` routes.

### Layout

```
views/index.html   template, rendered by GET / (never served statically)
public/app.js      all client logic
public/style.css
server.js          API + page rendering
FileUploader.js    the Actions job
firebase/          Firestore config + queries, shared by both
```

Because the key is a single shared secret, **serve this over HTTPS** if it is
reachable from anywhere but localhost. `secure` is set on the cookie whenever
`NODE_ENV=production`.

## Running the job

Three ways to start a run, all of which drain every link with
`completed: false`:

1. The **Run pending links** button in the console.
2. The **Run workflow** button on the Actions tab.
3. Any push to `main`.

A `concurrency` group keeps a second dispatch queued behind the first, so two
runs can't both claim the same links.

## Deploying the console

Only the console (Express + UI) deploys to Netlify or Vercel. The uploader itself
stays on GitHub Actions — it streams multi-gigabyte files and runs for up to two
hours, which no serverless function can host. The deployed console's only job is
to read/write Firestore and POST the dispatch.

`server.js` exports the app and binds a port only when it is the process entry
point, so the same file serves local `npm start` and both platforms.

### Vercel

`vercel.json` + `api/index.js` are ready to go. The Vercel Node runtime calls a
module's export as `(req, res)`, which is an Express app's own signature, so no
adapter is needed.

```
vercel env add APP_KEY                 # and each var below
vercel --prod
```

`includeFiles: "{views,public}/**"` is required: `views/index.html` is read at
request time with `fs.readFile()`, so no bundler can infer it by static analysis.

### Netlify

`netlify.toml` + `netlify/functions/server.js` are ready to go. Netlify Functions
are Lambda-shaped `(event, context)`, so `serverless-http` adapts the app.

```
netlify env:set APP_KEY "..."          # and each var below
netlify deploy --prod
```

`publish = "public"` makes the browser assets CDN-served; the `/*` redirect has
no `force`, so real files in `public/` win and only misses reach the function.
`views/` is deliberately outside the publish directory — it is a template with
`{{...}}` placeholders that the function stamps per request, and serving it
statically would leak an unrendered page.

### Environment variables to set on the platform

Everything from `.env.example` except `PORT`:
`APP_KEY`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `GITHUB_TOKEN`, `GITHUB_REPO`,
`GITHUB_WORKFLOW_FILE`, `GITHUB_REF`, `FIREBASE_PROJECT_ID`,
`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `URL_COLLECTION_NAME`.

Two notes:

- Set `NODE_ENV=production` so the session cookie gets the `Secure` flag.
  `netlify.toml` already does this; on Vercel it is set automatically.
- `FIREBASE_PRIVATE_KEY` is multi-line. Paste it with literal `\n` escapes —
  `firebase/config.js` un-escapes them. Pasting real newlines into a dashboard
  field usually truncates the key at the first line.

### Brute-force protection is weaker when serverless

The login lockout (8 attempts per IP, 5-minute window) is an in-memory `Map`.
That works on one long-lived process, but each serverless instance keeps its own
copy and cold starts reset it, so an attacker spreading attempts across instances
faces a much higher effective ceiling.

Nothing else regresses — the JWT is stateless and signature-verified, so sessions
work fine across instances. But since `APP_KEY` is a single static secret and it
is now the only real barrier, **use a long random key**:

```
openssl rand -base64 32
```

If you want the lockout to hold for real, back it with a shared store
(Upstash Redis, Vercel KV) instead of the `Map` in `server.js`.

## API

All routes are JSON. Everything except `/api/login` requires the session cookie.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/login` | `{ key }` → sets the session cookie |
| `POST` | `/api/logout` | Clears the cookie |
| `GET` | `/api/session` | Returns `{ expiresAt }`, used to skip the login screen |
| `GET` | `/api/links` | All links, newest first |
| `POST` | `/api/links` | `{ url, filename?, customHeaders? }` → queues a link |
| `POST` | `/api/links/:id/retry` | Resets a link to `Not Started` |
| `DELETE` | `/api/links/:id` | Removes one link |
| `POST` | `/api/links/completed` | Bulk-deletes completed links |
| `POST` | `/api/run` | Fires `workflow_dispatch` |

## Firestore document shape

Collection name comes from `URL_COLLECTION_NAME`.

```js
{
  data: { url: "https://…", filename: "" },  // filename blank → auto-generated
  completed: false,
  status: "Not Started",                     // job overwrites as it progresses
  customHeaders: { Referer: "https://…" },   // merged into both requests
  createdAt: "Mon Sep 29 2026 …",            // Date().toString(), not a Timestamp
  updatedAt: "Mon Sep 29 2026 …"
}
```

`status` moves through `Not Started` → `Started` → `Starting download` →
`Uploading to Drive...` → `Upload Complete`. On failure the error message is
written into `status` and `completed` stays `false`.

## Known limitations

These predate the console and are unchanged by it:

- **Interrupted runs leave links stuck.** The job installs no signal handler, so
  hitting the job timeout or cancelling a run freezes docs mid-status with
  `completed: false`. The next run restarts them from byte zero. Use **Retry**
  to reset anything wedged.
- **No bounded concurrency.** `run_job()` starts every pending link at once
  without awaiting, so a large queue contends for one runner's bandwidth.
- **Exit code is always 0.** A run shows green even if every link failed — the
  console's status column is the real signal.
- **Uploads aren't resumable.** A mid-transfer network drop fails the whole file.
- **Filenames collide.** Links without an explicit `filename` are named from the
  current timestamp with no extension.
