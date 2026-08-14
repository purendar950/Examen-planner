import unittest
from unittest.mock import patch

import app


class GithubContextTests(unittest.TestCase):
    def test_repo_slug_accepts_common_github_forms(self):
        self.assertEqual(app._github_repo_slug("owner/repo"), "owner/repo")
        self.assertEqual(app._github_repo_slug("https://github.com/owner/repo.git"), "owner/repo")
        self.assertIsNone(app._github_repo_slug("https://example.com/owner/repo"))
        self.assertIsNone(app._github_repo_slug("owner/repo/extra"))

    def test_safe_path_rejects_traversal_and_generated_directories(self):
        self.assertEqual(app._github_safe_path("src/main.py"), "src/main.py")
        self.assertIsNone(app._github_safe_path("../secrets.env"))
        self.assertIsNone(app._github_safe_path("node_modules/pkg/index.js"))

    @patch("app._github_fetch_file")
    def test_context_is_bounded_and_contains_selected_paths(self, fetch_file):
        fetch_file.side_effect = lambda slug, ref, path, token=None: "print('hello')\n" if path.endswith("main.py") else "# notes\n"
        err, context = app._github_context_from_body({
            "github": {"repo": "owner/repo", "ref": "main", "files": ["src/main.py", "README.md"]}
        })
        self.assertIsNone(err)
        self.assertIn("Repository: owner/repo", context)
        self.assertIn("FILE: src/main.py", context)
        self.assertIn("FILE: README.md", context)
        self.assertEqual(fetch_file.call_count, 2)

    def test_context_requires_selected_files(self):
        err, context = app._github_context_from_body({"github": {"repo": "owner/repo", "files": []}})
        self.assertEqual(err[0]["error"], "github_files_missing")
        self.assertIsNone(context)

    def test_ai_plan_can_only_edit_selected_files(self):
        source = [{"path": "app.py", "sha": "abc", "before": "print(1)"}]
        plan = app._github_validate_plan({"title": "Fix", "body": "Review", "files": [
            {"path": "app.py", "content": "print(2)"}
        ]}, {"app.py"}, source)
        self.assertEqual(plan["files"][0]["content"], "print(2)")
        with self.assertRaises(ValueError):
            app._github_validate_plan({"files": [{"path": "secret.py", "content": "x"}]},
                                      {"app.py"}, source)

    def test_large_files_are_rejected_for_safe_edits(self):
        source = [{"path": "app.py", "sha": "abc", "before": "x"}]
        with self.assertRaises(ValueError):
            app._github_validate_plan({"files": [{"path": "app.py", "content": "x" * (app._GITHUB_MAX_FILE_CHARS * 2 + 1)}]},
                                      {"app.py"}, source)

    @patch("app._github_connected_identity", return_value=({"uid": "u1"}, "token", None))
    @patch("app._github_user_request")
    def test_pr_requires_explicit_confirmation(self, request_mock, _identity):
        response = app.app.test_client().post("/api/ai-chat/github/pr", json={"draftId": "draft"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("confirm", response.get_json()["detail"].lower())
        request_mock.assert_not_called()

    @patch("app._github_oauth_ready", return_value=False)
    @patch("app._ai_chat_authorize", return_value=({"uid": "u1"}, {}, False, None))
    def test_oauth_start_requires_render_configuration(self, _auth, _ready):
        response = app.app.test_client().post("/api/ai-chat/github/oauth/start")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["error"], "github_oauth_not_configured")


if __name__ == "__main__":
    unittest.main()
