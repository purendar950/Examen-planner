# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════════
# Sourced by install.sh and start-all.sh. Removes Termux's own binaries from
# PATH so only the container's glibc toolchain is reachable.
#
# WHY THIS EXISTS
# `proot-distro login` does not isolate the environment by default, so Termux's
# PATH (/data/data/com.termux/files/usr/bin) is inherited straight into the
# container. Those are Android/bionic binaries, and leaving them visible defeats
# the whole reason for running a container:
#
#   * `python3` resolves to Termux's instead of Ubuntu's, so the venv is built
#     against bionic and pip hunts for Android wheels for grpcio,
#     google-crc32c and cryptography — the exact multi-hour source builds the
#     container exists to avoid.
#   * `node`/`npm` resolve to Termux's, so node-gyp reports a platform with no
#     published prebuilt `canvas` binary. prebuild-install misses, the build
#     falls back to compiling, and it dies on missing pixman-1/cairo headers.
#     "No package 'pixman-1' found" is a symptom of the wrong toolchain, not of
#     a genuinely missing library — the project's Dockerfile installs neither.
#
# Both failures are silent-until-much-later, which is why this is enforced at
# the top of both scripts rather than documented as a caveat.
# ═══════════════════════════════════════════════════════════════════════════

examzen_strip_termux_from_path() {
  local clean="" dir old_ifs="$IFS"
  IFS=':'
  for dir in $PATH; do
    case "$dir" in
      /data/data/com.termux/*) continue ;;
      "") continue ;;
    esac
    clean="${clean:+$clean:}$dir"
  done
  IFS="$old_ifs"

  case ":$clean:" in
    *":/usr/bin:"*) PATH="$clean" ;;
    # PATH was almost entirely Termux; rebuild from the container defaults so we
    # are not left with an empty or unusable PATH.
    *) PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${clean:+:$clean}" ;;
  esac
  export PATH

  # npm and node also honour these, and they can point back into Termux even
  # after PATH is clean.
  unset NODE_PATH NPM_CONFIG_PREFIX npm_config_prefix 2>/dev/null || true
}

# Fails with a clear message if a required tool still comes from Termux, rather
# than letting the wrong toolchain build something that breaks much later.
examzen_assert_not_termux() {
  local tool="$1" resolved
  resolved="$(command -v "$tool" 2>/dev/null || true)"
  case "$resolved" in
    /data/data/com.termux/*)
      printf '\033[1;31m✖ %s still resolves to Termux (%s).\033[0m\n' "$tool" "$resolved" >&2
      printf '  Run this inside the container, and do not prepend Termux paths to PATH.\n' >&2
      return 1 ;;
  esac
  return 0
}

examzen_strip_termux_from_path
