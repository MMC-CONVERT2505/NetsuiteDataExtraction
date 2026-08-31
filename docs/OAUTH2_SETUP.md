# OAuth2 Setup (NetSuite M2M)

## 1) Generate key and certificate

```powershell
mkdir keys
openssl genrsa -out keys/private_key.pem 2048
openssl req -new -x509 -key keys/private_key.pem -out keys/public_cert.pem -days 3650 -subj "/CN=netsuite-oauth2"
```

## 2) NetSuite values

1. `Setup > Integration > Manage Integrations > New`  
   Save integration and copy `Client ID`.
2. Upload `keys/public_cert.pem` in NetSuite certificate area.
3. `Setup > Integration > OAuth 2.0 Client Credentials (M2M) Setup`  
   Map integration + role + entity + certificate.
4. Copy certificate id as `NS_OAUTH2_CERTIFICATE_ID`.

## 3) Configure env

Copy `.env.example` to `.env` and fill values:

```env
NS_AUTH_MODE=oauth2
NS_ACCOUNT_ID=YOUR_ACCOUNT_ID
NS_OAUTH2_CLIENT_ID=YOUR_CLIENT_ID
NS_OAUTH2_CERTIFICATE_ID=YOUR_CERTIFICATE_ID
NS_OAUTH2_PRIVATE_KEY_PATH=./keys/private_key.pem
NS_OAUTH2_SCOPE=rest_webservices
```

## 4) Run

```powershell
npm start
```
