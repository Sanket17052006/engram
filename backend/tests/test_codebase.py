import tempfile
import unittest
from pathlib import Path

from engram_core.codebase import scan_codebase
from engram_core.main import CodebaseImportContents


class CodebaseScannerTests(unittest.TestCase):
    def test_extracts_typed_files_symbols_tests_and_local_relationships(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "service.py").write_text('"""User service."""\n\nclass UserService:\n    """Loads users."""\n    def get_user(self, user_id):\n        return user_id\n', encoding="utf-8")
            (root / "test_service.py").write_text("from service import UserService\n", encoding="utf-8")
            graph = scan_codebase(root)

        self.assertEqual(graph["filesScanned"], 2)
        self.assertEqual(len([node for node in graph["nodes"] if node["type"] == "CodeSymbol"]), 2)
        self.assertTrue(any(node["type"] == "TestFile" for node in graph["nodes"]))
        self.assertTrue(any(edge["type"] == "IMPORTS" for edge in graph["edges"]))
        self.assertTrue(any(edge["type"] == "TESTS" for edge in graph["edges"]))
        self.assertTrue(any(edge["type"] == "DEFINES" for edge in graph["edges"]))

    def test_skips_non_source_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "readme.md").write_text("not indexed", encoding="utf-8")
            (root / "main.py").write_text("def ok(): pass", encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "ignored.py").write_text("def no(): pass", encoding="utf-8")
            graph = scan_codebase(root)
        self.assertEqual(graph["filesScanned"], 1)
        self.assertEqual(graph["nodes"][0]["path"], "main.py")

    def test_code_import_payload_rejects_traversal_paths(self):
        with self.assertRaises(ValueError):
            CodebaseImportContents.model_validate({"commit": "abcdef0", "branch": "main", "files": [{"path": "../outside.py", "content": "secret"}]})

    def test_code_import_payload_accepts_bounded_repository_relative_sources(self):
        payload = CodebaseImportContents.model_validate({"commit": "abcdef0", "branch": "main", "files": [{"path": "src/service.py", "content": "def serve(): pass"}]})
        self.assertEqual(payload.files[0].path, "src/service.py")


if __name__ == "__main__":
    unittest.main()
