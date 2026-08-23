#!/data/data/com.termux/files/usr/bin/bash
# Stream an ExamZen container snapshot directly from a public Google Drive
# folder into proot-distro. The large .tar.gz is never saved as a duplicate
# file; only the tiny encrypted credentials companion is held temporarily.
set -euo pipefail

FOLDER_URL="${1:-}"
RAW_BASE="${EXAMZEN_RAW_BASE:-https://raw.githubusercontent.com/purendar950/Examen-planner/main/termux-server}"
WORK=""

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
usage() { printf 'Usage: %s <public-google-drive-folder-url>\n' "${0##*/}"; }

if [ "$FOLDER_URL" = -h ] || [ "$FOLDER_URL" = --help ]; then usage; exit 0; fi
[ "$#" -eq 1 ] || { usage >&2; exit 1; }
case "$FOLDER_URL" in
  https://drive.google.com/drive/folders/*) ;;
  *) die "Use a Google Drive folder link like: https://drive.google.com/drive/folders/FOLDER_ID" ;;
esac
[ -n "${TERMUX_VERSION:-}" ] || die "Run this in Termux on the new Android device."
command -v pkg >/dev/null || die "Termux package manager 'pkg' was not found."

say "Installing the small restore tools (the server dependencies are not rebuilt)"
pkg install -y python proot-distro gnupg curl \
  || die "Could not install the Termux restore tools."
# Folder JSON and stdout streaming are the gdown 6.x interfaces this helper
# consumes. Pin the supported major and always invoke it through this Python.
python -m pip install --disable-pip-version-check --no-cache-dir --upgrade 'gdown>=6.1,<7' \
  || die "Could not install the supported Google Drive downloader."

warn "One-link mode makes the encrypted credentials file downloadable to anyone who obtains the folder URL."
warn "Its encryption password is the remaining protection; do not publish the URL together with that password."

WORK="$(mktemp -d "${TMPDIR:-$HOME}/examzen-drive-restore.XXXXXX")" \
  || die "Could not create a private temporary directory."
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "Reading the two backup entries from the Drive folder link"
MANIFEST="$WORK/manifest.json"
if ! python -m gdown "$FOLDER_URL" --folder --json --quiet > "$MANIFEST"; then
  die "Could not list the Drive folder with gdown 6.x. Set General access to 'Anyone with the link' (Viewer), then retry."
fi

URLS="$WORK/urls"
python - "$MANIFEST" > "$URLS" <<'PY' || die "The Drive folder must contain exactly one .tar.gz snapshot and one .secrets.tar.gpg companion."
import json
import pathlib
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    entries = json.load(handle)

snapshots = []
secrets = []
for entry in entries:
    name = pathlib.PurePosixPath(entry.get("path", "")).name
    url = entry.get("url", "")
    if name.endswith(".secrets.tar.gpg") and url:
        secrets.append((name, url))
    elif name.endswith(".tar.gz") and url:
        snapshots.append((name, url))

if len(snapshots) != 1 or len(secrets) != 1:
    print(
        f"found {len(snapshots)} snapshots and {len(secrets)} encrypted companions",
        file=sys.stderr,
    )
    raise SystemExit(2)

print(snapshots[0][0])
print(snapshots[0][1])
print(secrets[0][0])
print(secrets[0][1])
PY

mapfile -t DRIVE_ITEMS < "$URLS"
[ "${#DRIVE_ITEMS[@]}" -eq 4 ] || die "Could not understand the Google Drive folder listing."
SNAPSHOT_NAME="${DRIVE_ITEMS[0]}"
SNAPSHOT_URL="${DRIVE_ITEMS[1]}"
SECRETS_NAME="${DRIVE_ITEMS[2]}"
SECRETS_URL="${DRIVE_ITEMS[3]}"
ok "found $SNAPSHOT_NAME and $SECRETS_NAME"

# restore.sh validates the password before consuming the large stdin stream, so
# retain only this tiny encrypted file in a mode-700 temporary directory.
SECRETS_FILE="$WORK/$SECRETS_NAME"
say "Downloading only the encrypted credentials companion"
python -m gdown "$SECRETS_URL" --quiet -O "$SECRETS_FILE" \
  || die "Could not download the encrypted credentials companion."
[ -s "$SECRETS_FILE" ] || die "The encrypted credentials download is empty."
chmod 600 "$SECRETS_FILE"

RESTORE_SCRIPT="$WORK/restore.sh"
curl -fsSL --retry 3 "$RAW_BASE/restore.sh" -o "$RESTORE_SCRIPT" \
  || die "Could not download the ExamZen restore script."
chmod 700 "$RESTORE_SCRIPT"

say "Streaming $SNAPSHOT_NAME directly into Ubuntu restore"
printf '  The 1.5 GB archive is transferred once but is not saved as a second file.\n'
printf '  Keep Termux open. A network interruption requires restarting this restore.\n'
if ! python -m gdown "$SNAPSHOT_URL" -O - --quiet \
    | bash "$RESTORE_SCRIPT" - "$SECRETS_FILE"; then
  warn "Direct restore did not finish. If a partial Ubuntu container was created, remove it before retrying:"
  warn "  proot-distro remove ubuntu"
  die "Google Drive streaming restore failed."
fi

ok "direct Google Drive restore completed; no snapshot archive was retained"
