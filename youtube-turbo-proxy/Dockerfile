# YouTube Turbo Proxy — Python (yt-dlp + Flask) + Node (bgutil PO-token server)
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    BGUTIL_REF=master

# System deps: node (for the PO-token server), git, ffmpeg, curl
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates ffmpeg gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

# Python deps
COPY requirements.txt .
RUN pip install -r requirements.txt

# Build the bgutil PO-token provider server AND install its matching yt-dlp
# plugin from the same source so versions never drift apart.
RUN git clone --depth 1 --branch "${BGUTIL_REF}" \
        https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm install \
    && npx --yes tsc \
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
