// Paystack provider (test mode until live keys). Amounts in kobo (NGN).
const crypto = require('crypto');
const SECRET = () => process.env.PAYSTACK_SECRET_KEY || '';
const enabled = () => SECRET().length > 0;

async function init(email, amountKobo, reference, metadata = {}) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: amountKobo, reference, metadata }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.status) throw new Error(`paystack-init: ${data.message || res.status}`);
  return data.data; // { authorization_url, access_code, reference }
}

function verifySignature(rawBody, signature) {
  if (!SECRET()) return false;
  const expected = crypto.createHmac('sha512', SECRET()).update(rawBody).digest('hex');
  const sig = String(signature || '');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

module.exports = { enabled, init, verifySignature };
