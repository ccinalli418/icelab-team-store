// Ice Lab Team Store — Cloudflare Worker
// Lightspeed Retail X-Series POS Integration
// Customer-facing ordering portal with Stripe checkout

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    // --- API Routes ---
    if (path.startsWith('/api/')) {
      try {
        // Auth
        if (path === '/api/verify-pin' && method === 'POST') return apiVerifyPin(request, env);
        if (path === '/api/verify-admin-pin' && method === 'POST') return apiVerifyAdminPin(request, env);

        // Public storefront
        if (path === '/api/categories' && method === 'GET') return apiGetCategories(env);
        if (path === '/api/products' && method === 'GET') return apiGetProducts(url, env);
        if (path.match(/^\/api\/product\/[^/]+$/) && method === 'GET') return apiGetProduct(path.split('/')[3], env);

        // Checkout
        if (path === '/api/checkout' && method === 'POST') return apiCheckout(request, env);
        if (path === '/api/stripe/webhook' && method === 'POST') return apiStripeWebhook(request, env);

        // Admin — Lightspeed
        if (path === '/api/admin/lightspeed/test' && method === 'GET') return apiLightspeedTest(env);
        if (path === '/api/admin/lightspeed/sync' && method === 'GET') return apiLightspeedSync(env);
        if (path === '/api/admin/lightspeed/toggle' && method === 'POST') return apiLightspeedToggle(request, env);
        if (path === '/api/admin/lightspeed/price' && method === 'POST') return apiLightspeedPrice(request, env);
        if (path === '/api/admin/import-products' && method === 'GET') return apiImportProducts(env);

        // Admin — general
        if (path === '/api/admin/orders' && method === 'GET') return apiAdminGetOrders(url, env);
        if (path === '/api/admin/enabled-products' && method === 'GET') return apiAdminEnabledProducts(env);
        if (path === '/api/admin/config' && method === 'GET') return apiAdminGetConfig(env);
        if (path === '/api/admin/config' && method === 'POST') return apiAdminSaveConfig(request, env);

        return json({ error: 'Not found' }, 404);
      } catch (e) {
        console.error('API Error:', e.message, e.stack);
        return json({ error: 'Internal server error', detail: e.message }, 500);
      }
    }

    // Pages
    if (path === '/admin' || path.startsWith('/admin')) return htmlResponse(adminPage());
    if (path === '/checkout/success') return htmlResponse(checkoutSuccessPage());
    if (path === '/checkout/cancel') return htmlResponse(checkoutCancelPage());
    return htmlResponse(storePage());
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronSyncProducts(env));
  }
};

// ============================================================
// HELPERS
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders() } });
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } });
}
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
}
async function getConfig(env) {
  const config = await env.STORE_DATA.get('config', 'json');
  return config || { storeName: 'Ice Lab Team Store', storePin: '1234', adminPin: '9999', stripePublishableKey: '', stripeSecretKey: '', stripeWebhookSecret: '', discountPercent: 15 };
}
function lsApi(env) {
  const prefix = env.LIGHTSPEED_DOMAIN_PREFIX || 'icelabproshop';
  return `https://${prefix}.retail.lightspeed.app/api/2.0`;
}
function lsHeaders(env) {
  return { 'Authorization': `Bearer ${env.LIGHTSPEED_API_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

// ============================================================
// PIN VERIFICATION
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
// LIGHTSPEED API HELPERS
// ============================================================
async function lsFetchAll(env, endpoint) {
  let all = [];
  let after = 0;
  let pages = 0;
  while (pages < 50) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `${lsApi(env)}/${endpoint}${after ? `${sep}after=${after}` : ''}`;
    const resp = await fetch(url, { headers: lsHeaders(env) });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Lightspeed API error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    const key = Object.keys(data).find(k => Array.isArray(data[k]));
    if (key) all = all.concat(data[key]);
    if (data.version && data.version.max && data.version.max > after) {
      after = data.version.max;
      pages++;
    } else {
      break;
    }
    if (!key || data[key].length === 0) break;
  }
  return all;
}

async function lsFetch(env, endpoint, options = {}) {
  const url = `${lsApi(env)}/${endpoint}`;
  const resp = await fetch(url, { headers: lsHeaders(env), ...options });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Lightspeed API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ============================================================
// LIGHTSPEED ADMIN APIs
// ============================================================
async function apiLightspeedTest(env) {
  if (!env.LIGHTSPEED_API_TOKEN) return json({ success: false, error: 'LIGHTSPEED_API_TOKEN not configured' });
  try {
    const data = await lsFetch(env, 'outlets');
    const outlets = data.outlets || data.data || [];
    return json({ success: true, message: `Connected. Found ${outlets.length} outlet(s).`, outlets: outlets.map(o => ({ id: o.id, name: o.name })) });
  } catch (e) {
    return json({ success: false, error: e.message });
  }
}

async function apiLightspeedSync(env) {
  if (!env.LIGHTSPEED_API_TOKEN) return json({ error: 'Lightspeed not configured' }, 400);
  try {
    const products = await lsFetchAll(env, 'products?page_size=100');
    await env.STORE_DATA.put('ls_products_cache', JSON.stringify(products));
    await env.STORE_DATA.put('ls_sync_timestamp', new Date().toISOString());

    // Extract categories (brands/types from Lightspeed)
    const brands = [...new Set(products.map(p => p.brand_name || p.supplier_name).filter(Boolean))];
    const types = [...new Set(products.map(p => p.type || p.product_type_name || p.product_type).filter(Boolean))];

    // Update enabled product configs with fresh data
    let updatedCount = 0;
    for (const p of products) {
      const configKey = `ts_enabled:${p.id}`;
      const existing = await env.STORE_DATA.get(configKey, 'json');
      if (existing && existing.enabled) {
        // Update stock and price from Lightspeed but keep team price override
        existing.currentStock = p.inventory?.[0]?.current_amount ?? p.current_inventory ?? 0;
        existing.retailPrice = parseFloat(p.price_including_tax || p.price || 0);
        existing.name = p.name;
        existing.updatedAt = new Date().toISOString();
        await env.STORE_DATA.put(configKey, JSON.stringify(existing));
        updatedCount++;
      }
    }

    return json({
      success: true,
      totalProducts: products.length,
      brands,
      types,
      updatedEnabled: updatedCount,
      syncedAt: new Date().toISOString()
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function apiLightspeedToggle(request, env) {
  const { productId, enabled } = await request.json();
  if (!productId) return json({ error: 'productId required' }, 400);

  const configKey = `ts_enabled:${productId}`;
  const config = await getConfig(env);
  const discount = config.discountPercent || 15;

  if (enabled) {
    // Fetch fresh product data from cache
    const cache = await env.STORE_DATA.get('ls_products_cache', 'json') || [];
    const product = cache.find(p => p.id === productId);
    if (!product) return json({ error: 'Product not found in cache. Run sync first.' }, 404);

    const retailPrice = parseFloat(product.price_including_tax || product.price || 0);
    const teamPrice = Math.round(retailPrice * (1 - discount / 100) * 100) / 100;

    const tsConfig = {
      enabled: true,
      lightspeedId: productId,
      name: product.name,
      brand: product.brand_name || product.supplier_name || '',
      sku: product.sku || product.supply_price ? '' : '',
      retailPrice,
      teamPrice,
      currentStock: product.inventory?.[0]?.current_amount ?? product.current_inventory ?? 0,
      images: product.images || product.image_url ? [product.image_url || product.images?.[0]?.url] : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await env.STORE_DATA.put(configKey, JSON.stringify(tsConfig));
    return json(tsConfig);
  } else {
    const existing = await env.STORE_DATA.get(configKey, 'json');
    if (existing) {
      existing.enabled = false;
      existing.updatedAt = new Date().toISOString();
      await env.STORE_DATA.put(configKey, JSON.stringify(existing));
    }
    return json({ enabled: false, productId });
  }
}

async function apiLightspeedPrice(request, env) {
  const { productId, teamPrice } = await request.json();
  if (!productId) return json({ error: 'productId required' }, 400);
  const configKey = `ts_enabled:${productId}`;
  const existing = await env.STORE_DATA.get(configKey, 'json');
  if (!existing) return json({ error: 'Product not enabled in team store' }, 404);
  existing.teamPrice = parseFloat(teamPrice) || 0;
  existing.updatedAt = new Date().toISOString();
  await env.STORE_DATA.put(configKey, JSON.stringify(existing));
  return json(existing);
}

async function apiImportProducts(env) {
  const cache = await env.STORE_DATA.get('ls_products_cache', 'json') || [];
  const syncTimestamp = await env.STORE_DATA.get('ls_sync_timestamp') || null;
  const config = await getConfig(env);

  // Get enabled status for each product
  const enriched = [];
  for (const p of cache) {
    const tsConfig = await env.STORE_DATA.get(`ts_enabled:${p.id}`, 'json');
    enriched.push({
      id: p.id,
      name: p.name,
      brand: p.brand_name || p.supplier_name || '',
      sku: p.sku || '',
      type: p.type || p.product_type_name || p.product_type || '',
      retailPrice: parseFloat(p.price_including_tax || p.price || 0),
      stock: p.inventory?.[0]?.current_amount ?? p.current_inventory ?? 0,
      hasVariants: p.has_variants || false,
      variantCount: p.variant_count || 0,
      variantParentId: p.variant_parent_id || null,
      variantName: p.variant_name || null,
      images: p.images || (p.image_url ? [{ url: p.image_url }] : []),
      imageUrl: p.image_url || p.images?.[0]?.url || null,
      enabled: tsConfig?.enabled || false,
      teamPrice: tsConfig?.teamPrice || null,
      description: p.description || ''
    });
  }

  return json({
    products: enriched,
    syncTimestamp,
    discountPercent: config.discountPercent || 15,
    totalProducts: enriched.length
  });
}

// ============================================================
// PUBLIC STOREFRONT APIs
// ============================================================
async function apiGetCategories(env) {
  // Build categories from enabled products' brands/types
  const cache = await env.STORE_DATA.get('ls_products_cache', 'json') || [];
  const enabledProducts = [];
  for (const p of cache) {
    const tsConfig = await env.STORE_DATA.get(`ts_enabled:${p.id}`, 'json');
    if (tsConfig?.enabled) enabledProducts.push({ ...p, tsConfig });
  }
  // Group by product type
  const typeMap = {};
  for (const p of enabledProducts) {
    if (p.variant_parent_id) continue; // skip child variants for category counting
    const type = p.type || p.product_type_name || p.product_type || 'Other';
    if (!typeMap[type]) typeMap[type] = { id: type, name: type, count: 0 };
    typeMap[type].count++;
  }
  return json(Object.values(typeMap).sort((a, b) => a.name.localeCompare(b.name)));
}

async function apiGetProducts(url, env) {
  const category = url.searchParams.get('category');
  const cache = await env.STORE_DATA.get('ls_products_cache', 'json') || [];
  const config = await getConfig(env);
  const discount = config.discountPercent || 15;

  const enabledProducts = [];
  for (const p of cache) {
    const tsConfig = await env.STORE_DATA.get(`ts_enabled:${p.id}`, 'json');
    if (!tsConfig?.enabled) continue;

    const type = p.type || p.product_type_name || p.product_type || 'Other';
    if (category && type !== category) continue;

    enabledProducts.push(buildStorefrontProduct(p, tsConfig, discount));
  }

  // Group by variant_parent_id — show parent products as cards
  const grouped = groupVariantProducts(enabledProducts);
  return json(grouped);
}

async function apiGetProduct(id, env) {
  const cache = await env.STORE_DATA.get('ls_products_cache', 'json') || [];
  const config = await getConfig(env);
  const discount = config.discountPercent || 15;

  // Find the product (could be a parent or standalone)
  const product = cache.find(p => p.id === id);
  if (!product) return json({ error: 'Product not found' }, 404);

  const tsConfig = await env.STORE_DATA.get(`ts_enabled:${id}`, 'json');
  if (!tsConfig?.enabled) return json({ error: 'Product not available' }, 404);

  const result = buildStorefrontProduct(product, tsConfig, discount);

  // If this has variants, find all child variants
  if (product.has_variants) {
    const children = cache.filter(p => p.variant_parent_id === id);
    result.variants = [];
    for (const child of children) {
      const childConfig = await env.STORE_DATA.get(`ts_enabled:${child.id}`, 'json');
      result.variants.push({
        id: child.id,
        name: child.variant_name || child.name,
        sku: child.sku || '',
        retailPrice: parseFloat(child.price_including_tax || child.price || 0),
        teamPrice: childConfig?.teamPrice || Math.round(parseFloat(child.price_including_tax || child.price || 0) * (1 - discount / 100) * 100) / 100,
        stock: child.inventory?.[0]?.current_amount ?? child.current_inventory ?? 0,
        enabled: childConfig?.enabled !== false
      });
    }
  }

  return json(result);
}

function buildStorefrontProduct(p, tsConfig, discount) {
  const retailPrice = parseFloat(p.price_including_tax || p.price || 0);
  const teamPrice = tsConfig?.teamPrice || Math.round(retailPrice * (1 - discount / 100) * 100) / 100;
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    brand: p.brand_name || p.supplier_name || '',
    type: p.type || p.product_type_name || p.product_type || '',
    sku: p.sku || '',
    retailPrice,
    teamPrice,
    stock: p.inventory?.[0]?.current_amount ?? p.current_inventory ?? 0,
    hasVariants: p.has_variants || false,
    variantParentId: p.variant_parent_id || null,
    variantName: p.variant_name || null,
    imageUrl: p.image_url || p.images?.[0]?.url || null
  };
}

function groupVariantProducts(products) {
  const parents = {};
  const standalone = [];

  for (const p of products) {
    if (p.variantParentId) {
      // This is a child variant
      if (!parents[p.variantParentId]) {
        parents[p.variantParentId] = {
          id: p.variantParentId,
          name: p.name?.replace(/ - .*$/, '') || p.name,
          brand: p.brand,
          type: p.type,
          imageUrl: p.imageUrl,
          retailPrice: p.retailPrice,
          teamPrice: p.teamPrice,
          hasVariants: true,
          totalStock: 0,
          variantCount: 0,
          description: p.description
        };
      }
      parents[p.variantParentId].totalStock += (p.stock || 0);
      parents[p.variantParentId].variantCount++;
      // Use lowest team price
      if (p.teamPrice < parents[p.variantParentId].teamPrice) {
        parents[p.variantParentId].teamPrice = p.teamPrice;
        parents[p.variantParentId].retailPrice = p.retailPrice;
      }
      if (!parents[p.variantParentId].imageUrl && p.imageUrl) {
        parents[p.variantParentId].imageUrl = p.imageUrl;
      }
    } else if (p.hasVariants) {
      // This is a parent product — use it as the card
      if (!parents[p.id]) {
        parents[p.id] = { ...p, totalStock: p.stock || 0, variantCount: 0 };
      } else {
        parents[p.id] = { ...parents[p.id], ...p, totalStock: parents[p.id].totalStock + (p.stock || 0) };
      }
    } else {
      standalone.push({ ...p, totalStock: p.stock || 0 });
    }
  }

  return [...Object.values(parents), ...standalone];
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
    let itemName = item.name || 'Product';
    if (item.variantName) itemName += ` - ${item.variantName}`;
    lineItems.push({
      price_data: { currency: 'usd', product_data: { name: itemName }, unit_amount: Math.round((item.teamPrice || item.price) * 100) },
      quantity: item.qty
    });
  }

  const origin = new URL(request.url).origin;
  const session = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
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
      id: generateId('ord'),
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
      lightspeedSaleId: null,
      lightspeedSyncFailed: false,
      notificationSent: false
    };

    // Try to create Lightspeed sale
    if (env.LIGHTSPEED_API_TOKEN) {
      try {
        const saleId = await createLightspeedSale(env, order);
        order.lightspeedSaleId = saleId;
      } catch (e) {
        console.error('Lightspeed sale creation failed:', e.message);
        order.lightspeedSyncFailed = true;
        order.lightspeedError = e.message;
      }
    }

    // Save order
    await env.STORE_DATA.put(`order:${order.id}`, JSON.stringify(order));
    const orderIds = await env.STORE_DATA.get('orders', 'json') || [];
    orderIds.unshift(order.id);
    await env.STORE_DATA.put('orders', JSON.stringify(orderIds));

    // Send notification email
    try {
      await sendOrderNotification(env, order);
      order.notificationSent = true;
      await env.STORE_DATA.put(`order:${order.id}`, JSON.stringify(order));
    } catch (e) {
      console.error('Notification email failed:', e.message);
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
// LIGHTSPEED SALE CREATION
// ============================================================
async function createLightspeedSale(env, order) {
  // Get register
  const registersData = await lsFetch(env, 'registers');
  const registers = registersData.registers || registersData.data || [];
  if (!registers.length) throw new Error('No registers found');
  const registerId = registers[0].id;

  // Get primary user
  const usersData = await lsFetch(env, 'users');
  const users = usersData.users || usersData.data || [];
  if (!users.length) throw new Error('No users found');
  const userId = users[0].id;

  // Find or create customer
  let customerId = null;
  if (order.customer.email) {
    try {
      const custSearch = await lsFetch(env, `customers?email=${encodeURIComponent(order.customer.email)}`);
      const customers = custSearch.customers || custSearch.data || [];
      if (customers.length > 0) {
        customerId = customers[0].id;
      }
    } catch (e) {
      console.error('Customer search failed:', e.message);
    }
  }

  if (!customerId && order.customer.email) {
    try {
      const nameParts = (order.customer.name || '').split(' ');
      const newCust = await lsFetch(env, 'customers', {
        method: 'POST',
        body: JSON.stringify({
          first_name: nameParts[0] || '',
          last_name: nameParts.slice(1).join(' ') || '',
          email: order.customer.email,
          phone: order.customer.phone || ''
        })
      });
      customerId = newCust.customer?.id || newCust.id;
    } catch (e) {
      console.error('Customer creation failed:', e.message);
    }
  }

  // Get a "layby/on account" payment type (or fallback)
  let paymentTypeId = null;
  try {
    const ptData = await lsFetch(env, 'payment_types');
    const paymentTypes = ptData.payment_types || ptData.data || [];
    const onAccount = paymentTypes.find(pt => pt.name?.toLowerCase().includes('account') || pt.name?.toLowerCase().includes('layby'));
    paymentTypeId = onAccount?.id || paymentTypes[0]?.id;
  } catch (e) {
    console.error('Payment types fetch failed:', e.message);
  }

  // Build sale products
  const saleProducts = order.items.map(item => ({
    product_id: item.lightspeedId || item.productId,
    quantity: item.qty,
    price: item.teamPrice || item.price,
    tax: 0
  }));

  // Build sale payload
  const salePayload = {
    register_id: registerId,
    user_id: userId,
    status: 'on_account',
    note: `TEAM ORDER - Paid via Stripe - ${order.customer.name} - ${order.customer.phone}`,
    register_sale_products: saleProducts
  };

  if (customerId) salePayload.customer_id = customerId;

  if (paymentTypeId) {
    salePayload.register_sale_payments = [{
      payment_type_id: paymentTypeId,
      amount: order.total
    }];
  }

  const saleResp = await lsFetch(env, 'register_sales', {
    method: 'POST',
    body: JSON.stringify(salePayload)
  });

  return saleResp.register_sale?.id || saleResp.id || 'unknown';
}

// ============================================================
// EMAIL NOTIFICATION
// ============================================================
async function sendOrderNotification(env, order) {
  const notifyEmail = env.NOTIFICATION_EMAIL || 'hello@icelabproshop.com';

  const itemRows = (order.items || []).map(item => {
    const name = item.name || 'Product';
    const variant = item.variantName ? ` - ${item.variantName}` : '';
    return `<tr><td style="padding:8px;border-bottom:1px solid #eee">${name}${variant}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${item.qty}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">$${((item.teamPrice || item.price || 0) * item.qty).toFixed(2)}</td></tr>`;
  }).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#4f46e5">New Team Store Order</h2>
      <p><strong>Order #:</strong> ${order.id.slice(-6).toUpperCase()}</p>
      <p><strong>Customer:</strong> ${order.customer?.name || 'N/A'}</p>
      <p><strong>Email:</strong> ${order.customer?.email || 'N/A'}</p>
      <p><strong>Phone:</strong> ${order.customer?.phone || 'N/A'}</p>
      ${order.lightspeedSaleId ? `<p><strong>Lightspeed Sale:</strong> ${order.lightspeedSaleId}</p>` : '<p style="color:#dc2626"><strong>Lightspeed sync failed - create sale manually</strong></p>'}
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead><tr style="background:#f8f9fa"><th style="padding:8px;text-align:left">Item</th><th style="padding:8px;text-align:center">Qty</th><th style="padding:8px;text-align:right">Total</th></tr></thead>
        <tbody>${itemRows}</tbody>
        <tfoot><tr><td colspan="2" style="padding:8px;font-weight:bold">Total</td><td style="padding:8px;text-align:right;font-weight:bold">$${(order.total || 0).toFixed(2)}</td></tr></tfoot>
      </table>
    </div>`;

  await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: notifyEmail }] }],
      from: { email: 'noreply@icelabproshop.com', name: 'Ice Lab Team Store' },
      subject: `New Team Order #${order.id.slice(-6).toUpperCase()} - ${order.customer?.name || 'Customer'}`,
      content: [{ type: 'text/html', value: html }]
    })
  });
}

// ============================================================
// ADMIN APIs
// ============================================================
async function apiAdminGetOrders(url, env) {
  const ids = await env.STORE_DATA.get('orders', 'json') || [];
  const orders = [];
  for (const id of ids) {
    const o = await env.STORE_DATA.get(`order:${id}`, 'json');
    if (o) orders.push(o);
  }
  return json(orders);
}

async function apiAdminEnabledProducts(env) {
  const cache = await env.STORE_DATA.get('ls_products_cache', 'json') || [];
  const enabled = [];
  for (const p of cache) {
    const tsConfig = await env.STORE_DATA.get(`ts_enabled:${p.id}`, 'json');
    if (tsConfig?.enabled) {
      enabled.push({
        id: p.id,
        name: p.name,
        brand: p.brand_name || p.supplier_name || '',
        sku: p.sku || '',
        retailPrice: parseFloat(p.price_including_tax || p.price || 0),
        teamPrice: tsConfig.teamPrice || 0,
        stock: p.inventory?.[0]?.current_amount ?? p.current_inventory ?? 0,
        imageUrl: p.image_url || p.images?.[0]?.url || null
      });
    }
  }
  return json(enabled);
}

async function apiAdminGetConfig(env) { return json(await getConfig(env)); }

async function apiAdminSaveConfig(request, env) {
  const data = await request.json();
  const existing = await getConfig(env);
  const config = { ...existing, ...data, updatedAt: new Date().toISOString() };
  await env.STORE_DATA.put('config', JSON.stringify(config));
  return json(config);
}

// ============================================================
// CRON SYNC
// ============================================================
async function cronSyncProducts(env) {
  if (!env.LIGHTSPEED_API_TOKEN) return;
  try {
    const products = await lsFetchAll(env, 'products?page_size=100');
    await env.STORE_DATA.put('ls_products_cache', JSON.stringify(products));
    await env.STORE_DATA.put('ls_sync_timestamp', new Date().toISOString());

    // Update enabled products
    for (const p of products) {
      const configKey = `ts_enabled:${p.id}`;
      const existing = await env.STORE_DATA.get(configKey, 'json');
      if (existing && existing.enabled) {
        existing.currentStock = p.inventory?.[0]?.current_amount ?? p.current_inventory ?? 0;
        existing.retailPrice = parseFloat(p.price_including_tax || p.price || 0);
        existing.name = p.name;
        existing.updatedAt = new Date().toISOString();
        await env.STORE_DATA.put(configKey, JSON.stringify(existing));
      }
    }
    console.log(`Cron sync complete: ${products.length} products synced at ${new Date().toISOString()}`);
  } catch (e) {
    console.error('Cron sync failed:', e.message);
  }
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
  settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  camera: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#c0c4cc" stroke-width="1.5"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>',
  menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
  store: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/></svg>',
  importIcon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
  sync: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>',
  link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

// ============================================================
// STOREFRONT PAGE
// ============================================================
function storePage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Ice Lab Team Store</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e;min-height:100vh}a{color:#4f46e5;text-decoration:none}
#pin-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}.pin-box{text-align:center;background:#fff;padding:48px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #e5e7eb}.pin-box h1{font-size:24px;font-weight:700;margin-bottom:4px;color:#1a1a2e}.pin-box p{color:#6b7280;margin-bottom:24px;font-size:14px}.pin-dots{display:flex;gap:12px;justify-content:center;margin-bottom:16px}.pin-dots input{width:48px;height:56px;text-align:center;font-size:22px;background:#fff;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;outline:none;transition:border 0.15s}.pin-dots input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.pin-error{color:#dc2626;font-size:13px;min-height:18px}
.sh{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,0.04)}.sh-brand{font-size:16px;font-weight:700;color:#1a1a2e;letter-spacing:0.5px;cursor:pointer}.cart-btn{position:relative;background:#fff;border:1px solid #e5e7eb;color:#1a1a2e;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;display:flex;align-items:center;gap:6px;transition:all 0.15s}.cart-btn:hover{border-color:#d1d5db;background:#f9fafb}.cart-badge{background:#4f46e5;color:#fff;font-size:11px;font-weight:700;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center}
.sc{max-width:1200px;margin:0 auto;padding:32px 24px}.st{font-size:20px;font-weight:700;margin-bottom:20px;color:#1a1a2e}
.cg{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:40px}.cc{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;cursor:pointer;transition:all 0.15s;text-align:center}.cc:hover{border-color:#d1d5db;box-shadow:0 1px 3px rgba(0,0,0,0.08);transform:translateY(-1px)}.cc h3{font-size:15px;font-weight:600;margin-bottom:4px;color:#1a1a2e}.cc p{font-size:13px;color:#6b7280}
.pg{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}.pc{background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;cursor:pointer;transition:all 0.15s}.pc:hover{box-shadow:0 4px 12px rgba(0,0,0,0.08);transform:translateY(-2px)}.pc-img{height:200px;background:#f0f1f3;display:flex;align-items:center;justify-content:center}.pc-img img{width:100%;height:100%;object-fit:cover}.pc-info{padding:14px 16px}.pc-info h3{font-size:14px;font-weight:600;margin-bottom:4px;color:#1a1a2e;line-height:1.3}.pc-brand{font-size:11px;color:#6b7280;margin-bottom:6px}.pc-price-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.pc-price{font-size:16px;font-weight:700;color:#1a1a2e}.pc-retail{font-size:12px;color:#9ca3af;text-decoration:line-through}.stock-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap}.stock-instock{background:#f0fdf4;color:#16a34a}.stock-order{background:#eff6ff;color:#2563eb}
.pd{background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.pd-layout{display:grid;grid-template-columns:400px 1fr;gap:40px}.pd-image{height:400px;background:#f0f1f3;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden}.pd-image img{width:100%;height:100%;object-fit:cover}.pd-info h2{font-size:22px;font-weight:700;margin-bottom:4px}.pd-brand{font-size:13px;color:#6b7280;margin-bottom:12px}.pd-info .price{font-size:24px;font-weight:700;color:#1a1a2e;margin-bottom:4px}.pd-info .retail-price{font-size:14px;color:#9ca3af;text-decoration:line-through;margin-bottom:16px}.pd-info .desc{color:#6b7280;margin-bottom:24px;line-height:1.6;font-size:14px}
.vg{margin-bottom:16px}.vg label{display:block;font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}.vg select{width:100%;padding:10px 12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:14px;cursor:pointer;transition:border 0.15s}.vg select:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.qty-row{display:flex;align-items:center;gap:12px;margin-bottom:20px}.qty-btn{width:36px;height:36px;border-radius:6px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s}.qty-btn:hover{background:#f9fafb}.qty-val{font-size:16px;font-weight:600;min-width:30px;text-align:center}
.stock-indicator{font-size:13px;padding:4px 10px;border-radius:4px;display:inline-block;margin-bottom:16px;font-weight:500}.si-green{background:#f0fdf4;color:#16a34a}.si-blue{background:#eff6ff;color:#2563eb}
.back-link{display:inline-flex;align-items:center;gap:4px;color:#6b7280;font-size:13px;margin-bottom:16px;cursor:pointer;font-weight:500;transition:color 0.15s}.back-link:hover{color:#1a1a2e}
.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;gap:6px}.btn-primary{background:#4f46e5;color:#fff}.btn-primary:hover{background:#4338ca}.btn-primary:disabled{background:#c7d2fe;color:#818cf8;cursor:not-allowed}.btn-full{width:100%}.btn-lg{padding:14px 24px;font-size:15px;font-weight:600}
.co{position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:200;display:none}.co.open{display:block}.cs{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:90vw;background:#fff;border-left:1px solid #e5e7eb;z-index:201;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.25s ease}.cs.open{transform:translateX(0)}.cs-header{padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between}.cs-header h2{font-size:16px;font-weight:600}.cs-close{background:none;border:none;color:#6b7280;cursor:pointer;padding:4px}.cs-close:hover{color:#1a1a2e}.cs-items{flex:1;overflow-y:auto;padding:16px 20px}.ci{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #f0f0f0}.ci-info{flex:1}.ci-info h4{font-size:14px;font-weight:600;margin-bottom:2px}.ci-info .opts{font-size:12px;color:#6b7280}.ci-info .ip{font-size:14px;color:#1a1a2e;font-weight:600;margin-top:4px}.ci-qty{display:flex;align-items:center;gap:6px}.ci-qty button{width:26px;height:26px;border-radius:4px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;cursor:pointer;font-size:13px;transition:all 0.15s}.ci-qty button:hover{background:#f9fafb}.ci-remove{background:none;border:none;color:#dc2626;font-size:12px;cursor:pointer;margin-top:4px;font-weight:500}.ci-remove:hover{text-decoration:underline}.cs-empty{text-align:center;color:#6b7280;padding:40px;font-size:14px}.cs-footer{padding:20px;border-top:1px solid #e5e7eb}.cs-total{display:flex;justify-content:space-between;font-size:16px;font-weight:700;margin-bottom:16px}
.co-form input{width:100%;padding:10px 12px;margin-bottom:8px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:14px;font-family:inherit;transition:border 0.15s}.co-form input:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.co-form input::placeholder{color:#9ca3af}
.toast{position:fixed;bottom:24px;right:24px;background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;z-index:300;transform:translateY(60px);opacity:0;transition:all 0.25s}.toast.show{transform:translateY(0);opacity:1}
.loading{text-align:center;padding:60px;color:#6b7280;font-size:14px}
@media(max-width:900px){.pg{grid-template-columns:repeat(2,1fr)}.pd-layout{grid-template-columns:1fr}}
@media(max-width:480px){.pg{grid-template-columns:1fr}.cg{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<div id="pin-screen"><div class="pin-box"><h1>Ice Lab Team Store</h1><p>Enter PIN to access the store</p><div class="pin-dots"><input type="tel" maxlength="1" autofocus><input type="tel" maxlength="1"><input type="tel" maxlength="1"><input type="tel" maxlength="1"></div><div class="pin-error" id="pin-error"></div></div></div>
<div id="store-app" style="display:none">
<header class="sh"><div class="sh-brand" onclick="showHome()">ICE LAB TEAM STORE</div><button class="cart-btn" onclick="toggleCart()">${ICONS.cart}<span id="cart-count" class="cart-badge">0</span></button></header>
<main class="sc" id="main-content"></main></div>
<div class="co" id="cart-overlay" onclick="toggleCart()"></div>
<div class="cs" id="cart-sidebar"><div class="cs-header"><h2>Your Cart</h2><button class="cs-close" onclick="toggleCart()">${ICONS.x}</button></div><div class="cs-items" id="cart-items"></div><div class="cs-footer" id="cart-footer"></div></div>
<div class="toast" id="toast"></div>
<script>
let categories=[],products=[],cart=JSON.parse(localStorage.getItem('icelab_cart')||'[]'),currentView='home',prevCategory=null;

const pinInputs=document.querySelectorAll('.pin-dots input');
pinInputs.forEach((inp,i)=>{inp.addEventListener('input',()=>{if(inp.value&&i<pinInputs.length-1)pinInputs[i+1].focus();if(i===pinInputs.length-1&&inp.value)checkPin()});inp.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!inp.value&&i>0)pinInputs[i-1].focus()})});
async function checkPin(){const pin=Array.from(pinInputs).map(i=>i.value).join('');if(pin.length<4)return;try{const r=await fetch('/api/verify-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){sessionStorage.setItem('store_pin',pin);document.getElementById('pin-screen').style.display='none';document.getElementById('store-app').style.display='';loadStore()}else{document.getElementById('pin-error').textContent='Invalid PIN';pinInputs.forEach(i=>i.value='');pinInputs[0].focus()}}catch(e){document.getElementById('pin-error').textContent='Connection error'}}
if(sessionStorage.getItem('store_pin')){document.getElementById('pin-screen').style.display='none';document.getElementById('store-app').style.display='';loadStore()}

async function loadStore(){
  document.getElementById('main-content').innerHTML='<div class="loading">Loading products...</div>';
  const[cr,pr]=await Promise.all([fetch('/api/categories'),fetch('/api/products')]);
  categories=await cr.json();
  products=await pr.json();
  updateCartCount();
  showHome();
}

function showHome(){
  currentView='home';prevCategory=null;
  const m=document.getElementById('main-content');
  let html='';
  if(categories.length>1){
    html+='<h2 class="st">Categories</h2><div class="cg">'+categories.map(c=>'<div class="cc" onclick="showCategory(\\''+esc(c.id)+'\\')"><h3>'+esc(c.name)+'</h3><p>'+c.count+' product'+(c.count!==1?'s':'')+'</p></div>').join('')+'</div>';
  }
  html+='<h2 class="st">All Products</h2>';
  if(products.length===0){html+='<div class="loading">No products available yet. Check back soon!</div>'}
  else{html+='<div class="pg">'+products.map(productCard).join('')+'</div>'}
  m.innerHTML=html;
}

function showCategory(catId){
  currentView='category';prevCategory=catId;
  const cat=categories.find(c=>c.id===catId);
  const filtered=products.filter(p=>p.type===catId);
  const m=document.getElementById('main-content');
  m.innerHTML='<a class="back-link" onclick="showHome()">${ICONS.back} All Categories</a><h2 class="st">'+esc(cat?.name||catId)+'</h2>'+(filtered.length?'<div class="pg">'+filtered.map(productCard).join('')+'</div>':'<p style="color:#6b7280">No products in this category yet.</p>');
}

function productCard(p){
  const stock=p.totalStock||p.stock||0;
  const stockBadge=stock>0?'<span class="stock-badge stock-instock">In Stock</span>':'<span class="stock-badge stock-order">Available to Order</span>';
  const img=p.imageUrl?'<img src="'+esc(p.imageUrl)+'">':'${ICONS.camera}';
  const teamPrice=p.teamPrice||p.price||0;
  const retailPrice=p.retailPrice||0;
  return '<div class="pc" onclick="showProduct(\\''+p.id+'\\')"><div class="pc-img">'+img+'</div><div class="pc-info">'+(p.brand?'<div class="pc-brand">'+esc(p.brand)+'</div>':'')+'<h3>'+esc(p.name)+'</h3><div class="pc-price-row"><div><span class="pc-price">$'+teamPrice.toFixed(2)+'</span>'+(retailPrice>teamPrice?' <span class="pc-retail">$'+retailPrice.toFixed(2)+'</span>':'')+'</div>'+stockBadge+'</div></div></div>';
}

async function showProduct(prodId){
  currentView='product';
  document.getElementById('main-content').innerHTML='<div class="loading">Loading...</div>';
  const r=await fetch('/api/product/'+prodId);
  if(!r.ok){showHome();return}
  const p=await r.json();
  window._currentProduct=p;
  window._pdQty=1;

  const img=p.imageUrl?'<img src="'+esc(p.imageUrl)+'">':'${ICONS.camera}';
  const stock=p.stock||0;
  const stockHtml=stock>0?'<span class="stock-indicator si-green">In Stock - Available Now</span>':'<span class="stock-indicator si-blue">Available to Order - 1-2 Weeks</span>';

  let variantHtml='';
  if(p.variants&&p.variants.length>0){
    variantHtml='<div class="vg"><label>Options</label><select id="variant-select" onchange="onVariantChange()"><option value="">Select an option</option>'+p.variants.map(v=>'<option value="'+v.id+'" data-stock="'+(v.stock||0)+'" data-team="'+(v.teamPrice||0)+'" data-retail="'+(v.retailPrice||0)+'">'+esc(v.name)+(v.stock>0?' (In Stock)':' (Available to Order)')+'</option>').join('')+'</select></div>';
  }

  const m=document.getElementById('main-content');
  m.innerHTML='<a class="back-link" onclick="goBack()">${ICONS.back} Back</a><div class="pd"><div class="pd-layout"><div class="pd-image">'+img+'</div><div class="pd-info"><h2>'+esc(p.name)+'</h2>'+(p.brand?'<div class="pd-brand">'+esc(p.brand)+'</div>':'')+'<div class="price" id="pd-price">$'+(p.teamPrice||0).toFixed(2)+'</div>'+(p.retailPrice>p.teamPrice?'<div class="retail-price" id="pd-retail">$'+p.retailPrice.toFixed(2)+'</div>':'')+'<p class="desc">'+esc(p.description)+'</p>'+variantHtml+'<div id="pd-stock-info">'+stockHtml+'</div><div class="qty-row"><span style="color:#6b7280;font-size:13px;font-weight:500">Qty</span><button class="qty-btn" onclick="changeQty(-1)">-</button><span class="qty-val" id="pd-qty">1</span><button class="qty-btn" onclick="changeQty(1)">+</button></div><button class="btn btn-primary btn-full btn-lg" id="btn-add" onclick="addToCart()"'+(p.variants&&p.variants.length?' disabled':'')+'>Add to Cart</button></div></div></div>';
}

function onVariantChange(){
  const sel=document.getElementById('variant-select');
  if(!sel)return;
  const opt=sel.options[sel.selectedIndex];
  const btn=document.getElementById('btn-add');
  if(!sel.value){btn.disabled=true;return}
  btn.disabled=false;
  const stock=parseInt(opt.dataset.stock)||0;
  const teamPrice=parseFloat(opt.dataset.team)||0;
  const retailPrice=parseFloat(opt.dataset.retail)||0;
  document.getElementById('pd-price').textContent='$'+teamPrice.toFixed(2);
  const retailEl=document.getElementById('pd-retail');
  if(retailEl){retailEl.textContent=retailPrice>teamPrice?'$'+retailPrice.toFixed(2):''}
  const si=document.getElementById('pd-stock-info');
  si.innerHTML=stock>0?'<span class="stock-indicator si-green">In Stock - Available Now</span>':'<span class="stock-indicator si-blue">Available to Order - 1-2 Weeks</span>';
}

function goBack(){if(currentView==='product'&&prevCategory)showCategory(prevCategory);else showHome()}
function changeQty(d){window._pdQty=Math.max(1,(window._pdQty||1)+d);document.getElementById('pd-qty').textContent=window._pdQty}

function addToCart(){
  const p=window._currentProduct;
  if(!p)return;
  const varSel=document.getElementById('variant-select');
  let selectedVariant=null;
  let teamPrice=p.teamPrice||0;
  let variantName='';
  let lightspeedId=p.id;

  if(varSel&&varSel.value){
    selectedVariant=p.variants.find(v=>v.id===varSel.value);
    if(selectedVariant){
      teamPrice=selectedVariant.teamPrice||teamPrice;
      variantName=selectedVariant.name||'';
      lightspeedId=selectedVariant.id;
    }
  }

  const ci={
    productId:p.id,
    lightspeedId:lightspeedId,
    name:p.name,
    variantName:variantName,
    teamPrice:teamPrice,
    price:teamPrice,
    qty:window._pdQty||1,
    imageUrl:p.imageUrl||null
  };
  const ei=cart.findIndex(c=>c.lightspeedId===ci.lightspeedId);
  if(ei>=0)cart[ei].qty+=ci.qty;
  else cart.push(ci);
  saveCart();
  showToast('Added to cart');
}

function saveCart(){localStorage.setItem('icelab_cart',JSON.stringify(cart));updateCartCount()}
function updateCartCount(){document.getElementById('cart-count').textContent=cart.reduce((s,i)=>s+i.qty,0)}
function toggleCart(){const o=document.getElementById('cart-overlay'),s=document.getElementById('cart-sidebar');if(s.classList.contains('open')){o.classList.remove('open');s.classList.remove('open')}else{renderCart();o.classList.add('open');s.classList.add('open')}}

function renderCart(){
  const ie=document.getElementById('cart-items'),fe=document.getElementById('cart-footer');
  if(!cart.length){ie.innerHTML='<div class="cs-empty">Your cart is empty</div>';fe.innerHTML='';return}
  ie.innerHTML=cart.map((c,i)=>{
    return '<div class="ci"><div class="ci-info"><h4>'+esc(c.name)+'</h4>'+(c.variantName?'<div class="opts">'+esc(c.variantName)+'</div>':'')+'<div class="ip">$'+(c.teamPrice*c.qty).toFixed(2)+'</div></div><div style="text-align:right"><div class="ci-qty"><button onclick="updateCartQty('+i+',-1)">-</button><span>'+c.qty+'</span><button onclick="updateCartQty('+i+',1)">+</button></div><button class="ci-remove" onclick="removeCartItem('+i+')">Remove</button></div></div>';
  }).join('');
  const total=cart.reduce((s,c)=>s+c.teamPrice*c.qty,0);
  fe.innerHTML='<div class="cs-total"><span>Total</span><span>$'+total.toFixed(2)+'</span></div><div class="co-form"><input type="text" id="co-name" placeholder="Full Name" value="'+esc(sessionStorage.getItem('co_name')||'')+'"><input type="email" id="co-email" placeholder="Email" value="'+esc(sessionStorage.getItem('co_email')||'')+'"><input type="tel" id="co-phone" placeholder="Phone" value="'+esc(sessionStorage.getItem('co_phone')||'')+'"><p style="font-size:12px;color:#6b7280;margin:8px 0">Local pickup only</p><button class="btn btn-primary btn-full" onclick="checkout()" id="checkout-btn">Checkout &middot; $'+total.toFixed(2)+'</button></div>';
}

function updateCartQty(i,d){cart[i].qty=Math.max(1,cart[i].qty+d);saveCart();renderCart()}
function removeCartItem(i){cart.splice(i,1);saveCart();renderCart()}

async function checkout(){
  const n=document.getElementById('co-name').value.trim(),e=document.getElementById('co-email').value.trim(),ph=document.getElementById('co-phone').value.trim();
  if(!n||!e||!ph){showToast('Please fill in all fields');return}
  sessionStorage.setItem('co_name',n);sessionStorage.setItem('co_email',e);sessionStorage.setItem('co_phone',ph);
  const btn=document.getElementById('checkout-btn');btn.disabled=true;btn.textContent='Processing...';
  try{
    const r=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:cart,customer:{name:n,email:e,phone:ph}})});
    const d=await r.json();
    if(d.url)window.location.href=d.url;
    else{showToast(d.error||'Checkout failed');btn.disabled=false;btn.textContent='Checkout'}
  }catch(err){showToast('Connection error');btn.disabled=false;btn.textContent='Checkout'}
}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
</script></body></html>`;
}

function checkoutSuccessPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Order Confirmed</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e}.rp{display:flex;align-items:center;justify-content:center;min-height:100vh}.rb{background:#fff;padding:48px;border-radius:12px;border:1px solid #e5e7eb;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.rb h2{font-size:22px;font-weight:700;margin:16px 0 8px;color:#1a1a2e}.rb p{color:#6b7280;margin-bottom:24px;font-size:14px;line-height:1.6}.ri{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;background:#f0fdf4;color:#16a34a}.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;background:#4f46e5;color:#fff;text-decoration:none;display:inline-block}</style></head><body><div class="rp"><div class="rb"><div class="ri">${ICONS.check}</div><h2>Order Confirmed</h2><p>Thanks for your order! We will have it ready for pickup at Ice Lab. You will receive a confirmation email shortly.</p><a href="/" class="btn">Continue Shopping</a></div></div><script>localStorage.removeItem('icelab_cart')</script></body></html>`;
}

function checkoutCancelPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Checkout Cancelled</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e}.rp{display:flex;align-items:center;justify-content:center;min-height:100vh}.rb{background:#fff;padding:48px;border-radius:12px;border:1px solid #e5e7eb;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.rb h2{font-size:22px;font-weight:700;margin:16px 0 8px}.rb p{color:#6b7280;margin-bottom:24px;font-size:14px}.ri{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;background:#f0f1f3;color:#6b7280}.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;background:#4f46e5;color:#fff;text-decoration:none;display:inline-block}</style></head><body><div class="rp"><div class="rb"><div class="ri">${ICONS.cart}</div><h2>Checkout Cancelled</h2><p>Your order was not completed. Your cart items are still saved.</p><a href="/" class="btn">Return to Store</a></div></div></body></html>`;
}

// ============================================================
// ADMIN PAGE
// ============================================================
function adminPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin - Ice Lab Team Store</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e;min-height:100vh}
#admin-pin-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}.pin-box{text-align:center;background:#fff;padding:48px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #e5e7eb}.pin-box h1{font-size:22px;font-weight:700;margin-bottom:4px;color:#1a1a2e}.pin-box p{color:#6b7280;margin-bottom:24px;font-size:14px}.pin-dots{display:flex;gap:12px;justify-content:center;margin-bottom:16px}.pin-dots input{width:48px;height:56px;text-align:center;font-size:22px;background:#fff;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;outline:none;transition:border 0.15s}.pin-dots input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.pin-error{color:#dc2626;font-size:13px;min-height:18px}
.admin-layout{display:flex;height:100vh}
.sidebar{width:220px;background:#fff;border-right:1px solid #e5e7eb;display:flex;flex-direction:column;flex-shrink:0}.sidebar-brand{padding:16px 20px;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:700;color:#1a1a2e;display:flex;align-items:center;gap:8px}.sidebar-brand .badge{background:#4f46e5;color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}.sidebar-nav{flex:1;padding:12px 0}.sidebar-nav button{width:100%;display:flex;align-items:center;gap:10px;padding:10px 20px;background:none;border:none;border-left:3px solid transparent;color:#6b7280;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s;font-family:inherit;text-align:left}.sidebar-nav button:hover{background:#f9fafb;color:#1a1a2e}.sidebar-nav button.active{border-left-color:#4f46e5;color:#1a1a2e;font-weight:600;background:#f5f3ff}.sidebar-footer{padding:12px 20px;border-top:1px solid #e5e7eb}.sidebar-footer a{display:flex;align-items:center;gap:6px;color:#6b7280;font-size:13px;text-decoration:none;font-weight:500}.sidebar-footer a:hover{color:#4f46e5}
.mobile-header{display:none;background:#fff;border-bottom:1px solid #e5e7eb;padding:12px 16px;align-items:center;justify-content:space-between}.mobile-header h1{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px}.mobile-header .badge{background:#4f46e5;color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}.hamburger{background:none;border:none;color:#1a1a2e;cursor:pointer;padding:4px}.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:300}
.admin-main{flex:1;overflow-y:auto;background:#f8f9fa;display:flex;flex-direction:column}
.admin-topbar{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 32px;height:52px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}.admin-topbar h2{font-size:16px;font-weight:600}.admin-topbar-actions{display:flex;align-items:center;gap:8px}.admin-topbar a{color:#4f46e5;font-size:13px;font-weight:500;text-decoration:none;display:flex;align-items:center;gap:4px}
.admin-content{padding:32px;flex:1;overflow-y:auto}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:24px}.card-header{padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between}.card-header h3{font-size:15px;font-weight:600}.card-body{padding:20px}
table{width:100%;border-collapse:collapse}th{padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;background:#f8f9fa;border-bottom:1px solid #e5e7eb}td{padding:10px 16px;font-size:13px;border-bottom:1px solid #f0f0f0;vertical-align:middle}tr:hover td{background:#f9fafb}
.prod-name{font-weight:600;font-size:13px;color:#1a1a2e}.prod-sku{font-size:11px;color:#6b7280;margin-top:1px}.prod-thumb{width:40px;height:40px;border-radius:4px;background:#f0f1f3;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}.prod-thumb img{width:100%;height:100%;object-fit:cover}.prod-thumb svg{width:16px;height:16px}.prod-cell{display:flex;align-items:center;gap:10px}
.btn{padding:8px 16px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit}.btn-primary{background:#4f46e5;color:#fff}.btn-primary:hover{background:#4338ca}.btn-outline{background:#fff;border:1px solid #d1d5db;color:#374151}.btn-outline:hover{background:#f9fafb}.btn-sm{padding:6px 12px;font-size:12px}.btn-success{background:#16a34a;color:#fff}.btn-success:hover{background:#15803d}.btn-ghost{background:none;border:none;color:#4f46e5;font-weight:500;cursor:pointer;font-size:13px;font-family:inherit;padding:0}.btn-ghost:hover{text-decoration:underline}
.toggle{position:relative;width:36px;height:20px;display:inline-block}.toggle input{opacity:0;width:0;height:0}.toggle-slider{position:absolute;cursor:pointer;inset:0;background:#d1d5db;border-radius:20px;transition:0.15s}.toggle-slider:before{content:'';position:absolute;height:16px;width:16px;left:2px;bottom:2px;background:#fff;border-radius:50%;transition:0.15s}.toggle input:checked+.toggle-slider{background:#4f46e5}.toggle input:checked+.toggle-slider:before{transform:translateX(16px)}
.fg{margin-bottom:14px}.fg label{display:block;font-size:12px;color:#374151;margin-bottom:4px;font-weight:600}.fg input,.fg textarea,.fg select{width:100%;padding:8px 12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:13px;font-family:inherit;transition:border 0.15s}.fg input:focus,.fg textarea:focus,.fg select:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.fg-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.settings-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:24px;margin-bottom:20px}.settings-card h3{font-size:14px;font-weight:600;margin-bottom:16px;color:#1a1a2e}
.empty-state{text-align:center;color:#6b7280;padding:40px;font-size:14px}
.badge-status{padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;display:inline-block}.badge-success{background:#f0fdf4;color:#16a34a}.badge-warning{background:#fffbeb;color:#d97706}.badge-error{background:#fef2f2;color:#dc2626}.badge-info{background:#eff6ff;color:#2563eb}
.search-bar{background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.search-input{flex:1;position:relative;min-width:200px}.search-input input{width:100%;padding:8px 12px 8px 32px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#1a1a2e;background:#fff;font-family:inherit;transition:border 0.15s}.search-input input:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.search-input input::placeholder{color:#9ca3af}.search-input .search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#9ca3af;display:flex}
.filter-select{padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#1a1a2e;background:#fff;font-family:inherit;cursor:pointer}
.sync-info{display:flex;align-items:center;gap:8px;font-size:12px;color:#6b7280;padding:12px 20px;border-bottom:1px solid #f0f0f0;background:#f8f9fa}
.price-input{width:80px;padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;color:#1a1a2e;background:#fff;text-align:right}
.price-input:focus{border-color:#4f46e5;outline:none}
.toast{position:fixed;bottom:24px;right:24px;background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;z-index:600;transform:translateY(60px);opacity:0;transition:all 0.25s}.toast.show{transform:translateY(0);opacity:1}
.stat-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px}.stat-card .label{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-weight:600;margin-bottom:4px}.stat-card .value{font-size:22px;font-weight:700;color:#1a1a2e}
.od-info{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;padding:20px 24px;border-bottom:1px solid #e5e7eb}.od-info-item label{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-weight:600;display:block;margin-bottom:2px}.od-info-item span{font-size:14px;color:#1a1a2e;font-weight:500}
.back-link{display:inline-flex;align-items:center;gap:4px;color:#6b7280;font-size:13px;cursor:pointer;font-weight:500;margin-bottom:16px;transition:color 0.15s}.back-link:hover{color:#1a1a2e}
@media(max-width:768px){.sidebar{display:none;position:fixed;top:0;left:0;bottom:0;z-index:301;box-shadow:4px 0 12px rgba(0,0,0,0.1)}.sidebar.open{display:flex}.sidebar-overlay.open{display:block}.mobile-header{display:flex}.admin-content{padding:16px}.admin-topbar{padding:0 16px}.od-info{grid-template-columns:1fr}.fg-row{grid-template-columns:1fr}.stat-cards{grid-template-columns:1fr 1fr}}
</style></head><body>
<div id="admin-pin-screen"><div class="pin-box"><h1>Admin Access</h1><p>Enter admin PIN</p><div class="pin-dots"><input type="tel" maxlength="1" autofocus><input type="tel" maxlength="1"><input type="tel" maxlength="1"><input type="tel" maxlength="1"></div><div class="pin-error" id="pin-error"></div></div></div>
<div id="admin-app" style="display:none">
<div class="mobile-header"><button class="hamburger" onclick="toggleSidebar()">${ICONS.menu}</button><h1>Ice Lab Team Store <span class="badge">Admin</span></h1><a href="/">${ICONS.store}</a></div>
<div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
<div class="admin-layout">
<aside class="sidebar" id="sidebar"><div class="sidebar-brand">Ice Lab Team Store <span class="badge">Admin</span></div><nav class="sidebar-nav">
<button class="active" onclick="showTab('import')" data-tab="import">${ICONS.importIcon} Import Products</button>
<button onclick="showTab('products')" data-tab="products">${ICONS.products} Products</button>
<button onclick="showTab('orders')" data-tab="orders">${ICONS.orders} Recent Orders</button>
<button onclick="showTab('settings')" data-tab="settings">${ICONS.settings} Settings</button>
</nav><div class="sidebar-footer"><a href="/">${ICONS.store} View Store</a></div></aside>
<div class="admin-main">
<div class="admin-topbar" id="admin-topbar"><h2 id="topbar-title">Import Products</h2><div class="admin-topbar-actions" id="topbar-actions"><a href="/">${ICONS.store} View Store</a></div></div>
<div class="admin-content" id="admin-content"></div>
</div></div></div>
<div class="toast" id="toast"></div>
<script>
let importProducts=[],enabledProducts=[],adminOrders=[],currentTab='import',searchQuery='',brandFilter='',showEnabledOnly=false;
let syncTimestamp=null,discountPercent=15;
const IC=${JSON.stringify(ICONS)};

// PIN
const pinInputs=document.querySelectorAll('.pin-dots input');
pinInputs.forEach((inp,i)=>{inp.addEventListener('input',()=>{if(inp.value&&i<pinInputs.length-1)pinInputs[i+1].focus();if(i===pinInputs.length-1&&inp.value)checkAdminPin()});inp.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!inp.value&&i>0)pinInputs[i-1].focus()})});
async function checkAdminPin(){const pin=Array.from(pinInputs).map(i=>i.value).join('');if(pin.length<4)return;try{const r=await fetch('/api/verify-admin-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){sessionStorage.setItem('admin_pin',pin);document.getElementById('admin-pin-screen').style.display='none';document.getElementById('admin-app').style.display='';loadAdmin()}else{document.getElementById('pin-error').textContent='Invalid PIN';pinInputs.forEach(i=>i.value='');pinInputs[0].focus()}}catch(e){document.getElementById('pin-error').textContent='Connection error'}}
if(sessionStorage.getItem('admin_pin')){document.getElementById('admin-pin-screen').style.display='none';document.getElementById('admin-app').style.display='';loadAdmin()}

function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('sidebar-overlay').classList.toggle('open')}

async function loadAdmin(){showTab(currentTab)}

function showTab(tab){
  currentTab=tab;
  document.querySelectorAll('.sidebar-nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  if(tab==='import')renderImport();
  else if(tab==='products')renderProducts();
  else if(tab==='orders')renderOrders();
  else if(tab==='settings')renderSettings();
}

function setTopbar(title,actions){document.getElementById('topbar-title').textContent=title;document.getElementById('topbar-actions').innerHTML=actions||'<a href="/">${ICONS.store} View Store</a>'}

// ============ IMPORT PRODUCTS ============
async function renderImport(){
  setTopbar('Import Products','<a href="/">${ICONS.store} View Store</a>');
  const c=document.getElementById('admin-content');
  c.innerHTML='<div class="empty-state">Loading products from Lightspeed...</div>';

  try{
    const r=await fetch('/api/admin/import-products');
    const data=await r.json();
    importProducts=data.products||[];
    syncTimestamp=data.syncTimestamp;
    discountPercent=data.discountPercent||15;
    renderImportTable();
  }catch(e){
    c.innerHTML='<div class="settings-card"><h3>Lightspeed Connection</h3><p style="color:#6b7280;margin-bottom:16px">No products synced yet. Click the button below to sync products from Lightspeed.</p><button class="btn btn-primary" onclick="syncProducts()">Sync Products from Lightspeed</button></div>';
  }
}

function renderImportTable(){
  const c=document.getElementById('admin-content');

  // Group variants by parent
  const parentMap={};
  const standalone=[];
  for(const p of importProducts){
    if(p.variantParentId){
      if(!parentMap[p.variantParentId])parentMap[p.variantParentId]={parent:null,children:[]};
      parentMap[p.variantParentId].children.push(p);
    }else if(p.hasVariants){
      if(!parentMap[p.id])parentMap[p.id]={parent:p,children:[]};
      else parentMap[p.id].parent=p;
    }else{
      standalone.push(p);
    }
  }

  // Build display list (parents + standalone)
  let displayList=[];
  for(const[id,group] of Object.entries(parentMap)){
    const parent=group.parent||group.children[0];
    const totalStock=group.children.reduce((s,c)=>s+(c.stock||0),0)+(parent?.stock||0);
    const anyEnabled=group.children.some(c=>c.enabled)||(parent?.enabled||false);
    displayList.push({
      ...parent,
      id:id,
      stock:totalStock,
      variantCount:group.children.length,
      enabled:anyEnabled,
      children:group.children,
      isGroup:true
    });
  }
  for(const p of standalone){
    displayList.push({...p,isGroup:false,children:[]});
  }

  // Get brands for filter
  const brands=[...new Set(displayList.map(p=>p.brand).filter(Boolean))].sort();

  // Filter
  let filtered=displayList;
  if(searchQuery){const q=searchQuery.toLowerCase();filtered=filtered.filter(p=>p.name?.toLowerCase().includes(q)||p.sku?.toLowerCase().includes(q)||p.brand?.toLowerCase().includes(q))}
  if(brandFilter)filtered=filtered.filter(p=>p.brand===brandFilter);
  if(showEnabledOnly)filtered=filtered.filter(p=>p.enabled);

  const enabledCount=displayList.filter(p=>p.enabled).length;

  c.innerHTML=
    '<div class="stat-cards">'+
      '<div class="stat-card"><div class="label">Total Products</div><div class="value">'+displayList.length+'</div></div>'+
      '<div class="stat-card"><div class="label">Enabled in Store</div><div class="value">'+enabledCount+'</div></div>'+
      '<div class="stat-card"><div class="label">Discount</div><div class="value">'+discountPercent+'%</div></div>'+
      '<div class="stat-card"><div class="label">Last Sync</div><div class="value" style="font-size:13px">'+(syncTimestamp?new Date(syncTimestamp).toLocaleString():'Never')+'</div></div>'+
    '</div>'+
    '<div class="card">'+
      '<div class="card-header"><h3>Lightspeed Products</h3><button class="btn btn-primary btn-sm" onclick="syncProducts()" id="sync-btn">${ICONS.sync} Sync from Lightspeed</button></div>'+
      '<div class="search-bar">'+
        '<div class="search-input"><span class="search-icon">${ICONS.search}</span><input id="import-search" placeholder="Search by name, SKU, brand..." value="'+esc(searchQuery)+'" oninput="searchQuery=this.value;renderImportTable()"></div>'+
        '<select class="filter-select" onchange="brandFilter=this.value;renderImportTable()"><option value="">All Brands</option>'+brands.map(b=>'<option value="'+esc(b)+'"'+(brandFilter===b?' selected':'')+'>'+esc(b)+'</option>').join('')+'</select>'+
        '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6b7280;cursor:pointer;white-space:nowrap"><input type="checkbox" '+(showEnabledOnly?'checked':'')+' onchange="showEnabledOnly=this.checked;renderImportTable()" style="accent-color:#4f46e5"> Enabled only</label>'+
      '</div>'+
      (filtered.length===0?'<div class="empty-state">'+(importProducts.length===0?'No products synced. Click "Sync from Lightspeed" to load products.':'No products match your search.')+'</div>':
      '<table><thead><tr><th style="width:50px">Show</th><th>Product</th><th>Brand</th><th>Variants</th><th>Stock</th><th>Retail Price</th><th>Team Price</th></tr></thead><tbody>'+
      filtered.map(p=>{
        const thumb=p.imageUrl?'<img src="'+esc(p.imageUrl)+'" style="width:32px;height:32px;border-radius:4px;object-fit:cover">':'<div style="width:32px;height:32px;background:#f0f1f3;border-radius:4px;display:flex;align-items:center;justify-content:center"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c0c4cc" stroke-width="1.5"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg></div>';
        const teamPrice=p.teamPrice||Math.round(p.retailPrice*(1-discountPercent/100)*100)/100;
        return '<tr>'+
          '<td><label class="toggle"><input type="checkbox" '+(p.enabled?'checked':'')+' onchange="toggleProduct(\\''+p.id+'\\',this.checked)"><span class="toggle-slider"></span></label></td>'+
          '<td><div class="prod-cell">'+thumb+'<div><div class="prod-name">'+esc(p.name)+'</div><div class="prod-sku">'+esc(p.sku||'')+'</div></div></div></td>'+
          '<td style="color:#6b7280">'+esc(p.brand||'-')+'</td>'+
          '<td>'+(p.variantCount||0)+'</td>'+
          '<td>'+(p.stock||0)+'</td>'+
          '<td>$'+(p.retailPrice||0).toFixed(2)+'</td>'+
          '<td><input type="number" step="0.01" class="price-input" value="'+teamPrice.toFixed(2)+'" onchange="updateTeamPrice(\\''+p.id+'\\',this.value)" '+(p.enabled?'':'disabled')+' id="price-'+p.id+'"></td>'+
        '</tr>';
      }).join('')+'</tbody></table>')+
    '</div>';
}

async function syncProducts(){
  const btn=document.getElementById('sync-btn');
  if(btn){btn.disabled=true;btn.innerHTML='Syncing...';}
  try{
    const r=await fetch('/api/admin/lightspeed/sync');
    const data=await r.json();
    if(data.success){
      showToast('Synced '+data.totalProducts+' products from Lightspeed');
      renderImport();
    }else{
      showToast('Sync failed: '+(data.error||'Unknown error'));
    }
  }catch(e){showToast('Sync failed: '+e.message)}
  finally{if(btn){btn.disabled=false;btn.innerHTML=IC.sync+' Sync from Lightspeed'}}
}

async function toggleProduct(productId,enabled){
  try{
    // If this is a group (parent with variants), toggle all children too
    const parent=importProducts.find(p=>p.id===productId);
    const children=importProducts.filter(p=>p.variantParentId===productId);

    // Toggle parent
    await fetch('/api/admin/lightspeed/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId,enabled})});

    // Toggle all children
    for(const child of children){
      await fetch('/api/admin/lightspeed/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:child.id,enabled})});
    }

    // Update local state
    const updateLocal=(id)=>{const p=importProducts.find(x=>x.id===id);if(p)p.enabled=enabled};
    updateLocal(productId);
    children.forEach(c=>updateLocal(c.id));

    // Enable/disable price input
    const priceInput=document.getElementById('price-'+productId);
    if(priceInput)priceInput.disabled=!enabled;

    showToast(enabled?'Product enabled in team store':'Product removed from team store');
  }catch(e){showToast('Error: '+e.message)}
}

async function updateTeamPrice(productId,value){
  const price=parseFloat(value);
  if(isNaN(price)||price<0){showToast('Invalid price');return}
  try{
    // Update parent
    await fetch('/api/admin/lightspeed/price',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId,teamPrice:price})});

    // Also update children
    const children=importProducts.filter(p=>p.variantParentId===productId);
    for(const child of children){
      if(child.enabled){
        await fetch('/api/admin/lightspeed/price',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:child.id,teamPrice:price})});
      }
    }

    showToast('Team price updated');
  }catch(e){showToast('Error: '+e.message)}
}

// ============ PRODUCTS (enabled list) ============
async function renderProducts(){
  setTopbar('Enabled Products');
  const c=document.getElementById('admin-content');
  c.innerHTML='<div class="empty-state">Loading...</div>';
  try{
    const r=await fetch('/api/admin/enabled-products');
    enabledProducts=await r.json();
    c.innerHTML='<div class="card"><div class="card-header"><h3>Team Store Products</h3><span style="font-size:12px;color:#6b7280">'+enabledProducts.length+' product(s) enabled</span></div>'+
      (enabledProducts.length===0?'<div class="empty-state">No products enabled yet. Go to Import Products to add products from Lightspeed.</div>':
      '<table><thead><tr><th>Product</th><th>Brand</th><th>SKU</th><th>Retail</th><th>Team Price</th><th>Stock</th></tr></thead><tbody>'+
      enabledProducts.map(p=>{
        const thumb=p.imageUrl?'<img src="'+esc(p.imageUrl)+'" style="width:32px;height:32px;border-radius:4px;object-fit:cover">':'';
        return '<tr><td><div class="prod-cell">'+(thumb||'')+'<div class="prod-name">'+esc(p.name)+'</div></div></td><td style="color:#6b7280">'+esc(p.brand||'-')+'</td><td style="color:#6b7280;font-size:11px">'+esc(p.sku||'-')+'</td><td>$'+(p.retailPrice||0).toFixed(2)+'</td><td style="font-weight:600;color:#16a34a">$'+(p.teamPrice||0).toFixed(2)+'</td><td>'+(p.stock||0)+'</td></tr>';
      }).join('')+'</tbody></table>')+
    '</div>';
  }catch(e){c.innerHTML='<div class="empty-state">Error loading products</div>'}
}

// ============ ORDERS ============
async function renderOrders(detailId){
  setTopbar('Recent Orders');
  const c=document.getElementById('admin-content');
  c.innerHTML='<div class="empty-state">Loading...</div>';
  try{
    const r=await fetch('/api/admin/orders');
    adminOrders=await r.json();
  }catch(e){adminOrders=[]}

  if(detailId)return renderOrderDetail(detailId);

  const c2=document.getElementById('admin-content');
  c2.innerHTML='<div class="card"><div class="card-header"><h3>Recent Orders</h3><span style="font-size:12px;color:#6b7280">Manage fulfillment in Lightspeed POS</span></div>'+
    (adminOrders.length===0?'<div class="empty-state">No orders yet</div>':
    '<table><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Items</th><th>Total</th><th>Lightspeed</th></tr></thead><tbody>'+
    adminOrders.map(o=>{
      const d=new Date(o.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
      const ic=(o.items||[]).reduce((s,i)=>s+(i.qty||1),0);
      const lsStatus=o.lightspeedSaleId?'<span class="badge-status badge-success">Synced</span>':(o.lightspeedSyncFailed?'<span class="badge-status badge-error">Failed</span>':'<span class="badge-status badge-warning">Pending</span>');
      return '<tr style="cursor:pointer" onclick="renderOrders(\\''+o.id+'\\')"><td style="font-weight:600;color:#4f46e5">#'+o.id.slice(-6).toUpperCase()+'</td><td>'+esc(o.customer?.name||'-')+'</td><td style="color:#6b7280">'+d+'</td><td>'+ic+'</td><td style="font-weight:600">$'+(o.total||0).toFixed(2)+'</td><td>'+lsStatus+'</td></tr>';
    }).join('')+'</tbody></table>')+
  '</div>';
}

function renderOrderDetail(orderId){
  const o=adminOrders.find(x=>x.id===orderId);
  if(!o)return;
  setTopbar('Order #'+o.id.slice(-6).toUpperCase());
  const c=document.getElementById('admin-content');
  const d=new Date(o.createdAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
  c.innerHTML='<a class="back-link" onclick="renderOrders()">${ICONS.back} Back to Orders</a>'+
    '<div class="card"><div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between"><span style="font-size:18px;font-weight:700">#'+o.id.slice(-6).toUpperCase()+'</span>'+
    (o.lightspeedSaleId?'<span class="badge-status badge-success">Synced to Lightspeed</span>':(o.lightspeedSyncFailed?'<span class="badge-status badge-error">Lightspeed sync failed</span>':'<span class="badge-status badge-warning">Processing</span>'))+
    '</div>'+
    '<div class="od-info"><div class="od-info-item"><label>Customer</label><span>'+esc(o.customer?.name||'-')+'</span></div><div class="od-info-item"><label>Email</label><span>'+esc(o.customer?.email||'-')+'</span></div><div class="od-info-item"><label>Phone</label><span>'+esc(o.customer?.phone||'-')+'</span></div></div>'+
    '<div class="od-info"><div class="od-info-item"><label>Order Date</label><span>'+d+'</span></div><div class="od-info-item"><label>Lightspeed Sale</label><span style="font-size:12px;color:#6b7280">'+(o.lightspeedSaleId||'N/A')+'</span></div><div class="od-info-item"><label>Stripe PI</label><span style="font-size:12px;color:#6b7280">'+(o.stripePaymentIntent||'-')+'</span></div></div>'+
    '<div style="padding:0 24px"><table><thead><tr><th>Product</th><th>Variant</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>'+
    (o.items||[]).map(item=>'<tr><td style="font-weight:500">'+esc(item.name||'Product')+'</td><td style="color:#6b7280;font-size:12px">'+esc(item.variantName||'-')+'</td><td>'+item.qty+'</td><td>$'+((item.teamPrice||item.price||0)).toFixed(2)+'</td><td style="font-weight:600">$'+((item.teamPrice||item.price||0)*item.qty).toFixed(2)+'</td></tr>').join('')+
    '</tbody></table></div>'+
    '<div style="padding:16px 24px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:24px;font-weight:600"><span>Total</span><span style="font-size:18px">$'+(o.total||0).toFixed(2)+'</span></div>'+
    '<div style="padding:16px 24px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px">Manage order fulfillment in Lightspeed POS</div>'+
  '</div>';
}

// ============ SETTINGS ============
function renderSettings(){
  setTopbar('Settings');
  const c=document.getElementById('admin-content');
  c.innerHTML='<div id="settings-content">Loading...</div>';
  loadSettings();
}

async function loadSettings(){
  const r=await fetch('/api/admin/config');
  const config=await r.json();
  document.getElementById('settings-content').innerHTML=
    '<div class="settings-card"><h3>Store Configuration</h3>'+
      '<div class="fg"><label>Store Name</label><input id="sf-name" value="'+esc(config.storeName||'')+'"></div>'+
      '<div class="fg-row"><div class="fg"><label>Store PIN (customer access)</label><input id="sf-pin" value="'+esc(config.storePin||'')+'"></div><div class="fg"><label>Admin PIN</label><input id="sf-admin-pin" value="'+esc(config.adminPin||'')+'"></div></div>'+
      '<button class="btn btn-primary" onclick="saveSettings(\\'store\\')">Save Store Settings</button>'+
    '</div>'+

    '<div class="settings-card"><h3>Lightspeed Integration</h3>'+
      '<div class="fg"><label>Team Discount %</label><input id="sf-discount" type="number" value="'+(config.discountPercent||15)+'" min="0" max="100"></div>'+
      '<div style="display:flex;gap:8px;margin-bottom:16px"><button class="btn btn-outline btn-sm" onclick="testLightspeed()" id="test-ls-btn">${ICONS.link} Test Connection</button><button class="btn btn-primary btn-sm" onclick="syncProducts()" id="sync-ls-btn">${ICONS.sync} Sync Products</button></div>'+
      '<div id="ls-test-result"></div>'+
      '<p style="font-size:12px;color:#6b7280;margin-top:8px">API token and domain prefix are set via wrangler secrets (LIGHTSPEED_API_TOKEN, LIGHTSPEED_DOMAIN_PREFIX).</p>'+
      '<p style="font-size:12px;color:#6b7280;margin-top:4px">Last sync: '+(syncTimestamp?new Date(syncTimestamp).toLocaleString():'Never')+'</p>'+
      '<p style="font-size:12px;color:#6b7280;margin-top:4px">Auto-sync runs every 30 minutes via cron trigger.</p>'+
      '<button class="btn btn-primary" onclick="saveSettings(\\'lightspeed\\')">Save Lightspeed Settings</button>'+
    '</div>'+

    '<div class="settings-card"><h3>Payment Configuration</h3>'+
      '<div class="fg"><label>Stripe Publishable Key</label><input id="sf-stripe-pk" value="'+esc(config.stripePublishableKey||'')+'"></div>'+
      '<div class="fg"><label>Stripe Secret Key</label><input id="sf-stripe-sk" type="password" value="'+esc(config.stripeSecretKey||'')+'"></div>'+
      '<div class="fg"><label>Stripe Webhook Secret</label><input id="sf-stripe-wh" type="password" value="'+esc(config.stripeWebhookSecret||'')+'"></div>'+
      '<button class="btn btn-primary" onclick="saveSettings(\\'payment\\')">Save Payment Settings</button>'+
    '</div>';
}

async function testLightspeed(){
  const btn=document.getElementById('test-ls-btn');
  const result=document.getElementById('ls-test-result');
  btn.disabled=true;btn.textContent='Testing...';
  try{
    const r=await fetch('/api/admin/lightspeed/test');
    const data=await r.json();
    if(data.success){result.innerHTML='<span class="badge-status badge-success">'+esc(data.message)+'</span>'}
    else{result.innerHTML='<span class="badge-status badge-error">'+esc(data.error)+'</span>'}
  }catch(e){result.innerHTML='<span class="badge-status badge-error">Connection error</span>'}
  finally{btn.disabled=false;btn.innerHTML=IC.link+' Test Connection'}
}

async function saveSettings(section){
  let config={};
  if(section==='store'){
    config={storeName:document.getElementById('sf-name').value.trim(),storePin:document.getElementById('sf-pin').value.trim(),adminPin:document.getElementById('sf-admin-pin').value.trim()};
  }else if(section==='lightspeed'){
    config={discountPercent:parseInt(document.getElementById('sf-discount').value)||15};
  }else{
    config={stripePublishableKey:document.getElementById('sf-stripe-pk').value.trim(),stripeSecretKey:document.getElementById('sf-stripe-sk').value.trim(),stripeWebhookSecret:document.getElementById('sf-stripe-wh').value.trim()};
  }
  await fetch('/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
  showToast('Settings saved');
}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
</script></body></html>`;
}
