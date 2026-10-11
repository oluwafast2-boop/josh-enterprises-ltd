// Seed demo marketplace: 2 sellers, businesses, published listings.
// Usage: $env:ADMIN_EMAIL=...; $env:ADMIN_PASSWORD=...; node scripts/seed-demo.js
// Rerunnable (timestamp-unique emails).
const API = 'http://localhost:4000';
const stamp = Date.now();

async function api(path, { method = 'GET', body = null, token = null } = {}) {
  const headers = { connection: 'close', 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

(async () => {
  const cats = (await api('/api/categories')).body.categories || [];
  const cat = (name) => (cats.find((c) => c.name === name) || {}).id || null;
  const sellers = [
    { email: `adaeze+${stamp}@demo.local`, password: 'demo-pass-1', name: 'Adaeze Okafor', business: 'Adaeze Fashion Hub', location: 'Lagos',
      products: [
        { title: 'Ankara Gown — Emerald', price_kobo: 2500000, category: 'Fashion', stock: 8 },
        { title: 'Aso-Oke Head Tie', price_kobo: 450000, category: 'Fashion', stock: 20 },
      ],
      services: [{ title: 'Bridal Styling Session', price_kobo: 1500000, location: 'Lagos' }] },
    { email: `tunde+${stamp}@demo.local`, password: 'demo-pass-1', name: 'Tunde Bakare', business: 'Tunde Electronics', location: 'Ikeja',
      products: [
        { title: 'Solar Power Bank 50000mAh', price_kobo: 3850000, category: 'Electronics', stock: 15 },
        { title: 'Bluetooth Speaker Bass Pro', price_kobo: 5200000, category: 'Electronics', stock: 6 },
      ],
      services: [{ title: 'Phone Screen Replacement', price_kobo: 800000, location: 'Ikeja' }] },
  ];
  for (const s of sellers) {
    await api('/api/auth/register', { method: 'POST', body: { email: s.email, password: s.password, name: s.name } });
    const login = await api('/api/auth/login', { method: 'POST', body: { email: s.email, password: s.password } });
    const token = login.body.token;
    await api('/api/me', { method: 'PATCH', token, body: { location: s.location } });
    await api('/api/businesses', { method: 'POST', token, body: { name: s.business, location: s.location, description: `Official store of ${s.name}` } });
    for (const p of s.products) {
      await api('/api/products', { method: 'POST', token, body: { ...p, price_kobo: p.price_kobo, category_id: cat(p.category), location: s.location, status: 'published', description: `Quality ${p.title} from ${s.business}.` } });
    }
    for (const svc of s.services) {
      await api('/api/services', { method: 'POST', token, body: { ...svc, status: 'published', description: `Professional ${svc.title} by ${s.name}.` } });
    }
    console.log(`seeded ${s.business}`);
  }
  console.log('SEED OK');
})();
