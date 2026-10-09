// Money core: escrow ledger transitions with audit trail (PRD §17).
// States: none -> held -> released | refunded | disputed
const crypto = require('crypto');

async function getLedger(db, orderId) {
  const r = await db.query('SELECT * FROM escrow_ledger WHERE order_id = $1', [orderId]);
  return r.rows[0] || null;
}

async function ensureLedger(db, orderId, amountKobo) {
  let ledger = await getLedger(db, orderId);
  if (!ledger) {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO escrow_ledger (id, order_id, amount_kobo, state, audit, updated_at)
       VALUES ($1,$2,$3,'none',$4,$5)`,
      [crypto.randomUUID(), orderId, amountKobo, [{ at: now, event: 'created', amount_kobo: amountKobo }], now]
    );
    ledger = await getLedger(db, orderId);
  }
  return ledger;
}

async function transition(db, orderId, from, to, event) {
  const now = new Date().toISOString();
  const r = await db.query(
    `UPDATE escrow_ledger SET state = $1, updated_at = $2,
       audit = COALESCE(audit, '[]'::jsonb) || $3::jsonb
     WHERE order_id = $4 AND state = $5`,
    [to, now, JSON.stringify([{ at: now, event, from, to }]), orderId, from]
  );
  if (r.rowCount === 0) {
    const cur = await getLedger(db, orderId);
    throw new Error(`escrow-transition: expected ${from}, found ${cur ? cur.state : 'missing'}`);
  }
  return getLedger(db, orderId);
}

const hold = (db, orderId, amount) => ensureLedger(db, orderId, amount).then(() => transition(db, orderId, 'none', 'held', 'buyer-paid'));
const release = (db, orderId) => transition(db, orderId, 'held', 'released', 'buyer-confirmed');
const refund = (db, orderId) => transition(db, orderId, 'held', 'refunded', 'order-cancelled');

module.exports = { getLedger, ensureLedger, hold, release, refund };
