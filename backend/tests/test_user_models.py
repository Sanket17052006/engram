import json
import unittest
from unittest.mock import AsyncMock, patch

from engram_core.agent import _synthesize
from engram_core.main import ChatRequest


class UserModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_provider_phrases_only_cited_graph_evidence(self):
        config = {"provider": "openai", "model": "gpt-4.1-mini", "apiKey": "private-test-key"}
        sources = [{"id": 1, "title": "Relevant PR", "url": "https://example.test/pr/1", "role": "matching review"}]
        with patch("engram_core.agent._invoke_user_model", new=AsyncMock(return_value=json.dumps({"answer": "A reviewer has matching experience.", "sourceIds": [1]}))) as invoke:
            answer, mode = await _synthesize("Who can review?", "owner/repo", "Graph draft", sources, config)
        self.assertEqual(mode, "openai")
        self.assertIn("[source:1]", answer)
        self.assertNotIn(config["apiKey"], answer)
        self.assertEqual(invoke.await_args.args[0], config)

    async def test_invalid_model_citations_fall_back_to_graph_answer(self):
        config = {"provider": "groq", "model": "llama-3.3-70b-versatile", "apiKey": "private-test-key"}
        sources = [{"id": 1, "title": "Relevant PR", "url": "https://example.test/pr/1", "role": "matching review"}]
        with patch("engram_core.agent._invoke_user_model", new=AsyncMock(return_value=json.dumps({"answer": "Unsupported claim.", "sourceIds": [9]}))):
            answer, mode = await _synthesize("Question", "owner/repo", "Grounded fallback", sources, config)
        self.assertEqual(mode, "graph-template")
        self.assertEqual(answer, "Grounded fallback")

    def test_chat_request_accepts_provider_config_without_a_key_for_ollama(self):
        request = ChatRequest.model_validate({"prompt": "Explain this change", "modelConfig": {"provider": "ollama", "model": "qwen2.5:7b"}})
        self.assertEqual(request.user_model.provider, "ollama")
        self.assertIsNone(request.user_model.api_key)

    def test_chat_request_rejects_missing_hosted_provider_key(self):
        with self.assertRaises(ValueError):
            ChatRequest.model_validate({"prompt": "Explain this change", "modelConfig": {"provider": "openai", "model": "gpt-4.1-mini"}})


if __name__ == "__main__":
    unittest.main()
