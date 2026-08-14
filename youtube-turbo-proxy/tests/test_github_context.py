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
        fetch_file.side_effect = lambda slug, ref, path: "print('hello')\n" if path.endswith("main.py") else "# notes\n"
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


if __name__ == "__main__":
    unittest.main()
