// Termii SMS (generic send). Live only when TERMII_SEND=1 — otherwise stub
// so tests/seeds never spend credit. Requires TERMII_API_KEY in .env.
async function sendSms(to, message) {
  const key = process.env.TERMII_API_KEY || '';
  const from = process.env.TERMII_SENDER_ID || 'JoshEnt';
  if (!key || process.env.TERMII_SEND !== '1') {
    return { mode: 'stub', to, hint: 'set TERMII_SEND=1 with funded key to send' };
  }
  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, from, sms: message, type: 'plain', channel: 'generic', api_key: key }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 'ok') throw new Error(`termii: ${data.message || res.status}`);
  return { mode: 'live', to, messageId: data.message_id || null };
}

module.exports = { sendSms };
