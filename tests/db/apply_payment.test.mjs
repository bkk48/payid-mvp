// Runs the real migration (supabase/migrations/20261107000000_payid.sql) in an
// in-memory Postgres (PGlite) and walks the README "Test checklist":
// exact payment, wrong amount, expired + late payment, cancel + late payment,
// re-used open PayID, duplicate webhook, double payment, auto-expire, roles.
// No network, no real database.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = readFileSync(path.join(root, 'supabase/migrations/20261107000000_payid.sql'), 'utf8');

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

const db = new PGlite();
// Supabase plumbing the migration expects.
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create publication supabase_realtime;
`);
await db.exec(migration);
await db.exec(migration); // re-runnable
console.log('\n# PayID apply_payment (migration 20261107000000)');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
let n = 0;
const intent = async (amount, { minutes = 15, status = 'awaiting' } = {}) => {
  n++;
  const [r] = await q(
    `insert into payment_intents(order_id, store_id, amount_cents, provider, provider_ref, payid, status, expires_at)
     values ($1, 'hampton-park', $2, 'mock', $3, $4, $5, now() + ($6 || ' minutes')::interval) returning id`,
    [`order-${n}`, amount, `ref-${n}`, `p${n}@pay.test`, status, String(minutes)],
  );
  return { id: r.id, ref: `ref-${n}` };
};
const pay = async (ref, cents, eventId = crypto.randomUUID()) =>
  (await q(`select apply_payment('mock', $1, $2, $3, 'TEST', '{}'::jsonb) r`, [eventId, ref, cents]))[0].r;
const row = async (id) => (await q(`select status::text, paid_cents from payment_intents where id = $1`, [id]))[0];

// 1. exact amount
let i = await intent(2250);
check('pay correct amount -> paid', await pay(i.ref, 2250), 'paid');
check('row: paid, $22.50 recorded (before: awaiting, null)', await row(i.id), { status: 'paid', paid_cents: 2250 });

// 2. wrong amount
i = await intent(2250);
check('pay $20.00 on a $22.50 bill -> mismatch', await pay(i.ref, 2000), 'mismatch');
check('row: mismatch, $20.00 recorded (staff decide)', await row(i.id), { status: 'mismatch', paid_cents: 2000 });

// 3. expired, then paid
i = await intent(1500, { minutes: -1 });
check('pay after expiry -> late_paid (refund)', await pay(i.ref, 1500), 'late_paid');

// 4. cancelled, then paid
i = await intent(1500, { status: 'cancelled' });
check('pay after cancel -> late_paid (refund)', await pay(i.ref, 1500), 'late_paid');

// 5. same webhook twice
i = await intent(990);
const ev = crypto.randomUUID();
check('first webhook -> paid', await pay(i.ref, 990, ev), 'paid');
check('same webhook replayed -> duplicate', await pay(i.ref, 990, ev), 'duplicate');
check('replay did not double count', await row(i.id), { status: 'paid', paid_cents: 990 });
check('one event row stored for it', (await q(`select count(*)::int c from payment_events where event_id = $1`, [ev]))[0].c, 1);

// 6. customer pays twice (two different bank transfers)
check('second, different payment on a paid bill -> already_paid (refund)', await pay(i.ref, 990), 'already_paid');

// 7. unknown PayID reference
check('payment for an unknown reference -> unknown_intent', await pay('nope', 100), 'unknown_intent');

// 8. one open PayID per order
await q(`insert into payment_intents(order_id, store_id, amount_cents, provider, provider_ref, status, expires_at)
         values ('dup', 'hampton-park', 100, 'mock', 'dup-1', 'awaiting', now() + interval '15 minutes')`);
const second = await db.query(`insert into payment_intents(order_id, store_id, amount_cents, provider, provider_ref, status, expires_at)
         values ('dup', 'hampton-park', 100, 'mock', 'dup-2', 'awaiting', now() + interval '15 minutes')`).then(() => 'ok', () => 'blocked');
check('a second open PayID for the same order is refused', second, 'blocked');

// 9. auto-expire (what the expire-payid cron calls every minute)
const stale = await intent(500, { minutes: -5 });
const fresh = await intent(500, { minutes: 10 });
check('expire_payment_intents() expires only the overdue one', (await q('select expire_payment_intents() n'))[0].n >= 1, true);
check('overdue -> expired, fresh -> still awaiting', [(await row(stale.id)).status, (await row(fresh.id)).status], ['expired', 'awaiting']);

// 10. who may call what
const asRole = async (role, sql) => {
  await db.exec('begin');
  try { await db.exec(`set local role ${role}`); await db.query(sql); await db.exec('rollback'); return 'ok'; }
  catch { await db.exec('rollback'); return 'blocked'; }
};
check('anon cannot call apply_payment (only the webhook, as service role)', await asRole('anon', `select apply_payment('mock','x','ref-1',1,null,'{}')`), 'blocked');
check('logged-in user cannot call apply_payment', await asRole('authenticated', `select apply_payment('mock','x','ref-1',1,null,'{}')`), 'blocked');

console.log(`  -> ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
