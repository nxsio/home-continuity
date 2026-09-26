# Pick up a family dinner plan without repeating yesterday.

Tell Home Continuity who is coming, when, and what they cannot eat. In a later session, ask it to continue dinner planning. The page brings back the saved visit, makes a dinner plan, and adds only missing ingredients to the shopping list.

[Try the live demo](https://home-continuity.nxsio.com/). Save a dinner visit, then ask it to continue the plan. The calendar and shopping list remain in this browser when you reopen the page.

This is a web simulation of an Alexa+ conversation. It does not connect to an Alexa device or an external calendar or shopping account. Dietary notes guide the plan, but the person preparing the meal must check ingredient labels and suitability before serving.

## Run locally

You need Node.js 24+, pnpm, a local Continuity Core checkout, and a Nemotron 3 Super API key. Set `NEMOTRON_API_KEY` in the family service's process environment using your local secret manager. `NEMOTRON_BASE_URL` and `NEMOTRON_MODEL` are optional; their defaults are the DeepInfra OpenAI-compatible endpoint and `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`.

From the Continuity Core directory, start its MCP service:

```bash
pnpm install
pnpm start
```

From this directory, start Home Continuity in a separate terminal:

```bash
pnpm install
pnpm start
```

Open `http://127.0.0.1:43188/`. Choose a family and dinner date, enter the visit in step 1, then use step 2 to continue dinner planning. The result card shows the meal, what was added to shopping, what needs checking, and the original note. Reload the page with the same family and date to see the saved calendar, list, and latest plan.

The same story also works from separate command-line client processes. The date is the dinner date; use fresh dates or household IDs for a new run.

```bash
pnpm demo remember family_a 2030-06-12 "Mom is coming for dinner at 7 PM, and she can't have peanuts"
pnpm demo pick-up family_a 2030-06-12 "Pick up dinner for Mom tonight"
pnpm demo state family_a 2030-06-12

pnpm demo remember family_b 2030-06-13 "Aunt Maya will join dinner at 6:30 PM; she can't have dairy or mushrooms"
pnpm demo pick-up family_b 2030-06-13 "Continue Aunt Maya's dinner plan and add what we still need"
pnpm demo state family_b 2030-06-13
```

The first call for each household extracts the visitor, time, and dietary notes with Nemotron, saves the original note through MCP `remember_commitment`, and writes a calendar entry to SQLite. The later call uses MCP `recall_commitments` and `resume_commitment`, sends the current calendar and list to Nemotron, and writes the returned ingredients to SQLite. Its action card shows the input, meal, ingredients, actual new list items, and confirmations. Results depend on the model response; the examples do not encode fixed meals or shopping items.

Repeat a `pick-up` command to see zero new items. Restart both services and run `state` or the same `pick-up` command again to inspect persistence. A repeated command reuses its saved plan, while a new command asks the model for a new plan. Model and MCP failures return visible JSON errors; there is no fixed-plan fallback.

## Run on Cloudflare Workers

The [`cloudflare/`](cloudflare/) adapter serves the same page and API from a Worker. D1 stores visits, shopping items, dinner plans, and model usage. A random, persistent HttpOnly cookie keeps each visitor's data separate, even when two visitors enter the same household and date. Keep the cookie in the same browser to return to a saved plan. The Worker calls Continuity Core's Streamable HTTP `/mcp` endpoint with the official MCP client and a shared bearer secret. It uses DeepInfra's Nemotron 3 Super for visit extraction and dinner planning.

The company D1 database and custom domain are already configured in `cloudflare/wrangler.jsonc`. The Core URL must be an HTTPS URL ending in `/mcp`; use the same `CORE_SHARED_SECRET` in both Workers. Set `CONTINUITY_MCP_URL`, `CORE_SHARED_SECRET`, and `NEMOTRON_API_KEY` with `pnpm exec wrangler secret put NAME --config cloudflare/wrangler.jsonc`, passing each value directly from a secret manager. To publish an update:

```bash
pnpm exec wrangler d1 migrations apply HOME_DB --remote --config cloudflare/wrangler.jsonc
pnpm exec wrangler deploy --config cloudflare/wrangler.jsonc
```

The public demo allows at most 100 model requests per UTC day across all visitors and eight per visitor per UTC day. Both limits are enforced in D1 before a request reaches DeepInfra; a request over either limit returns HTTP 429 with a visible explanation. Reusing a saved dinner command does not call the model again. [Workers](https://developers.cloudflare.com/workers/platform/limits/) and [D1](https://developers.cloudflare.com/d1/platform/pricing/) offer Free plans; DeepInfra model calls use the account behind the secret.

## Use Amazon Bedrock for dinner planning

The Worker can send a new dinner request to an [AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html). Its Python [Strands agent](agentcore/main.py) uses a Bedrock model and calls the same remote MCP memory server over Streamable HTTP. The Worker checks the returned plan, model usage, and memory evidence, then writes the dinner and only the missing groceries to its existing D1 tables. The result card shows the actual AgentCore, Bedrock, and MCP route when that route handled the request. A repeated command uses its saved plan without another model invocation.

Run `sh agentcore/build.sh` to create a Python 3.13 **CodeZip** artifact for Linux ARM64 at `.local/agentcore-codezip.zip` (requires `uv` and `zip`). The [AWS direct-code guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html) covers the artifact upload and Runtime creation; use `main.py` as its entrypoint. Give the Runtime execution role `bedrock:InvokeModelWithResponseStream` for the chosen model and outbound HTTPS access to your MCP endpoint. Inject `CONTINUITY_MCP_URL`, `CORE_SHARED_SECRET`, `BEDROCK_MODEL_ID` (default `amazon.nova-micro-v1:0`), and `AWS_REGION` into the Runtime from a secret manager or deployment environment. Do not put the bearer in the code archive.

Set the Worker's `AGENTCORE_RUNTIME_ARN` to the deployed Runtime ARN and inject `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, for temporary credentials, `AWS_SESSION_TOKEN` as Cloudflare secrets. The calling IAM principal needs `bedrock-agentcore:InvokeAgentRuntime` on that ARN. `AGENTCORE_BEDROCK_MODEL_ID` must equal the Runtime's `BEDROCK_MODEL_ID` if you override the default. Only a configured ARN selects AWS; an incomplete AWS configuration fails visibly rather than using another model. Without it, the hosted Worker continues to use DeepInfra for development. Visit extraction still uses Nemotron in either mode.

AWS dinner requests share the existing daily 100-call and eight-per-visitor limits and have an additional 1,000-invocation lifetime cap in D1. The Runtime receives the visitor's memory context, date, calendar, current list, and request. It returns the actual MCP call results and Bedrock text and usage. It does not receive the Worker's AWS signing credentials. `pnpm test` checks the signed request, D1 list integration, and rejection paths without contacting AWS; the Python tests run with `python -m unittest discover -s agentcore -p 'test_*.py'` after installing the `agentcore/` project into a Python 3.13 environment.

## Local API and storage

The Node service binds to `127.0.0.1:43188`. It connects to Continuity Core at `http://127.0.0.1:43187/mcp` using the official MCP client SDK and Streamable HTTP. Set `CONTINUITY_URL`, `HOME_PORT`, or `HOME_DB_PATH` to change the local connection, port, or family SQLite path. `HOME_URL` changes the demo client's target. Continuity Core's `CONTINUITY_DB_PATH` controls its separate memory database.

The endpoints are `POST /api/remember`, `POST /api/pick-up-dinner`, and `GET /api/state?household=family_a&date=2030-06-12`. POST bodies contain `household`, `date`, and `utterance` strings. The JSON response includes the action card or calendar entry, MCP protocol metadata, and the model's raw answer, token usage, latency, and provider cost estimate when a model call occurred. `GET /api/state` returns the saved calendar, shopping list, and latest dinner plan for the page.

If a note uses a dinner hour without AM or PM, the service assumes evening and marks the time for confirmation. It checks that extracted visitor, time quote, and dietary terms come from the original note; it checks that a plan keeps the saved time and dietary notes, limits ingredients, and rejects direct mentions of restricted terms in the meal or shopping list. These checks are not a medical safety assessment.

## License

MIT. See [LICENSE](LICENSE).
