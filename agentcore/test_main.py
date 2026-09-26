import json
import os
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

import main


MEMORY_CONTEXT = "home-continuity:session:family:2030-06-12"
NOTE = "Mom is coming at 7 PM and can't have peanuts"
VISIT = {"id": 1, "memoryId": 42, "sourceUtterance": NOTE, "time": "19:00", "restrictions": ["peanuts"]}
PLAN = {
    "intent": "dinner", "eventId": 1, "time": "19:00", "restrictions": ["peanuts"],
    "meal": "Roast chicken with rice", "ingredients": ["rice", "carrots", "chicken"], "confirmations": [],
}
PAYLOAD = {
    "context": MEMORY_CONTEXT, "date": "2030-06-12", "request": "Continue dinner for Mom",
    "calendar": [VISIT], "shoppingList": [], "planPrompt": "Return a dinner plan as JSON.",
}


class FakeSession:
    last = None

    def __init__(self, *streams):
        self.calls = []
        FakeSession.last = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *arguments):
        return False

    async def initialize(self):
        return SimpleNamespace(protocolVersion="2025-11-25", serverInfo=SimpleNamespace(model_dump=lambda: {"name": "continuity-core"}))

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        content = ({"commitments": [{"id": 42, "context": MEMORY_CONTEXT, "commitment": NOTE}]}
                   if name == "recall_commitments" else
                   {"id": 42, "context": MEMORY_CONTEXT, "commitment": NOTE, "next_step": "Plan dinner"})
        return SimpleNamespace(isError=False, structuredContent=content)


class FakeAgent:
    def __init__(self, **arguments):
        self.arguments = arguments

    async def invoke_async(self, prompt):
        assert json.loads(prompt)["remembered"][0]["id"] == 42
        return SimpleNamespace(
            message={"content": [{"text": json.dumps(PLAN)}]},
            metrics=SimpleNamespace(accumulated_usage={"inputTokens": 120, "outputTokens": 75, "totalTokens": 195}),
        )


@asynccontextmanager
async def fake_transport(url, headers):
    assert url.endswith("/mcp")
    assert headers["Authorization"].startswith("Bearer ")
    yield (object(), object(), None)


class AgentTest(unittest.IsolatedAsyncioTestCase):
    def test_payload_requires_a_saved_visit(self):
        with self.assertRaisesRegex(ValueError, "saved dinner visit"):
            main.required_payload({**PAYLOAD, "calendar": []})

    async def test_mcp_and_bedrock_results_are_returned_together(self):
        with patch.dict(os.environ, {
            "CONTINUITY_MCP_URL": "https://example.com/mcp", "CORE_SHARED_SECRET": "test-value",
            "BEDROCK_MODEL_ID": "amazon.nova-micro-v1:0", "AWS_REGION": "us-east-1",
        }), patch.object(main, "streamablehttp_client", fake_transport), \
                patch.object(main, "ClientSession", FakeSession), \
                patch.object(main, "BedrockModel", lambda **arguments: arguments), \
                patch.object(main, "Agent", FakeAgent):
            result = await main.invoke(PAYLOAD)
        self.assertEqual(result["plan"], PLAN)
        self.assertEqual(result["model"]["tokens"]["total"], 195)
        self.assertEqual(result["model"]["request"]["rememberedCount"], 1)
        self.assertEqual(result["mcp"]["calls"][1], {"name": "resume_commitment", "id": 42})
        self.assertEqual(FakeSession.last.calls, [
            ("recall_commitments", {"context": MEMORY_CONTEXT}),
            ("resume_commitment", {"id": 42}),
        ])

    async def test_model_without_usage_is_not_reported_as_success(self):
        result = SimpleNamespace(message={"content": [{"text": json.dumps(PLAN)}]},
                                 metrics=SimpleNamespace(accumulated_usage={}))
        with self.assertRaisesRegex(RuntimeError, "token usage"):
            main.model_content(result)


if __name__ == "__main__":
    unittest.main()
