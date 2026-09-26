# Pick up a family dinner plan without repeating yesterday.

Tell Home Continuity who is coming, when, and what they cannot eat. In a later session, ask it to continue dinner planning. It retrieves the saved commitment through MCP, reads the family calendar and shopping list, asks Nemotron 3 Super for a meal and ingredients, and adds only missing items to a persistent list.

This is a local HTTP simulation of an Alexa+ conversation. It does not connect to an Alexa device or an external calendar or shopping account. Dietary notes guide the plan, but the person preparing the meal must check ingredient labels and suitability before serving.

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

Run the next commands as separate client processes. The date is the dinner date; use fresh dates or household IDs for a new run.

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

## Local API and storage

The service binds to `127.0.0.1:43188`. It connects to Continuity Core at `http://127.0.0.1:43187/mcp` using the official MCP client SDK and Streamable HTTP. Set `CONTINUITY_URL`, `HOME_PORT`, or `HOME_DB_PATH` to change the local connection, port, or family SQLite path. `HOME_URL` changes the demo client's target. Continuity Core's `CONTINUITY_DB_PATH` controls its separate memory database.

The endpoints are `POST /api/remember`, `POST /api/pick-up-dinner`, and `GET /api/state?household=family_a&date=2030-06-12`. POST bodies contain `household`, `date`, and `utterance` strings. The JSON response includes the action card or calendar entry, MCP protocol metadata, and the model's raw answer, token usage, latency, and provider cost estimate when a model call occurred.

If a note uses a dinner hour without AM or PM, the service assumes evening and marks the time for confirmation. It checks that extracted visitor, time quote, and dietary terms come from the original note; it checks that a plan keeps the saved time and dietary notes, limits ingredients, and rejects direct mentions of restricted terms in the meal or shopping list. These checks are not a medical safety assessment.

## License

MIT. See [LICENSE](LICENSE).
