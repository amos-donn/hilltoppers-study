# StudyStream

A Hilltoppers Topping for studying with one classmate at a time: a text chat
and a screen share, side by side, while you both work. It is a plain website
that the extension embeds in the Topping panel, so nothing here touches the
extension itself.

- The website (this repo, served by GitHub Pages) is the Topping.
- The Worker (`worker/`) hands out short lookup codes and authorizes rooms.
- Chat and screen sharing go straight between the two browsers. The Worker
  never sees a message or a pixel.

![The session view](docs/session.png)

## How a session works

1. Each account gets a 6-character code. Ambiguous letters (O/0, I/1) are left
   out so a code can be read aloud. The code is public; the long account id
   behind it never is.
2. Enter a classmate's code to invite them, or share your own code and wait.
3. The invited side accepts. Only one side dials through PeerJS, so exactly one
   chat channel and one screen call exist per room.
4. Either side can share a screen. A room is 1:1 and ends after two hours.

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

## Deploy

### 1. Worker

```sh
cd worker
npm ci
npx wrangler d1 create studystream-sessions    # copy the id into wrangler.toml
npx wrangler d1 execute studystream-sessions --config wrangler.toml --remote --file=schema.sql
npx wrangler secret put SESSION_HMAC_KEY         # any 32+ character random string
npm run deploy
```

`ALLOWED_ORIGINS` in `wrangler.toml` must list the site's origin
(`https://amos-donn.github.io`) so the browser is allowed to call `/api`.

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
