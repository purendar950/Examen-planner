#!/usr/bin/env python3
"""Focused tests for live OmniRoute endpoint resolution without importing Flask."""

import ipaddress
import os
import re
import secrets
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

SRC = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
START = SRC.index('OMNIROUTE_DEFAULT_BASE_URL = ')
END = SRC.index('OPENROUTER_VIDEO_URL = ', START)
NS = {"ipaddress": ipaddress, "os": os, "re": re, "secrets": secrets, "urllib": urllib}
exec(SRC[START:END], NS)

BROWSER_DIRECT_START = SRC.index("def _browser_direct_provider_configs(")
BROWSER_DIRECT_END = SRC.index('@app.get("/api/ai-chat/status")', BROWSER_DIRECT_START)
BROWSER_NS = {
    "STUDY_PROVIDER_IDS": ("omniroute",),
    "STUDY_TEST_PROVIDERS": {"omniroute": {"transport": "openai_chat"}},
    "IMAGE_PROVIDER_ENDPOINTS": {},
    "_provider_configured": lambda cfg, provider_id: True,
    "_configured_provider_keys": lambda cfg, provider_id: ["test-key"],
    "_study_provider_url": lambda *args: (_ for _ in ()).throw(
        AssertionError("OmniRoute browser-direct must use the explicit public URL")),
    "_omniroute_endpoints": NS["_omniroute_endpoints"],
    "_resolve_omniroute_public_base_url": NS["_resolve_omniroute_public_base_url"],
}
exec(SRC[BROWSER_DIRECT_START:BROWSER_DIRECT_END], BROWSER_NS)

DEFAULT = "https://precut-uniformly-handsfree.ngrok-free.dev/v1"
RETIRED = "https://squeak-earthly-obliged.ngrok-free.dev/v1"
canonicalize = NS["_canonicalize_omniroute_base_url"]
canonicalize_local = NS["_canonicalize_omniroute_local_base_url"]
resolve_public = NS["_resolve_omniroute_public_base_url"]
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
        with patch.dict(os.environ, {
                "OMNIROUTE_LOCAL_URL": "",
                "OMNIROUTE_URL": "https://env-route.ngrok-free.dev/v1"}):
            self.assertEqual(resolve(cfg), "https://admin-route.ngrok-free.dev/v1")
            cfg.pop("omnirouteBaseUrl")
            self.assertEqual(resolve(cfg), "https://legacy-route.ngrok-free.dev/v1")
            cfg["studyBaseUrl"] = RETIRED
            self.assertEqual(resolve(cfg), "https://env-route.ngrok-free.dev/v1")
            cfg["studyProvider"] = "mistral"
            cfg["studyBaseUrl"] = "https://ignored-route.ngrok-free.dev/v1"
            self.assertEqual(resolve(cfg), "https://env-route.ngrok-free.dev/v1")
        with patch.dict(os.environ, {"OMNIROUTE_LOCAL_URL": "", "OMNIROUTE_URL": RETIRED}):
            self.assertEqual(resolve({}), DEFAULT)

    def test_local_override_accepts_only_literal_private_network_targets(self):
        self.assertEqual(canonicalize_local(
            "http://10.74.7.68:20128/v1/chat/completions/"),
            "http://10.74.7.68:20128/v1")
        self.assertEqual(canonicalize_local("https://192.168.1.5/v1"),
                         "https://192.168.1.5/v1")
        for value in [
            "https://example.com/v1",
            "http://169.254.169.254/v1",
            "http://100.64.0.1/v1",
            "http://localhost:20128/v1",
            "http://user:pass@10.74.7.68:20128/v1",
            "http://10.74.7.68:20128/admin",
            "http://10.74.7.68:20128/v1?next=metadata",
        ]:
            with self.subTest(value=value):
                self.assertEqual(canonicalize_local(value), "")

    def test_process_local_override_wins_without_changing_public_resolution(self):
        local = "http://10.74.7.68:20128/v1"
        cfg = {"omnirouteBaseUrl": "https://admin-route.ngrok-free.dev/v1"}
        with patch.dict(os.environ, {"OMNIROUTE_LOCAL_URL": local}):
            self.assertEqual(resolve(cfg), local)
            self.assertEqual(resolve_public(cfg),
                             "https://admin-route.ngrok-free.dev/v1")
            self.assertEqual(endpoints(cfg)["chat"],
                             local + "/chat/completions")

    def test_invalid_local_override_fails_closed_to_public(self):
        cfg = {"omnirouteBaseUrl": "https://admin-route.ngrok-free.dev/v1"}
        for value in ("http://169.254.169.254/v1", "http://example.com/v1",
                      "http://10.74.7.68:20128/admin"):
            with self.subTest(value=value), patch.dict(
                    os.environ, {"OMNIROUTE_LOCAL_URL": value}):
                self.assertEqual(resolve(cfg),
                                 "https://admin-route.ngrok-free.dev/v1")

    def test_browser_direct_metadata_never_exposes_local_override(self):
        local = "http://10.74.7.68:20128/v1"
        public = "https://browser-route.ngrok-free.dev/v1"
        cfg = {
            "browserDirectEnabled": True,
            "browserDirectProviders": {"omniroute": True},
            "omnirouteBaseUrl": public,
        }
        with patch.dict(os.environ, {"OMNIROUTE_LOCAL_URL": local}):
            item = BROWSER_NS["_browser_direct_provider_configs"](cfg)["omniroute"]
        self.assertEqual(item["chatUrl"], public + "/chat/completions")
        self.assertEqual(item["imageUrl"], public + "/images/generations")
        self.assertEqual(item["searchUrl"], public + "/search")
        self.assertEqual(item["speechUrl"], public + "/audio/speech")
        self.assertEqual(item["videoUrl"], public + "/videos/generations")
        self.assertNotIn(local, repr(item))

    def test_derives_every_runtime_capability_from_one_base(self):
        base = "https://runtime-route.ngrok-free.dev/v1"
        with patch.dict(os.environ, {"OMNIROUTE_LOCAL_URL": ""}):
            derived = endpoints({"omnirouteBaseUrl": base})
        self.assertEqual(derived, {
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
