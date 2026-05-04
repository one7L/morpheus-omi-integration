# Morpheus × OMI Integration

Personal CTO second brain integration for the OMI AI companion.

## What It Does

When OMI creates a memory from a conversation, it sends the full transcript, structured summary, action items, and events to the Morpheus webhook endpoint. Morpheus processes this data and writes it into the second brain knowledge base.

## Architecture

```
OMI App (Memory Creation Trigger)
  → POST webhook (JSON payload)
  → Morpheus Webhook Listener (Node.js, pm2)
  → /opt/morpheus/second-brain/_ingest/omi-webhook-log.ndjson
```

## Webhook Endpoint

- **URL:** `http://89.167.22.192:3000/omi-webhook`
- **Method:** POST
- **Content-Type:** application/json
- **Health Check:** GET `/omi-webhook`

## Payload Format

OMI sends a JSON payload containing:
- Transcript with speaker identification
- Structured summary (title, overview, category, emoji)
- Action items extracted
- Events detected
- Timestamps and metadata

## Setup

1. Deploy the webhook listener:
```bash
cd /opt/morpheus/omi-webhook
pm2 start server.js --name omi-webhook
pm2 save
```

2. Create the OMI App at [app.omi.me/my-apps/new](https://app.omi.me/my-apps/new)
3. Set the webhook URL to your server endpoint
4. Select "Memory Creation" as the trigger event

## License

MIT
