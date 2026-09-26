import json
import os
import time

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.models import BedrockModel


app = BedrockAgentCoreApp()


def required_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("A dinner request is required.")
    context = payload.get("context")
    if not isinstance(context, str) or not context.startswith("home-continuity:") or len(context) > 200:
        raise ValueError("A valid memory context is required.")
    if not isinstance(payload.get("date"), str) or not isinstance(payload.get("request"), str):
        raise ValueError("A date and dinner request are required.")
    if not isinstance(payload.get("calendar"), list) or not payload["calendar"]:
        raise ValueError("A saved dinner visit is required.")
    if not isinstance(payload.get("shoppingList"), list) or not isinstance(payload.get("planPrompt"), str):
        raise ValueError("The dinner planning input is incomplete.")
    if len(json.dumps(payload)) > 16_384:
        raise ValueError("The dinner planning input is too large.")
    return context


def tool_content(result, name):
    if result.isError or not isinstance(result.structuredContent, dict):
        raise RuntimeError(f"{name} returned no usable structured result.")
    return result.structuredContent


def model_content(result):
    blocks = result.message.get("content", [])
    text = "".join(block.get("text", "") for block in blocks if isinstance(block, dict))
    if not text:
        raise RuntimeError("Bedrock returned no plan text.")
    try:
        plan = json.loads(text)
    except json.JSONDecodeError as error:
        raise RuntimeError("Bedrock returned an unreadable dinner plan.") from error
    usage = result.metrics.accumulated_usage
    if not isinstance(usage, dict) or not isinstance(usage.get("inputTokens"), int) or not isinstance(usage.get("outputTokens"), int):
        raise RuntimeError("Bedrock returned no token usage.")
    return plan, text, usage


@app.entrypoint
async def invoke(payload, context=None):
    memory_context = required_payload(payload)
    url = os.environ["CONTINUITY_MCP_URL"]
    bearer = os.environ["CORE_SHARED_SECRET"]
    model_id = os.environ.get("BEDROCK_MODEL_ID", "amazon.nova-micro-v1:0")
    region = os.environ.get("AWS_REGION", "us-east-1")
    started = time.monotonic()

    async with streamablehttp_client(url, headers={"Authorization": f"Bearer {bearer}"}) as streams:
        async with ClientSession(streams[0], streams[1]) as client:
            negotiated = await client.initialize()
            if negotiated.protocolVersion != "2025-11-25":
                raise RuntimeError("Continuity Core negotiated an unexpected MCP version.")
            recall = tool_content(await client.call_tool("recall_commitments", {"context": memory_context}), "recall_commitments")
            commitments = recall.get("commitments")
            if not isinstance(commitments, list) or not all(
                any(entry.get("id") == event.get("memoryId") and entry.get("context") == memory_context for entry in commitments)
                for event in payload["calendar"]
            ):
                raise RuntimeError("A calendar visit has no matching saved memory.")

            agent = Agent(
                model=BedrockModel(model_id=model_id, region_name=region, temperature=0, max_tokens=950),
                system_prompt=payload["planPrompt"],
                callback_handler=None,
            )
            result = await agent.invoke_async(json.dumps({
                "request": payload["request"], "date": payload["date"],
                "calendar": payload["calendar"], "remembered": commitments,
                "shoppingList": payload["shoppingList"],
            }))
            plan, raw_content, usage = model_content(result)
            event = next((item for item in payload["calendar"] if item.get("id") == plan.get("eventId")), None)
            if not event:
                raise RuntimeError("Bedrock chose a visit not on the calendar.")
            resumed = tool_content(await client.call_tool("resume_commitment", {"id": event["memoryId"]}), "resume_commitment")
            if resumed.get("id") != event["memoryId"] or resumed.get("context") != memory_context or \
                    event["sourceUtterance"] not in resumed.get("commitment", ""):
                raise RuntimeError("The resumed memory does not match the calendar visit.")
            return {
                "status": "completed",
                "plan": plan,
                "model": {
                    "provider": "bedrock", "model": model_id, "rawContent": raw_content,
                    "request": {"date": payload["date"], "utterance": payload["request"],
                                "calendarCount": len(payload["calendar"]),
                                "rememberedCount": len(commitments),
                                "shoppingCount": len(payload["shoppingList"])},
                    "tokens": {"input": usage["inputTokens"], "output": usage["outputTokens"],
                               "total": usage.get("totalTokens")},
                },
                "mcp": {
                    "protocolVersion": negotiated.protocolVersion,
                    "server": negotiated.serverInfo.model_dump(),
                    "calls": [{"name": "recall_commitments", "context": memory_context},
                              {"name": "resume_commitment", "id": event["memoryId"]}],
                    "elapsedMs": round((time.monotonic() - started) * 1000),
                },
                "sources": {"commitments": commitments, "resumed": resumed},
            }


if __name__ == "__main__":
    app.run()
