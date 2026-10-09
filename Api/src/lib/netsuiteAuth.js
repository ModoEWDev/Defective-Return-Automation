const jwt = require('jsonwebtoken');

let cachedToken = null;
let cachedTokenExpiry = 0;

/**
 * Requests (and caches) an access token using the service account's
 * Client Credentials Grant — the entity/role/certificate set up earlier.
 * No username or password is involved; the JWT is signed with the
 * private key half of the certificate registered in NetSuite's
 * OAuth 2.0 Client Credentials (M2M) Setup record.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 30_000) {
    return cachedToken;
  }

  const {
    NETSUITE_ACCOUNT_ID,
    NETSUITE_CLIENT_ID,
    NETSUITE_CERTIFICATE_ID,
    NETSUITE_PRIVATE_KEY, // PEM contents; store with literal \n, see README
  } = process.env;

  const privateKey = NETSUITE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const tokenUrl = `https://${NETSUITE_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: NETSUITE_CLIENT_ID,
      scope: 'rest_webservices',
      aud: tokenUrl,
      exp: now + 3300, // 55 minutes — leaves a safety margin under NetSuite's 1-hour limit
      iat: now,
    },
    privateKey,
    { algorithm: 'PS256', keyid: NETSUITE_CERTIFICATE_ID }
  );

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NetSuite token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

module.exports = { getAccessToken };
