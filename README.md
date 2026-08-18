# placement.sh

Buy publisher placements so a URL gets cited. An agent sets a budget; placement.sh books the campaign.

This is **bought** inventory (paid placements), not earned media. Outcome still matters: ChatGPT, Perplexity, Google, AI Overviews.

## Connect an agent

```bash
claude mcp add --transport http placement https://mcp.placement.sh/mcp
grok mcp add placement --url https://mcp.placement.sh/mcp
```

Until the custom domain is attached, use the Worker URL the same way (`…/mcp`).

Call **`estimate`** first. Then `search_publishers` / `get_publisher` to inspect. Publisher domains stay blind until delivery.

- Agents: [`/llms.txt`](https://placement.sh/llms.txt)
- Registry card: [`/.well-known/mcp/server.json`](https://placement.sh/.well-known/mcp/server.json)
- Skill: [`skills/placement/SKILL.md`](skills/placement/SKILL.md)

Hosted implementation: [`cite-worker/`](cite-worker/). Operator console is unchanged internally (D1 table names stay `sites` so live inventory does not migrate).
