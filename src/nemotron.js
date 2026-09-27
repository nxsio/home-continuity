const baseUrl = (process.env.NEMOTRON_BASE_URL ?? 'https://api.deepinfra.com/v1/openai').replace(/\/+$/, '');
const model = process.env.NEMOTRON_MODEL ?? 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
const apiKey = process.env.NEMOTRON_API_KEY;

export async function askNemotron(messages, maxTokens) {
  if (!apiKey) throw new Error('NEMOTRON_API_KEY is required');
  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, response_format: { type: 'json_object' },
      ...(baseUrl.includes('deepinfra.com') ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      temperature: 0, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(90_000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`The dinner model could not complete this request (HTTP ${response.status}). No new result was saved.`);

  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error('The dinner model returned an unreadable result. No new result was saved.');
  }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('The dinner model returned no result. No new result was saved.');
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('The dinner model returned an unusable result. No new result was saved.');
  }
  return {
    value,
    response: {
      id: result.id ?? null,
      model: result.model ?? model,
      rawContent: content,
      tokens: {
        input: result.usage?.prompt_tokens ?? null,
        output: result.usage?.completion_tokens ?? null,
        total: result.usage?.total_tokens ?? null
      },
      estimatedCostUsd: result.usage?.estimated_cost ?? null,
      elapsedMs: Math.round(performance.now() - started)
    }
  };
}
