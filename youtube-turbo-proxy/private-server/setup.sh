#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${EXAMZEN_PRIVATE_RUNTIME:-$ROOT/private-server/.private-runtime}"
VENV_DIR="$ROOT/.venv"
BGUTIL_REF="${BGUTIL_REF:-master}"
BGUTIL_DIR="$RUNTIME_DIR/bgutil"

is_termux() {
  [ -n "${TERMUX_VERSION:-}" ]
}

missing=()
for command in python3 git curl unzip node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    missing+=("$command")
  fi
done

if [ "${#missing[@]}" -ne 0 ]; then
  printf 'Missing required tools: %s\n' "${missing[*]}"
  if is_termux; then
    printf 'Install them with:\n  pkg install -y python git curl unzip nodejs-lts\n'
  elif command -v apt-get >/dev/null 2>&1; then
    printf 'Install them with:\n  sudo apt-get install -y python3 python3-venv python3-pip git curl unzip ca-certificates nodejs npm\n'
  else
    printf 'Install these with your platform package manager.\n'
  fi
  exit 1
fi

if ! command -v deno >/dev/null 2>&1; then
  cat <<'EOF'
Deno was not found. Modern YouTube extraction needs a supported JavaScript runtime.
Install Deno for your host, then run this script again. On Termux, prefer the
Termux Deno package or a Node.js 22+ runtime configured through yt-dlp.
EOF
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
. "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip
python -m pip install -r "$ROOT/requirements.txt"

mkdir -p "$RUNTIME_DIR"
if [ ! -f "$BGUTIL_DIR/server/build/main.js" ]; then
  rm -rf "$BGUTIL_DIR"
  git clone --depth 1 --branch "$BGUTIL_REF" \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$BGUTIL_DIR"
fi

(
  cd "$BGUTIL_DIR/server"
  npm install --no-audit --no-fund
  npx --yes tsc
)

python -m pip install "$BGUTIL_DIR/plugin"

cat <<EOF

Private server dependencies are ready.
Next:
  cp private.env.example private.env
  $EDITOR private.env
  ./start.sh
EOF
