# 🎧 spotify-tv-jam

A full-screen "listening party" dashboard for a TV. It shows:

- **Now playing** — big album art, track, artist, live progress bar
- **Up next** — the live queue, each song tagged with **who added it**
- **Jam QR code** — auto-generated from your live Spotify Jam; guests scan it to join and add songs
- **Clock, date, and weather** — top bar, updates on its own

Point a browser on your TV at it, full-screen it, done.

---

## Want to see it first? (no setup)

Just double-click **`preview.html`**. It opens in any browser and shows the
exact design with fake demo data (needs internet for the demo album art + QR).
No Node, no Spotify account required. Use this to judge the look.

---

## Running the real thing

### 0. Requirements
- [Node.js 18+](https://nodejs.org)
- A Spotify **Premium** account (playback/queue API needs Premium)

### 1. Install & run
```bash
cd spotify-tv-jam
npm install
npm start
```
Open **http://localhost:3000** on the TV (or `http://<your-computer-ip>:3000`
from any device on the network) and full-screen it.

### 2. Sign in — scan the QR on the TV 📱
The first time it runs, the TV shows a big **"Scan to set up"** QR code.
While it boots, the server opens a temporary **public setup link** through a
Cloudflare quick tunnel (`https://<random>.trycloudflare.com` — cloudflared is
auto-downloaded on first use); the QR points at it. Scan it with your phone
and follow the steps on the page that opens:

1. **Spotify app credentials** — create an app in the
   [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
   add the **Redirect URI(s)** shown on the setup page (copy buttons
   provided — the trycloudflare one is first), and paste the app's
   **Client ID**. No client secret needed (sign-in uses PKCE).
2. **Sign in with Spotify** — tap the button, approve on Spotify, and you
   bounce straight back. The server exchanges and stores the tokens itself
   (`.data/auth.json`) and keeps itself signed in from then on — no curl,
   no copying tokens.
3. The TV flips to the dashboard automatically. The public tunnel closes
   itself a couple of minutes later — your dashboard is never left exposed.

You can revisit the setup page any time at `http://127.0.0.1:3000/setup` on
the machine itself (or `https://<your-ip>:3443/setup` on the LAN) to
reconnect, disconnect, or add the Jam cookie.

> **Notes on the tunnel:** the trycloudflare URL is random on every server
> start, so the redirect URI you register is the one shown *at that moment* —
> that's fine, setup is a one-time thing. Anyone who guesses the random URL
> during setup could see the (not-yet-signed-in) setup page; it auto-closes
> after sign-in. Set `TUNNEL=false` in `.env` to disable tunnels entirely.
>
> **Without the tunnel** (offline, or `TUNNEL=false`): the QR falls back to
> the server's self-signed HTTPS listener (`https://<your-ip>:3443/setup`).
> Spotify requires HTTPS redirect URIs, hence the self-signed cert — your
> phone shows a one-time "connection not private" warning, tap *Advanced →
> Continue*. If the dashboard rejects the LAN `https://…` URI, sign in once
> from a browser **on the computer running the server** at
> `http://127.0.0.1:3000/setup` — loopback is always accepted.

### 3. The Jam auto-QR + "who added" (optional — the `sp_dc` cookie)
Spotify's **Jam** feature has **no official API**, so the app reads it through
the same internal endpoints the web player uses. That needs your logged-in web
session cookie — this is the one thing that can't be automated:

1. In a desktop browser, log into **https://open.spotify.com**.
2. Open DevTools → **Application** (Chrome) or **Storage** (Firefox) → **Cookies** → `https://open.spotify.com`.
3. Paste the value of the **`sp_dc`** cookie into step 3 of the setup page
   (or into `SPOTIFY_SP_DC` in `.env`).

That cookie is long-lived (months). Treat it like a password — anyone with it
can act as your Spotify login. Skip it and everything except the Jam QR /
contributor names still works.

> **How the QR works:** with `sp_dc` set, the server **starts the Jam by
> itself** as soon as music is playing on any of your devices (it calls the
> same `current_or_new` endpoint the web player uses) and renders the join
> link as a QR. Guests scan → land in your Jam → their additions show up in
> **Up next** with their name. Prefer starting Jams manually from the phone
> app? Set `JAM_AUTO_CREATE=false` — the dashboard then just detects the
> session you start.

### 4. Play music on the TV itself (web player)
With `WEBPLAYER=true` (the default), the dashboard loads Spotify's **Web
Playback SDK** and the TV shows up as a Spotify Connect device named **TV Jam**
(change with `WEBPLAYER_NAME`). This means the TV can play music on its own —
so the Jam has an active device and comes up **with no phone or computer
needed**.

- **Requires Spotify Premium** (an SDK requirement).
- If you signed in before this feature existed, **reconnect once** at `/setup`
  — sign-in now also asks for the `streaming` permission. The TV will prompt
  "Reconnect Spotify to enable playback" if the scope is missing.
- **First play needs one tap** (browsers block autoplay): the TV shows a
  **"▶ Play on this TV"** button; tap it and playback starts on the TV and the
  Jam auto-creates. To skip even that tap in kiosk mode, launch Chromium with
  `--autoplay-policy=no-user-gesture-required` (the bundled `start.bat` already
  does this) and it starts on its own.
- Needs a browser with EME/Widevine (Chrome, Edge, Firefox, Chromium kiosk —
  most smart-TV built-in browsers do **not** qualify; use a Pi/mini-PC).
- Set `WEBPLAYER=false` to turn the TV back into a display-only dashboard.

### 5. Weather + clock
In `.env`:
```
WEATHER_CITY=San Francisco
TEMP_UNIT=fahrenheit      # or celsius
CLOCK_24H=false           # true for 24-hour time
```
Weather uses Open-Meteo — free, no API key.

---

## Putting it on the TV
- **Smart TV / browser:** just navigate to `http://<your-computer-ip>:3000` and full-screen.
- **Raspberry Pi / mini PC (recommended, rock solid):** run the server, then launch Chromium in kiosk mode:
  ```bash
  chromium-browser --kiosk --incognito http://localhost:3000
  ```
- **Chromecast/AirPlay:** cast the browser tab.

Keep the machine running the server on the same network as the TV.

---

## Fallback if the Jam lookup can't find a session
The internal Jam endpoints are undocumented and Spotify changes them occasionally.
If the app can't resolve a live Jam, it will:
1. Still show now-playing + queue perfectly (that's the stable Web API).
2. Render `JAM_URL_FALLBACK` as the QR if you set one in `.env` — paste any Jam invite
   link there as a manual backstop.
3. Otherwise show "Start a Jam on your phone to activate."

Per-song "added by" names come from the Jam session data; songs added outside a Jam
(or when the session doesn't expose the adder) simply show without a name.

---

## Notes & caveats
- The `sp_dc` / social-connect approach is **unofficial**. It works today but isn't
  guaranteed by Spotify and may break if they change their internal API — this is the
  only way to get Jam data, since the public API doesn't expose it.
- Everything degrades gracefully: if the Jam or weather calls fail, the rest keeps working.
- Requires Spotify **Premium** for the playback/queue endpoints.
- If the stored sign-in is ever revoked, the TV automatically falls back to the
  "Scan to set up" screen.
- `.env` values still work as overrides/seeds (e.g. a hand-obtained
  `SPOTIFY_REFRESH_TOKEN`); anything saved via `/setup` wins.

## Run on an Orange Pi 5 (kiosk appliance)

Turn a board into a plug-in-and-go dashboard that boots straight into the TV view.

```bash
git clone <this repo> ~/spotify-tv-jam
cd ~/spotify-tv-jam
bash deploy/install.sh      # installs Node + Chromium, sets up auto-start
sudo reboot
```

`deploy/install.sh` (Debian/Ubuntu/Armbian ARM64):
- installs Node 20 + Chromium if missing,
- runs the server as a **systemd service** (`spotify-tv-jam`, auto-restart on crash/boot),
- adds a **desktop auto-start** that opens Chromium full-screen on the dashboard (`deploy/kiosk.sh`).

Logs: `journalctl -u spotify-tv-jam -f`. It runs **entirely on the Pi** — the
Cloudflare tunnel is only the public address the Jam QR points at.

**Branding:** drop your logo at `public/ramtech-logo.png`.

**Locked-down setup:** because the tunnel makes `/setup` public, *changing* anything
requires a **6-digit code shown only on the TV** (loopback-only). View the page from
anywhere; you can only edit it if you can see the screen. Requests from the Pi itself
skip the code.

**Audio on the Pi:** ARM Chromium can't do Spotify's DRM web player, so the Pi plays
through **librespot** (installed as `raspotify` by `install.sh`) — a headless Spotify
Connect device named **RAMTECH TV**. One-time: on your phone's Spotify app (same
account, **Premium**), open the devices menu and tap **RAMTECH TV** once to authorize
it; it then reconnects on its own forever.

**Playback rule:** music plays **only while someone else is in the Jam** — the server
starts it on the Pi when a guest joins and pauses when the last guest leaves
(`JAM_PLAY_ON_GUEST=true`). Scanning the QR just joins the Jam; the join is what
triggers playback.

## File map
```
server.js         Express server + /api/state + setup/OAuth routes + server-side QR
lib/auth.js       Sign-in flow (PKCE), token store (.data/auth.json), self-signed TLS
lib/tunnel.js     Cloudflare quick tunnel (public address for setup + the Jam QR)
lib/spotify.js    Web API (now playing, queue) + Jam session + join-URL builder
lib/webtoken.js   Mints the Jam web token via the logged-in browser (no TOTP forgery)
lib/remote.js     Phone-driven remote Spotify sign-in (CDP screen-share) + browser finder
lib/weather.js    Open-Meteo geocode + current conditions
lib/demo.js       Fake data for DEMO=true
public/           The TV UI (index.html, style.css, app.js), player.js
                  (Web Playback SDK), and setup.html (OTP-gated phone sign-in)
deploy/           Orange Pi installer: install.sh, kiosk.sh, systemd service
.data/            Generated at runtime: tokens, TLS cert, cloudflared, PID (gitignored)
```
