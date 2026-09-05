# 🎧 spotify-tv-jam / RAMTECH OS

> **Repo layout:** the TV dashboard app lives in [`app/`](app/), the RAMTECH
> device-manager web UI in [`admin/`](admin/), the bootable OS image build in
> [`os/`](os/), and the one-click USB writer in [`imager/`](imager/) — see
> **RAMTECH OS live USB** at the bottom.
> `start.bat` / `start.sh` still run the app from the repo root as before.

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

### 5. Weather, clock & countdown
The **weather place** and an optional **countdown** (e.g. "⏳ 42 days until
Kickoff", shown under the clock; flips to a live timer in the last 48 h) are
set from the **/setup page → Dashboard preferences** — no restart needed.
`.env` values act as defaults:
```
WEATHER_CITY=San Francisco
TEMP_UNIT=fahrenheit      # or celsius
CLOCK_24H=false           # true for 24-hour time
COUNTDOWN_DATE=2026-12-31 # optional; /setup value wins
COUNTDOWN_LABEL=New Year
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

## Run it on a machine you already have (manual install)

Turn any Debian/Ubuntu box into a plug-in-and-go dashboard that boots straight
into the TV view. For a Promethean panel you almost certainly want the
**live USB** instead (bottom of this file) — it installs nothing.

```bash
git clone <this repo> ~/spotify-tv-jam
cd ~/spotify-tv-jam
bash deploy/install.sh      # installs Node + Chromium, sets up auto-start
sudo reboot
```

`deploy/install.sh` (Debian/Ubuntu/Armbian, ARM64-flavoured):
- installs Node 20 + Chromium if missing,
- runs the server as a **systemd service** (`spotify-tv-jam`, auto-restart on crash/boot),
- adds a **desktop auto-start** that opens Chromium full-screen on the dashboard (`deploy/kiosk.sh`).

Logs: `journalctl -u spotify-tv-jam -f`. It runs **entirely on the box** — the
Cloudflare tunnel is only the public address the Jam QR points at.

**Branding:** drop your logo at `public/ramtech-logo.png`.

**Locked-down setup:** because the tunnel makes `/setup` public, *changing* anything
requires a **6-digit code shown only on the TV** (loopback-only). View the page from
anywhere; you can only edit it if you can see the screen. Requests from the Pi itself
skip the code.

**Audio:** ARM Chromium can't do Spotify's DRM web player, so `install.sh` sets the
box up to play through **librespot** (installed as `raspotify`) — a headless Spotify
Connect device named **RAMTECH TV**. One-time: on your phone's Spotify app (same
account, **Premium**), open the devices menu and tap **RAMTECH TV** once to authorize
it; it then reconnects on its own forever. On x86 this sidecar isn't needed — see the
live USB section, which ships Google Chrome and plays through the Web Playback SDK.

**Playback rule:** music plays **only while someone else is in the Jam**, and
**joining is what starts it**: Spotify gives remote guests no way to start the
host's playback (a guest pressing play on their phone starts *local* playback and
drops them out of the Jam), so the host must be playing for guest phones to mirror
the Jam and queue into it. Boot is silent (the seed playlist is loaded but paused —
just enough for the QR to appear); the first guest joining starts playback once;
a deliberate pause mid-Jam is respected, not fought; the last guest leaving pauses
it again (`JAM_PLAY_ON_GUEST=true` controls all of this).

## File map
```
app/server.js       Express server + /api/state + setup/OAuth routes + server-side QR
app/lib/auth.js     Sign-in flow (PKCE), token store (.data/auth.json), self-signed TLS
app/lib/tunnel.js   Cloudflare quick tunnel (public address for setup + the Jam QR)
app/lib/spotify.js  Web API (now playing, queue) + Jam session + join-URL builder
app/lib/webtoken.js Mints the Jam web token via the logged-in browser (no TOTP forgery)
app/lib/remote.js   Phone-driven remote Spotify sign-in (CDP screen-share) + browser finder
app/lib/weather.js  Open-Meteo geocode + current conditions
app/lib/demo.js     Fake data for DEMO=true
app/public/         The TV UI (index.html, style.css, app.js), player.js
                    (Web Playback SDK), and setup.html (OTP-gated phone sign-in)
app/deploy/kiosk.sh Kiosk browser launcher (used by the OS image + install.sh)
app/.data/          Generated at runtime: tokens, TLS cert, cloudflared (gitignored)
admin/              RAMTECH device manager web UI (port 8080) — see below
os/                 RAMTECH OS live-USB image build (Debian live-build) — see below
os/overlay/         What gets baked into the image: systemd units, OTA scripts,
                    kiosk session, branding, seeded .env
imager/             RAMTECH Imager — the Electron GUI that writes the image to USB
deploy/install.sh   Manual installer for an existing Debian/Armbian board
.github/workflows/  release.yml: tag v* → OTA tarball on GitHub Releases
```

---

# 🖥 RAMTECH OS live USB (x86 / Promethean OPS)

A bootable USB stick that turns the **OPS module** in a Promethean panel — or
any x86 mini PC — into the dashboard. Nothing is installed on the panel: pull
the stick out and the machine boots back into whatever it ran before.

The whole process is two steps.

## 1. Write the stick

Open **RAMTECH Imager**, pick a USB stick, press **Write**.


It downloads the latest image from this repo's GitHub Releases (cached, so the
second stick is instant), checks its SHA-256, erases the stick, writes it and
reads it back to verify. Nothing to configure and no partitioning to do — the
persistence partition is already inside the image.

```bash
cd imager
npm install
npm start           # or `npm run dist` to build an installer
```
Windows needs Administrator (the app asks and restarts itself); macOS and Linux
prompt for a password when the write starts. If you'd rather not run it,
**balenaEtcher** and **Rufus** both open the `.img.gz` directly and do the same
job — the imager just removes the "which of these 14 options do I pick" problem.

## 2. Boot the panel from it

1. Plug the stick into a **USB port on the OPS module** — the PC in the bay at
   the back of the panel, not a panel-front port (those are wired to Android).
2. Power on and press the boot-menu key: **F7** on most Promethean OPS modules,
   sometimes **F12** or **Esc**. Pick the USB stick.
3. To make it permanent, put the stick first in the boot order in BIOS setup
   (**Del** or **F2**).

The image is **Secure Boot signed** (Debian's shim), so it boots without turning
Secure Boot off. It boots UEFI; the BIOS/CSM path is best-effort.

The boot menu shows for two seconds and then starts on its own — a panel has no
keyboard, and live-build's stock templates wait at that menu forever. Press a key
during those two seconds to reach the fail-safe entry.

First boot lands on the dashboard's **"Scan to set up"** QR — sign in to Spotify
from a phone exactly as described at the top of this file. That sign-in is
written to the stick's persistence partition and is still there after a reboot.

## What's on the stick
- Debian **trixie** live system, branded RAMTECH OS, built with `live-build`
- Boots keyboard-free: autologin → X11 → **Google Chrome** kiosk on `localhost:3000`
- `spotify-tv-jam` + `ramtech-admin` as systemd services
- **The panel plays the music itself.** Google Chrome ships Widevine, so the
  Spotify Web Playback SDK works and the panel appears as the **RAMTECH TV**
  Connect device — no librespot sidecar, unlike the ARM build
- A **4 GB ext4 persistence partition** mounted `/ union`: Spotify tokens,
  admin settings, Wi-Fi and OTA-installed app versions all survive reboots
- App under `/opt/ramtech/releases/<ver>` with a `current` symlink; state in
  `/opt/ramtech/data`

Console login (plug in a keyboard, Ctrl+Alt+F2): `ramtech` / `ramtech`. Root is
locked. Anyone holding the stick owns it — treat it like a key, not a password.

## Device manager (port 8080)
`http://ramtech.local:8080` — default password **`ramtech`** (a change is
forced on first login). Status/temps, service control, journals, Wi-Fi,
hostname, apt upgrades, reboot — and **Software update**: checks this repo's
GitHub Releases, installs atomically, health-checks the app and **rolls back
automatically** if the new version doesn't come up. Optional daily auto-update
timer. Updates land on the persistence partition, so they stick.

## Building the image yourself
```bash
bash os/build.sh                  # ~30 min the first time, ~15 after
bash os/build.sh --clean          # throw away the package cache too
bash os/build.sh --smoke-test     # then boot the result in QEMU and screenshot it
PERSIST_MB=8192 bash os/build.sh  # a bigger persistence partition
```
The first run downloads roughly 1.5 GB of Debian packages; later runs reuse them
from a Docker volume, so most of the time goes on squashfs and gzip.
The only requirement is **Docker** — the build runs in the Debian container from
[`os/Dockerfile`](os/Dockerfile), so the command is the same on Windows (Git
Bash), macOS and Linux. Output lands in `os/out/`:

| file | what it is |
| --- | --- |
| `ramtech-os-<ver>-x86_64.img.gz` | the USB image, gzip so the imager can stream it with no dependencies |
| `ramtech-os-<ver>-x86_64.img.gz.sha256` | what the imager checks the download against |
| `ramtech-os-<ver>-x86_64.iso` | the same system as a plain ISO, for VMs — **no persistence** |
| `build.log` | the full live-build log |

The build bakes in the **latest GitHub release** of the app (repo set in
[`os/overlay/seed/repo.txt`](os/overlay/seed/repo.txt)); drop a
`ramtech-app-<ver>.tar.gz` into `os/overlay/seed/` to build fully offline.

**How the image is put together** — `live-build` produces a hybrid ISO, and then
[`os/finish-image.sh`](os/finish-image.sh) appends a labelled ext4 `ramtech-data`
partition to it and writes `persistence.conf` inside. Baking the partition in
rather than creating it on the stick is what lets the imager be one click on
Windows, which cannot format ext4. The finished layout:

```
1  1.2 GB  bootable  the ISO itself (squashfs, kernel, initrd)
2  3.3 MB  EFI       the ESP, embedded in the ISO — Debian's signed shim + GRUB
3  4.0 GB  Linux     ext4 "ramtech-data", persistence.conf = "/ union"
```

## Releasing an update (OTA)
```bash
git tag v1.2.3 && git push origin v1.2.3
```
CI builds `ramtech-app-v1.2.3.tar.gz` (app + admin + updater, node_modules
bundled), publishes a GitHub Release, then builds the OS image against that
release and attaches it too. Existing sticks pick the app up via **Check** in
the device manager or the daily timer; the imager offers the new image to
anyone writing a fresh stick.
