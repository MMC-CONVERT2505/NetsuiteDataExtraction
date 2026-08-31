# Multi-Org OAuth2 Setup

## 1) One-time per NetSuite org

For each org/account:
1. Create integration with:
   - `Client Credentials (Machine To Machine) Grant` enabled
   - `REST Web Services` enabled
2. Upload certificate and do M2M mapping.
3. Keep these values:
   - `accountId`
   - `clientId`
   - `certificateId`
   - private key file path

## 2) Create org config

1. Copy `orgs.example.json` to `orgs.json`.
2. Fill real values for each org.

## 3) Run all orgs in one command

```powershell
npm run start:multi
```

## 4) Select one org from dropdown (auto-fill)

```powershell
npm run start:select
```

This shows a numbered org list from `orgs.json`.  
You select one org, and all auth values are auto-filled from that file.

## 5) Optional controls

If config file name is different:

```powershell
$env:NS_ORGS_FILE="my-orgs.json"
npm run start:multi
```

Continue remaining orgs even if one fails:

```powershell
$env:NS_MULTI_CONTINUE_ON_ERROR="true"
npm run start:multi
```
