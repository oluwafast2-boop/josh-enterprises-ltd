// Resend email. Live only when RESEND_SEND=1 — otherwise stub so tests
// never send. Requires RESEND_API_KEY + RESEND_FROM in .env.
async function sendMail(to, subject, html) {
  const key = process.env.RESEND_API_KEY || '';
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  if (!key || process.env.RESEND_SEND !== '1') {
    return { mode: 'stub', to, hint: 'set RESEND_SEND=1 to send' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`resend: ${data.message || res.status}`);
  return { mode: 'live', to, id: data.id || null };
}

module.exports = { sendMail };
