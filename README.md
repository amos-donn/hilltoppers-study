# StudyStream

A Hilltoppers Topping for studying with one classmate at a time: a text chat
and a screen share, side by side, while you both work. It is a plain website
that the extension embeds in the Topping panel, so nothing here touches the
extension itself.

- The website (this repo, served by GitHub Pages) is the Topping.
- The Worker (`worker/`) hands out short lookup codes and authorizes rooms.
- Chat and screen sharing go straight between the two browsers. The Worker
  never sees a message or a pixel.

![The home view](docs/home.png)
![The session view](docs/session.png)

## How a session works

1. Each account gets a 6-character code. Ambiguous letters (O/0, I/1) are left
   out so a code can be read aloud. The code is public; the long account id
   behind it never is.
2. Enter a classmate's code to invite them, or share your own code and wait.
3. The invited side accepts. Only one side dials through PeerJS, so exactly one
   chat channel and one screen call exist per room.
4. Either side can share a screen. A room is 1:1 and ends after two hours.

## Look and feel

The Topping matches the Hilltoppers popup rather than inventing its own style:
the same light surface (`#f7f8fb` behind white cards), the same SJA green
accent (`#1a7f37`), the same system font stack, and the same card, button and
input shapes and border colours. A classmate who opens it should not be able to
tell it was built separately.

## Layout

The panel is about **318 × 360 px**. The page is built to that width: the layout
uses no fixed pixel widths, text wraps, and the chat and buttons stay inside the
card. It follows the Topping conventions in the Hilltoppers repo:

- `[data-topping-content]` wraps everything and is measured by `resize.js`,
  which reports the natural height back to the extension for **Fit content**
  height mode.
- The page is embeddable in an iframe (no `X-Frame-Options`, no framing CSP).
- Because the Topping iframe is `sandbox="allow-scripts ..."` without
  `allow-modals`, `window.confirm`/`alert` are blocked, so confirmations are
  in-page overlays. `localStorage` is also blocked in a sandboxed cross-origin
  frame, so every access is guarded and the app still runs.

## Screen sharing needs one change in Hilltoppers

The extension embeds Toppings in an iframe that does **not** currently carry
`allow="display-capture"`. In a cross-origin frame, the browser then refuses
`getDisplayMedia` with:

> NotAllowedError: Access to the feature "display-capture" is disallowed by
> permissions policy.

So the screen share cannot start until the Topping iframe is granted that
permission. The fix is one attribute in
`chrome-extension/src/popup/Toppings.tsx`:

```diff
 <iframe ref={frame} src={source.href} title={`${topping.name} topping`}
+  allow="display-capture"
   sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
   referrerPolicy="no-referrer" />
```

Until then the app is fully usable for chat and the Share button explains that
screen sharing is blocked, rather than failing silently.

## Relay (TURN), for school networks

Even once the iframe allows capture, two browsers still have to find a network
path to each other. On many school networks they cannot: the network blocks the
direct peer-to-peer route. Chat usually still works because it is small, but a
screen share is a continuous stream and cannot, so it looks like "sharing is
broken on school wifi".

The fix is a relay, or TURN, server. The Worker hands out short-lived Cloudflare
TURN credentials from `/api/turn`, and the app adds them to the connection
automatically. The TURN key stays on the server; students only ever get a
credential that expires in a few hours.

To turn it on, in the Cloudflare dashboard:

1. Go to **Realtime → TURN**, create a **TURN key**, and copy its **Key ID**.
2. Create an **API token** with the *Calls Write* (and *Realtime*) permission.
3. Add both to the Worker as secrets: **Settings → Variables and Secrets →
   Add → Secret**, named `TURN_KEY_ID` and `TURN_API_TOKEN`.

(If you have a terminal, the same two are set with
`npx wrangler secret put TURN_KEY_ID --config ../wrangler.toml` and the same for
`TURN_API_TOKEN`, from inside `worker/`.)

While those are unset, `/api/turn` answers `{"configured":false}` and the app
quietly falls back to the public PeerJS cloud, which is fine on an open network.
Set both and reload the Topping to switch it on. To check from a browser, open
`https://hilltoppers-study.amos-donn.workers.dev/api/turn` — with the secrets in
place you should see a list of `iceServers` instead of an empty one.

## Deploy

These are the steps that match the current Cloudflare setup: Worker
`hilltoppers-study`, D1 database `studystream-sessions`
(`7cfc650d-c260-4857-b3cc-8f23b36223cb`), binding `DB_BINDING`, and the site at
`https://hilltoppers-study.amos-donn.workers.dev`.

### 1. Worker

`wrangler.toml` lives at the **repository root** because Cloudflare runs the
build from the repo root. It points `main` at `worker/src/index.ts`.

In the Cloudflare dashboard, the Worker's build (Settings → Build) must be:

- **Root directory:** the repository root (leave empty)
- **Build command:** `cd worker && npm ci`
- **Deploy command:** `npx wrangler deploy --config ../wrangler.toml`

If it is left as a static site / assets Worker, the Worker serves the repo files
instead of running the API and `/api/health` returns a bare 404.

**The database tables are created automatically.** The Worker runs the
statements in `worker/schema.sql` on its first request, so there is no
`wrangler d1 execute` step and no terminal needed. After the build is set and the
secret below is added, open
`https://hilltoppers-study.amos-donn.workers.dev/api/setup` once to create the
tables (any API call does it too).

**The signing secret is the one thing to add by hand.** In the dashboard:
Worker → **Settings → Variables and Secrets → Add → Secret**, name
`SESSION_HMAC_KEY`, value any random string of 32+ characters. Without it the
Worker answers `StudyStream is not configured yet`.

If you changed the binding name or database id, keep `wrangler.toml` and the
dashboard in sync. `DB_BINDING` in `wrangler.toml` must match the variable name
the dashboard shows on the Worker's settings page.

`ALLOWED_ORIGINS` in `wrangler.toml` must list the site's origin
(`https://amos-donn.github.io`) so the browser is allowed to call `/api`.

<details>
<summary>Deploying with a terminal instead (optional)</summary>

```sh
cd worker
npm ci
npx wrangler d1 execute studystream-sessions --config ../wrangler.toml --remote --file=schema.sql
npx wrangler secret put SESSION_HMAC_KEY --config ../wrangler.toml
npm run deploy
```

The `d1 execute` line is optional: the Worker creates the tables itself.
</details>

### 2. Website

In `config.js`, set `window.STUDYSTREAM_API` to the deployed Worker URL. Then
serve this repo with GitHub Pages (Settings → Pages → Deploy from a branch →
`main` / root). The Topping URL is the Pages URL.

### 3. Add it to Hilltoppers

Topping Bar → **Preview a Topping**, paste the Pages URL, choose a height mode,
and open it in the popup.

## Checks

```sh
cd worker
npm run typecheck                        # no errors
npm run build                            # wrangler deploy --dry-run
node scripts/manual-test.mjs <worker-url>  # API end to end
```

There are no browser tests. The UI was checked by hand and with a scripted
browser at the Topping width: sign-in, invite and accept across two windows,
two-way chat, the share/stop flow with a stubbed capture stream, the
permission-denied message, and the resize protocol. Screen capture itself needs
a real display and the `allow="display-capture"` change above.

## Privacy

- No email, password, or message content is stored. An account is a random id
  plus a random secret kept only on the student's device.
- Chat and screen media are peer to peer. The Worker learns who is in a room
  together, and only until the room ends.
- `/api` is rate-limited, and stale accounts and rooms are swept hourly.
