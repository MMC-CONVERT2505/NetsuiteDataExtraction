# How to Get NetSuite Credentials (for connecting a new company)

This document explains how to get the values needed to connect **any** NetSuite company/account to the NetSuite Data Extractor app:

- **Account ID**
- **Client ID**
- **Client Secret**

No certificate, no private key, no OpenSSL — this app connects via NetSuite login (OAuth 2.0 Authorization Code Grant), which only needs these three values plus a one-time browser login.

You need to do this once per NetSuite company. It must be done by someone with **Administrator** access in that specific NetSuite account — there is no way to get these values without logging into NetSuite itself, and no way to copy them from another company's setup. Each NetSuite account (production, sandbox, or a different company entirely) requires its own separate setup.

---

## Step 1 — Find the Account ID

Log in to NetSuite and look at the browser address bar.

```
https://3952268.app.netsuite.com/...
```

The number right after `https://` is the **Account ID**. In the example above, it's `3952268`.

- Production accounts: just the number (e.g. `3952268`)
- Sandbox accounts: number with a suffix (e.g. `3952268-sb1`)

---

## Step 2 — Get the Redirect URI from the app

1. Open the app and log in.
2. Click the gear icon (top-right) to open **Manage Companies**.
3. Under **"Add a company with NetSuite login"**, copy the value shown in **"Redirect URI to register in NetSuite"** (it will look like `http://127.0.0.1:3001/api/auth/callback`, or the server's address if the app is deployed).

You'll paste this into NetSuite in the next step.

---

## Step 3 — Create the Integration Record

1. In NetSuite, go to: **Setup > Integration > Manage Integrations > New**
2. Give it a clear name, e.g. `NetSuite Extractor - <Company Name>`
3. Under **OAuth 2.0**, check only:
   - ✅ **Authorization Code Grant**
   - ✅ **REST Web Services** (under Scope)
4. Paste the **Redirect URI** from Step 2 into the Redirect URI field.
5. Leave **Client Credentials (Machine to Machine) Grant**, **Token-Based Authentication**, **User Credentials**, and everything else at their defaults — none of it applies to this connection method.
6. Click **Save**.
7. NetSuite shows a **Client ID** and a **Client Secret** on the confirmation screen. **Copy both now** — they are shown only this once and can never be retrieved again. If you lose them, you'll need to reset the Integration Record's credentials or create a new one.

---

## Step 4 — Confirm the role has OAuth permission

1. Go to: **Setup > Users/Roles > Manage Roles**
2. Open the role the connecting user will use.
3. Go to **Permissions > Setup**.
4. Add: **Log in using OAuth 2.0 Access Tokens**
5. Click **Save**.

Without this permission, the NetSuite login will fail even with correct credentials.

---

## What you should end up with

| Value | Example | Where you got it |
|---|---|---|
| Account ID | `3952268` | Browser URL while logged into NetSuite (Step 1) |
| Client ID | `31447483979a4585d1a7...` | Integration Record confirmation screen (Step 3) — shown once |
| Client Secret | (long random string) | Same confirmation screen (Step 3) — shown once |

---

## Step 5 — Add it in the app

1. Open the app, click the gear icon, expand **"Add a company with NetSuite login"**.
2. Fill in: **Org Name** (a label you choose, e.g. `adaptimmune`), **Account ID**, **Client ID**, **Client Secret**.
3. Click **Save & Login with NetSuite** — you'll be redirected to NetSuite's real login page.
4. Log in with a NetSuite user that has the role from Step 4.
5. You'll be sent back to the app, now connected. The company appears in Step 1's dropdown from then on, for everyone.

Each company's exported files are automatically kept separate — connecting a second company never overwrites or mixes with another company's files.

A logged-in user's session with NetSuite renews itself silently in the background (using a refresh token). Roughly once every 7 days, NetSuite will require logging in again — that's normal, not an error.

---

## Troubleshooting

**"Client Credentials are only displayed on the initial setup page. They cannot be retrieved from the system."**
If you lose or aren't sure of a Client ID/Secret, don't guess — NetSuite genuinely cannot show them again. Either reset them on that Integration Record (Edit > reset credentials, shown once more), or create a brand-new Integration Record instead (cleaner if you're unsure whether anything else depends on the old one).

**Redirect URI mismatch / NetSuite rejects the login**
The Redirect URI pasted into the Integration Record (Step 3) must match, character-for-character, what the app showed you in Step 2. If the app's address changes (e.g. moved to a different server), the Integration Record's Redirect URI needs updating to match.

**"Token request failed" / "Authorization code exchange failed"**
Usually means, inside that NetSuite account:
- The Integration Record got disabled, or
- The role lost the permission from Step 4, or
- The Client Secret was reset/rotated since it was entered in the app (Step 5 needs to be redone with the new secret).

**Connect works but no data comes back**
Check that the NetSuite user who logged in actually has access to the records you're trying to export (vendor payments, customer payments, etc.) — OAuth permission alone isn't the same as record-level access.
