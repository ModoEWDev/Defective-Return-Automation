# Warranty Claims API

Azure Function backing the warranty claims form. Receives a claim submission,
checks it against the rules below, posts a credit memo in NetSuite when
everything clears, and returns an outcome + customer-facing message.

## Outcomes

- **`approved`** — all gates clear, a credit memo has been posted.
- **`offer`** — purchase is outside the 30-month warranty window; customer is
  told about a 50% off wholesale replacement and pointed to customer relations.
  No NetSuite action is taken for this outcome.
- **`escalate`** — needs a human: account's rep is Kathryn Land, account has
  hit the daily claim cap, the item appears already fully credited, or the
  invoice couldn't be found.

## Required app settings

Set these as Key Vault references in the Function App's configuration
(`@Microsoft.KeyVault(SecretUri=...)`), not as plain values:

| Setting | What it is |
|---|---|
| `NETSUITE_ACCOUNT_ID` | Your NetSuite account ID (the subdomain in your SuiteTalk URL) |
| `NETSUITE_CLIENT_ID` | From the Integration record's Client Credentials Grant |
| `NETSUITE_CERTIFICATE_ID` | The Certificate ID from the OAuth 2.0 Client Credentials (M2M) Setup record |
| `NETSUITE_PRIVATE_KEY` | The private key half of that certificate, PEM format, with newlines escaped as `\n` |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |

`AzureWebJobsStorage` is already set automatically when you create the
Function App — this code reuses that same storage account for claim-count
tracking rather than provisioning a separate one.

For local development, copy `local.settings.example.json` to
`local.settings.json` and fill in real values there. That file is gitignored —
never commit it with real secrets in it.

## Before this touches production NetSuite

This is a working first version, not a finished one. Specifically:

- **The credit memo payload in `netsuiteClient.js` is a starting point, not a
  guarantee.** Your NetSuite account may require additional fields on credit
  memos (class, department, location, tax schedule, a specific custom form)
  that aren't visible from outside your account. Test it against a real
  invoice/SKU pair in your **sandbox** account and check the resulting credit
  memo in the NetSuite UI before trusting it on anything real.
- **The SuiteQL queries assume standard field names** (`tranid`, `entityid`,
  `salesrep`, `itemid`, etc.). If any custom fields or saved search logic are
  involved in how your team actually computes "units purchased" or "units
  credited" today, those queries need to match that, not just approximate it.
- **The photo isn't stored or validated beyond being present.** The Function
  currently requires `photoBase64` to exist but doesn't check that it's
  actually an image or keep a copy anywhere. Worth deciding whether you want
  an audit trail of submitted photos (e.g. saved to Blob Storage) before this
  is customer-facing.
- **Large photo uploads as base64 in a JSON body are inefficient.** Fine for
  initial testing; if real photo sizes cause problems, the better pattern is
  having the form upload directly to Blob Storage and send the Function a URL
  instead of embedding the image in the request.

## No CORS setup needed

Because this `/api` folder deploys alongside the form inside the same Static
Web App, the frontend and this Function share an origin — no CORS
configuration is required for the form to call `/api/claims`.
