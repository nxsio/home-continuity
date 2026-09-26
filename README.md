# Pick up dinner plans without repeating yesterday.

Tell Home Continuity that Mom is coming at 7 and can't have peanuts. In a later session, say “Pick up dinner for Mom tonight.” It retrieves the saved note through MCP, checks the family calendar, and adds four dinner items to a shopping list you can inspect after a restart.

## Run the dinner story

You need Node.js 24+, pnpm, and a local Continuity Core checkout. Start the core service from its directory:

```bash
pnpm install
pnpm start
```

In this project's directory, start the family service:

```bash
pnpm install
pnpm start
```

Run these commands in separate terminal processes. The date is the dinner date; use a fresh date when replaying the story.

```bash
pnpm demo remember family 2030-06-12
pnpm demo pick-up family 2030-06-12
pnpm demo state family 2030-06-12
```

The first call saves the note with Continuity Core's `remember_commitment` tool and writes Mom's 7 PM visit to the local calendar. The second call uses `recall_commitments` and `resume_commitment`, reads the calendar entry, and adds pasta, tomatoes, basil, and olive oil to SQLite. Its JSON response includes the source memory, calendar entry, shopping list before and after, and the MCP protocol version. Restart this service and run `pnpm demo state` again to see the same calendar and list. Repeating `pick-up` keeps the list unchanged and reports that it is up to date.

## Connect the two services

The family service uses the official MCP client SDK over Streamable HTTP. It connects to `http://127.0.0.1:43187/mcp` by default. Set `CONTINUITY_URL` when the core service uses another address. Set `HOME_PORT` to change this service's loopback port, `HOME_URL` for the demo client, and `HOME_DB_PATH` for its SQLite file. Continuity Core's own `CONTINUITY_DB_PATH` controls the memory database. Each service owns its storage; neither copies the other's implementation.

The HTTP endpoints are `POST /api/remember`, `POST /api/pick-up-dinner`, and `GET /api/state?household=family&date=2030-06-12`. The demo script sends the example sentences to these endpoints. This first scenario recognizes Mom's 7 PM visit and peanut restriction with explicit rules; it does not use a language model to interpret arbitrary requests. The commands simulate the Alexa+ conversation in a local HTTP experience. Every result card is built from tool responses and SQLite rows, and failed calls return a visible JSON error.

## License

MIT. See [LICENSE](LICENSE).
