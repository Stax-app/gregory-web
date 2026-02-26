# GREGORY Daily Sync — n8n Workflow

## Overview

This n8n workflow triggers the `gregory-daily-sync` Supabase Edge Function every day at **9:00 PM PT**. It handles retries, success/failure checking, and logging.

## Workflow Nodes

1. **Daily 9 PM PT** — Schedule trigger (runs once daily at 21:00)
2. **Call GREGORY Sync** — HTTP POST to the Supabase Edge Function (120s timeout, 3 retries with 5-minute intervals)
3. **Check Success** — Validates HTTP status code is 200
4. **Log Success / Log Failure** — Records the sync result

## Setup

### Prerequisites

- A running [n8n](https://n8n.io/) instance (self-hosted or cloud)
- Access to the GREGORY Supabase project

### Import the Workflow

1. Open your n8n instance
2. Go to **Workflows → Import from File**
3. Select `gregory-daily-sync.json`

### Configure Environment Variable

The workflow references the Supabase service role key via an n8n environment variable. Set the following before activating:

| Variable | Description |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role JWT for the GREGORY project |

In n8n, go to **Settings → Environment Variables** and add `SUPABASE_SERVICE_ROLE_KEY` with your key value.

### Activate

Toggle the workflow to **Active** in n8n. It will run automatically every day at 9 PM PT.

## Endpoint

```
POST https://civpkkhofvpaifprhpii.supabase.co/functions/v1/gregory-daily-sync
```

## Retry Policy

- Up to **3 attempts** on failure
- **5-minute** wait between retries
- **120-second** HTTP timeout per request
