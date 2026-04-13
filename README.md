# Eduversal Mail Service

Node.js + Express + Resend — newsletter & transactional email service for the Eduversal network.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/schools` | List all schools (for filter UI) |
| GET | `/recipients?schoolId=` | Merged recipient list (registered + manual contacts) |
| POST | `/send-campaign` | Send newsletter to all or selected schools |
| POST | `/send-test` | Send test email to a single address |
| GET | `/campaigns` | Recent campaign history |

All endpoints except `/health` require `Authorization: Bearer <API_SECRET>`.

## Setup

### 1. Environment Variables (Railway)

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | From resend.com/api-keys |
| `FROM_EMAIL` | `secondary.edu@eduversal.org` (must be verified in Resend) |
| `FROM_NAME` | `Eduversal Education` |
| `API_SECRET` | Random secret shared with CentralHub |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Service account JSON, base64-encoded |
| `FIREBASE_PROJECT_ID` | `centralhub-8727b` |

### 2. Encode Firebase service account

```bash
node -e "console.log(Buffer.from(require('fs').readFileSync('keys/centralhub-service-account.json')).toString('base64'))"
```

Paste the output as `FIREBASE_SERVICE_ACCOUNT_BASE64` in Railway.

### 3. Generate API_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the same value as `MAIL_SERVICE_SECRET` in CentralHub's Vercel environment variables.

### 4. Deploy to Railway

1. Push this repo to GitHub (`a-perdana/eduversal-mail-service`)
2. New Railway project → Deploy from GitHub repo
3. Add environment variables above
4. Railway auto-detects Node.js, runs `npm start`

## POST /send-campaign payload

```json
{
  "subject":      "Monthly Newsletter — April 2026",
  "bodyHtml":     "<h2>Dear Teachers...</h2><p>...</p>",
  "schoolIds":    [],
  "campaignName": "April 2026 Newsletter",
  "sentBy":       "admin@eduversal.org"
}
```

`schoolIds: []` = send to ALL teachers across all schools.

## Firestore collections used

- `users` — reads `role_teachershub`, `schoolId`, `email`, `displayName`
- `teacher_contacts` — reads `email`, `name`, `schoolId`, `schoolName`
- `schools` — reads school list for filter UI
- `mail_campaigns` — writes campaign records + status updates
