// Ice Lab Team Store — Cloudflare Worker
// Standalone e-commerce store for hockey equipment & team gear

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // --- API Routes ---
    if (path.startsWith('/api/')) {
      try {
        if (path === '/api/verify-pin' && method === 'POST') return apiVerifyPin(request, env);
        if (path === '/api/verify-admin-pin' && method === 'POST') return apiVerifyAdminPin(request, env);
        if (path === '/api/categories' && method === 'GET') return apiGetCategories(env);
        if (path === '/api/products' && method === 'GET') return apiGetProducts(url, env);
        if (path.match(/^\/api\/product\/[^/]+$/) && method === 'GET') return apiGetProduct(path.split('/')[3], env);
        if (path === '/api/checkout' && method === 'POST') return apiCheckout(request, env);
        if (path === '/api/stripe/webhook' && method === 'POST') return apiStripeWebhook(request, env);
        if (path === '/api/admin/categories' && method === 'GET') return apiAdminGetCategories(env);
        if (path === '/api/admin/category' && method === 'POST') return apiAdminSaveCategory(request, env);
        if (path.match(/^\/api\/admin\/category\/[^/]+$/) && method === 'DELETE') return apiAdminDeleteCategory(path.split('/')[4], env);
        if (path === '/api/admin/products' && method === 'GET') return apiAdminGetProducts(env);
        if (path === '/api/admin/product' && method === 'POST') return apiAdminSaveProduct(request, env);
        if (path.match(/^\/api\/admin\/product\/[^/]+$/) && method === 'DELETE') return apiAdminDeleteProduct(path.split('/')[4], env);
        if (path === '/api/admin/orders' && method === 'GET') return apiAdminGetOrders(url, env);
        if (path === '/api/admin/order/status' && method === 'POST') return apiAdminUpdateOrderStatus(request, env);
        if (path === '/api/admin/config' && method === 'GET') return apiAdminGetConfig(env);
        if (path === '/api/admin/config' && method === 'POST') return apiAdminSaveConfig(request, env);
        if (path === '/api/admin/seed' && method === 'POST') return apiAdminSeed(env);
        return json({ error: 'Not found' }, 404);
      } catch (e) {
        console.error('API Error:', e);
        return json({ error: 'Internal server error' }, 500);
      }
    }

    if (path === '/admin' || path.startsWith('/admin')) return htmlResponse(adminPage());
    if (path === '/checkout/success') return htmlResponse(checkoutSuccessPage());
    if (path === '/checkout/cancel') return htmlResponse(checkoutCancelPage());
    return htmlResponse(storePage());
  }
};

// ============================================================
// HELPERS
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } });
}
function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
}
async function getConfig(env) {
  const config = await env.STORE_DATA.get('config', 'json');
  return config || { storeName: 'Ice Lab Team Store', storePin: '1234', adminPin: '9999', stripePublishableKey: '', stripeSecretKey: '', stripeWebhookSecret: '' };
}

// ============================================================
// STORE PIN API
// ============================================================
async function apiVerifyPin(request, env) {
  const { pin } = await request.json();
  const config = await getConfig(env);
  if (pin === config.storePin) return json({ success: true });
  return json({ error: 'Invalid PIN' }, 401);
}
async function apiVerifyAdminPin(request, env) {
  const { pin } = await request.json();
  const config = await getConfig(env);
  if (pin === config.adminPin) return json({ success: true });
  return json({ error: 'Invalid PIN' }, 401);
}

// ============================================================
// PUBLIC PRODUCT APIs
// ============================================================
async function apiGetCategories(env) {
  const ids = await env.STORE_DATA.get('categories', 'json') || [];
  const cats = [];
  for (const id of ids) { const cat = await env.STORE_DATA.get(`category:${id}`, 'json'); if (cat && cat.active !== false) cats.push(cat); }
  cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  return json(cats);
}
async function apiGetProducts(url, env) {
  const categoryId = url.searchParams.get('category');
  const ids = await env.STORE_DATA.get('products', 'json') || [];
  const products = [];
  for (const id of ids) { const p = await env.STORE_DATA.get(`product:${id}`, 'json'); if (!p || !p.active) continue; if (categoryId && p.category !== categoryId) continue; products.push(p); }
  return json(products);
}
async function apiGetProduct(id, env) {
  const p = await env.STORE_DATA.get(`product:${id}`, 'json');
  if (!p) return json({ error: 'Product not found' }, 404);
  return json(p);
}

// ============================================================
// CHECKOUT API
// ============================================================
async function apiCheckout(request, env) {
  const config = await getConfig(env);
  if (!config.stripeSecretKey) return json({ error: 'Stripe not configured' }, 500);
  const { items, customer } = await request.json();
  if (!items?.length) return json({ error: 'Cart is empty' }, 400);
  if (!customer?.name || !customer?.email || !customer?.phone) return json({ error: 'Customer info required' }, 400);
  const lineItems = [];
  for (const item of items) {
    const product = await env.STORE_DATA.get(`product:${item.productId}`, 'json');
    if (!product) return json({ error: `Product not found: ${item.productId}` }, 400);
    if (item.variantId) {
      const variant = product.variants?.find(v => v.id === item.variantId);
      if (variant && variant.stock !== null && variant.stock !== undefined && variant.stock < item.qty) {
        return json({ error: `Insufficient stock for ${product.name}` }, 400);
      }
    }
    const price = item.variantId ? (product.variants?.find(v => v.id === item.variantId)?.price || product.price) : product.price;
    let itemName = product.name;
    if (item.options && Object.keys(item.options).length > 0) itemName += ' (' + Object.values(item.options).join(', ') + ')';
    lineItems.push({ price_data: { currency: 'usd', product_data: { name: itemName }, unit_amount: Math.round(price * 100) }, quantity: item.qty });
  }
  const origin = new URL(request.url).origin;
  const session = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildStripeBody({
      'mode': 'payment', 'success_url': `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`, 'cancel_url': `${origin}/checkout/cancel`,
      'customer_email': customer.email, 'metadata[customerName]': customer.name, 'metadata[customerPhone]': customer.phone, 'metadata[items]': JSON.stringify(items),
      ...lineItems.reduce((acc, li, i) => { acc[`line_items[${i}][price_data][currency]`] = li.price_data.currency; acc[`line_items[${i}][price_data][product_data][name]`] = li.price_data.product_data.name; acc[`line_items[${i}][price_data][unit_amount]`] = li.price_data.unit_amount; acc[`line_items[${i}][quantity]`] = li.quantity; return acc; }, {})
    })
  });
  const sessionData = await session.json();
  if (sessionData.error) return json({ error: sessionData.error.message }, 400);
  return json({ url: sessionData.url, sessionId: sessionData.id });
}
function buildStripeBody(params) { return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }

// ============================================================
// STRIPE WEBHOOK
// ============================================================
async function apiStripeWebhook(request, env) {
  const config = await getConfig(env);
  const body = await request.text();
  if (config.stripeWebhookSecret) {
    const sig = request.headers.get('stripe-signature');
    const valid = await verifyStripeSignature(body, sig, config.stripeWebhookSecret);
    if (!valid) return json({ error: 'Invalid signature' }, 400);
  }
  const event = JSON.parse(body);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const items = JSON.parse(session.metadata?.items || '[]');
    const order = {
      id: generateId('ord'), status: 'pending',
      customer: { name: session.metadata?.customerName || '', email: session.customer_email || session.customer_details?.email || '', phone: session.metadata?.customerPhone || '' },
      items, total: session.amount_total / 100, stripeSessionId: session.id, stripePaymentIntent: session.payment_intent,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pickupReadyAt: null, pickedUpAt: null
    };
    await env.STORE_DATA.put(`order:${order.id}`, JSON.stringify(order));
    const orderIds = await env.STORE_DATA.get('orders', 'json') || [];
    orderIds.unshift(order.id);
    await env.STORE_DATA.put('orders', JSON.stringify(orderIds));
    for (const item of items) {
      const product = await env.STORE_DATA.get(`product:${item.productId}`, 'json');
      if (product && item.variantId) {
        const variant = product.variants?.find(v => v.id === item.variantId);
        if (variant && variant.stock !== null && variant.stock !== undefined) { variant.stock = Math.max(0, variant.stock - item.qty); await env.STORE_DATA.put(`product:${product.id}`, JSON.stringify(product)); }
      }
    }
  }
  return json({ received: true });
}
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  try {
    const parts = sigHeader.split(',').reduce((acc, part) => { const [key, value] = part.split('='); acc[key.trim()] = value; return acc; }, {});
    const signedPayload = `${parts.t}.${payload}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return expected === parts.v1;
  } catch { return false; }
}

// ============================================================
// ADMIN APIs
// ============================================================
async function apiAdminGetCategories(env) {
  const ids = await env.STORE_DATA.get('categories', 'json') || [];
  const cats = [];
  for (const id of ids) { const cat = await env.STORE_DATA.get(`category:${id}`, 'json'); if (cat) cats.push(cat); }
  cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  return json(cats);
}
async function apiAdminSaveCategory(request, env) {
  const data = await request.json();
  const isNew = !data.id;
  const id = data.id || generateId('cat');
  const category = { id, name: data.name, description: data.description || '', image: data.image || '', order: data.order || 0, active: data.active !== false, createdAt: data.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await env.STORE_DATA.put(`category:${id}`, JSON.stringify(category));
  if (isNew) { const ids = await env.STORE_DATA.get('categories', 'json') || []; ids.push(id); await env.STORE_DATA.put('categories', JSON.stringify(ids)); }
  return json(category);
}
async function apiAdminDeleteCategory(id, env) {
  await env.STORE_DATA.delete(`category:${id}`);
  const ids = await env.STORE_DATA.get('categories', 'json') || [];
  await env.STORE_DATA.put('categories', JSON.stringify(ids.filter(i => i !== id)));
  return json({ success: true });
}
async function apiAdminGetProducts(env) {
  const ids = await env.STORE_DATA.get('products', 'json') || [];
  const products = [];
  for (const id of ids) { const p = await env.STORE_DATA.get(`product:${id}`, 'json'); if (p) products.push(p); }
  return json(products);
}
async function apiAdminSaveProduct(request, env) {
  const data = await request.json();
  const isNew = !data.id;
  const id = data.id || generateId('prod');
  const product = { id, name: data.name, description: data.description || '', category: data.category || '', price: parseFloat(data.price) || 0, images: data.images || [], variantTypes: data.variantTypes || [], variants: data.variants || [], active: data.active !== false, createdAt: data.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await env.STORE_DATA.put(`product:${id}`, JSON.stringify(product));
  if (isNew) { const ids = await env.STORE_DATA.get('products', 'json') || []; ids.push(id); await env.STORE_DATA.put('products', JSON.stringify(ids)); }
  return json(product);
}
async function apiAdminDeleteProduct(id, env) {
  const product = await env.STORE_DATA.get(`product:${id}`, 'json');
  if (product) { product.active = false; product.updatedAt = new Date().toISOString(); await env.STORE_DATA.put(`product:${id}`, JSON.stringify(product)); }
  return json({ success: true });
}
async function apiAdminGetOrders(url, env) {
  const status = url.searchParams.get('status');
  const ids = await env.STORE_DATA.get('orders', 'json') || [];
  const orders = [];
  for (const id of ids) { const o = await env.STORE_DATA.get(`order:${id}`, 'json'); if (!o) continue; if (status && o.status !== status) continue; orders.push(o); }
  return json(orders);
}
async function apiAdminUpdateOrderStatus(request, env) {
  const { orderId, status } = await request.json();
  const order = await env.STORE_DATA.get(`order:${orderId}`, 'json');
  if (!order) return json({ error: 'Order not found' }, 404);
  order.status = status; order.updatedAt = new Date().toISOString();
  if (status === 'ready') order.pickupReadyAt = new Date().toISOString();
  if (status === 'picked_up') order.pickedUpAt = new Date().toISOString();
  await env.STORE_DATA.put(`order:${order.id}`, JSON.stringify(order));
  return json(order);
}
async function apiAdminGetConfig(env) { return json(await getConfig(env)); }
async function apiAdminSaveConfig(request, env) {
  const data = await request.json();
  const existing = await getConfig(env);
  const config = { ...existing, ...data, updatedAt: new Date().toISOString() };
  await env.STORE_DATA.put('config', JSON.stringify(config));
  return json(config);
}
async function apiAdminSeed(env) {
  const categories = [
    { id: 'cat_sticks', name: 'Sticks', description: 'Hockey sticks for all levels', image: '', order: 1, active: true },
    { id: 'cat_helmets', name: 'Helmets', description: 'Protective helmets and cages', image: '', order: 2, active: true },
    { id: 'cat_gloves', name: 'Gloves', description: 'Hockey gloves', image: '', order: 3, active: true },
    { id: 'cat_protective', name: 'Protective', description: 'Shin guards, shoulder pads, pants', image: '', order: 4, active: true },
    { id: 'cat_apparel', name: 'Apparel', description: 'Team apparel and accessories', image: '', order: 5, active: true }
  ];
  const products = [
    { id: 'prod_stick1', name: 'Bauer Nexus E5 Pro Stick', description: 'Top-tier performance stick with enhanced puck feel.', category: 'cat_sticks', price: 289.99, images: [], active: true,
      variantTypes: [{ name: 'Hand', options: ['Left', 'Right'] }, { name: 'Flex', options: ['75', '85', '95'] }, { name: 'Curve', options: ['P92', 'P88', 'P28'] }],
      variants: [{ id: 'var_s1a', sku: 'BAU-NE5P-L85-P92', options: { Hand: 'Left', Flex: '85', Curve: 'P92' }, stock: 5, price: null }, { id: 'var_s1b', sku: 'BAU-NE5P-R85-P92', options: { Hand: 'Right', Flex: '85', Curve: 'P92' }, stock: 3, price: null }, { id: 'var_s1c', sku: 'BAU-NE5P-L75-P88', options: { Hand: 'Left', Flex: '75', Curve: 'P88' }, stock: 2, price: null }] },
    { id: 'prod_stick2', name: 'CCM Jetspeed FT6 Pro', description: 'Lightweight and responsive for quick release.', category: 'cat_sticks', price: 319.99, images: [], active: true,
      variantTypes: [{ name: 'Hand', options: ['Left', 'Right'] }, { name: 'Flex', options: ['75', '85', '95'] }, { name: 'Curve', options: ['P29', 'P90', 'P28'] }],
      variants: [{ id: 'var_s2a', sku: 'CCM-JFT6-L85-P29', options: { Hand: 'Left', Flex: '85', Curve: 'P29' }, stock: 4, price: null }, { id: 'var_s2b', sku: 'CCM-JFT6-R95-P90', options: { Hand: 'Right', Flex: '95', Curve: 'P90' }, stock: 2, price: null }] },
    { id: 'prod_helmet1', name: 'Bauer Re-Akt 85 Helmet', description: 'Premium protection with comfort fit system.', category: 'cat_helmets', price: 159.99, images: [], active: true,
      variantTypes: [{ name: 'Size', options: ['Small', 'Medium', 'Large'] }, { name: 'Color', options: ['Black', 'White', 'Navy'] }],
      variants: [{ id: 'var_h1a', sku: 'BAU-RA85-M-BLK', options: { Size: 'Medium', Color: 'Black' }, stock: 6, price: null }, { id: 'var_h1b', sku: 'BAU-RA85-L-BLK', options: { Size: 'Large', Color: 'Black' }, stock: 4, price: null }, { id: 'var_h1c', sku: 'BAU-RA85-M-WHT', options: { Size: 'Medium', Color: 'White' }, stock: 3, price: null }] },
    { id: 'prod_gloves1', name: 'Warrior Alpha LX2 Gloves', description: 'Lightweight gloves with great feel and protection.', category: 'cat_gloves', price: 129.99, images: [], active: true,
      variantTypes: [{ name: 'Size', options: ['13"', '14"', '15"'] }, { name: 'Color', options: ['Black', 'Navy', 'Red'] }],
      variants: [{ id: 'var_g1a', sku: 'WAR-ALX2-14-BLK', options: { Size: '14"', Color: 'Black' }, stock: 8, price: null }, { id: 'var_g1b', sku: 'WAR-ALX2-13-NAV', options: { Size: '13"', Color: 'Navy' }, stock: 5, price: null }] },
    { id: 'prod_shins1', name: 'CCM Tacks AS-V Shin Guards', description: 'Pro-level shin protection with anatomical fit.', category: 'cat_protective', price: 89.99, images: [], active: true,
      variantTypes: [{ name: 'Size', options: ['13"', '14"', '15"', '16"'] }],
      variants: [{ id: 'var_p1a', sku: 'CCM-ASV-SG-14', options: { Size: '14"' }, stock: 10, price: null }, { id: 'var_p1b', sku: 'CCM-ASV-SG-15', options: { Size: '15"' }, stock: 7, price: null }] },
    { id: 'prod_hoodie1', name: 'Ice Lab Team Hoodie', description: 'Heavyweight fleece hoodie with embroidered Ice Lab logo.', category: 'cat_apparel', price: 54.99, images: [], active: true,
      variantTypes: [{ name: 'Size', options: ['S', 'M', 'L', 'XL', '2XL'] }, { name: 'Color', options: ['Black', 'Charcoal', 'Navy'] }],
      variants: [{ id: 'var_a1a', sku: 'ICE-HOOD-M-BLK', options: { Size: 'M', Color: 'Black' }, stock: 15, price: null }, { id: 'var_a1b', sku: 'ICE-HOOD-L-BLK', options: { Size: 'L', Color: 'Black' }, stock: 12, price: null }, { id: 'var_a1c', sku: 'ICE-HOOD-XL-CHA', options: { Size: 'XL', Color: 'Charcoal' }, stock: 8, price: null }] }
  ];
  const catIds = categories.map(c => c.id);
  await env.STORE_DATA.put('categories', JSON.stringify(catIds));
  for (const cat of categories) { cat.createdAt = new Date().toISOString(); cat.updatedAt = new Date().toISOString(); await env.STORE_DATA.put(`category:${cat.id}`, JSON.stringify(cat)); }
  const prodIds = products.map(p => p.id);
  await env.STORE_DATA.put('products', JSON.stringify(prodIds));
  for (const prod of products) { prod.createdAt = new Date().toISOString(); prod.updatedAt = new Date().toISOString(); await env.STORE_DATA.put(`product:${prod.id}`, JSON.stringify(prod)); }
  return json({ success: true, categories: catIds.length, products: prodIds.length });
}

// ============================================================
// SVG ICONS
// ============================================================
const ICONS = {
  cart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  orders: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>',
  products: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  categories: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  camera: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#c0c4cc" stroke-width="1.5"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>',
  menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
  store: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/></svg>',
};

// ============================================================
// STOREFRONT PAGE
// ============================================================
function storePage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Ice Lab Team Store</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e;min-height:100vh}
a{color:#4f46e5;text-decoration:none}

/* PIN */
#pin-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}
.pin-box{text-align:center;background:#fff;padding:48px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #e5e7eb}
.pin-box h1{font-size:24px;font-weight:700;margin-bottom:4px;color:#1a1a2e}
.pin-box p{color:#6b7280;margin-bottom:24px;font-size:14px}
.pin-dots{display:flex;gap:12px;justify-content:center;margin-bottom:16px}
.pin-dots input{width:48px;height:56px;text-align:center;font-size:22px;background:#fff;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;outline:none;transition:border 0.15s}
.pin-dots input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.pin-error{color:#dc2626;font-size:13px;min-height:18px}

/* Header */
.sh{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.sh-brand{font-size:16px;font-weight:700;color:#1a1a2e;letter-spacing:0.5px;cursor:pointer;display:flex;align-items:center;gap:8px}
.cart-btn{position:relative;background:#fff;border:1px solid #e5e7eb;color:#1a1a2e;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;display:flex;align-items:center;gap:6px;transition:all 0.15s}
.cart-btn:hover{border-color:#d1d5db;background:#f9fafb}
.cart-badge{background:#4f46e5;color:#fff;font-size:11px;font-weight:700;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center}

/* Content */
.sc{max-width:1200px;margin:0 auto;padding:32px 24px}
.st{font-size:20px;font-weight:700;margin-bottom:20px;color:#1a1a2e}

/* Category Grid */
.cg{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:40px}
.cc{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;cursor:pointer;transition:all 0.15s;text-align:center}
.cc:hover{border-color:#d1d5db;box-shadow:0 1px 3px rgba(0,0,0,0.08);transform:translateY(-1px)}
.cc h3{font-size:15px;font-weight:600;margin-bottom:4px;color:#1a1a2e}
.cc p{font-size:13px;color:#6b7280}

/* Product Grid */
.pg{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
.pc{background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;cursor:pointer;transition:all 0.15s}
.pc:hover{box-shadow:0 4px 12px rgba(0,0,0,0.08);transform:translateY(-2px)}
.pc-img{height:200px;background:#f0f1f3;display:flex;align-items:center;justify-content:center}
.pc-img img{width:100%;height:100%;object-fit:cover}
.pc-info{padding:14px 16px}
.pc-info h3{font-size:14px;font-weight:600;margin-bottom:6px;color:#1a1a2e;line-height:1.3}
.pc-price-row{display:flex;align-items:center;justify-content:space-between}
.pc-price{font-size:16px;font-weight:700;color:#1a1a2e}
.stock-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.stock-green{background:#16a34a}
.stock-yellow{background:#f59e0b}
.stock-red{background:#dc2626}

/* Product Detail */
.pd{background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.pd-layout{display:grid;grid-template-columns:400px 1fr;gap:40px}
.pd-image{height:400px;background:#f0f1f3;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.pd-image img{width:100%;height:100%;object-fit:cover}
.pd-info h2{font-size:22px;font-weight:700;margin-bottom:8px}
.pd-info .price{font-size:24px;font-weight:700;color:#1a1a2e;margin-bottom:16px}
.pd-info .desc{color:#6b7280;margin-bottom:24px;line-height:1.6;font-size:14px}
.vg{margin-bottom:16px}
.vg label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.vg select{width:100%;padding:10px 12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:14px;cursor:pointer;transition:border 0.15s}
.vg select:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.qty-row{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.qty-btn{width:36px;height:36px;border-radius:6px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s}
.qty-btn:hover{background:#f9fafb}
.qty-val{font-size:16px;font-weight:600;min-width:30px;text-align:center}
.stock-indicator{font-size:13px;padding:4px 10px;border-radius:4px;display:inline-block;margin-bottom:16px;font-weight:500}
.si-green{background:#f0fdf4;color:#16a34a}
.si-yellow{background:#fffbeb;color:#d97706}
.si-red{background:#fef2f2;color:#dc2626}
.back-link{display:inline-flex;align-items:center;gap:4px;color:#6b7280;font-size:13px;margin-bottom:16px;cursor:pointer;font-weight:500;transition:color 0.15s}
.back-link:hover{color:#1a1a2e}

/* Buttons */
.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.btn-primary{background:#4f46e5;color:#fff}
.btn-primary:hover{background:#4338ca}
.btn-primary:disabled{background:#c7d2fe;color:#818cf8;cursor:not-allowed}
.btn-outline{background:#fff;border:1px solid #d1d5db;color:#374151}
.btn-outline:hover{background:#f9fafb}
.btn-full{width:100%}
.btn-lg{padding:14px 24px;font-size:15px;font-weight:600}

/* Cart Sidebar */
.co{position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:200;display:none}
.co.open{display:block}
.cs{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:90vw;background:#fff;border-left:1px solid #e5e7eb;z-index:201;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.25s ease}
.cs.open{transform:translateX(0)}
.cs-header{padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between}
.cs-header h2{font-size:16px;font-weight:600}
.cs-close{background:none;border:none;color:#6b7280;cursor:pointer;padding:4px}
.cs-close:hover{color:#1a1a2e}
.cs-items{flex:1;overflow-y:auto;padding:16px 20px}
.ci{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #f0f0f0}
.ci-info{flex:1}
.ci-info h4{font-size:14px;font-weight:600;margin-bottom:2px}
.ci-info .opts{font-size:12px;color:#6b7280}
.ci-info .ip{font-size:14px;color:#1a1a2e;font-weight:600;margin-top:4px}
.ci-qty{display:flex;align-items:center;gap:6px}
.ci-qty button{width:26px;height:26px;border-radius:4px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;cursor:pointer;font-size:13px;transition:all 0.15s}
.ci-qty button:hover{background:#f9fafb}
.ci-remove{background:none;border:none;color:#dc2626;font-size:12px;cursor:pointer;margin-top:4px;font-weight:500}
.ci-remove:hover{text-decoration:underline}
.cs-empty{text-align:center;color:#6b7280;padding:40px;font-size:14px}
.cs-footer{padding:20px;border-top:1px solid #e5e7eb}
.cs-total{display:flex;justify-content:space-between;font-size:16px;font-weight:700;margin-bottom:16px}
.co-form input{width:100%;padding:10px 12px;margin-bottom:8px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:14px;font-family:inherit;transition:border 0.15s}
.co-form input:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.co-form input::placeholder{color:#9ca3af}

/* Result pages */
.rp{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}
.rb{background:#fff;padding:48px;border-radius:12px;border:1px solid #e5e7eb;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.rb h2{font-size:22px;font-weight:700;margin-bottom:8px;margin-top:16px}
.rb p{color:#6b7280;margin-bottom:24px;font-size:14px;line-height:1.6}
.ri{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto}
.ri-ok{background:#f0fdf4;color:#16a34a}
.ri-cancel{background:#f0f1f3;color:#6b7280}

/* Toast */
.toast{position:fixed;bottom:24px;right:24px;background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;z-index:300;transform:translateY(60px);opacity:0;transition:all 0.25s}
.toast.show{transform:translateY(0);opacity:1}

@media(max-width:900px){.pg{grid-template-columns:repeat(2,1fr)}.pd-layout{grid-template-columns:1fr}}
@media(max-width:480px){.pg{grid-template-columns:1fr}.cg{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<div id="pin-screen"><div class="pin-box"><h1>Ice Lab Team Store</h1><p>Enter PIN to access the store</p>
<div class="pin-dots"><input type="tel" maxlength="1" autofocus><input type="tel" maxlength="1"><input type="tel" maxlength="1"><input type="tel" maxlength="1"></div>
<div class="pin-error" id="pin-error"></div></div></div>

<div id="store-app" style="display:none">
<header class="sh"><div class="sh-brand" onclick="showHome()">ICE LAB TEAM STORE</div>
<button class="cart-btn" onclick="toggleCart()">${ICONS.cart}<span id="cart-count" class="cart-badge">0</span></button></header>
<main class="sc" id="main-content"></main></div>

<div class="co" id="cart-overlay" onclick="toggleCart()"></div>
<div class="cs" id="cart-sidebar"><div class="cs-header"><h2>Your Cart</h2><button class="cs-close" onclick="toggleCart()">${ICONS.x}</button></div>
<div class="cs-items" id="cart-items"></div><div class="cs-footer" id="cart-footer"></div></div>
<div class="toast" id="toast"></div>

<script>
let categories=[],products=[],cart=JSON.parse(localStorage.getItem('icelab_cart')||'[]'),currentView='home',prevCategory=null;
const pinInputs=document.querySelectorAll('.pin-dots input');
pinInputs.forEach((inp,i)=>{inp.addEventListener('input',()=>{if(inp.value&&i<pinInputs.length-1)pinInputs[i+1].focus();if(i===pinInputs.length-1&&inp.value)checkPin()});inp.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!inp.value&&i>0)pinInputs[i-1].focus()})});
async function checkPin(){const pin=Array.from(pinInputs).map(i=>i.value).join('');if(pin.length<4)return;try{const r=await fetch('/api/verify-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){sessionStorage.setItem('store_pin',pin);document.getElementById('pin-screen').style.display='none';document.getElementById('store-app').style.display='';loadStore()}else{document.getElementById('pin-error').textContent='Invalid PIN';pinInputs.forEach(i=>i.value='');pinInputs[0].focus()}}catch(e){document.getElementById('pin-error').textContent='Connection error'}}
if(sessionStorage.getItem('store_pin')){document.getElementById('pin-screen').style.display='none';document.getElementById('store-app').style.display='';loadStore()}
async function loadStore(){const[cr,pr]=await Promise.all([fetch('/api/categories'),fetch('/api/products')]);categories=await cr.json();products=await pr.json();updateCartCount();showHome()}
function showHome(){currentView='home';prevCategory=null;const m=document.getElementById('main-content');
m.innerHTML='<h2 class="st">Categories</h2><div class="cg">'+categories.map(c=>'<div class="cc" onclick="showCategory(\\''+c.id+'\\')"><h3>'+esc(c.name)+'</h3><p>'+esc(c.description)+'</p></div>').join('')+'</div><h2 class="st">All Products</h2><div class="pg">'+products.map(productCard).join('')+'</div>'}
function showCategory(catId){currentView='category';prevCategory=catId;const cat=categories.find(c=>c.id===catId);const filtered=products.filter(p=>p.category===catId);const m=document.getElementById('main-content');
m.innerHTML='<a class="back-link" onclick="showHome()">${ICONS.back} All Categories</a><h2 class="st">'+esc(cat.name)+'</h2>'+(filtered.length?'<div class="pg">'+filtered.map(productCard).join('')+'</div>':'<p style="color:#6b7280">No products in this category yet.</p>')}
function productCard(p){const ts=p.variants?.reduce((s,v)=>s+(v.stock??0),0)??0;const hv=p.variants?.length>0;let sd='';if(hv){if(ts===0)sd='<span class="stock-dot stock-red"></span>';else if(ts<=3)sd='<span class="stock-dot stock-yellow"></span>';else sd='<span class="stock-dot stock-green"></span>'}
const img=p.images?.[0]?'<img src="'+esc(p.images[0])+'" alt="">':'${ICONS.camera}';
return '<div class="pc" onclick="showProduct(\\''+p.id+'\\')"><div class="pc-img">'+img+'</div><div class="pc-info"><h3>'+esc(p.name)+'</h3><div class="pc-price-row"><span class="pc-price">$'+p.price.toFixed(2)+'</span>'+sd+'</div></div></div>'}
function showProduct(prodId){currentView='product';const p=products.find(x=>x.id===prodId);if(!p)return;
const img=p.images?.[0]?'<img src="'+esc(p.images[0])+'" alt="">':'${ICONS.camera}';
const vs=(p.variantTypes||[]).map(vt=>'<div class="vg"><label>'+esc(vt.name)+'</label><select onchange="updateVariantStock()" data-variant="'+esc(vt.name)+'"><option value="">Select '+esc(vt.name)+'</option>'+vt.options.map(o=>'<option value="'+esc(o)+'">'+esc(o)+'</option>').join('')+'</select></div>').join('');
const m=document.getElementById('main-content');
m.innerHTML='<a class="back-link" onclick="goBack()">${ICONS.back} Back</a><div class="pd"><div class="pd-layout"><div class="pd-image">'+img+'</div><div class="pd-info"><h2>'+esc(p.name)+'</h2><div class="price" id="pd-price">$'+p.price.toFixed(2)+'</div><p class="desc">'+esc(p.description)+'</p>'+vs+'<div id="pd-stock-info"></div><div class="qty-row"><span style="color:#6b7280;font-size:13px;font-weight:500">Qty</span><button class="qty-btn" onclick="changeQty(-1)">-</button><span class="qty-val" id="pd-qty">1</span><button class="qty-btn" onclick="changeQty(1)">+</button></div><button class="btn btn-primary btn-full btn-lg" id="btn-add" onclick="addToCart(\\''+p.id+'\\')"'+(p.variantTypes?.length?' disabled':'')+'>Add to Cart</button></div></div></div>';
window._pdQty=1;window._currentProduct=p}
function goBack(){if(currentView==='product'&&prevCategory){showCategory(prevCategory)}else{showHome()}}
function changeQty(d){window._pdQty=Math.max(1,(window._pdQty||1)+d);document.getElementById('pd-qty').textContent=window._pdQty}
function updateVariantStock(){const p=window._currentProduct;if(!p)return;const sels=document.querySelectorAll('[data-variant]');const sel={};let allSel=true;sels.forEach(s=>{if(s.value)sel[s.dataset.variant]=s.value;else allSel=false});
const btn=document.getElementById('btn-add'),si=document.getElementById('pd-stock-info');
if(!allSel){btn.disabled=true;si.innerHTML='';return}
const v=p.variants?.find(v=>Object.entries(sel).every(([k,val])=>v.options[k]===val));
if(v){if(v.stock!==null&&v.stock!==undefined){if(v.stock===0){si.innerHTML='<span class="stock-indicator si-red">Out of Stock</span>';btn.disabled=true}else if(v.stock<=3){si.innerHTML='<span class="stock-indicator si-yellow">Low Stock - Only '+v.stock+' left</span>';btn.disabled=false}else{si.innerHTML='<span class="stock-indicator si-green">In Stock</span>';btn.disabled=false}}else{si.innerHTML='<span class="stock-indicator si-green">In Stock</span>';btn.disabled=false}
if(v.price)document.getElementById('pd-price').textContent='$'+v.price.toFixed(2)}else{si.innerHTML='<span class="stock-indicator si-red">Unavailable</span>';btn.disabled=true}}
function addToCart(prodId){const p=products.find(x=>x.id===prodId);if(!p)return;const sels=document.querySelectorAll('[data-variant]');const opts={};sels.forEach(s=>{if(s.value)opts[s.dataset.variant]=s.value});
const variant=p.variants?.find(v=>Object.entries(opts).every(([k,val])=>v.options[k]===val));const price=variant?.price||p.price;
const ci={productId:p.id,variantId:variant?.id||null,name:p.name,options:opts,price,qty:window._pdQty||1};
const ei=cart.findIndex(c=>c.productId===ci.productId&&c.variantId===ci.variantId);
if(ei>=0)cart[ei].qty+=ci.qty;else cart.push(ci);saveCart();showToast('Added to cart')}
function saveCart(){localStorage.setItem('icelab_cart',JSON.stringify(cart));updateCartCount()}
function updateCartCount(){document.getElementById('cart-count').textContent=cart.reduce((s,i)=>s+i.qty,0)}
function toggleCart(){const o=document.getElementById('cart-overlay'),s=document.getElementById('cart-sidebar');if(s.classList.contains('open')){o.classList.remove('open');s.classList.remove('open')}else{renderCart();o.classList.add('open');s.classList.add('open')}}
function renderCart(){const ie=document.getElementById('cart-items'),fe=document.getElementById('cart-footer');
if(!cart.length){ie.innerHTML='<div class="cs-empty">Your cart is empty</div>';fe.innerHTML='';return}
ie.innerHTML=cart.map((c,i)=>{const os=Object.values(c.options||{}).join(', ');return '<div class="ci"><div class="ci-info"><h4>'+esc(c.name)+'</h4>'+(os?'<div class="opts">'+esc(os)+'</div>':'')+'<div class="ip">$'+(c.price*c.qty).toFixed(2)+'</div></div><div style="text-align:right"><div class="ci-qty"><button onclick="updateCartQty('+i+',-1)">-</button><span>'+c.qty+'</span><button onclick="updateCartQty('+i+',1)">+</button></div><button class="ci-remove" onclick="removeCartItem('+i+')">Remove</button></div></div>'}).join('');
const total=cart.reduce((s,c)=>s+c.price*c.qty,0);
fe.innerHTML='<div class="cs-total"><span>Total</span><span>$'+total.toFixed(2)+'</span></div><div class="co-form"><input type="text" id="co-name" placeholder="Full Name" value="'+esc(sessionStorage.getItem('co_name')||'')+'"><input type="email" id="co-email" placeholder="Email" value="'+esc(sessionStorage.getItem('co_email')||'')+'"><input type="tel" id="co-phone" placeholder="Phone" value="'+esc(sessionStorage.getItem('co_phone')||'')+'"><p style="font-size:12px;color:#6b7280;margin:8px 0">Local pickup only</p><button class="btn btn-primary btn-full" onclick="checkout()" id="checkout-btn">Checkout &middot; $'+total.toFixed(2)+'</button></div>'}
function updateCartQty(i,d){cart[i].qty=Math.max(1,cart[i].qty+d);saveCart();renderCart()}
function removeCartItem(i){cart.splice(i,1);saveCart();renderCart()}
async function checkout(){const n=document.getElementById('co-name').value.trim(),e=document.getElementById('co-email').value.trim(),ph=document.getElementById('co-phone').value.trim();
if(!n||!e||!ph){showToast('Please fill in all fields');return}
sessionStorage.setItem('co_name',n);sessionStorage.setItem('co_email',e);sessionStorage.setItem('co_phone',ph);
const btn=document.getElementById('checkout-btn');btn.disabled=true;btn.textContent='Processing...';
try{const r=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:cart,customer:{name:n,email:e,phone:ph}})});const d=await r.json();
if(d.url)window.location.href=d.url;else{showToast(d.error||'Checkout failed');btn.disabled=false;btn.textContent='Checkout'}}catch(err){showToast('Connection error');btn.disabled=false;btn.textContent='Checkout'}}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
</script></body></html>`;
}

// ============================================================
// CHECKOUT RESULT PAGES
// ============================================================
function checkoutSuccessPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Order Confirmed</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e}
.rp{display:flex;align-items:center;justify-content:center;min-height:100vh}.rb{background:#fff;padding:48px;border-radius:12px;border:1px solid #e5e7eb;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.rb h2{font-size:22px;font-weight:700;margin:16px 0 8px;color:#1a1a2e}.rb p{color:#6b7280;margin-bottom:24px;font-size:14px;line-height:1.6}
.ri{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;background:#f0fdf4;color:#16a34a}
.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;background:#4f46e5;color:#fff;text-decoration:none;display:inline-block}</style></head>
<body><div class="rp"><div class="rb"><div class="ri">${ICONS.check}</div><h2>Order Confirmed</h2><p>Thanks for your order. We will have it ready for pickup at Ice Lab. You will receive a confirmation email shortly.</p><a href="/" class="btn">Continue Shopping</a></div></div>
<script>localStorage.removeItem('icelab_cart')</script></body></html>`;
}

function checkoutCancelPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Checkout Cancelled</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e}
.rp{display:flex;align-items:center;justify-content:center;min-height:100vh}.rb{background:#fff;padding:48px;border-radius:12px;border:1px solid #e5e7eb;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.rb h2{font-size:22px;font-weight:700;margin:16px 0 8px}.rb p{color:#6b7280;margin-bottom:24px;font-size:14px}
.ri{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;background:#f0f1f3;color:#6b7280}
.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;background:#4f46e5;color:#fff;text-decoration:none;display:inline-block}</style></head>
<body><div class="rp"><div class="rb"><div class="ri">${ICONS.cart}</div><h2>Checkout Cancelled</h2><p>Your order was not completed. Your cart items are still saved.</p><a href="/" class="btn">Return to Store</a></div></div></body></html>`;
}

// ============================================================
// ADMIN PAGE
// ============================================================
function adminPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin - Ice Lab Team Store</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e;min-height:100vh}

/* PIN */
#admin-pin-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}
.pin-box{text-align:center;background:#fff;padding:48px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #e5e7eb}
.pin-box h1{font-size:22px;font-weight:700;margin-bottom:4px;color:#1a1a2e}
.pin-box p{color:#6b7280;margin-bottom:24px;font-size:14px}
.pin-dots{display:flex;gap:12px;justify-content:center;margin-bottom:16px}
.pin-dots input{width:48px;height:56px;text-align:center;font-size:22px;background:#fff;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;outline:none;transition:border 0.15s}
.pin-dots input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.pin-error{color:#dc2626;font-size:13px;min-height:18px}

/* Layout */
#admin-app{display:none;height:100vh}
.admin-layout{display:flex;height:100vh}

/* Sidebar */
.sidebar{width:220px;background:#fff;border-right:1px solid #e5e7eb;display:flex;flex-direction:column;flex-shrink:0}
.sidebar-brand{padding:16px 20px;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:700;color:#1a1a2e;display:flex;align-items:center;gap:8px}
.sidebar-brand .badge{background:#4f46e5;color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}
.sidebar-nav{flex:1;padding:12px 0}
.sidebar-nav button{width:100%;display:flex;align-items:center;gap:10px;padding:10px 20px;background:none;border:none;border-left:3px solid transparent;color:#6b7280;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s;font-family:inherit;text-align:left}
.sidebar-nav button:hover{background:#f9fafb;color:#1a1a2e}
.sidebar-nav button.active{border-left-color:#4f46e5;color:#1a1a2e;font-weight:600;background:#f5f3ff}
.sidebar-footer{padding:12px 20px;border-top:1px solid #e5e7eb}
.sidebar-footer a{display:flex;align-items:center;gap:6px;color:#6b7280;font-size:13px;text-decoration:none;font-weight:500;transition:color 0.15s}
.sidebar-footer a:hover{color:#4f46e5}

/* Mobile sidebar */
.mobile-header{display:none;background:#fff;border-bottom:1px solid #e5e7eb;padding:12px 16px;align-items:center;justify-content:space-between}
.mobile-header h1{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px}
.mobile-header .badge{background:#4f46e5;color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}
.hamburger{background:none;border:none;color:#1a1a2e;cursor:pointer;padding:4px}
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:300}

/* Main */
.admin-main{flex:1;overflow-y:auto;background:#f8f9fa}
.admin-topbar{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 32px;height:52px;display:flex;align-items:center;justify-content:space-between}
.admin-topbar h2{font-size:16px;font-weight:600}
.admin-topbar a{color:#4f46e5;font-size:13px;font-weight:500;text-decoration:none;display:flex;align-items:center;gap:4px}
.admin-content{padding:32px}

/* Cards */
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:24px}
.card-header{padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between}
.card-header h3{font-size:15px;font-weight:600}
.card-body{padding:20px}
.card-muted{color:#6b7280;font-size:13px;padding:16px 20px;border-bottom:1px solid #f0f0f0}

/* Tables */
table{width:100%;border-collapse:collapse}
th{padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;background:#f8f9fa;border-bottom:1px solid #e5e7eb}
td{padding:10px 16px;font-size:13px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
tr:hover td{background:#f9fafb}
.prod-name{font-weight:600;font-size:13px;color:#1a1a2e}
.prod-sku{font-size:11px;color:#6b7280;margin-top:1px}
.prod-thumb{width:40px;height:40px;border-radius:4px;background:#f0f1f3;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}
.prod-thumb img{width:100%;height:100%;object-fit:cover}
.prod-thumb svg{width:16px;height:16px}
.prod-cell{display:flex;align-items:center;gap:10px}
.edit-btn{background:none;border:none;color:#9ca3af;cursor:pointer;padding:4px;border-radius:4px;transition:all 0.15s}
.edit-btn:hover{color:#4f46e5;background:#f5f3ff}
.cb{width:16px;height:16px;accent-color:#4f46e5;cursor:pointer}

/* Status badges */
.badge-status{padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;display:inline-block}
.badge-pending{background:#fffbeb;color:#d97706}
.badge-ready{background:#eff6ff;color:#2563eb}
.badge-picked_up{background:#f0fdf4;color:#16a34a}
.badge-cancelled{background:#fef2f2;color:#dc2626}

/* Filter tabs */
.filter-tabs{display:flex;gap:0;border-bottom:1px solid #e5e7eb;padding:0 20px;background:#fff;border-radius:8px 8px 0 0}
.filter-tab{padding:12px 16px;font-size:13px;font-weight:500;color:#6b7280;border:none;background:none;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;font-family:inherit;display:flex;align-items:center;gap:6px}
.filter-tab:hover{color:#1a1a2e}
.filter-tab.active{color:#4f46e5;border-bottom-color:#4f46e5}
.filter-count{background:#f0f0f0;color:#6b7280;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px}
.filter-tab.active .filter-count{background:#ede9fe;color:#4f46e5}

/* Search bar */
.search-bar{background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;display:flex;gap:12px;align-items:center}
.search-input{flex:1;position:relative}
.search-input input{width:100%;padding:8px 12px 8px 32px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#1a1a2e;background:#fff;font-family:inherit;transition:border 0.15s}
.search-input input:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.search-input input::placeholder{color:#9ca3af}
.search-input svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#9ca3af}
.search-input .search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#9ca3af;display:flex}
.filter-select{padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#1a1a2e;background:#fff;font-family:inherit;cursor:pointer}
.filter-select:focus{border-color:#4f46e5;outline:none}

/* Buttons */
.btn{padding:8px 16px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit}
.btn-primary{background:#4f46e5;color:#fff}
.btn-primary:hover{background:#4338ca}
.btn-outline{background:#fff;border:1px solid #d1d5db;color:#374151}
.btn-outline:hover{background:#f9fafb}
.btn-danger{background:#dc2626;color:#fff}
.btn-danger:hover{background:#b91c1c}
.btn-sm{padding:6px 12px;font-size:12px}
.btn-success{background:#16a34a;color:#fff}
.btn-success:hover{background:#15803d}
.btn-blue{background:#2563eb;color:#fff}
.btn-blue:hover{background:#1d4ed8}
.btn-text{background:none;border:none;color:#6b7280;font-size:12px;cursor:pointer;font-family:inherit;font-weight:500}
.btn-text:hover{color:#4f46e5}
.btn-ghost{background:none;border:none;color:#4f46e5;font-weight:500;cursor:pointer;font-size:13px;font-family:inherit;padding:0}
.btn-ghost:hover{text-decoration:underline}

/* Modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.3);backdrop-filter:blur(2px);z-index:500;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto}
.modal{background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.15);max-width:800px;width:100%;max-height:calc(100vh - 80px);overflow-y:auto}
.modal-header{padding:20px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between}
.modal-header h2{font-size:18px;font-weight:600}
.modal-close{background:none;border:none;color:#6b7280;cursor:pointer;padding:4px}
.modal-close:hover{color:#1a1a2e}
.modal-body{padding:24px}
.modal-footer{padding:16px 24px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:8px}
.modal-section{margin-bottom:24px}
.modal-section-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #e5e7eb}

/* Form */
.fg{margin-bottom:14px}
.fg label{display:block;font-size:12px;color:#374151;margin-bottom:4px;font-weight:600}
.fg input,.fg textarea,.fg select{width:100%;padding:8px 12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:13px;font-family:inherit;transition:border 0.15s}
.fg input:focus,.fg textarea:focus,.fg select:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.fg textarea{min-height:72px;resize:vertical}
.fg-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}

/* Variant builder */
.vt-row{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;padding:12px;background:#f8f9fa;border-radius:6px;border:1px solid #e5e7eb}
.vt-row select,.vt-row input{padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#1a1a2e;background:#fff;font-family:inherit}
.vt-row select:focus,.vt-row input:focus{border-color:#4f46e5;outline:none}
.tag-wrap{display:flex;flex-wrap:wrap;gap:4px;padding:4px 8px;background:#fff;border:1px solid #d1d5db;border-radius:6px;min-height:34px;align-items:center;cursor:text;transition:border 0.15s}
.tag-wrap:focus-within{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.tag{background:#ede9fe;color:#4f46e5;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;display:flex;align-items:center;gap:4px}
.tag .rm{cursor:pointer;color:#a78bfa;font-size:14px;line-height:1}
.tag .rm:hover{color:#dc2626}
.tag-wrap input{border:none;background:none;color:#1a1a2e;font-size:12px;outline:none;flex:1;min-width:60px;padding:2px;font-family:inherit}
.vt-remove{background:none;border:none;color:#d1d5db;cursor:pointer;padding:4px;transition:color 0.15s;flex-shrink:0;margin-top:2px}
.vt-remove:hover{color:#dc2626}

/* Variant stock table */
.vs-table{width:100%;border-collapse:collapse;font-size:13px}
.vs-table th{padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;background:#f8f9fa;border-bottom:1px solid #e5e7eb}
.vs-table td{padding:6px 10px;border-bottom:1px solid #f0f0f0}
.vs-table input{padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;color:#1a1a2e;background:#fff;font-family:inherit;transition:border 0.15s}
.vs-table input:focus{border-color:#4f46e5;outline:none}
.vs-remove{background:none;border:none;color:#d1d5db;cursor:pointer;padding:2px;transition:color 0.15s}
.vs-remove:hover{color:#dc2626}
.apply-link{font-size:11px;color:#4f46e5;cursor:pointer;font-weight:500;display:block;margin-top:2px}
.apply-link:hover{text-decoration:underline}

/* Order detail */
.order-detail{background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.od-header{padding:20px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.od-info{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;padding:20px 24px;border-bottom:1px solid #e5e7eb}
.od-info-item label{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-weight:600;display:block;margin-bottom:2px}
.od-info-item span{font-size:14px;color:#1a1a2e;font-weight:500}
.od-items{padding:0 24px}
.od-total{padding:16px 24px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:24px;font-weight:600}
.od-actions{padding:16px 24px;border-top:1px solid #e5e7eb;display:flex;gap:8px;flex-wrap:wrap}

.empty-state{text-align:center;color:#6b7280;padding:40px;font-size:14px}
.toast{position:fixed;bottom:24px;right:24px;background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;z-index:600;transform:translateY(60px);opacity:0;transition:all 0.25s}
.toast.show{transform:translateY(0);opacity:1}

/* Settings */
.settings-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:24px;margin-bottom:20px}
.settings-card h3{font-size:14px;font-weight:600;margin-bottom:16px;color:#1a1a2e}

@media(max-width:768px){
  .sidebar{display:none;position:fixed;top:0;left:0;bottom:0;z-index:301;box-shadow:4px 0 12px rgba(0,0,0,0.1)}
  .sidebar.open{display:flex}
  .sidebar-overlay.open{display:block}
  .mobile-header{display:flex}
  .admin-content{padding:16px}
  .admin-topbar{padding:0 16px}
  .od-info{grid-template-columns:1fr}
  .fg-row{grid-template-columns:1fr}
}
</style></head><body>
<div id="admin-pin-screen"><div class="pin-box"><h1>Admin Access</h1><p>Enter admin PIN</p>
<div class="pin-dots"><input type="tel" maxlength="1" autofocus><input type="tel" maxlength="1"><input type="tel" maxlength="1"><input type="tel" maxlength="1"></div>
<div class="pin-error" id="pin-error"></div></div></div>

<div id="admin-app">
<div class="mobile-header"><button class="hamburger" onclick="toggleSidebar()">${ICONS.menu}</button><h1>Ice Lab Team Store <span class="badge">Admin</span></h1><a href="/">${ICONS.store}</a></div>
<div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
<div class="admin-layout">
<aside class="sidebar" id="sidebar">
<div class="sidebar-brand">Ice Lab Team Store <span class="badge">Admin</span></div>
<nav class="sidebar-nav">
<button class="active" onclick="showTab('orders')" data-tab="orders">${ICONS.orders} Orders</button>
<button onclick="showTab('products')" data-tab="products">${ICONS.products} Products</button>
<button onclick="showTab('categories')" data-tab="categories">${ICONS.categories} Categories</button>
<button onclick="showTab('settings')" data-tab="settings">${ICONS.settings} Settings</button>
</nav>
<div class="sidebar-footer"><a href="/">${ICONS.store} View Store</a></div>
</aside>
<div class="admin-main">
<div class="admin-topbar"><h2 id="topbar-title">Orders</h2><a href="/">${ICONS.store} View Store</a></div>
<div class="admin-content" id="admin-content"></div>
</div>
</div>
</div>
<div class="toast" id="toast"></div>

<script>
let adminCategories=[],adminProducts=[],adminOrders=[],currentTab='orders',orderFilter='all',searchQuery='',catFilter='';
const IC=${JSON.stringify(ICONS)};

// PIN
const pinInputs=document.querySelectorAll('.pin-dots input');
pinInputs.forEach((inp,i)=>{inp.addEventListener('input',()=>{if(inp.value&&i<pinInputs.length-1)pinInputs[i+1].focus();if(i===pinInputs.length-1&&inp.value)checkAdminPin()});inp.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!inp.value&&i>0)pinInputs[i-1].focus()})});
async function checkAdminPin(){const pin=Array.from(pinInputs).map(i=>i.value).join('');if(pin.length<4)return;try{const r=await fetch('/api/verify-admin-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){sessionStorage.setItem('admin_pin',pin);document.getElementById('admin-pin-screen').style.display='none';document.getElementById('admin-app').style.display='';loadAdmin()}else{document.getElementById('pin-error').textContent='Invalid PIN';pinInputs.forEach(i=>i.value='');pinInputs[0].focus()}}catch(e){document.getElementById('pin-error').textContent='Connection error'}}
if(sessionStorage.getItem('admin_pin')){document.getElementById('admin-pin-screen').style.display='none';document.getElementById('admin-app').style.display='';loadAdmin()}

function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('sidebar-overlay').classList.toggle('open')}

async function loadAdmin(){const[cr,pr,or]=await Promise.all([fetch('/api/admin/categories'),fetch('/api/admin/products'),fetch('/api/admin/orders')]);adminCategories=await cr.json();adminProducts=await pr.json();adminOrders=await or.json();showTab(currentTab)}
function showTab(tab){currentTab=tab;document.querySelectorAll('.sidebar-nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));document.getElementById('topbar-title').textContent=tab.charAt(0).toUpperCase()+tab.slice(1);
document.getElementById('sidebar').classList.remove('open');document.getElementById('sidebar-overlay').classList.remove('open');
if(tab==='orders')renderOrders();else if(tab==='products')renderProducts();else if(tab==='categories')renderCategories();else if(tab==='settings')renderSettings()}

// ============ ORDERS ============
function renderOrders(detail){const c=document.getElementById('admin-content');if(detail)return renderOrderDetail(detail);
const counts={all:adminOrders.length,pending:adminOrders.filter(o=>o.status==='pending').length,ready:adminOrders.filter(o=>o.status==='ready').length,picked_up:adminOrders.filter(o=>o.status==='picked_up').length,cancelled:adminOrders.filter(o=>o.status==='cancelled').length};
const filtered=orderFilter==='all'?adminOrders:adminOrders.filter(o=>o.status===orderFilter);
// Sort: pending first, then by date desc
const sorted=[...filtered].sort((a,b)=>{if(a.status==='pending'&&b.status!=='pending')return -1;if(b.status==='pending'&&a.status!=='pending')return 1;return new Date(b.createdAt)-new Date(a.createdAt)});

c.innerHTML='<div class="card"><div class="filter-tabs">'+['all','pending','ready','picked_up','cancelled'].map(f=>'<button class="filter-tab'+(orderFilter===f?' active':'')+'" onclick="orderFilter=\\''+f+'\\';renderOrders()">'+f.replace('_',' ').replace(/^./,c=>c.toUpperCase())+'<span class="filter-count">'+counts[f]+'</span></button>').join('')+'</div>'+
(sorted.length===0?'<div class="empty-state">No orders</div>':'<table><thead><tr><th>Order</th><th>Customer</th><th>Email</th><th>Phone</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th></tr></thead><tbody>'+
sorted.map(o=>{const ic=o.items?.reduce((s,i)=>s+(i.qty||1),0)||0;const d=new Date(o.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'});
return '<tr onclick="renderOrders(\\''+o.id+'\\')" style="cursor:pointer"><td style="font-weight:600;color:#4f46e5">#'+o.id.slice(-6).toUpperCase()+'</td><td>'+esc(o.customer?.name)+'</td><td style="color:#6b7280;font-size:12px">'+esc(o.customer?.email)+'</td><td style="color:#6b7280;font-size:12px">'+esc(o.customer?.phone)+'</td><td style="color:#6b7280">'+d+'</td><td>'+ic+'</td><td style="font-weight:600">$'+(o.total||0).toFixed(2)+'</td><td><span class="badge-status badge-'+o.status+'">'+o.status.replace('_',' ')+'</span></td></tr>'}).join('')+'</tbody></table>')+'</div>'}

function renderOrderDetail(orderId){const o=adminOrders.find(x=>x.id===orderId);if(!o)return;const c=document.getElementById('admin-content');
const d=new Date(o.createdAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
c.innerHTML='<a class="back-link" onclick="renderOrders()" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;color:#6b7280;font-size:13px;font-weight:500;margin-bottom:16px">${ICONS.back} Back to Orders</a>'+
'<div class="order-detail"><div class="od-header"><div><span style="font-size:18px;font-weight:700">#'+o.id.slice(-6).toUpperCase()+'</span></div><span class="badge-status badge-'+o.status+'" style="font-size:13px;padding:5px 14px">'+o.status.replace('_',' ')+'</span></div>'+
'<div class="od-info"><div class="od-info-item"><label>Customer</label><span>'+esc(o.customer?.name)+'</span></div><div class="od-info-item"><label>Email</label><span>'+esc(o.customer?.email)+'</span></div><div class="od-info-item"><label>Phone</label><span>'+esc(o.customer?.phone)+'</span></div></div>'+
'<div class="od-info" style="border-bottom:none"><div class="od-info-item"><label>Order Date</label><span>'+d+'</span></div><div class="od-info-item"><label>Order ID</label><span style="font-size:12px;color:#6b7280">'+o.id+'</span></div><div class="od-info-item"><label>Stripe</label><span style="font-size:12px;color:#6b7280">'+(o.stripePaymentIntent||'-')+'</span></div></div>'+
'<div class="od-items"><table><thead><tr><th>Product</th><th>Variant</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>'+
(o.items||[]).map(item=>{const opts=Object.values(item.options||{}).join(', ');return '<tr><td style="font-weight:500">'+esc(item.name)+'</td><td style="color:#6b7280;font-size:12px">'+esc(opts||'-')+'</td><td>'+item.qty+'</td><td>$'+((item.price||0)).toFixed(2)+'</td><td style="font-weight:600">$'+((item.price||0)*item.qty).toFixed(2)+'</td></tr>'}).join('')+
'</tbody></table></div>'+
'<div class="od-total"><span>Total</span><span style="font-size:18px">$'+(o.total||0).toFixed(2)+'</span></div>'+
'<div class="od-actions">'+orderActionButtons(o)+'</div></div>'}

function orderActionButtons(o){
if(o.status==='pending')return '<button class="btn btn-blue" onclick="updateOrderStatus(\\''+o.id+'\\',\\'ready\\')">Mark Ready for Pickup</button><button class="btn btn-outline" onclick="if(confirm(\\'Cancel this order?\\'))updateOrderStatus(\\''+o.id+'\\',\\'cancelled\\')">Cancel Order</button>';
if(o.status==='ready')return '<button class="btn btn-success" onclick="updateOrderStatus(\\''+o.id+'\\',\\'picked_up\\')">Mark Picked Up</button><button class="btn btn-outline" onclick="if(confirm(\\'Cancel this order?\\'))updateOrderStatus(\\''+o.id+'\\',\\'cancelled\\')">Cancel Order</button>';
return ''}
async function updateOrderStatus(id,status){await fetch('/api/admin/order/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:id,status})});await loadAdmin();renderOrders(id);showToast('Order updated')}

// ============ PRODUCTS ============
function renderProducts(){const c=document.getElementById('admin-content');const active=adminProducts.filter(p=>p.active);
let filtered=active;
if(searchQuery){const q=searchQuery.toLowerCase();filtered=filtered.filter(p=>p.name.toLowerCase().includes(q)||(p.variants||[]).some(v=>(v.sku||'').toLowerCase().includes(q)))}
if(catFilter)filtered=filtered.filter(p=>p.category===catFilter);

c.innerHTML='<div class="search-bar"><div class="search-input"><span class="search-icon">${ICONS.search}</span><input id="prod-search" placeholder="Search by name, SKU..." value="'+esc(searchQuery)+'" oninput="searchQuery=this.value;renderProducts()"></div>'+
'<select class="filter-select" onchange="catFilter=this.value;renderProducts()"><option value="">All Categories</option>'+adminCategories.map(cat=>'<option value="'+cat.id+'"'+(catFilter===cat.id?' selected':'')+'>'+esc(cat.name)+'</option>').join('')+'</select>'+
(searchQuery||catFilter?'<button class="btn-ghost" onclick="searchQuery=\\'\\';catFilter=\\'\\';renderProducts()">Clear</button>':'')+'</div>'+
'<div class="card"><div class="card-header"><h3>Products</h3><div style="display:flex;gap:8px"><button class="btn btn-outline btn-sm" onclick="seedData()">Seed Sample Data</button><button class="btn btn-primary btn-sm" onclick="openProductModal()">Add Product</button></div></div>'+
'<div class="card-muted">Displaying '+filtered.length+' product'+(filtered.length!==1?'s':'')+'</div>'+
(filtered.length===0?'<div class="empty-state">No products found</div>':
'<table><thead><tr><th style="width:30px"><input type="checkbox" class="cb" onclick="toggleAllCb(this)"></th><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th style="width:40px"></th></tr></thead><tbody>'+
filtered.map(p=>{const cat=adminCategories.find(c=>c.id===p.category);const ts=p.variants?.reduce((s,v)=>s+(v.stock??0),0)??0;const firstSku=p.variants?.[0]?.sku||'';
const thumb=p.images?.[0]?'<img src="'+esc(p.images[0])+'">':'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c0c4cc" stroke-width="1.5"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg>';
return '<tr><td><input type="checkbox" class="cb"></td><td><div class="prod-cell"><div class="prod-thumb">'+thumb+'</div><div><div class="prod-name">'+esc(p.name)+'</div>'+(firstSku?'<div class="prod-sku">'+esc(firstSku)+'</div>':'')+'</div></div></td><td style="color:#6b7280">'+esc(cat?.name||'-')+'</td><td style="font-weight:600">$'+p.price.toFixed(2)+'</td><td>'+ts+'</td><td><button class="edit-btn" onclick="event.stopPropagation();openProductModal(\\''+p.id+'\\')" title="Edit">${ICONS.edit}</button></td></tr>'}).join('')+'</tbody></table>')+'</div>'}

function toggleAllCb(master){document.querySelectorAll('tbody .cb').forEach(cb=>cb.checked=master.checked)}

function openProductModal(prodId){const p=prodId?adminProducts.find(x=>x.id===prodId):null;
window._editVariantTypes=p?JSON.parse(JSON.stringify(p.variantTypes||[])):[];
window._editVariants=p?JSON.parse(JSON.stringify(p.variants||[])):[];
const modal=document.createElement('div');modal.className='modal-overlay';modal.onclick=e=>{if(e.target===modal)modal.remove()};
modal.innerHTML='<div class="modal"><div class="modal-header"><h2>'+(p?'Edit Product':'Add Product')+'</h2><button class="modal-close" onclick="this.closest(\\'.modal-overlay\\').remove()">${ICONS.x}</button></div><div class="modal-body">'+
'<div class="modal-section"><div class="modal-section-title">Product Details</div>'+
'<div class="fg"><label>Name</label><input id="pf-name" value="'+esc(p?.name||'')+'"></div>'+
'<div class="fg"><label>Description</label><textarea id="pf-desc">'+esc(p?.description||'')+'</textarea></div>'+
'<div class="fg-row"><div class="fg"><label>Category</label><select id="pf-cat"><option value="">Select category</option>'+adminCategories.map(c=>'<option value="'+c.id+'"'+(p?.category===c.id?' selected':'')+'>'+esc(c.name)+'</option>').join('')+'</select></div>'+
'<div class="fg"><label>Base Price ($)</label><input id="pf-price" type="number" step="0.01" value="'+(p?.price||'')+'"></div></div>'+
'<div class="fg"><label>Image URL</label><input id="pf-image" value="'+esc(p?.images?.[0]||'')+'"></div></div>'+
'<div class="modal-section"><div class="modal-section-title">Variant Configuration</div><div id="vt-container"></div>'+
'<button class="btn btn-outline btn-sm" onclick="addVariantType()" style="margin-top:8px">+ Add Variant Type</button></div>'+
'<div class="modal-section"><div class="modal-section-title">Inventory & Pricing</div><div id="var-container"></div>'+
'<button class="btn btn-outline btn-sm" onclick="generateVariants()" style="margin-top:8px">Generate Variant Combinations</button></div>'+
'</div><div class="modal-footer">'+(p?'<button class="btn btn-danger btn-sm" onclick="if(confirm(\\'Delete this product?\\'))deleteProduct(\\''+p.id+'\\')">Delete Product</button><div style="flex:1"></div>':'')+
'<button class="btn-ghost" onclick="this.closest(\\'.modal-overlay\\').remove()">Cancel</button>'+
'<button class="btn btn-primary" onclick="saveProduct('+(p?"'"+p.id+"'":'null')+')">Save Product</button></div></div>';
document.body.appendChild(modal);renderVariantTypes();renderVariants()}

function addVariantType(){window._editVariantTypes.push({name:'',options:[]});renderVariantTypes()}
function removeVariantType(i){window._editVariantTypes.splice(i,1);renderVariantTypes()}
function renderVariantTypes(){const c=document.getElementById('vt-container');if(!c)return;
c.innerHTML=window._editVariantTypes.map((vt,i)=>{const presets=['Size','Color','Hand','Flex','Curve'];const isCustom=vt.name&&!presets.includes(vt.name);
return '<div class="vt-row"><div style="flex:1"><select onchange="vtNameChange('+i+',this.value)" style="width:100%"><option value="">Type name...</option>'+presets.map(p=>'<option value="'+p+'"'+(vt.name===p?' selected':'')+'>'+p+'</option>').join('')+'<option value="__custom"'+(isCustom?' selected':'')+'>Custom...</option></select>'+
(isCustom?'<input style="margin-top:4px;width:100%" value="'+esc(vt.name)+'" onchange="vtCustomName('+i+',this.value)" placeholder="Custom name">':'')+'</div><div style="flex:2" id="vt-opts-'+i+'"></div><button class="vt-remove" onclick="removeVariantType('+i+')">${ICONS.x}</button></div>'}).join('');
window._editVariantTypes.forEach((vt,i)=>{const wrap=document.getElementById('vt-opts-'+i);if(wrap)renderTagInput(wrap,vt.options,o=>{window._editVariantTypes[i].options=o})})}
function vtNameChange(i,v){if(v==='__custom')window._editVariantTypes[i].name='';else window._editVariantTypes[i].name=v;
const defaults={Size:['S','M','L','XL','2XL'],Color:['Black','White','Navy'],Hand:['Left','Right'],Flex:['75','85','95'],Curve:['P92','P88','P28','P29']};
if(defaults[v]&&!window._editVariantTypes[i].options.length)window._editVariantTypes[i].options=[...defaults[v]];
renderVariantTypes()}
function vtCustomName(i,v){window._editVariantTypes[i].name=v}
function renderTagInput(container,tags,onChange){const wrap=document.createElement('div');wrap.className='tag-wrap';function render(){wrap.innerHTML='';tags.forEach((t,i)=>{const el=document.createElement('span');el.className='tag';el.innerHTML=esc(t)+'<span class="rm">'+IC.x+'</span>';el.querySelector('.rm').addEventListener('click',e=>{e.stopPropagation();tags.splice(i,1);onChange(tags);render()});wrap.appendChild(el)});
const inp=document.createElement('input');inp.placeholder='Type & press Enter';inp.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===',')&&inp.value.trim()){e.preventDefault();const val=inp.value.trim().replace(/,$/,'');if(val&&!tags.includes(val)){tags.push(val);onChange(tags)}inp.value='';render()}if(e.key==='Backspace'&&!inp.value&&tags.length){tags.pop();onChange(tags);render()}});wrap.appendChild(inp);wrap.addEventListener('click',()=>inp.focus())}
render();container.innerHTML='';container.appendChild(wrap)}
function generateVariants(){const types=window._editVariantTypes.filter(vt=>vt.name&&vt.options.length);if(!types.length){showToast('Add variant types first');return}
let combos=[{}];for(const vt of types){const nc=[];for(const c of combos)for(const o of vt.options)nc.push({...c,[vt.name]:o});combos=nc}
const existing=window._editVariants||[];
window._editVariants=combos.map(opts=>{const match=existing.find(v=>Object.entries(opts).every(([k,val])=>v.options?.[k]===val));return match||{id:generateId('var'),sku:'',options:opts,stock:0,price:null}});
renderVariants();showToast('Generated '+combos.length+' variant(s)')}
function renderVariants(){const c=document.getElementById('var-container');if(!c)return;
if(!window._editVariants?.length){c.innerHTML='<p style="color:#6b7280;font-size:13px">No variants. Generate from variant types above.</p>';return}
c.innerHTML='<table class="vs-table"><thead><tr><th>Options</th><th>SKU</th><th>Stock <span class="apply-link" onclick="applyAll(\\'stock\\')">Apply to All</span></th><th>Price Override <span class="apply-link" onclick="applyAll(\\'price\\')">Apply to All</span></th><th style="width:30px"></th></tr></thead><tbody>'+
window._editVariants.map((v,i)=>{const os=Object.entries(v.options).map(([k,val])=>k+': '+val).join(', ');
return '<tr><td style="font-size:12px;color:#6b7280">'+esc(os)+'</td><td><input style="width:100px" value="'+esc(v.sku||'')+'" onchange="window._editVariants['+i+'].sku=this.value"></td><td><input type="number" min="0" style="width:70px" value="'+(v.stock??0)+'" onchange="window._editVariants['+i+'].stock=parseInt(this.value)||0"></td><td><input type="number" step="0.01" style="width:90px" value="'+(v.price||'')+'" placeholder="Base" onchange="window._editVariants['+i+'].price=parseFloat(this.value)||null"></td><td><button class="vs-remove" onclick="window._editVariants.splice('+i+',1);renderVariants()">${ICONS.x}</button></td></tr>'}).join('')+'</tbody></table>'}
function applyAll(field){if(!window._editVariants?.length)return;const first=window._editVariants[0];
if(field==='stock'){const val=first.stock??0;window._editVariants.forEach(v=>v.stock=val)}
if(field==='price'){const val=first.price;window._editVariants.forEach(v=>v.price=val)}
renderVariants();showToast('Applied to all variants')}
function generateId(prefix){return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).substr(2,6)}
async function saveProduct(existingId){const product={id:existingId||undefined,name:document.getElementById('pf-name').value.trim(),description:document.getElementById('pf-desc').value.trim(),category:document.getElementById('pf-cat').value,price:parseFloat(document.getElementById('pf-price').value)||0,images:document.getElementById('pf-image').value.trim()?[document.getElementById('pf-image').value.trim()]:[],variantTypes:window._editVariantTypes.filter(vt=>vt.name&&vt.options.length),variants:window._editVariants||[],active:true};
if(!product.name){showToast('Product name is required');return}if(!product.price){showToast('Price is required');return}
await fetch('/api/admin/product',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(product)});document.querySelector('.modal-overlay')?.remove();await loadAdmin();showTab('products');showToast(existingId?'Product updated':'Product added')}
async function deleteProduct(id){await fetch('/api/admin/product/'+id,{method:'DELETE'});document.querySelector('.modal-overlay')?.remove();await loadAdmin();showTab('products');showToast('Product deleted')}
async function seedData(){if(!confirm('Seed sample catalog data?'))return;await fetch('/api/admin/seed',{method:'POST'});await loadAdmin();showTab('products');showToast('Sample data loaded')}

// ============ CATEGORIES ============
function renderCategories(){const c=document.getElementById('admin-content');
c.innerHTML='<div class="card"><div class="card-header"><h3>Categories</h3><button class="btn btn-primary btn-sm" onclick="openCategoryModal()">Add Category</button></div>'+
(adminCategories.length===0?'<div class="empty-state">No categories yet</div>':
'<table><thead><tr><th>Name</th><th>Description</th><th>Order</th><th style="width:40px"></th></tr></thead><tbody>'+
adminCategories.map(cat=>'<tr><td style="font-weight:500">'+esc(cat.name)+'</td><td style="color:#6b7280">'+esc(cat.description)+'</td><td>'+
(cat.order||0)+'</td><td><button class="edit-btn" onclick="openCategoryModal(\\''+cat.id+'\\')">${ICONS.edit}</button></td></tr>').join('')+'</tbody></table>')+'</div>'}
function openCategoryModal(catId){const cat=catId?adminCategories.find(c=>c.id===catId):null;
const modal=document.createElement('div');modal.className='modal-overlay';modal.onclick=e=>{if(e.target===modal)modal.remove()};
modal.innerHTML='<div class="modal" style="max-width:500px"><div class="modal-header"><h2>'+(cat?'Edit':'Add')+' Category</h2><button class="modal-close" onclick="this.closest(\\'.modal-overlay\\').remove()">${ICONS.x}</button></div><div class="modal-body">'+
'<div class="fg"><label>Name</label><input id="cf-name" value="'+esc(cat?.name||'')+'"></div>'+
'<div class="fg"><label>Description</label><textarea id="cf-desc">'+esc(cat?.description||'')+'</textarea></div>'+
'<div class="fg"><label>Display Order</label><input id="cf-order" type="number" value="'+(cat?.order||0)+'"></div>'+
'</div><div class="modal-footer">'+(cat?'<button class="btn btn-danger btn-sm" onclick="if(confirm(\\'Delete this category?\\'))deleteCategory(\\''+cat.id+'\\')">Delete Category</button><div style="flex:1"></div>':'')+
'<button class="btn-ghost" onclick="this.closest(\\'.modal-overlay\\').remove()">Cancel</button><button class="btn btn-primary" onclick="saveCategory('+(cat?"'"+cat.id+"'":'null')+')">Save</button></div></div>';
document.body.appendChild(modal)}
async function saveCategory(existingId){const category={id:existingId||undefined,name:document.getElementById('cf-name').value.trim(),description:document.getElementById('cf-desc').value.trim(),order:parseInt(document.getElementById('cf-order').value)||0};
if(!category.name){showToast('Name is required');return}await fetch('/api/admin/category',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(category)});document.querySelector('.modal-overlay')?.remove();await loadAdmin();showTab('categories');showToast(existingId?'Category updated':'Category added')}
async function deleteCategory(id){await fetch('/api/admin/category/'+id,{method:'DELETE'});document.querySelector('.modal-overlay')?.remove();await loadAdmin();showTab('categories');showToast('Category deleted')}

// ============ SETTINGS ============
function renderSettings(){const c=document.getElementById('admin-content');
c.innerHTML='<div id="settings-content">Loading...</div>';loadSettings()}
async function loadSettings(){const r=await fetch('/api/admin/config');const config=await r.json();
document.getElementById('settings-content').innerHTML=
'<div class="settings-card"><h3>Store Configuration</h3>'+
'<div class="fg"><label>Store Name</label><input id="sf-name" value="'+esc(config.storeName||'')+'"></div>'+
'<div class="fg-row"><div class="fg"><label>Store PIN (customer access)</label><input id="sf-pin" value="'+esc(config.storePin||'')+'"></div>'+
'<div class="fg"><label>Admin PIN</label><input id="sf-admin-pin" value="'+esc(config.adminPin||'')+'"></div></div>'+
'<button class="btn btn-primary" onclick="saveSettings(\\'store\\')">Save Store Settings</button></div>'+
'<div class="settings-card"><h3>Payment Configuration</h3>'+
'<div class="fg"><label>Stripe Publishable Key</label><input id="sf-stripe-pk" value="'+esc(config.stripePublishableKey||'')+'"></div>'+
'<div class="fg"><label>Stripe Secret Key</label><input id="sf-stripe-sk" type="password" value="'+esc(config.stripeSecretKey||'')+'"></div>'+
'<div class="fg"><label>Stripe Webhook Secret</label><input id="sf-stripe-wh" type="password" value="'+esc(config.stripeWebhookSecret||'')+'"></div>'+
'<button class="btn btn-primary" onclick="saveSettings(\\'payment\\')">Save Payment Settings</button></div>'}
async function saveSettings(section){let config={};
if(section==='store'){config={storeName:document.getElementById('sf-name').value.trim(),storePin:document.getElementById('sf-pin').value.trim(),adminPin:document.getElementById('sf-admin-pin').value.trim()}}
else{config={stripePublishableKey:document.getElementById('sf-stripe-pk').value.trim(),stripeSecretKey:document.getElementById('sf-stripe-sk').value.trim(),stripeWebhookSecret:document.getElementById('sf-stripe-wh').value.trim()}}
await fetch('/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});showToast('Settings saved')}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
</script></body></html>`;
}
