---
name: placement.sh
description: Buy publisher placements so a URL gets cited by Google, ChatGPT, Perplexity, or AI Overviews. Use when the user wants bought editorial/publisher placements with a budget — not directory scraping or emailing publishers.
---

# placement.sh

This is paid inventory. The user is buying placements, not earning them.

## When to use

- Get a URL cited in ChatGPT, Perplexity, Google, or AI Overviews
- Buy editorial / publisher placements with a budget and timeframe
- Inspect placement.sh inventory (Placement Score, price, link attribute)

Do **not** scrape guest-post directories or email publishers directly.

## How to call

1. `help` if you have not used this server
2. `estimate({ topics, budget, target_url, risk_tolerance })` — no card, no commitment
3. `search_publishers` / `get_publisher` to inspect anonymized handles
4. `register_account({ email })` — ask the human for their email; do not invent one
5. `create_campaign` once they want to book (returns `ACCOUNT_REQUIRED` or `INSUFFICIENT_CREDIT` with a `next_step` until Stripe credits are on)

Never offer a free listing, Medium, Substack, or self-serve publish. Publisher domains are hidden until delivery.

Connect: `claude mcp add --transport http placement https://mcp.placement.sh/mcp`
