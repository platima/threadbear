// Sends one sealed notification to an Android phone through Firebase, the way
// the push relay does (relay/convex/fcm.ts), for the emulator check in CI
// (.github/workflows/android.yml) and for trying a phone by hand.
//
//   FIREBASE_SERVICE_ACCOUNT='<the key file's contents>' \
//     node android/scripts/send-test-push.mjs <firebase-token> <push-key-base64> <title> <body>
//
// The text is sealed with the push key as convex/push.ts seals it, so only the
// phone with that key can read it. Exits 0 when Firebase accepts the message.
// It prints Firebase's answer and nothing of the key, the token or the text.
import crypto from 'node:crypto';

const [token, keyBase64, title, body] = process.argv.slice(2);
if (!token || !keyBase64 || !title || !body) {
  console.error('usage: send-test-push.mjs <firebase-token> <push-key-base64> <title> <body>');
  process.exit(2);
}
let account;
try {
  account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT ?? '');
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT is not the contents of a service account key file');
  process.exit(2);
}
if (!account.client_email || !account.private_key || !account.project_id) {
  console.error('FIREBASE_SERVICE_ACCOUNT has no client_email, private_key and project_id: it needs the key file itself, not just the account\'s address');
  process.exit(2);
}

const b64url = (b) => Buffer.from(b).toString('base64url');

// The same as convex/pushSeal.ts: nonce, ciphertext and tag, in base64
function seal(key, text) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

async function accessToken() {
  const iat = Math.floor(Date.now() / 1000);
  const claims = { iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 };
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const assertion = `${input}.${b64url(crypto.createSign('RSA-SHA256').update(input).sign(account.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok || !answer.access_token) {
    console.error(`Google would not give an access token: HTTP ${res.status} ${answer.error ?? ''}`);
    process.exit(1);
  }
  return answer.access_token;
}

const message = {
  message: {
    token,
    data: { threadId: 'ci-check', e: seal(keyBase64, JSON.stringify({ title, body })) },
    android: { priority: 'HIGH', ttl: '300s' },
  },
};
const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(message),
});
const answer = await res.json().catch(() => ({}));
// Firebase's error status word (UNREGISTERED, INVALID_ARGUMENT...) can be shown; its message can name the token
console.log(res.ok ? 'Firebase accepted the message' : `Firebase said HTTP ${res.status} ${answer?.error?.status ?? ''}`);
process.exit(res.ok ? 0 : 1);
