#!/usr/bin/env python3
"""Focused tests for live OmniRoute endpoint resolution without importing Flask."""

import os
import re
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

SRC = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
START = SRC.index('OMNIROUTE_DEFAULT_BASE_URL = ')
END = SRC.index('OPENROUTER_VIDEO_URL = ', START)
NS = {"os": os, "re": re, "urllib": urllib}
exec(SRC[START:END], NS)

DEFAULT = "https://precut-uniformly-handsfree.ngrok-free.dev/v1"
RETIRED = "https://squeak-earthly-obliged.ngrok-free.dev/v1"
canonicalize = NS["_canonicalize_omniroute_base_url"]
resolve = NS["_resolve_omniroute_base_url"]
endpoints = NS["_omniroute_endpoints"]


class OmniRouteEndpointTests(unittest.TestCase):
    def test_canonicalizes_supported_base_and_chat_urls(self):
        self.assertEqual(canonicalize("https://next-route.ngrok-free.dev/v1/"),
                         "https://next-route.ngrok-free.dev/v1")
        self.assertEqual(canonicalize(
            "https://NEXT-route.ngrok-free.dev/v1/chat/completions/"),
            "https://next-route.ngrok-free.dev/v1")

    def test_rejects_retired_or_unsafe_targets(self):
        rejected = [
            RETIRED,
            "http://next-route.ngrok-free.dev/v1",
            "https://next-route.ngrok-free.dev:8443/v1",
            "https://user:pass@next-route.ngrok-free.dev/v1",
            "https://next-route.ngrok-free.dev/v1?target=internal",
            "https://next-route.ngrok-free.dev/v1#fragment",
            "https://ngrok-free.dev/v1",
            "https://next-route.ngrok-free.dev.evil.test/v1",
            "https://example.com/v1",
            "https://next-route.ngrok-free.dev/admin",
            "https:\\next-route.ngrok-free.dev\\v1",
        ]
        for value in rejected:
            with self.subTest(value=value):
                self.assertEqual(canonicalize(value), "")

    def test_resolution_precedence_and_retired_migration(self):
        cfg = {
            "studyProvider": "omniroute",
            "studyTransport": "openai_chat",
            "omnirouteBaseUrl": "https://admin-route.ngrok-free.dev/v1",
            "studyBaseUrl": "https://legacy-route.ngrok-free.dev/v1",
        }
        with patch.dict(os.environ, {"OMNIROUTE_URL": "https://env-route.ngrok-free.dev/v1"}):
            self.assertEqual(resolve(cfg), "https://admin-route.ngrok-free.dev/v1")
            cfg.pop("omnirouteBaseUrl")
            self.assertEqual(resolve(cfg), "https://legacy-route.ngrok-free.dev/v1")
            cfg["studyBaseUrl"] = RETIRED
            self.assertEqual(resolve(cfg), "https://env-route.ngrok-free.dev/v1")
            cfg["studyProvider"] = "mistral"
            cfg["studyBaseUrl"] = "https://ignored-route.ngrok-free.dev/v1"
            self.assertEqual(resolve(cfg), "https://env-route.ngrok-free.dev/v1")
        with patch.dict(os.environ, {"OMNIROUTE_URL": RETIRED}):
            self.assertEqual(resolve({}), DEFAULT)

    def test_derives_every_runtime_capability_from_one_base(self):
        base = "https://runtime-route.ngrok-free.dev/v1"
        self.assertEqual(endpoints({"omnirouteBaseUrl": base}), {
            "base": base,
            "chat": base + "/chat/completions",
            "models": base + "/models",
            "images": base + "/images/generations",
            "edits": base + "/images/edits",
            "search": base + "/search",
            "speech": base + "/audio/speech",
            "video": base + "/videos/generations",
        })


if __name__ == "__main__":
    unittest.main(verbosity=2)
