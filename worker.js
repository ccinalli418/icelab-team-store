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
        // Store PIN verification
        if (path === '/api/verify-pin' && method === 'POST') return apiVerifyPin(request, env);
        if (path === '/api/verify-admin-pin' && method === 'POST') return apiVerifyAdminPin(request, env);

        // Public product/category APIs (require store PIN)
        if (path === '/api/categories' && method === 'GET') return apiGetCategories(env);
        if (path === '/api/products' && method === 'GET') return apiGetProducts(url, env);
        if (path.match(/^\/api\/product\/[^/]+$/) && method === 'GET') return apiGetProduct(path.split('/')[3], env);

        // Checkout
        if (path === '/api/checkout' && method === 'POST') return apiCheckout(request, env);
        if (path === '/api/stripe/webhook' && method === 'POST') return apiStripeWebhook(request, env);

        // Admin APIs
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

    // --- Page Routes ---
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' }
  });
}

function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
}

async function getConfig(env) {
  const config = await env.STORE_DATA.get('config', 'json');
  return config || {
    storeName: 'Ice Lab Team Store',
    storePin: '1234',
    adminPin: '9999',
    stripePublishableKey: '',
    stripeSecretKey: '',
    stripeWebhookSecret: ''
  };
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
  for (const id of ids) {
    const cat = await env.STORE_DATA.get(`category:${id}`, 'json');
    if (cat && cat.active !== false) cats.push(cat);
  }
  cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  return json(cats);
}

async function apiGetProducts(url, env) {
  const categoryId = url.searchParams.get('category');
  const ids = await env.STORE_DATA.get('products', 'json') || [];
  const products = [];
  for (const id of ids) {
    const p = await env.STORE_DATA.get(`product:${id}`, 'json');
    if (!p || !p.active) continue;
    if (categoryId && p.category !== categoryId) continue;
    products.push(p);
  }
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

  // Validate items and build line items
  const lineItems = [];
  for (const item of items) {
    const product = await env.STORE_DATA.get(`product:${item.productId}`, 'json');
    if (!product) return json({ error: `Product not found: ${item.productId}` }, 400);

    // Check stock if variant specified
    if (item.variantId) {
      const variant = product.variants?.find(v => v.id === item.variantId);
      if (variant && variant.stock !== null && variant.stock !== undefined && variant.stock < item.qty) {
        return json({ error: `Insufficient stock for ${product.name}` }, 400);
      }
    }

    const price = item.variantId
      ? (product.variants?.find(v => v.id === item.variantId)?.price || product.price)
      : product.price;

    let itemName = product.name;
    if (item.options && Object.keys(item.options).length > 0) {
      itemName += ' (' + Object.values(item.options).join(', ') + ')';
    }

    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: itemName },
        unit_amount: Math.round(price * 100)
      },
      quantity: item.qty
    });
  }

  const origin = new URL(request.url).origin;

  // Create Stripe Checkout Session
  const session = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: buildStripeBody({
      'mode': 'payment',
      'success_url': `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${origin}/checkout/cancel`,
      'customer_email': customer.email,
      'metadata[customerName]': customer.name,
      'metadata[customerPhone]': customer.phone,
      'metadata[items]': JSON.stringify(items),
      ...lineItems.reduce((acc, li, i) => {
        acc[`line_items[${i}][price_data][currency]`] = li.price_data.currency;
        acc[`line_items[${i}][price_data][product_data][name]`] = li.price_data.product_data.name;
        acc[`line_items[${i}][price_data][unit_amount]`] = li.price_data.unit_amount;
        acc[`line_items[${i}][quantity]`] = li.quantity;
        return acc;
      }, {})
    })
  });

  const sessionData = await session.json();
  if (sessionData.error) return json({ error: sessionData.error.message }, 400);

  return json({ url: sessionData.url, sessionId: sessionData.id });
}

function buildStripeBody(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// ============================================================
// STRIPE WEBHOOK
// ============================================================
async function apiStripeWebhook(request, env) {
  const config = await getConfig(env);
  const body = await request.text();

  // Verify webhook signature if secret is configured
  if (config.stripeWebhookSecret) {
    const sig = request.headers.get('stripe-signature');
    const valid = await verifyStripeSignature(body, sig, config.stripeWebhookSecret);
    if (!valid) return json({ error: 'Invalid signature' }, 400);
  }

  const event = JSON.parse(body);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const items = JSON.parse(session.metadata?.items || '[]');

    // Create order
    const order = {
      id: generateId('ord'),
      status: 'pending',
      customer: {
        name: session.metadata?.customerName || '',
        email: session.customer_email || session.customer_details?.email || '',
        phone: session.metadata?.customerPhone || ''
      },
      items,
      total: session.amount_total / 100,
      stripeSessionId: session.id,
      stripePaymentIntent: session.payment_intent,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pickupReadyAt: null,
      pickedUpAt: null
    };

    await env.STORE_DATA.put(`order:${order.id}`, JSON.stringify(order));

    // Add to orders list
    const orderIds = await env.STORE_DATA.get('orders', 'json') || [];
    orderIds.unshift(order.id);
    await env.STORE_DATA.put('orders', JSON.stringify(orderIds));

    // Decrement stock
    for (const item of items) {
      const product = await env.STORE_DATA.get(`product:${item.productId}`, 'json');
      if (product && item.variantId) {
        const variant = product.variants?.find(v => v.id === item.variantId);
        if (variant && variant.stock !== null && variant.stock !== undefined) {
          variant.stock = Math.max(0, variant.stock - item.qty);
          await env.STORE_DATA.put(`product:${product.id}`, JSON.stringify(product));
        }
      }
    }
  }

  return json({ received: true });
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  try {
    const parts = sigHeader.split(',').reduce((acc, part) => {
      const [key, value] = part.split('=');
      acc[key.trim()] = value;
      return acc;
    }, {});
    const timestamp = parts.t;
    const signature = parts.v1;
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return expected === signature;
  } catch {
    return false;
  }
}

// ============================================================
// ADMIN APIs
// ============================================================
async function apiAdminGetCategories(env) {
  const ids = await env.STORE_DATA.get('categories', 'json') || [];
  const cats = [];
  for (const id of ids) {
    const cat = await env.STORE_DATA.get(`category:${id}`, 'json');
    if (cat) cats.push(cat);
  }
  cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  return json(cats);
}

async function apiAdminSaveCategory(request, env) {
  const data = await request.json();
  const isNew = !data.id;
  const id = data.id || generateId('cat');
  const category = {
    id,
    name: data.name,
    description: data.description || '',
    image: data.image || '',
    order: data.order || 0,
    active: data.active !== false,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await env.STORE_DATA.put(`category:${id}`, JSON.stringify(category));

  if (isNew) {
    const ids = await env.STORE_DATA.get('categories', 'json') || [];
    ids.push(id);
    await env.STORE_DATA.put('categories', JSON.stringify(ids));
  }

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
  for (const id of ids) {
    const p = await env.STORE_DATA.get(`product:${id}`, 'json');
    if (p) products.push(p);
  }
  return json(products);
}

async function apiAdminSaveProduct(request, env) {
  const data = await request.json();
  const isNew = !data.id;
  const id = data.id || generateId('prod');
  const product = {
    id,
    name: data.name,
    description: data.description || '',
    category: data.category || '',
    price: parseFloat(data.price) || 0,
    images: data.images || [],
    variantTypes: data.variantTypes || [],
    variants: data.variants || [],
    active: data.active !== false,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await env.STORE_DATA.put(`product:${id}`, JSON.stringify(product));

  if (isNew) {
    const ids = await env.STORE_DATA.get('products', 'json') || [];
    ids.push(id);
    await env.STORE_DATA.put('products', JSON.stringify(ids));
  }

  return json(product);
}

async function apiAdminDeleteProduct(id, env) {
  const product = await env.STORE_DATA.get(`product:${id}`, 'json');
  if (product) {
    product.active = false;
    product.updatedAt = new Date().toISOString();
    await env.STORE_DATA.put(`product:${id}`, JSON.stringify(product));
  }
  return json({ success: true });
}

async function apiAdminGetOrders(url, env) {
  const status = url.searchParams.get('status');
  const ids = await env.STORE_DATA.get('orders', 'json') || [];
  const orders = [];
  for (const id of ids) {
    const o = await env.STORE_DATA.get(`order:${id}`, 'json');
    if (!o) continue;
    if (status && o.status !== status) continue;
    orders.push(o);
  }
  return json(orders);
}

async function apiAdminUpdateOrderStatus(request, env) {
  const { orderId, status } = await request.json();
  const order = await env.STORE_DATA.get(`order:${orderId}`, 'json');
  if (!order) return json({ error: 'Order not found' }, 404);

  order.status = status;
  order.updatedAt = new Date().toISOString();
  if (status === 'ready') order.pickupReadyAt = new Date().toISOString();
  if (status === 'picked_up') order.pickedUpAt = new Date().toISOString();

  await env.STORE_DATA.put(`order:${order.id}`, JSON.stringify(order));
  return json(order);
}

async function apiAdminGetConfig(env) {
  return json(await getConfig(env));
}

async function apiAdminSaveConfig(request, env) {
  const data = await request.json();
  const existing = await getConfig(env);
  const config = { ...existing, ...data, updatedAt: new Date().toISOString() };
  await env.STORE_DATA.put('config', JSON.stringify(config));
  return json(config);
}

// Seed sample data
async function apiAdminSeed(env) {
  const categories = [
    { id: 'cat_sticks', name: 'Sticks', description: 'Hockey sticks for all levels', image: '', order: 1, active: true },
    { id: 'cat_helmets', name: 'Helmets', description: 'Protective helmets and cages', image: '', order: 2, active: true },
    { id: 'cat_gloves', name: 'Gloves', description: 'Hockey gloves', image: '', order: 3, active: true },
    { id: 'cat_protective', name: 'Protective', description: 'Shin guards, shoulder pads, pants', image: '', order: 4, active: true },
    { id: 'cat_apparel', name: 'Apparel', description: 'Team apparel and accessories', image: '', order: 5, active: true }
  ];

  const products = [
    {
      id: 'prod_stick1', name: 'Bauer Nexus E5 Pro Stick', description: 'Top-tier performance stick with enhanced puck feel.', category: 'cat_sticks', price: 289.99, images: [], active: true,
      variantTypes: [
        { name: 'Hand', options: ['Left', 'Right'] },
        { name: 'Flex', options: ['75', '85', '95'] },
        { name: 'Curve', options: ['P92', 'P88', 'P28'] }
      ],
      variants: [
        { id: 'var_s1a', options: { Hand: 'Left', Flex: '85', Curve: 'P92' }, stock: 5, price: null },
        { id: 'var_s1b', options: { Hand: 'Right', Flex: '85', Curve: 'P92' }, stock: 3, price: null },
        { id: 'var_s1c', options: { Hand: 'Left', Flex: '75', Curve: 'P88' }, stock: 2, price: null }
      ]
    },
    {
      id: 'prod_stick2', name: 'CCM Jetspeed FT6 Pro', description: 'Lightweight and responsive for quick release.', category: 'cat_sticks', price: 319.99, images: [], active: true,
      variantTypes: [
        { name: 'Hand', options: ['Left', 'Right'] },
        { name: 'Flex', options: ['75', '85', '95'] },
        { name: 'Curve', options: ['P29', 'P90', 'P28'] }
      ],
      variants: [
        { id: 'var_s2a', options: { Hand: 'Left', Flex: '85', Curve: 'P29' }, stock: 4, price: null },
        { id: 'var_s2b', options: { Hand: 'Right', Flex: '95', Curve: 'P90' }, stock: 2, price: null }
      ]
    },
    {
      id: 'prod_helmet1', name: 'Bauer Re-Akt 85 Helmet', description: 'Premium protection with comfort fit system.', category: 'cat_helmets', price: 159.99, images: [], active: true,
      variantTypes: [
        { name: 'Size', options: ['Small', 'Medium', 'Large'] },
        { name: 'Color', options: ['Black', 'White', 'Navy'] }
      ],
      variants: [
        { id: 'var_h1a', options: { Size: 'Medium', Color: 'Black' }, stock: 6, price: null },
        { id: 'var_h1b', options: { Size: 'Large', Color: 'Black' }, stock: 4, price: null },
        { id: 'var_h1c', options: { Size: 'Medium', Color: 'White' }, stock: 3, price: null }
      ]
    },
    {
      id: 'prod_gloves1', name: 'Warrior Alpha LX2 Gloves', description: 'Lightweight gloves with great feel and protection.', category: 'cat_gloves', price: 129.99, images: [], active: true,
      variantTypes: [
        { name: 'Size', options: ['13"', '14"', '15"'] },
        { name: 'Color', options: ['Black', 'Navy', 'Red'] }
      ],
      variants: [
        { id: 'var_g1a', options: { Size: '14"', Color: 'Black' }, stock: 8, price: null },
        { id: 'var_g1b', options: { Size: '13"', Color: 'Navy' }, stock: 5, price: null }
      ]
    },
    {
      id: 'prod_shins1', name: 'CCM Tacks AS-V Shin Guards', description: 'Pro-level shin protection with anatomical fit.', category: 'cat_protective', price: 89.99, images: [], active: true,
      variantTypes: [
        { name: 'Size', options: ['13"', '14"', '15"', '16"'] }
      ],
      variants: [
        { id: 'var_p1a', options: { Size: '14"' }, stock: 10, price: null },
        { id: 'var_p1b', options: { Size: '15"' }, stock: 7, price: null }
      ]
    },
    {
      id: 'prod_hoodie1', name: 'Ice Lab Team Hoodie', description: 'Heavyweight fleece hoodie with embroidered Ice Lab logo.', category: 'cat_apparel', price: 54.99, images: [], active: true,
      variantTypes: [
        { name: 'Size', options: ['S', 'M', 'L', 'XL', '2XL'] },
        { name: 'Color', options: ['Black', 'Charcoal', 'Navy'] }
      ],
      variants: [
        { id: 'var_a1a', options: { Size: 'M', Color: 'Black' }, stock: 15, price: null },
        { id: 'var_a1b', options: { Size: 'L', Color: 'Black' }, stock: 12, price: null },
        { id: 'var_a1c', options: { Size: 'XL', Color: 'Charcoal' }, stock: 8, price: null }
      ]
    }
  ];

  // Save categories
  const catIds = categories.map(c => c.id);
  await env.STORE_DATA.put('categories', JSON.stringify(catIds));
  for (const cat of categories) {
    cat.createdAt = new Date().toISOString();
    cat.updatedAt = new Date().toISOString();
    await env.STORE_DATA.put(`category:${cat.id}`, JSON.stringify(cat));
  }

  // Save products
  const prodIds = products.map(p => p.id);
  await env.STORE_DATA.put('products', JSON.stringify(prodIds));
  for (const prod of products) {
    prod.createdAt = new Date().toISOString();
    prod.updatedAt = new Date().toISOString();
    await env.STORE_DATA.put(`product:${prod.id}`, JSON.stringify(prod));
  }

  return json({ success: true, categories: catIds.length, products: prodIds.length });
}

// ============================================================
// STOREFRONT HTML
// ============================================================
function storePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ice Lab Team Store</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e17; color: #e2e8f0; min-height: 100vh; }

/* PIN Screen */
#pin-screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: linear-gradient(135deg, #0a0e17 0%, #1a1f35 100%); }
.pin-box { text-align: center; background: #141929; padding: 48px; border-radius: 16px; border: 1px solid #2d3548; }
.pin-box h1 { font-size: 28px; margin-bottom: 8px; color: #60a5fa; }
.pin-box p { color: #94a3b8; margin-bottom: 24px; }
.pin-input { display: flex; gap: 12px; justify-content: center; margin-bottom: 20px; }
.pin-input input { width: 52px; height: 60px; text-align: center; font-size: 24px; background: #1e2438; border: 2px solid #2d3548; border-radius: 10px; color: #e2e8f0; outline: none; }
.pin-input input:focus { border-color: #60a5fa; }
.pin-error { color: #f87171; font-size: 14px; min-height: 20px; }

/* Header */
.store-header { background: #141929; border-bottom: 1px solid #2d3548; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
.store-header h1 { font-size: 20px; color: #60a5fa; cursor: pointer; }
.cart-btn { position: relative; background: #1e2438; border: 1px solid #2d3548; color: #e2e8f0; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.cart-btn:hover { background: #2d3548; }
.cart-badge { background: #60a5fa; color: #0a0e17; font-size: 12px; font-weight: 700; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; }

/* Main content */
.store-content { max-width: 1200px; margin: 0 auto; padding: 24px; }

/* Category Grid */
.section-title { font-size: 22px; margin-bottom: 20px; color: #f1f5f9; }
.cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
.cat-card { background: #141929; border: 1px solid #2d3548; border-radius: 12px; padding: 24px; cursor: pointer; transition: all 0.2s; text-align: center; }
.cat-card:hover { border-color: #60a5fa; transform: translateY(-2px); }
.cat-card h3 { font-size: 18px; margin-bottom: 6px; color: #f1f5f9; }
.cat-card p { font-size: 13px; color: #94a3b8; }
.cat-icon { font-size: 36px; margin-bottom: 12px; }

/* Product Grid */
.prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 20px; }
.prod-card { background: #141929; border: 1px solid #2d3548; border-radius: 12px; overflow: hidden; cursor: pointer; transition: all 0.2s; }
.prod-card:hover { border-color: #60a5fa; transform: translateY(-2px); }
.prod-img { height: 180px; background: #1e2438; display: flex; align-items: center; justify-content: center; color: #475569; font-size: 48px; }
.prod-img img { width: 100%; height: 100%; object-fit: cover; }
.prod-info { padding: 16px; }
.prod-info h3 { font-size: 16px; margin-bottom: 4px; color: #f1f5f9; }
.prod-info .price { font-size: 18px; font-weight: 700; color: #60a5fa; }
.prod-info .stock-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-top: 6px; display: inline-block; }
.in-stock { background: #064e3b; color: #34d399; }
.low-stock { background: #78350f; color: #fbbf24; }
.out-of-stock { background: #7f1d1d; color: #f87171; }

/* Product Detail */
.product-detail { background: #141929; border-radius: 12px; border: 1px solid #2d3548; padding: 32px; }
.pd-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
.pd-image { height: 350px; background: #1e2438; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #475569; font-size: 64px; overflow: hidden; }
.pd-image img { width: 100%; height: 100%; object-fit: cover; }
.pd-info h2 { font-size: 24px; margin-bottom: 8px; }
.pd-info .price { font-size: 28px; font-weight: 700; color: #60a5fa; margin-bottom: 16px; }
.pd-info .description { color: #94a3b8; margin-bottom: 20px; line-height: 1.6; }
.variant-group { margin-bottom: 16px; }
.variant-group label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.variant-group select { width: 100%; padding: 10px 12px; background: #1e2438; border: 1px solid #2d3548; border-radius: 8px; color: #e2e8f0; font-size: 15px; cursor: pointer; }
.variant-group select:focus { border-color: #60a5fa; outline: none; }
.qty-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.qty-btn { width: 36px; height: 36px; border-radius: 8px; border: 1px solid #2d3548; background: #1e2438; color: #e2e8f0; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.qty-btn:hover { background: #2d3548; }
.qty-val { font-size: 18px; min-width: 30px; text-align: center; }

/* Buttons */
.btn { padding: 12px 24px; border-radius: 8px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
.btn-primary { background: #2563eb; color: white; }
.btn-primary:hover { background: #1d4ed8; }
.btn-primary:disabled { background: #1e3a5f; color: #64748b; cursor: not-allowed; }
.btn-secondary { background: #1e2438; border: 1px solid #2d3548; color: #e2e8f0; }
.btn-secondary:hover { background: #2d3548; }
.btn-full { width: 100%; }
.btn-add-cart { background: #2563eb; color: white; padding: 14px; font-size: 16px; }
.btn-add-cart:hover { background: #1d4ed8; }

.back-link { display: inline-flex; align-items: center; gap: 6px; color: #60a5fa; text-decoration: none; margin-bottom: 20px; font-size: 14px; cursor: pointer; }
.back-link:hover { color: #93c5fd; }

/* Cart Sidebar */
.cart-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 200; display: none; }
.cart-overlay.open { display: block; }
.cart-sidebar { position: fixed; top: 0; right: 0; bottom: 0; width: 400px; max-width: 90vw; background: #141929; border-left: 1px solid #2d3548; z-index: 201; display: flex; flex-direction: column; transform: translateX(100%); transition: transform 0.3s; }
.cart-sidebar.open { transform: translateX(0); }
.cart-header { padding: 20px; border-bottom: 1px solid #2d3548; display: flex; align-items: center; justify-content: space-between; }
.cart-header h2 { font-size: 18px; }
.cart-close { background: none; border: none; color: #94a3b8; font-size: 24px; cursor: pointer; }
.cart-items { flex: 1; overflow-y: auto; padding: 16px 20px; }
.cart-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid #1e2438; }
.cart-item-info { flex: 1; }
.cart-item-info h4 { font-size: 14px; margin-bottom: 2px; }
.cart-item-info .opts { font-size: 12px; color: #94a3b8; }
.cart-item-info .item-price { font-size: 14px; color: #60a5fa; font-weight: 600; margin-top: 4px; }
.cart-item-qty { display: flex; align-items: center; gap: 8px; }
.cart-item-qty button { width: 28px; height: 28px; border-radius: 6px; border: 1px solid #2d3548; background: #1e2438; color: #e2e8f0; cursor: pointer; font-size: 14px; }
.cart-item-remove { background: none; border: none; color: #f87171; font-size: 12px; cursor: pointer; margin-top: 4px; }
.cart-empty { text-align: center; color: #64748b; padding: 40px; }
.cart-footer { padding: 20px; border-top: 1px solid #2d3548; }
.cart-total { display: flex; justify-content: space-between; font-size: 18px; font-weight: 700; margin-bottom: 16px; }
.cart-total .amount { color: #60a5fa; }

/* Checkout Form */
.checkout-form { margin-top: 12px; }
.checkout-form input { width: 100%; padding: 10px 12px; margin-bottom: 8px; background: #1e2438; border: 1px solid #2d3548; border-radius: 8px; color: #e2e8f0; font-size: 14px; }
.checkout-form input:focus { border-color: #60a5fa; outline: none; }
.checkout-form input::placeholder { color: #64748b; }

/* Success / Cancel pages */
.result-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
.result-box { background: #141929; padding: 48px; border-radius: 16px; border: 1px solid #2d3548; max-width: 480px; }
.result-icon { font-size: 64px; margin-bottom: 16px; }
.result-box h2 { font-size: 24px; margin-bottom: 8px; }
.result-box p { color: #94a3b8; margin-bottom: 24px; }

/* Toast */
.toast { position: fixed; bottom: 24px; right: 24px; background: #1e3a5f; color: #93c5fd; padding: 12px 20px; border-radius: 8px; font-size: 14px; z-index: 300; transform: translateY(80px); opacity: 0; transition: all 0.3s; }
.toast.show { transform: translateY(0); opacity: 1; }

@media (max-width: 768px) {
  .pd-layout { grid-template-columns: 1fr; }
  .cat-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .prod-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 480px) {
  .prod-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<div id="pin-screen">
  <div class="pin-box">
    <h1>Ice Lab Team Store</h1>
    <p>Enter PIN to access the store</p>
    <div class="pin-input">
      <input type="tel" maxlength="1" autofocus>
      <input type="tel" maxlength="1">
      <input type="tel" maxlength="1">
      <input type="tel" maxlength="1">
    </div>
    <div class="pin-error" id="pin-error"></div>
  </div>
</div>

<div id="store-app" style="display:none;">
  <header class="store-header">
    <h1 onclick="showHome()">Ice Lab Team Store</h1>
    <button class="cart-btn" onclick="toggleCart()">
      <span>Cart</span>
      <span class="cart-badge" id="cart-count">0</span>
    </button>
  </header>
  <main class="store-content" id="main-content"></main>
</div>

<!-- Cart Sidebar -->
<div class="cart-overlay" id="cart-overlay" onclick="toggleCart()"></div>
<div class="cart-sidebar" id="cart-sidebar">
  <div class="cart-header">
    <h2>Your Cart</h2>
    <button class="cart-close" onclick="toggleCart()">&times;</button>
  </div>
  <div class="cart-items" id="cart-items"></div>
  <div class="cart-footer" id="cart-footer"></div>
</div>

<div class="toast" id="toast"></div>

<script>
// State
let categories = [];
let products = [];
let cart = JSON.parse(localStorage.getItem('icelab_cart') || '[]');
let currentView = 'home';

// PIN logic
const pinInputs = document.querySelectorAll('.pin-input input');
pinInputs.forEach((inp, i) => {
  inp.addEventListener('input', () => {
    if (inp.value && i < pinInputs.length - 1) pinInputs[i + 1].focus();
    if (i === pinInputs.length - 1 && inp.value) checkPin();
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !inp.value && i > 0) pinInputs[i - 1].focus();
  });
});

async function checkPin() {
  const pin = Array.from(pinInputs).map(i => i.value).join('');
  if (pin.length < 4) return;
  try {
    const r = await fetch('/api/verify-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    if (r.ok) {
      sessionStorage.setItem('store_pin', pin);
      document.getElementById('pin-screen').style.display = 'none';
      document.getElementById('store-app').style.display = 'block';
      loadStore();
    } else {
      document.getElementById('pin-error').textContent = 'Invalid PIN';
      pinInputs.forEach(i => i.value = '');
      pinInputs[0].focus();
    }
  } catch { document.getElementById('pin-error').textContent = 'Connection error'; }
}

// Check if already authed
if (sessionStorage.getItem('store_pin')) {
  document.getElementById('pin-screen').style.display = 'none';
  document.getElementById('store-app').style.display = 'block';
  loadStore();
}

async function loadStore() {
  const [catRes, prodRes] = await Promise.all([fetch('/api/categories'), fetch('/api/products')]);
  categories = await catRes.json();
  products = await prodRes.json();
  updateCartCount();
  showHome();
}

function showHome() {
  currentView = 'home';
  const catIcons = { 'Sticks': '🏒', 'Helmets': '⛑️', 'Gloves': '🧤', 'Protective': '🛡️', 'Apparel': '👕' };
  const main = document.getElementById('main-content');
  main.innerHTML = '<h2 class="section-title">Shop by Category</h2><div class="cat-grid">' +
    categories.map(c => '<div class="cat-card" onclick="showCategory(\\'' + c.id + '\\')">' +
      '<div class="cat-icon">' + (catIcons[c.name] || '📦') + '</div>' +
      '<h3>' + esc(c.name) + '</h3>' +
      '<p>' + esc(c.description) + '</p></div>').join('') +
    '</div>' +
    '<h2 class="section-title">All Products</h2>' +
    '<div class="prod-grid">' + products.map(productCard).join('') + '</div>';
}

function showCategory(catId) {
  currentView = 'category';
  const cat = categories.find(c => c.id === catId);
  const filtered = products.filter(p => p.category === catId);
  const main = document.getElementById('main-content');
  main.innerHTML = '<a class="back-link" onclick="showHome()">&#8592; All Categories</a>' +
    '<h2 class="section-title">' + esc(cat.name) + '</h2>' +
    (filtered.length ? '<div class="prod-grid">' + filtered.map(productCard).join('') + '</div>'
    : '<p style="color:#64748b;">No products in this category yet.</p>');
}

function productCard(p) {
  const totalStock = p.variants?.reduce((sum, v) => sum + (v.stock ?? 0), 0) ?? 0;
  const hasVariants = p.variants?.length > 0;
  let stockHtml = '';
  if (hasVariants) {
    if (totalStock === 0) stockHtml = '<span class="stock-badge out-of-stock">Out of Stock</span>';
    else if (totalStock <= 3) stockHtml = '<span class="stock-badge low-stock">Low Stock</span>';
    else stockHtml = '<span class="stock-badge in-stock">In Stock</span>';
  }
  const imgHtml = p.images?.[0] ? '<img src="' + esc(p.images[0]) + '" alt="">' : '📦';
  return '<div class="prod-card" onclick="showProduct(\\'' + p.id + '\\')">' +
    '<div class="prod-img">' + imgHtml + '</div>' +
    '<div class="prod-info"><h3>' + esc(p.name) + '</h3>' +
    '<div class="price">$' + p.price.toFixed(2) + '</div>' +
    stockHtml + '</div></div>';
}

function showProduct(prodId) {
  currentView = 'product';
  const p = products.find(x => x.id === prodId);
  if (!p) return;
  const imgHtml = p.images?.[0] ? '<img src="' + esc(p.images[0]) + '" alt="">' : '📦';
  const variantSelects = (p.variantTypes || []).map(vt =>
    '<div class="variant-group"><label>' + esc(vt.name) + '</label>' +
    '<select onchange="updateVariantStock()" data-variant="' + esc(vt.name) + '">' +
    '<option value="">Select ' + esc(vt.name) + '</option>' +
    vt.options.map(o => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('') +
    '</select></div>'
  ).join('');

  const main = document.getElementById('main-content');
  main.innerHTML = '<a class="back-link" onclick="goBack()">&#8592; Back</a>' +
    '<div class="product-detail"><div class="pd-layout">' +
    '<div class="pd-image">' + imgHtml + '</div>' +
    '<div class="pd-info">' +
    '<h2>' + esc(p.name) + '</h2>' +
    '<div class="price" id="pd-price">$' + p.price.toFixed(2) + '</div>' +
    '<p class="description">' + esc(p.description) + '</p>' +
    variantSelects +
    '<div id="pd-stock-info" style="margin-bottom:12px;"></div>' +
    '<div class="qty-row"><span style="color:#94a3b8;font-size:13px;">Qty:</span>' +
    '<button class="qty-btn" onclick="changeQty(-1)">-</button>' +
    '<span class="qty-val" id="pd-qty">1</span>' +
    '<button class="qty-btn" onclick="changeQty(1)">+</button></div>' +
    '<button class="btn btn-add-cart btn-full" id="btn-add" onclick="addToCart(\\'' + p.id + '\\')"' +
    (p.variantTypes?.length ? ' disabled' : '') + '>Add to Cart</button>' +
    '</div></div></div>';

  window._pdQty = 1;
  window._currentProduct = p;
}

function goBack() {
  if (currentView === 'product') {
    const p = window._currentProduct;
    if (p) {
      const cat = categories.find(c => c.id === p.category);
      if (cat) { showCategory(p.category); return; }
    }
  }
  showHome();
}

function changeQty(delta) {
  window._pdQty = Math.max(1, (window._pdQty || 1) + delta);
  document.getElementById('pd-qty').textContent = window._pdQty;
}

function updateVariantStock() {
  const p = window._currentProduct;
  if (!p) return;
  const selects = document.querySelectorAll('[data-variant]');
  const selected = {};
  let allSelected = true;
  selects.forEach(s => {
    if (s.value) selected[s.dataset.variant] = s.value;
    else allSelected = false;
  });

  const btn = document.getElementById('btn-add');
  const stockInfo = document.getElementById('pd-stock-info');

  if (!allSelected) {
    btn.disabled = true;
    stockInfo.innerHTML = '';
    return;
  }

  // Find matching variant
  const variant = p.variants?.find(v => {
    return Object.entries(selected).every(([k, val]) => v.options[k] === val);
  });

  if (variant) {
    if (variant.stock !== null && variant.stock !== undefined) {
      if (variant.stock === 0) {
        stockInfo.innerHTML = '<span class="stock-badge out-of-stock">Out of Stock</span>';
        btn.disabled = true;
      } else if (variant.stock <= 3) {
        stockInfo.innerHTML = '<span class="stock-badge low-stock">Only ' + variant.stock + ' left</span>';
        btn.disabled = false;
      } else {
        stockInfo.innerHTML = '<span class="stock-badge in-stock">In Stock</span>';
        btn.disabled = false;
      }
    } else {
      stockInfo.innerHTML = '<span class="stock-badge in-stock">In Stock</span>';
      btn.disabled = false;
    }
    if (variant.price) {
      document.getElementById('pd-price').textContent = '$' + variant.price.toFixed(2);
    }
  } else {
    stockInfo.innerHTML = '<span class="stock-badge out-of-stock">Unavailable</span>';
    btn.disabled = true;
  }
}

function addToCart(prodId) {
  const p = products.find(x => x.id === prodId);
  if (!p) return;

  const selects = document.querySelectorAll('[data-variant]');
  const options = {};
  selects.forEach(s => { if (s.value) options[s.dataset.variant] = s.value; });

  const variant = p.variants?.find(v => Object.entries(options).every(([k, val]) => v.options[k] === val));
  const price = variant?.price || p.price;

  const cartItem = {
    productId: p.id,
    variantId: variant?.id || null,
    name: p.name,
    options,
    price,
    qty: window._pdQty || 1
  };

  // Check if same item+variant exists
  const existIdx = cart.findIndex(ci => ci.productId === cartItem.productId && ci.variantId === cartItem.variantId);
  if (existIdx >= 0) {
    cart[existIdx].qty += cartItem.qty;
  } else {
    cart.push(cartItem);
  }

  saveCart();
  showToast('Added to cart!');
}

function saveCart() {
  localStorage.setItem('icelab_cart', JSON.stringify(cart));
  updateCartCount();
}

function updateCartCount() {
  const count = cart.reduce((s, i) => s + i.qty, 0);
  document.getElementById('cart-count').textContent = count;
}

function toggleCart() {
  const overlay = document.getElementById('cart-overlay');
  const sidebar = document.getElementById('cart-sidebar');
  const isOpen = sidebar.classList.contains('open');
  if (isOpen) {
    overlay.classList.remove('open');
    sidebar.classList.remove('open');
  } else {
    renderCart();
    overlay.classList.add('open');
    sidebar.classList.add('open');
  }
}

function renderCart() {
  const itemsEl = document.getElementById('cart-items');
  const footerEl = document.getElementById('cart-footer');

  if (cart.length === 0) {
    itemsEl.innerHTML = '<div class="cart-empty">Your cart is empty</div>';
    footerEl.innerHTML = '';
    return;
  }

  itemsEl.innerHTML = cart.map((ci, i) => {
    const optsStr = Object.values(ci.options || {}).join(', ');
    return '<div class="cart-item">' +
      '<div class="cart-item-info">' +
      '<h4>' + esc(ci.name) + '</h4>' +
      (optsStr ? '<div class="opts">' + esc(optsStr) + '</div>' : '') +
      '<div class="item-price">$' + (ci.price * ci.qty).toFixed(2) + '</div>' +
      '</div>' +
      '<div style="text-align:right;">' +
      '<div class="cart-item-qty">' +
      '<button onclick="updateCartQty(' + i + ',-1)">-</button>' +
      '<span>' + ci.qty + '</span>' +
      '<button onclick="updateCartQty(' + i + ',1)">+</button>' +
      '</div>' +
      '<button class="cart-item-remove" onclick="removeCartItem(' + i + ')">Remove</button>' +
      '</div></div>';
  }).join('');

  const total = cart.reduce((s, ci) => s + ci.price * ci.qty, 0);
  footerEl.innerHTML = '<div class="cart-total"><span>Total</span><span class="amount">$' + total.toFixed(2) + '</span></div>' +
    '<div class="checkout-form">' +
    '<input type="text" id="co-name" placeholder="Full Name" value="' + esc(sessionStorage.getItem('co_name') || '') + '">' +
    '<input type="email" id="co-email" placeholder="Email" value="' + esc(sessionStorage.getItem('co_email') || '') + '">' +
    '<input type="tel" id="co-phone" placeholder="Phone" value="' + esc(sessionStorage.getItem('co_phone') || '') + '">' +
    '<p style="font-size:12px;color:#64748b;margin:8px 0;">Local pickup only</p>' +
    '<button class="btn btn-primary btn-full" onclick="checkout()" id="checkout-btn">Checkout - $' + total.toFixed(2) + '</button>' +
    '</div>';
}

function updateCartQty(idx, delta) {
  cart[idx].qty = Math.max(1, cart[idx].qty + delta);
  saveCart();
  renderCart();
}

function removeCartItem(idx) {
  cart.splice(idx, 1);
  saveCart();
  renderCart();
}

async function checkout() {
  const name = document.getElementById('co-name').value.trim();
  const email = document.getElementById('co-email').value.trim();
  const phone = document.getElementById('co-phone').value.trim();

  if (!name || !email || !phone) { showToast('Please fill in all fields'); return; }

  sessionStorage.setItem('co_name', name);
  sessionStorage.setItem('co_email', email);
  sessionStorage.setItem('co_phone', phone);

  const btn = document.getElementById('checkout-btn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    const r = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart, customer: { name, email, phone } })
    });
    const data = await r.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast(data.error || 'Checkout failed');
      btn.disabled = false;
      btn.textContent = 'Checkout';
    }
  } catch {
    showToast('Connection error');
    btn.disabled = false;
    btn.textContent = 'Checkout';
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
</script>
</body>
</html>`;
}

// ============================================================
// CHECKOUT SUCCESS / CANCEL PAGES
// ============================================================
function checkoutSuccessPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Order Confirmed</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a0e17; color:#e2e8f0; }
.result-page { display:flex; align-items:center; justify-content:center; min-height:100vh; }
.result-box { background:#141929; padding:48px; border-radius:16px; border:1px solid #2d3548; max-width:480px; text-align:center; }
.result-icon { font-size:64px; margin-bottom:16px; }
.result-box h2 { font-size:24px; margin-bottom:8px; color:#34d399; }
.result-box p { color:#94a3b8; margin-bottom:24px; line-height:1.6; }
.btn { padding:12px 24px; border-radius:8px; border:none; font-size:15px; font-weight:600; cursor:pointer; background:#2563eb; color:white; text-decoration:none; }
</style></head><body>
<div class="result-page"><div class="result-box">
<div class="result-icon">✅</div>
<h2>Order Confirmed!</h2>
<p>Thanks for your order! We'll have it ready for pickup at Ice Lab. You'll receive a confirmation email shortly.</p>
<a href="/" class="btn">Continue Shopping</a>
</div></div>
<script>localStorage.removeItem('icelab_cart');</script>
</body></html>`;
}

function checkoutCancelPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Checkout Cancelled</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a0e17; color:#e2e8f0; }
.result-page { display:flex; align-items:center; justify-content:center; min-height:100vh; }
.result-box { background:#141929; padding:48px; border-radius:16px; border:1px solid #2d3548; max-width:480px; text-align:center; }
.result-icon { font-size:64px; margin-bottom:16px; }
.result-box h2 { font-size:24px; margin-bottom:8px; }
.result-box p { color:#94a3b8; margin-bottom:24px; }
.btn { padding:12px 24px; border-radius:8px; border:none; font-size:15px; font-weight:600; cursor:pointer; background:#2563eb; color:white; text-decoration:none; }
</style></head><body>
<div class="result-page"><div class="result-box">
<div class="result-icon">🛒</div>
<h2>Checkout Cancelled</h2>
<p>Your order was not completed. Your cart items are still saved.</p>
<a href="/" class="btn">Return to Store</a>
</div></div>
</body></html>`;
}

// ============================================================
// ADMIN PAGE
// ============================================================
function adminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin - Ice Lab Team Store</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a0e17; color:#e2e8f0; min-height:100vh; }

/* PIN */
#admin-pin-screen { display:flex; align-items:center; justify-content:center; min-height:100vh; background:linear-gradient(135deg,#0a0e17,#1a1f35); }
.pin-box { text-align:center; background:#141929; padding:48px; border-radius:16px; border:1px solid #2d3548; }
.pin-box h1 { font-size:24px; margin-bottom:8px; color:#f59e0b; }
.pin-box p { color:#94a3b8; margin-bottom:24px; }
.pin-input { display:flex; gap:12px; justify-content:center; margin-bottom:20px; }
.pin-input input { width:52px; height:60px; text-align:center; font-size:24px; background:#1e2438; border:2px solid #2d3548; border-radius:10px; color:#e2e8f0; outline:none; }
.pin-input input:focus { border-color:#f59e0b; }
.pin-error { color:#f87171; font-size:14px; min-height:20px; }

/* Layout */
#admin-app { display:none; }
.admin-header { background:#141929; border-bottom:1px solid #2d3548; padding:16px 24px; display:flex; align-items:center; justify-content:space-between; }
.admin-header h1 { font-size:18px; color:#f59e0b; }
.admin-header a { color:#60a5fa; text-decoration:none; font-size:14px; }
.admin-nav { display:flex; gap:0; background:#141929; border-bottom:1px solid #2d3548; overflow-x:auto; }
.admin-nav button { padding:12px 20px; background:none; border:none; border-bottom:2px solid transparent; color:#94a3b8; font-size:14px; cursor:pointer; white-space:nowrap; }
.admin-nav button.active { color:#f59e0b; border-bottom-color:#f59e0b; }
.admin-nav button:hover { color:#e2e8f0; }
.admin-content { max-width:1000px; margin:0 auto; padding:24px; }

/* Shared */
.btn { padding:10px 18px; border-radius:8px; border:none; font-size:14px; font-weight:600; cursor:pointer; transition:all 0.2s; }
.btn-primary { background:#2563eb; color:white; }
.btn-primary:hover { background:#1d4ed8; }
.btn-warn { background:#dc2626; color:white; }
.btn-warn:hover { background:#b91c1c; }
.btn-secondary { background:#1e2438; border:1px solid #2d3548; color:#e2e8f0; }
.btn-secondary:hover { background:#2d3548; }
.btn-sm { padding:6px 12px; font-size:12px; }
.btn-amber { background:#d97706; color:white; }
.btn-amber:hover { background:#b45309; }
.btn-green { background:#059669; color:white; }
.btn-green:hover { background:#047857; }

.form-group { margin-bottom:16px; }
.form-group label { display:block; font-size:13px; color:#94a3b8; margin-bottom:4px; font-weight:600; }
.form-group input, .form-group textarea, .form-group select { width:100%; padding:10px 12px; background:#1e2438; border:1px solid #2d3548; border-radius:8px; color:#e2e8f0; font-size:14px; }
.form-group input:focus, .form-group textarea:focus, .form-group select:focus { border-color:#60a5fa; outline:none; }
.form-group textarea { min-height:80px; resize:vertical; font-family:inherit; }

.card { background:#141929; border:1px solid #2d3548; border-radius:12px; padding:20px; margin-bottom:16px; }
.card-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.card-header h3 { font-size:16px; }

table { width:100%; border-collapse:collapse; }
th, td { padding:10px 12px; text-align:left; border-bottom:1px solid #1e2438; font-size:14px; }
th { color:#94a3b8; font-weight:600; font-size:12px; text-transform:uppercase; }
tr:hover { background:#1e2438; }

.status-badge { padding:3px 10px; border-radius:12px; font-size:12px; font-weight:600; }
.status-pending { background:#78350f; color:#fbbf24; }
.status-ready { background:#064e3b; color:#34d399; }
.status-picked_up { background:#1e3a5f; color:#60a5fa; }
.status-cancelled { background:#7f1d1d; color:#f87171; }

.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:500; display:flex; align-items:center; justify-content:center; }
.modal { background:#141929; border:1px solid #2d3548; border-radius:16px; padding:32px; max-width:600px; width:90vw; max-height:85vh; overflow-y:auto; }
.modal h2 { font-size:20px; margin-bottom:20px; }

/* Variant builder */
.variant-type-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; padding:10px; background:#1e2438; border-radius:8px; }
.variant-type-row input { flex:1; }
.variant-type-row .options-input { flex:2; }
.tag-input-wrap { display:flex; flex-wrap:wrap; gap:4px; padding:6px 8px; background:#0a0e17; border:1px solid #2d3548; border-radius:6px; min-height:36px; align-items:center; cursor:text; }
.tag-input-wrap:focus-within { border-color:#60a5fa; }
.tag { background:#2d3548; color:#e2e8f0; padding:2px 8px; border-radius:4px; font-size:13px; display:flex; align-items:center; gap:4px; }
.tag .remove { cursor:pointer; color:#94a3b8; font-size:16px; line-height:1; }
.tag .remove:hover { color:#f87171; }
.tag-input-wrap input { border:none; background:none; color:#e2e8f0; font-size:13px; outline:none; flex:1; min-width:60px; padding:2px; }

.empty-state { text-align:center; color:#64748b; padding:40px; }

.toast { position:fixed; bottom:24px; right:24px; background:#1e3a5f; color:#93c5fd; padding:12px 20px; border-radius:8px; font-size:14px; z-index:600; transform:translateY(80px); opacity:0; transition:all 0.3s; }
.toast.show { transform:translateY(0); opacity:1; }
</style>
</head>
<body>

<div id="admin-pin-screen">
  <div class="pin-box">
    <h1>Admin Access</h1>
    <p>Enter admin PIN</p>
    <div class="pin-input">
      <input type="tel" maxlength="1" autofocus>
      <input type="tel" maxlength="1">
      <input type="tel" maxlength="1">
      <input type="tel" maxlength="1">
    </div>
    <div class="pin-error" id="pin-error"></div>
  </div>
</div>

<div id="admin-app">
  <header class="admin-header">
    <h1>Ice Lab Team Store Admin</h1>
    <a href="/">← View Store</a>
  </header>
  <nav class="admin-nav">
    <button class="active" onclick="showTab('orders')">Orders</button>
    <button onclick="showTab('products')">Products</button>
    <button onclick="showTab('categories')">Categories</button>
    <button onclick="showTab('settings')">Settings</button>
  </nav>
  <div class="admin-content" id="admin-content"></div>
</div>

<div class="toast" id="toast"></div>

<script>
let adminCategories = [];
let adminProducts = [];
let adminOrders = [];
let currentTab = 'orders';

// PIN
const pinInputs = document.querySelectorAll('.pin-input input');
pinInputs.forEach((inp, i) => {
  inp.addEventListener('input', () => {
    if (inp.value && i < pinInputs.length - 1) pinInputs[i + 1].focus();
    if (i === pinInputs.length - 1 && inp.value) checkAdminPin();
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !inp.value && i > 0) pinInputs[i - 1].focus();
  });
});

async function checkAdminPin() {
  const pin = Array.from(pinInputs).map(i => i.value).join('');
  if (pin.length < 4) return;
  try {
    const r = await fetch('/api/verify-admin-pin', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pin}) });
    if (r.ok) {
      sessionStorage.setItem('admin_pin', pin);
      document.getElementById('admin-pin-screen').style.display = 'none';
      document.getElementById('admin-app').style.display = 'block';
      loadAdmin();
    } else {
      document.getElementById('pin-error').textContent = 'Invalid PIN';
      pinInputs.forEach(i => i.value = '');
      pinInputs[0].focus();
    }
  } catch { document.getElementById('pin-error').textContent = 'Connection error'; }
}

if (sessionStorage.getItem('admin_pin')) {
  document.getElementById('admin-pin-screen').style.display = 'none';
  document.getElementById('admin-app').style.display = 'block';
  loadAdmin();
}

async function loadAdmin() {
  const [catRes, prodRes, ordRes] = await Promise.all([
    fetch('/api/admin/categories'), fetch('/api/admin/products'), fetch('/api/admin/orders')
  ]);
  adminCategories = await catRes.json();
  adminProducts = await prodRes.json();
  adminOrders = await ordRes.json();
  showTab(currentTab);
}

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.admin-nav button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.admin-nav button').forEach(b => { if (b.textContent.toLowerCase() === tab) b.classList.add('active'); });
  if (tab === 'orders') renderOrders();
  else if (tab === 'products') renderProducts();
  else if (tab === 'categories') renderCategories();
  else if (tab === 'settings') renderSettings();
}

// ---- ORDERS ----
function renderOrders() {
  const c = document.getElementById('admin-content');
  if (adminOrders.length === 0) {
    c.innerHTML = '<div class="card"><div class="empty-state">No orders yet</div></div>';
    return;
  }
  c.innerHTML = '<div class="card"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
    adminOrders.map(o => {
      const itemCount = o.items?.reduce((s, i) => s + (i.qty || 1), 0) || 0;
      const date = new Date(o.createdAt).toLocaleDateString();
      return '<tr>' +
        '<td>' + esc(o.id.slice(-8)) + '<br><span style="font-size:11px;color:#64748b;">' + date + '</span></td>' +
        '<td>' + esc(o.customer?.name) + '<br><span style="font-size:11px;color:#64748b;">' + esc(o.customer?.email) + '</span></td>' +
        '<td>' + itemCount + ' item(s)</td>' +
        '<td>$' + (o.total || 0).toFixed(2) + '</td>' +
        '<td><span class="status-badge status-' + o.status + '">' + o.status.replace('_', ' ') + '</span></td>' +
        '<td>' + orderActions(o) + '</td></tr>';
    }).join('') +
    '</tbody></table></div>';
}

function orderActions(o) {
  if (o.status === 'pending') return '<button class="btn btn-amber btn-sm" onclick="updateOrderStatus(\\'' + o.id + '\\',\\'ready\\')">Mark Ready</button>';
  if (o.status === 'ready') return '<button class="btn btn-green btn-sm" onclick="updateOrderStatus(\\'' + o.id + '\\',\\'picked_up\\')">Picked Up</button>';
  return '';
}

async function updateOrderStatus(orderId, status) {
  await fetch('/api/admin/order/status', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({orderId, status}) });
  await loadAdmin();
  showToast('Order updated');
}

// ---- PRODUCTS ----
function renderProducts() {
  const c = document.getElementById('admin-content');
  const activeProds = adminProducts.filter(p => p.active);
  c.innerHTML = '<div class="card"><div class="card-header"><h3>Products (' + activeProds.length + ')</h3>' +
    '<div style="display:flex;gap:8px;"><button class="btn btn-secondary btn-sm" onclick="seedData()">Seed Sample Data</button>' +
    '<button class="btn btn-primary btn-sm" onclick="openProductModal()">+ Add Product</button></div></div>' +
    (activeProds.length === 0 ? '<div class="empty-state">No products yet. Add one or seed sample data.</div>'
    : '<table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Actions</th></tr></thead><tbody>' +
    activeProds.map(p => {
      const cat = adminCategories.find(c => c.id === p.category);
      const totalStock = p.variants?.reduce((s, v) => s + (v.stock ?? 0), 0) ?? 0;
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(cat?.name || '-') + '</td>' +
        '<td>$' + p.price.toFixed(2) + '</td><td>' + totalStock + '</td>' +
        '<td><button class="btn btn-secondary btn-sm" onclick="openProductModal(\\'' + p.id + '\\')">Edit</button> ' +
        '<button class="btn btn-warn btn-sm" onclick="deleteProduct(\\'' + p.id + '\\')">Delete</button></td></tr>';
    }).join('') + '</tbody></table>') + '</div>';
}

function openProductModal(prodId) {
  const p = prodId ? adminProducts.find(x => x.id === prodId) : null;
  const isNew = !p;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  // Store variant types state
  window._editVariantTypes = p ? JSON.parse(JSON.stringify(p.variantTypes || [])) : [];
  window._editVariants = p ? JSON.parse(JSON.stringify(p.variants || [])) : [];

  modal.innerHTML = '<div class="modal"><h2>' + (isNew ? 'Add Product' : 'Edit Product') + '</h2>' +
    '<div class="form-group"><label>Name</label><input id="pf-name" value="' + esc(p?.name || '') + '"></div>' +
    '<div class="form-group"><label>Description</label><textarea id="pf-desc">' + esc(p?.description || '') + '</textarea></div>' +
    '<div class="form-group"><label>Category</label><select id="pf-cat">' +
    '<option value="">Select category</option>' +
    adminCategories.map(c => '<option value="' + c.id + '"' + (p?.category === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') +
    '</select></div>' +
    '<div class="form-group"><label>Base Price ($)</label><input id="pf-price" type="number" step="0.01" value="' + (p?.price || '') + '"></div>' +
    '<div class="form-group"><label>Image URL</label><input id="pf-image" value="' + esc(p?.images?.[0] || '') + '"></div>' +
    '<div class="form-group"><label>Variant Types</label><div id="vt-container"></div>' +
    '<button class="btn btn-secondary btn-sm" onclick="addVariantType()" style="margin-top:8px;">+ Add Variant Type</button></div>' +
    '<div class="form-group"><label>Variants & Stock</label><div id="var-container"></div>' +
    '<button class="btn btn-secondary btn-sm" onclick="generateVariants()" style="margin-top:8px;">Generate Variant Combinations</button></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px;">' +
    '<button class="btn btn-secondary" onclick="this.closest(\\'.modal-overlay\\').remove()">Cancel</button>' +
    '<button class="btn btn-primary" onclick="saveProduct(' + (p ? "\\'" + p.id + "\\'" : 'null') + ')">Save Product</button></div></div>';

  document.body.appendChild(modal);
  renderVariantTypes();
  renderVariants();
}

function addVariantType() {
  window._editVariantTypes.push({ name: '', options: [] });
  renderVariantTypes();
}

function removeVariantType(idx) {
  window._editVariantTypes.splice(idx, 1);
  renderVariantTypes();
}

function renderVariantTypes() {
  const container = document.getElementById('vt-container');
  if (!container) return;
  container.innerHTML = window._editVariantTypes.map((vt, i) => {
    const presets = ['Size', 'Color', 'Hand', 'Flex', 'Curve'];
    return '<div class="variant-type-row">' +
      '<div style="flex:1;"><div class="tag-input-wrap" style="padding:0;border:none;min-height:auto;">' +
      '<select onchange="vtNameChange(' + i + ', this.value)" style="width:100%;padding:8px;background:#0a0e17;border:1px solid #2d3548;border-radius:6px;color:#e2e8f0;font-size:13px;">' +
      '<option value="">Type name...</option>' +
      presets.map(p => '<option value="' + p + '"' + (vt.name === p ? ' selected' : '') + '>' + p + '</option>').join('') +
      '<option value="__custom"' + (vt.name && !presets.includes(vt.name) ? ' selected' : '') + '>Custom...</option>' +
      '</select></div>' +
      (vt.name && !presets.includes(vt.name) ? '<input style="margin-top:4px;width:100%;padding:6px 8px;background:#0a0e17;border:1px solid #2d3548;border-radius:6px;color:#e2e8f0;font-size:13px;" value="' + esc(vt.name) + '" onchange="vtCustomName(' + i + ',this.value)" placeholder="Custom name">' : '') +
      '</div>' +
      '<div style="flex:2;" id="vt-opts-' + i + '"></div>' +
      '<button class="btn btn-warn btn-sm" onclick="removeVariantType(' + i + ')" style="flex-shrink:0;">×</button></div>';
  }).join('');

  // Render tag inputs for options
  window._editVariantTypes.forEach((vt, i) => {
    const wrap = document.getElementById('vt-opts-' + i);
    if (!wrap) return;
    renderTagInput(wrap, vt.options, (newOpts) => { window._editVariantTypes[i].options = newOpts; });
  });
}

function vtNameChange(idx, val) {
  if (val === '__custom') window._editVariantTypes[idx].name = '';
  else window._editVariantTypes[idx].name = val;

  // Pre-fill common options
  const defaults = { Size: ['S','M','L','XL','2XL'], Color: ['Black','White','Navy'], Hand: ['Left','Right'], Flex: ['75','85','95'], Curve: ['P92','P88','P28','P29'] };
  if (defaults[val] && window._editVariantTypes[idx].options.length === 0) {
    window._editVariantTypes[idx].options = [...defaults[val]];
  }
  renderVariantTypes();
}

function vtCustomName(idx, val) {
  window._editVariantTypes[idx].name = val;
}

function renderTagInput(container, tags, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'tag-input-wrap';

  function render() {
    wrap.innerHTML = '';
    tags.forEach((tag, i) => {
      const el = document.createElement('span');
      el.className = 'tag';
      el.innerHTML = esc(tag) + '<span class="remove" onclick="event.stopPropagation()">×</span>';
      el.querySelector('.remove').addEventListener('click', () => { tags.splice(i, 1); onChange(tags); render(); });
      wrap.appendChild(el);
    });
    const input = document.createElement('input');
    input.placeholder = 'Type & press Enter';
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
        e.preventDefault();
        const val = input.value.trim().replace(/,$/,'');
        if (val && !tags.includes(val)) { tags.push(val); onChange(tags); }
        input.value = '';
        render();
      }
      if (e.key === 'Backspace' && !input.value && tags.length) {
        tags.pop(); onChange(tags); render();
      }
    });
    wrap.appendChild(input);
    wrap.addEventListener('click', () => input.focus());
  }
  render();
  container.innerHTML = '';
  container.appendChild(wrap);
}

function generateVariants() {
  const types = window._editVariantTypes.filter(vt => vt.name && vt.options.length > 0);
  if (types.length === 0) { showToast('Add variant types first'); return; }

  // Generate all combinations
  let combos = [{}];
  for (const vt of types) {
    const newCombos = [];
    for (const combo of combos) {
      for (const opt of vt.options) {
        newCombos.push({ ...combo, [vt.name]: opt });
      }
    }
    combos = newCombos;
  }

  // Keep existing variants that match, add new ones
  const existing = window._editVariants || [];
  window._editVariants = combos.map(opts => {
    const match = existing.find(v => Object.entries(opts).every(([k, val]) => v.options?.[k] === val));
    return match || { id: generateId('var'), options: opts, stock: 0, price: null };
  });

  renderVariants();
  showToast('Generated ' + combos.length + ' variant(s)');
}

function renderVariants() {
  const container = document.getElementById('var-container');
  if (!container) return;
  if (!window._editVariants?.length) { container.innerHTML = '<p style="color:#64748b;font-size:13px;">No variants. Generate from variant types above.</p>'; return; }

  container.innerHTML = '<table><thead><tr><th>Options</th><th>Stock</th><th>Price Override</th><th></th></tr></thead><tbody>' +
    window._editVariants.map((v, i) => {
      const optsStr = Object.entries(v.options).map(([k, val]) => k + ': ' + val).join(', ');
      return '<tr><td style="font-size:13px;">' + esc(optsStr) + '</td>' +
        '<td><input type="number" min="0" value="' + (v.stock ?? 0) + '" style="width:70px;padding:4px 8px;background:#0a0e17;border:1px solid #2d3548;border-radius:4px;color:#e2e8f0;font-size:13px;" onchange="window._editVariants[' + i + '].stock=parseInt(this.value)||0"></td>' +
        '<td><input type="number" step="0.01" value="' + (v.price || '') + '" placeholder="Base" style="width:90px;padding:4px 8px;background:#0a0e17;border:1px solid #2d3548;border-radius:4px;color:#e2e8f0;font-size:13px;" onchange="window._editVariants[' + i + '].price=parseFloat(this.value)||null"></td>' +
        '<td><button class="btn btn-warn btn-sm" onclick="window._editVariants.splice(' + i + ',1);renderVariants()">×</button></td></tr>';
    }).join('') + '</tbody></table>';
}

function generateId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6); }

async function saveProduct(existingId) {
  const product = {
    id: existingId || undefined,
    name: document.getElementById('pf-name').value.trim(),
    description: document.getElementById('pf-desc').value.trim(),
    category: document.getElementById('pf-cat').value,
    price: parseFloat(document.getElementById('pf-price').value) || 0,
    images: document.getElementById('pf-image').value.trim() ? [document.getElementById('pf-image').value.trim()] : [],
    variantTypes: window._editVariantTypes.filter(vt => vt.name && vt.options.length),
    variants: window._editVariants || [],
    active: true
  };

  if (!product.name) { showToast('Product name is required'); return; }
  if (!product.price) { showToast('Price is required'); return; }

  await fetch('/api/admin/product', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(product) });
  document.querySelector('.modal-overlay')?.remove();
  await loadAdmin();
  showTab('products');
  showToast(existingId ? 'Product updated' : 'Product added');
}

async function deleteProduct(id) {
  if (!confirm('Delete this product?')) return;
  await fetch('/api/admin/product/' + id, { method:'DELETE' });
  await loadAdmin();
  showTab('products');
  showToast('Product deleted');
}

async function seedData() {
  if (!confirm('Seed sample catalog data?')) return;
  await fetch('/api/admin/seed', { method:'POST' });
  await loadAdmin();
  showTab('products');
  showToast('Sample data loaded');
}

// ---- CATEGORIES ----
function renderCategories() {
  const c = document.getElementById('admin-content');
  c.innerHTML = '<div class="card"><div class="card-header"><h3>Categories (' + adminCategories.length + ')</h3>' +
    '<button class="btn btn-primary btn-sm" onclick="openCategoryModal()">+ Add Category</button></div>' +
    (adminCategories.length === 0 ? '<div class="empty-state">No categories yet</div>'
    : '<table><thead><tr><th>Name</th><th>Description</th><th>Order</th><th>Actions</th></tr></thead><tbody>' +
    adminCategories.map(cat =>
      '<tr><td>' + esc(cat.name) + '</td><td>' + esc(cat.description) + '</td><td>' + (cat.order || 0) + '</td>' +
      '<td><button class="btn btn-secondary btn-sm" onclick="openCategoryModal(\\'' + cat.id + '\\')">Edit</button> ' +
      '<button class="btn btn-warn btn-sm" onclick="deleteCategory(\\'' + cat.id + '\\')">Delete</button></td></tr>'
    ).join('') + '</tbody></table>') + '</div>';
}

function openCategoryModal(catId) {
  const cat = catId ? adminCategories.find(c => c.id === catId) : null;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.innerHTML = '<div class="modal"><h2>' + (cat ? 'Edit' : 'Add') + ' Category</h2>' +
    '<div class="form-group"><label>Name</label><input id="cf-name" value="' + esc(cat?.name || '') + '"></div>' +
    '<div class="form-group"><label>Description</label><textarea id="cf-desc">' + esc(cat?.description || '') + '</textarea></div>' +
    '<div class="form-group"><label>Display Order</label><input id="cf-order" type="number" value="' + (cat?.order || 0) + '"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:24px;">' +
    '<button class="btn btn-secondary" onclick="this.closest(\\'.modal-overlay\\').remove()">Cancel</button>' +
    '<button class="btn btn-primary" onclick="saveCategory(' + (cat ? "\\'" + cat.id + "\\'" : 'null') + ')">Save</button></div></div>';
  document.body.appendChild(modal);
}

async function saveCategory(existingId) {
  const category = {
    id: existingId || undefined,
    name: document.getElementById('cf-name').value.trim(),
    description: document.getElementById('cf-desc').value.trim(),
    order: parseInt(document.getElementById('cf-order').value) || 0
  };
  if (!category.name) { showToast('Name is required'); return; }
  await fetch('/api/admin/category', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(category) });
  document.querySelector('.modal-overlay')?.remove();
  await loadAdmin();
  showTab('categories');
  showToast(existingId ? 'Category updated' : 'Category added');
}

async function deleteCategory(id) {
  if (!confirm('Delete this category?')) return;
  await fetch('/api/admin/category/' + id, { method:'DELETE' });
  await loadAdmin();
  showTab('categories');
  showToast('Category deleted');
}

// ---- SETTINGS ----
function renderSettings() {
  const c = document.getElementById('admin-content');
  c.innerHTML = '<div class="card"><h3 style="margin-bottom:16px;">Store Settings</h3><div id="settings-form">Loading...</div></div>';
  loadSettings();
}

async function loadSettings() {
  const r = await fetch('/api/admin/config');
  const config = await r.json();
  document.getElementById('settings-form').innerHTML =
    '<div class="form-group"><label>Store Name</label><input id="sf-name" value="' + esc(config.storeName || '') + '"></div>' +
    '<div class="form-group"><label>Store PIN (customer access)</label><input id="sf-pin" value="' + esc(config.storePin || '') + '"></div>' +
    '<div class="form-group"><label>Admin PIN</label><input id="sf-admin-pin" value="' + esc(config.adminPin || '') + '"></div>' +
    '<div class="form-group"><label>Stripe Publishable Key</label><input id="sf-stripe-pk" value="' + esc(config.stripePublishableKey || '') + '"></div>' +
    '<div class="form-group"><label>Stripe Secret Key</label><input id="sf-stripe-sk" type="password" value="' + esc(config.stripeSecretKey || '') + '"></div>' +
    '<div class="form-group"><label>Stripe Webhook Secret</label><input id="sf-stripe-wh" type="password" value="' + esc(config.stripeWebhookSecret || '') + '"></div>' +
    '<button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>';
}

async function saveSettings() {
  const config = {
    storeName: document.getElementById('sf-name').value.trim(),
    storePin: document.getElementById('sf-pin').value.trim(),
    adminPin: document.getElementById('sf-admin-pin').value.trim(),
    stripePublishableKey: document.getElementById('sf-stripe-pk').value.trim(),
    stripeSecretKey: document.getElementById('sf-stripe-sk').value.trim(),
    stripeWebhookSecret: document.getElementById('sf-stripe-wh').value.trim()
  };
  await fetch('/api/admin/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config) });
  showToast('Settings saved');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
</script>
</body>
</html>`;
}
