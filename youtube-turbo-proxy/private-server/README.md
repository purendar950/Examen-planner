# Private tunnel server

Run the existing `youtube-turbo-proxy` Flask API on a phone, mini PC, VPS, or
home server and publish only its loopback listener through an HTTPS tunnel.
The frontend continues to use Firebase authentication; the tunnel hides the
origin address but does not replace API authorization.

## Supported hosts

- Linux servers and single-board computers.
- macOS for development.
- Android through Termux + `proot-distro` Ubuntu for personal always-plugged-in
  use.

Do not expose port `8080` directly to the internet. Keep the API bound to
loopback and publish it with Cloudflare Tunnel, Tailscale Funnel, or another
authenticated HTTPS proxy.

## Install and start

From the repository root:

```sh
cd youtube-turbo-proxy/private-server
./setup.sh
cp private.env.example private.env
$EDITOR private.env
./start.sh
```

`setup.sh` creates `.venv`, installs Python dependencies, clones/builds the
matching bgutil PO-token provider, and installs its yt-dlp plugin. It can be
run again after pulling updates. `start.sh` starts both the PO-token provider
and Gunicorn on `127.0.0.1:8080`.

Secrets stay in `private.env`, which is ignored by Git. The example loads them
from files outside the repository rather than storing secret values inline.

## Cloudflare Tunnel quick test

With the API running:

```sh
cloudflared tunnel --url http://127.0.0.1:8080
```

Use the printed `https://*.trycloudflare.com` URL for a temporary test. For a
stable URL, create a named Cloudflare Tunnel and use
`cloudflared.example.yml` as the ingress template.

Stable Cloudflare Tunnel setup:

```sh
cloudflared tunnel login
cloudflared tunnel create examzen-api
cloudflared tunnel route dns examzen-api examzen-api.example.com
cloudflared --config cloudflared.example.yml tunnel run examzen-api
```

Replace the UUID, credentials path, and hostname in the YAML first. Install the
tunnel as a system service after a successful test:

```sh
sudo cloudflared service install
```

For an always-on Linux host, copy `examzen-private.service` to
`/etc/systemd/system/`, set its `User`, paths, and environment-file location,
then enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now examzen-private.service
```

## Connect ExamZen

1. Open Admin → configuration → Server Role Routing.
2. Add the HTTPS tunnel URL as a backend server.
3. Enable it for **media**, **AI**, or both.
4. Set that route's mode to **strict** so requests do not fail back to Render.

The URL must be HTTPS when the GitHub Pages frontend is loaded over HTTPS.
CORS already permits your GitHub Pages origin through the app defaults or
`ALLOWED_ORIGINS`; never use a wildcard origin.

## Operational notes

- Keep one Gunicorn worker on small devices; increase workers only after
  checking memory headroom.
- On Android, run the server inside an Ubuntu proot rather than installing its
  GNU Python/Node dependencies directly in Termux. Keep the phone plugged in,
  disable battery optimization for Termux, and run `termux-wake-lock`.
- Configure `FIREBASE_SERVICE_ACCOUNT` so Firebase tokens and Firestore AI
  settings work exactly as on Render.
- Configure YouTube cookies and AI keys through Firestore or `private.env`.
- Check `http://127.0.0.1:8080/health` before exposing the tunnel.

## Android: Termux + Ubuntu

Install Termux from F-Droid or its GitHub releases—not the outdated Play Store
build—then run these commands in Termux:

```sh
pkg update && pkg upgrade -y
pkg install -y proot-distro termux-api
proot-distro install ubuntu
termux-wake-lock
proot-distro login ubuntu
```

Inside Ubuntu:

```sh
apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip git curl unzip \
  ca-certificates nodejs npm procps
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
git clone https://github.com/purendar950/Examen-planner.git /opt/examzen
cd /opt/examzen/youtube-turbo-proxy/private-server
./setup.sh
cp private.env.example private.env
nano private.env
./start.sh
```

Leave that Ubuntu session running. Open a second Termux session, enter the same
Ubuntu container with `proot-distro login ubuntu`, install `cloudflared`, and
run either the quick test above or your named tunnel configuration.
