# NetSuite Web App User Guide

This document explains how to run the NetSuite export web app and how to get the NetSuite OAuth values required in the Connect screen.

## 1. What This App Does

The app connects to NetSuite and exports payment-related data for a selected date range.

Supported export types:

- `vendorpayment`
- `customerpayment`
- `depositapplication`
- `journalentry`

The browser UI collects the NetSuite runtime credentials, connects to NetSuite, then runs the extraction.

## 2. Project Files

Important files in this project:

| File or Folder | Purpose |
|---|---|
| `backend.js` | Backend API server. Runs on port `3001`. |
| `frontend-server.js` | Frontend UI server. Runs on port `3002` when configured. |
| `public/index.html` | Browser UI. |
| `netsuite-export.js` | Main NetSuite export script used by the backend. |
| `keys/mmcc_public_cert.pem` | Public certificate uploaded to NetSuite. |
| `keys/mmcc_private_key.pem` | Private key pasted into the UI or used locally. |
| `.env.example` | Example environment variables for CLI usage. |

## 3. How to Run the App

Open PowerShell.

Go to the project folder:

```powershell
cd "D:\net suite try 11"
```

If dependencies are missing, install them:

```powershell
npm.cmd install
```

### Start Backend

Open PowerShell window 1:

```powershell
cd "D:\net suite try 11"
node backend.js
```

Expected output:

```text
Backend API running at http://127.0.0.1:3001
```

Keep this PowerShell window open.

### Start Frontend

Open PowerShell window 2:

```powershell
cd "D:\net suite try 11"
$env:UI_PORT="3002"
node frontend-server.js
```

Expected output:

```text
Frontend UI running at http://127.0.0.1:3002
Backend API expected at http://127.0.0.1:3001
```

Keep this PowerShell window open.

### Open the App

Open this URL in the browser:

```text
http://127.0.0.1:3002
```

Do not open port `3001` for the UI. Port `3001` is only the backend API.

## 4. If Port Is Already in Use

If backend says port `3001` is already in use:

```powershell
netstat -ano | findstr :3001
```

The last number is the process ID.

Stop it:

```powershell
Stop-Process -Id PROCESS_ID
```

Example:

```powershell
Stop-Process -Id 18736
```

If frontend port `3002` is already in use:

```powershell
netstat -ano | findstr :3002
Stop-Process -Id PROCESS_ID
```

## 5. NetSuite Values Needed in the Connect Screen

The Connect screen has these fields:

| UI Field | What to Enter |
|---|---|
| Org Name (Label) | Any label you choose, for example `mmcc_prod_runtime`. |
| Account ID | NetSuite account-specific domain ID, for example `1234567` or `1234567-sb1`. |
| Client ID | Client ID from the NetSuite Integration Record. |
| Certificate ID (kid) | Certificate ID from NetSuite OAuth 2.0 Client Credentials setup. |
| Scope | Keep as `rest_webservices`. |
| Token URL | Leave blank unless you need a custom token URL. |
| Private Key PEM | Full private key text from `keys/mmcc_private_key.pem`. |

## 6. How to Get the Account ID

Log in to NetSuite and check the browser URL.

Production example:

```text
https://1234567.app.netsuite.com
```

Use:

```text
1234567
```

Sandbox example:

```text
https://1234567-sb1.app.netsuite.com
```

Use:

```text
1234567-sb1
```

Important: use the URL/domain style account ID. If NetSuite shows an account ID with an underscore, such as `1234567_SB1`, the SuiteTalk domain usually uses lowercase with a hyphen:

```text
1234567-sb1
```

## 7. How to Create or Check the Integration Record

In NetSuite:

1. Go to:

```text
Setup > Integration > Manage Integrations
```

2. Open the existing integration or click:

```text
New
```

3. Enter a name, for example:

```text
NetSuite Export App
```

4. Set the integration state to:

```text
Enabled
```

5. Enable OAuth 2.0 / REST options required for machine-to-machine access.

Look for options like:

```text
Client Credentials (Machine to Machine) Grant
REST Web Services
```

6. Save the integration.

7. Copy the integration's:

```text
Client ID
```

Paste this into the app field:

```text
Client ID
```

## 8. How to Upload the Public Certificate and Get Certificate ID

Use this file as the public certificate:

```text
D:\net suite try 11\keys\mmcc_public_cert.pem
```

In NetSuite:

1. Go to:

```text
Setup > Integration > Manage Authentication
```

2. Open:

```text
OAuth 2.0 Client Credentials (M2M) Setup
```

The exact menu name may vary slightly by NetSuite role or version.

3. Click:

```text
Create New
```

4. Select the required mapping values:

```text
Entity: Select the NetSuite user for this integration
Role: Select the role the app should use
Application: Select the Integration Record
Certificate: Upload mmcc_public_cert.pem
```

5. Save.

6. After saving, NetSuite shows a row for this OAuth 2.0 Client Credentials setup.

7. Copy:

```text
Certificate ID
```

Paste this value into the app field:

```text
Certificate ID (kid)
```

## 9. Private Key PEM

The private key file is:

```text
D:\net suite try 11\keys\mmcc_private_key.pem
```

Open the file and copy the full contents.

It should include the first and last lines:

```text
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

Paste the full text into:

```text
Private Key PEM
```

Do not upload the private key to NetSuite. NetSuite gets only the public certificate. This app uses the private key locally to sign the OAuth request.

### Is the Private Key Always the Same?

For the same NetSuite account and same uploaded certificate, yes, the private key stays the same.

The private key changes only when:

- A new private/public key pair is generated.
- A new public certificate is uploaded to NetSuite.
- The certificate is rotated or replaced.
- A different NetSuite account or sandbox uses a different certificate.

The private key must match the public certificate uploaded in NetSuite.

## 10. Role Permission Required

The role selected in the OAuth 2.0 Client Credentials setup must have permission to use OAuth 2.0 access tokens.

In NetSuite:

1. Go to:

```text
Setup > Users/Roles > Manage Roles
```

2. Open or customize the role used in the OAuth setup.

3. Go to:

```text
Permissions > Setup
```

4. Add this permission:

```text
Log in using OAuth 2.0 Access Tokens
```

5. Save the role.

The role must also have access to the NetSuite records being exported.

## 11. Recommended Values for the App Form

Use this as a template:

```text
Org Name (Label): mmcc_prod_runtime
Account ID: 1234567
Client ID: <Client ID from NetSuite Integration Record>
Certificate ID (kid): <Certificate ID from OAuth 2.0 Client Credentials setup>
Scope: rest_webservices
Token URL: leave blank
Private Key PEM: paste full private key from keys/mmcc_private_key.pem
```

For sandbox:

```text
Org Name (Label): mmcc_sandbox_runtime
Account ID: 1234567-sb1
Client ID: <Sandbox Client ID>
Certificate ID (kid): <Sandbox Certificate ID>
Scope: rest_webservices
Token URL: leave blank
Private Key PEM: paste matching private key
```

## 12. How to Use the Web App

1. Start backend and frontend.
2. Open:

```text
http://127.0.0.1:3002
```

3. Fill the Connect form.
4. Click:

```text
Connect Runtime
```

5. If connection is successful, choose:

```text
Start Date
End Date
Payment Type
```

6. Click the export/run button.

7. Wait for the job to complete.

8. Download the output file from the file list.

## 13. Output Files

The app can show or download generated export files such as:

```text
vendorpayment.csv
customerpayment.csv
depositapplication.csv
journalentry.csv
raw_*.jsonl
progress_*.json
```

Available download formats depend on the file type:

- CSV
- XLSX
- JSON

## 14. Common Errors

### Backend API cannot start because port 3001 is already in use

Another backend process is already running.

Fix:

```powershell
netstat -ano | findstr :3001
Stop-Process -Id PROCESS_ID
node backend.js
```

### Frontend UI cannot start because port 3002 is already in use

Another frontend process is already running.

Fix:

```powershell
netstat -ano | findstr :3002
Stop-Process -Id PROCESS_ID
$env:UI_PORT="3002"
node frontend-server.js
```

### PowerShell says npm.ps1 cannot be loaded

Use `npm.cmd` instead of `npm`:

```powershell
npm.cmd install
```

### Connect Runtime fails

Check these values:

- Account ID uses domain style, for example `1234567-sb1`.
- Client ID is copied from the correct NetSuite Integration Record.
- Certificate ID is copied from OAuth 2.0 Client Credentials setup.
- Private key matches the public certificate uploaded to NetSuite.
- Role has `Log in using OAuth 2.0 Access Tokens`.
- Role has permission to access the required NetSuite records.

### Invalid private key

Make sure the pasted key includes:

```text
-----BEGIN PRIVATE KEY-----
```

and:

```text
-----END PRIVATE KEY-----
```

Do not paste the public certificate into the Private Key PEM field.

### Token URL problem

Usually leave Token URL blank.

If you need to enter it manually, use this format:

```text
https://ACCOUNT_ID.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token
```

Example:

```text
https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token
```

## 15. Security Notes

- Do not share `mmcc_private_key.pem`.
- Do not commit real private keys to Git.
- Do not send private keys in chat or email.
- Public certificate can be uploaded to NetSuite.
- Private key stays only in this app or local secure storage.
- Rotate the certificate/key if the private key is exposed.

## 16. Quick Checklist

Before using the app, confirm:

- Backend is running on `3001`.
- Frontend is running on `3002`.
- Browser is opened at `http://127.0.0.1:3002`.
- NetSuite Integration Record is enabled.
- Client ID is copied.
- Public certificate is uploaded.
- Certificate ID is copied.
- Role has OAuth 2.0 token permission.
- Private key PEM is pasted fully.
- Scope is `rest_webservices`.
- Token URL is blank unless a custom URL is required.

