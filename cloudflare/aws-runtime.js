import { AwsClient } from 'aws4fetch';

const DEFAULT_MODEL = 'amazon.nova-micro-v1:0';

export function agentCoreConfigured(env) {
  return Boolean(env.AGENTCORE_RUNTIME_ARN);
}

export function validateAgentResult(result, { context, events, modelId, payload }) {
  if (!result || typeof result !== 'object' || result.status !== 'completed') {
    throw new Error('AgentCore did not complete the dinner plan.');
  }
  const { mcp, sources, model } = result;
  if (mcp?.protocolVersion !== '2025-11-25' ||
      !Array.isArray(mcp.calls) || mcp.calls.length !== 2 ||
      mcp.calls[0]?.name !== 'recall_commitments' || mcp.calls[0]?.context !== context ||
      mcp.calls[1]?.name !== 'resume_commitment' ||
      !Array.isArray(sources?.commitments) || !sources.resumed ||
      !events.every(event => sources.commitments.some(entry => entry.id === event.memoryId && entry.context === context))) {
    throw new Error('AgentCore returned incomplete MCP evidence.');
  }
  const selected = events.find(event => event.id === result.plan?.eventId);
  if (!selected || mcp.calls[1].id !== selected.memoryId ||
      sources.resumed.id !== selected.memoryId || sources.resumed.context !== context ||
      !sources.resumed.commitment?.includes(selected.sourceUtterance)) {
    throw new Error('AgentCore memory does not match the saved calendar visit.');
  }
  if (model?.provider !== 'bedrock' || model.model !== modelId ||
      typeof model.rawContent !== 'string' || !model.rawContent.trim() ||
      model.request?.date !== payload.date || model.request.utterance !== payload.request ||
      model.request.calendarCount !== events.length ||
      model.request.rememberedCount !== sources.commitments.length ||
      model.request.shoppingCount !== payload.shoppingList.length ||
      !Number.isInteger(model.tokens?.input) || model.tokens.input < 0 ||
      !Number.isInteger(model.tokens?.output) || model.tokens.output < 0) {
    throw new Error('AgentCore returned incomplete Bedrock evidence.');
  }
  try {
    if (JSON.stringify(JSON.parse(model.rawContent)) !== JSON.stringify(result.plan)) {
      throw new Error('Bedrock plan does not match the reported result.');
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Bedrock returned an unreadable plan.');
    throw error;
  }
  return {
    plan: result.plan,
    model,
    mcp: { protocolVersion: mcp.protocolVersion, server: mcp.server, tools: mcp.calls.map(call => call.name), elapsedMs: mcp.elapsedMs },
    sources: { recalled: sources.commitments.find(entry => entry.id === selected.memoryId), resumed: sources.resumed }
  };
}

export async function invokeAgentCore(env, payload, events) {
  const arn = env.AGENTCORE_RUNTIME_ARN;
  const match = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):\d{12}:runtime\/[A-Za-z0-9_-]+$/.exec(arn ?? '');
  if (!match || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AgentCore invocation is not configured.');
  }
  const region = match[1];
  const modelId = env.AGENTCORE_BEDROCK_MODEL_ID || DEFAULT_MODEL;
  const signer = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    region,
    service: 'bedrock-agentcore'
  });
  const endpoint = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`;
  const started = performance.now();
  const response = await signer.fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': crypto.randomUUID()
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000)
  });
  if (!response.ok) throw new Error(`AgentCore invocation failed (HTTP ${response.status}).`);
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    throw new Error('AgentCore returned a non-JSON response.');
  }
  const text = await response.text();
  if (text.length > 65_536) throw new Error('AgentCore response is too large.');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('AgentCore returned invalid JSON.'); }
  const validated = validateAgentResult(result, { context: payload.context, events, modelId, payload });
  return {
    ...validated,
    model: {
      ...validated.model,
      agentCoreRequestId: response.headers.get('x-amzn-requestid') ?? null,
      elapsedMs: Math.round(performance.now() - started)
    }
  };
}
