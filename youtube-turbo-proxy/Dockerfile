# YouTube Turbo Proxy — Python (yt-dlp + Flask) + Node (bgutil PO-token server)
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    BGUTIL_REF=master

# System deps: node (for the PO-token server), git, ffmpeg, unzip, curl
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates ffmpeg gnupg unzip \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno: the JavaScript runtime yt-dlp uses to solve YouTube's signature and
# n-parameter challenges. Without it, extraction returns incomplete/throttled
# formats ("Requested format is not available"). Installs to /usr/local/bin/deno.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version

WORKDIR /opt/app

# Python deps
COPY requirements.txt .
RUN pip install -r requirements.txt

# Build the bgutil PO-token provider server AND install its matching yt-dlp
# plugin from the same source so versions never drift apart.
#
# upstream/plugin/pyproject.toml points readme at "../README.md" (outside the
# plugin's own build root). Newer hatchling releases (the plugin's build
# backend) reject any readme path that escapes the project directory —
# "ValueError: Readme path must be within the project directory" — which
# broke `pip install /opt/bgutil/plugin` on every build once pip resolved a
# hatchling new enough to enforce that check (no version pin upstream, so
# this could recur again on a future hatchling release). Copying the repo's
# top-level README.md into plugin/ before installing satisfies the check
# without needing a patched fork or an upstream fix — same file, same
# content, just reachable from where hatchling insists on finding it.
RUN git clone --depth 1 --branch "${BGUTIL_REF}" \
        https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm install \
    && npx --yes tsc \
    && cp /opt/bgutil/README.md /opt/bgutil/plugin/README.md \
    && sed -i 's#readme = {file = "\.\./README\.md"#readme = {file = "README.md"#' /opt/bgutil/plugin/pyproject.toml \
    && pip install /opt/bgutil/plugin \
    # Fail the build loudly if the PO-token server didn't compile, instead of
    # silently shipping an image where pot_provider is always false.
    && test -f /opt/bgutil/server/build/main.js

# App code
COPY app.py start.sh ./
RUN chmod +x start.sh

ENV PORT=8080
EXPOSE 8080
CMD ["./start.sh"]
