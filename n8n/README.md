# GREGORY n8n Workflows

Two n8n workflows that bring GREGORY's multi-agent intelligence system into your automation pipeline.

## Workflows

### 1. Chat API (`gregory-chat-workflow.json`)
Exposes GREGORY as a REST API endpoint with automatic agent routing.

**Flow:**
```
Webhook (POST) → Classify Question (Claude) → Route to Agent → Call AI Provider → Response
```

**Features:**
- Auto-routes questions to the correct sub-agent (Behavioral, Financial, Regulatory, Marketing, or GREGORY hub)
- Dual AI provider support — Anthropic Claude (default) or OpenAI GPT-4o
- Accepts conversation history for multi-turn chat
- Returns structured JSON with agent name, model used, and response

**Endpoint:** `POST /webhook/gregory-chat`

**Request body:**
```json
{
  "message": "What cognitive biases affect pricing decisions?",
  "history": [],
  "provider": "anthropic"
}
```

**Response:**
```json
{
  "success": true,
  "agent": "behavioral",
  "model": "claude-sonnet-4-20250514",
  "response": "..."
}
```

### 2. Weekly Financial Update (`gregory-weekly-update-workflow.json`)
Automated pipeline that generates a weekly financial intelligence brief every Monday at 9am.

**Flow:**
```
Schedule (Mon 9am) → Fetch News + Market Data + Treasury Yields → AI Analysis → Push to GitHub → Deploy
```

**Features:**
- Pulls from 3 data sources in parallel (NewsAPI, Financial Modeling Prep)
- Claude generates a structured intelligence brief (market snapshot, macro signals, sector highlights, risk watchlist)
- Auto-commits the brief to your GitHub repo as `n8n/weekly-brief.md`
- Triggers a Netlify redeploy so the brief is live immediately

---

## Setup

### Step 1: Import Workflows

1. Open your n8n instance
2. Go to **Workflows** → **Add Workflow** → **Import from File**
3. Import `gregory-chat-workflow.json`
4. Repeat for `gregory-weekly-update-workflow.json`

### Step 2: Create Credentials

You need to set up the following credentials in n8n (**Settings** → **Credentials** → **Add Credential** → **Header Auth**):

#### Anthropic API Key
- **Credential type:** Header Auth
- **Header Name:** `x-api-key`
- **Header Value:** Your Anthropic API key (starts with `sk-ant-`)
- **Used by:** Chat workflow (AI calls), Weekly workflow (brief generation)
- After creating, note the credential ID and update `ANTHROPIC_HEADER_AUTH_ID` in both workflow JSONs

#### OpenAI API Key (optional — only if using dual-provider)
- **Credential type:** Header Auth
- **Header Name:** `Authorization`
- **Header Value:** `Bearer sk-your-openai-key`
- **Used by:** Chat workflow (when `provider: "openai"` is sent)
- Update `OPENAI_HEADER_AUTH_ID` in the chat workflow JSON

#### GitHub Personal Access Token
- **Credential type:** Header Auth
- **Header Name:** `Authorization`
- **Header Value:** `Bearer ghp_your-github-token`
- **Required scopes:** `repo` (full control of private repositories)
- **Used by:** Weekly workflow (push brief to GitHub)
- Update `GITHUB_HEADER_AUTH_ID` in the weekly workflow JSON

#### Netlify API Token
- **Credential type:** Header Auth
- **Header Name:** `Authorization`
- **Header Value:** `Bearer your-netlify-token`
- **Used by:** Weekly workflow (trigger redeploy)
- Update `NETLIFY_HEADER_AUTH_ID` in the weekly workflow JSON

### Step 3: Set Environment Variables

In n8n, go to **Settings** → **Variables** (or set as environment variables on your host):

| Variable | Description | Get it from |
|----------|-------------|-------------|
| `NEWS_API_KEY` | NewsAPI.org API key | [newsapi.org](https://newsapi.org) (free tier: 100 req/day) |
| `FMP_API_KEY` | Financial Modeling Prep API key | [financialmodelingprep.com](https://financialmodelingprep.com/developer) (free tier available) |

### Step 4: Update Credential IDs in Workflow JSONs

After creating credentials in n8n, each credential gets a unique ID. You need to replace the placeholder IDs in the workflow JSON files:

**In `gregory-chat-workflow.json`:**
- Replace `ANTHROPIC_HEADER_AUTH_ID` with your Anthropic credential ID
- Replace `OPENAI_HEADER_AUTH_ID` with your OpenAI credential ID

**In `gregory-weekly-update-workflow.json`:**
- Replace `ANTHROPIC_HEADER_AUTH_ID` with your Anthropic credential ID
- Replace `GITHUB_HEADER_AUTH_ID` with your GitHub credential ID
- Replace `NETLIFY_HEADER_AUTH_ID` with your Netlify credential ID

> **Tip:** You can find credential IDs in n8n by going to Settings → Credentials, clicking on the credential, and checking the URL (e.g., `/credentials/123` → ID is `123`).

### Step 5: Customize (Optional)

**Change the GitHub repo:** In the weekly workflow, update the GitHub API URLs from:
```
https://api.github.com/repos/Stax-app/gregory-web/contents/n8n/weekly-brief.md
```
to your own repo path.

**Change the Netlify site:** Update the Netlify deploy URL site ID (`70ebf6a9-...`) to your own site.

**Change the schedule:** The weekly workflow runs every Monday at 9am. Edit the Schedule Trigger node to change timing.

**Switch default AI provider:** The chat workflow defaults to Anthropic. To default to OpenAI, change the condition in the "Provider Switch" node.

### Step 6: Activate

1. Open each imported workflow
2. Click the **Active** toggle in the top-right corner
3. The chat workflow will start accepting webhook requests immediately
4. The weekly workflow will run on its next scheduled Monday at 9am

---

## Architecture

### Chat Workflow
```
┌──────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│ Webhook  │───▶│ Classify │───▶│  Switch   │───▶│ AI Call  │───▶│ Response │
│ (POST)   │    │ (Claude) │    │ (5 agents)│    │ (Claude/ │    │ (JSON)   │
└──────────┘    └──────────┘    └───────────┘    │  GPT-4o) │    └──────────┘
                                                  └──────────┘
```

### Weekly Workflow
```
┌──────────┐    ┌──────────────────────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Schedule │───▶│ Fetch News + Market +    │───▶│ Generate │───▶│ Push to  │───▶│ Netlify  │
│ Mon 9am  │    │ Treasury (3 parallel)    │    │ Brief    │    │ GitHub   │    │ Deploy   │
└──────────┘    └──────────────────────────┘    │ (Claude) │    └──────────┘    └──────────┘
                                                 └──────────┘
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Webhook returns 404 | Make sure the chat workflow is **active** |
| "Invalid API key" on AI calls | Check Header Auth credential — ensure the header name is exactly `x-api-key` for Anthropic or `Authorization` for OpenAI |
| NewsAPI returns 401 | Verify `NEWS_API_KEY` environment variable is set in n8n |
| GitHub push fails with 404 | Ensure the repo path is correct and your token has `repo` scope |
| GitHub push fails with 409 | The "Check Existing Brief" node may have failed — ensure `continueOnFail` is enabled on that node |
| Weekly workflow doesn't run | Check that the workflow is active and the schedule trigger is configured correctly |
| Classification routes to wrong agent | The classifier uses a quick Claude call — ensure your Anthropic credential is valid |

---

## API Keys Quick Reference

| Service | Free Tier | Sign Up |
|---------|-----------|---------|
| Anthropic | Pay-as-you-go | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI | Pay-as-you-go | [platform.openai.com](https://platform.openai.com) |
| NewsAPI | 100 requests/day | [newsapi.org](https://newsapi.org) |
| Financial Modeling Prep | 250 requests/day | [financialmodelingprep.com](https://financialmodelingprep.com) |
| GitHub | Free | [github.com/settings/tokens](https://github.com/settings/tokens) |
| Netlify | Free (300 build min/mo) | [app.netlify.com](https://app.netlify.com) |
