// Ice Lab Team Store — Cloudflare Worker
// Price Book Based Team Catalogs with Lightspeed Retail X-Series POS Integration

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    // --- API Routes ---
    if (path.startsWith('/api/')) {
      try {
        if (path === '/api/verify-pin' && method === 'POST') return apiVerifyPin(request, env);
        if (path === '/api/verify-admin-pin' && method === 'POST') return apiVerifyAdminPin(request, env);
        if (path === '/api/teams' && method === 'GET') return apiGetTeams(env);
        if (path === '/api/products' && method === 'GET') return apiGetProducts(url, env);
        if (path.match(/^\/api\/product\/[^/]+$/) && method === 'GET') return apiGetProduct(url, path.split('/')[3], env);
        if (path === '/api/checkout' && method === 'POST') return apiCheckout(request, env);
        if (path === '/api/stripe/webhook' && method === 'POST') return apiStripeWebhook(request, env);
        if (path === '/api/admin/lightspeed/test' && method === 'GET') return apiLightspeedTest(env);
        if (path === '/api/admin/lightspeed/sync' && method === 'POST') return apiLightspeedSyncTeam(request, env);
        if (path === '/api/admin/lightspeed/sync-all' && method === 'POST') return apiLightspeedSyncAll(env);
        if (path === '/api/admin/import-products' && method === 'GET') return apiImportProducts(url, env);
        if (path === '/api/admin/orders' && method === 'GET') return apiAdminGetOrders(env);
        if (path === '/api/admin/products' && method === 'GET') return apiAdminAllProducts(env);
        if (path === '/api/admin/config' && method === 'GET') return apiAdminGetConfig(env);
        if (path === '/api/admin/config' && method === 'POST') return apiAdminSaveConfig(request, env);
        if (path === '/api/admin/teams' && method === 'GET') return apiAdminGetTeams(env);
        if (path === '/api/admin/teams' && method === 'POST') return apiAdminSaveTeams(request, env);
        if (path === '/api/admin/test-order' && method === 'POST') return apiTestOrder(request, env);
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
    ctx.waitUntil(cronSyncAllTeams(env));
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
  return config || { storeName: 'Ice Lab Team Store', adminPin: '9999', stripePublishableKey: '', stripeSecretKey: '', stripeWebhookSecret: '' };
}
async function getTeams(env) {
  const teams = await env.STORE_DATA.get('store:teams', 'json');
  return teams || [];
}
function lsApi(env) {
  const prefix = env.LIGHTSPEED_DOMAIN_PREFIX || 'icelabproshop';
  return `https://${prefix}.retail.lightspeed.app/api/2.0`;
}
function lsApiLegacy(env) {
  const prefix = env.LIGHTSPEED_DOMAIN_PREFIX || 'icelabproshop';
  return `https://${prefix}.retail.lightspeed.app/api`;
}
async function lsFetchLegacy(env, endpoint, options = {}) {
  const url = `${lsApiLegacy(env)}/${endpoint}`;
  const resp = await fetch(url, { headers: lsHeaders(env), ...options });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Lightspeed API error ${resp.status}: ${text}`);
  }
  return resp.json();
}
function lsHeaders(env) {
  return { 'Authorization': `Bearer ${env.LIGHTSPEED_API_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

// ============================================================
// LIGHTSPEED API HELPERS
// ============================================================
async function lsFetchAll(env, endpoint) {
  let all = [];
  let after = 0;
  let pages = 0;
  const seen = new Set();
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
    if (key) {
      // Deduplicate by id or product_id
      for (const item of data[key]) {
        const uid = item.product_id || item.id;
        if (!seen.has(uid)) { seen.add(uid); all.push(item); }
      }
    }
    if (data.version && data.version.max && data.version.max > after) {
      after = data.version.max;
      pages++;
    } else break;
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
// PIN VERIFICATION — Multi-team
// ============================================================
async function apiVerifyPin(request, env) {
  const { pin } = await request.json();
  const teams = await getTeams(env);
  const team = teams.find(t => t.pin === pin && t.enabled);
  if (team) {
    return json({ success: true, team: { name: team.name, slug: team.slug, priceBookId: team.priceBookId, logoUrl: team.logoUrl || '' } });
  }
  return json({ error: 'Invalid PIN' }, 401);
}

async function apiVerifyAdminPin(request, env) {
  const { pin } = await request.json();
  const config = await getConfig(env);
  if (pin === config.adminPin) return json({ success: true });
  return json({ error: 'Invalid PIN' }, 401);
}

// ============================================================
// TEAMS API (public — for showing team name on PIN page)
// ============================================================
async function apiGetTeams(env) {
  const teams = await getTeams(env);
  // Only return slug + name for public use
  return json(teams.filter(t => t.enabled).map(t => ({ slug: t.slug, name: t.name, logoUrl: t.logoUrl || '' })));
}

// ============================================================
// PRICE BOOK SYNC
// ============================================================
async function syncPriceBook(env, priceBookId) {
  // 1. Fetch price book products
  const pbProducts = await lsFetchAll(env, `price_books/${priceBookId}/products`);

  // 2. Fetch product details for each (batched)
  const enriched = [];
  for (const pbp of pbProducts) {
    try {
      const detail = await lsFetch(env, `products/${pbp.product_id}`);
      const product = detail.data || detail.product || detail;
      const parentName = product.name || pbp.name || '';
      // Parse variant label from pbp.name (e.g. "Stick - SR / LFT / 77 / P90T")
      let variantLabel = '';
      const pbName = pbp.name || '';
      // Variant label is after the base product name in the price book name
      // Price book names include full variant: "Brand Model - Size / Hand / Flex / Curve"
      if (product.variant_name && product.variant_name !== product.name) {
        // variant_name has full name, name has parent name
        variantLabel = product.variant_name.replace(product.name, '').replace(/^\s*\/\s*/, '').replace(/^\s*-\s*/, '').trim();
        if (variantLabel.startsWith('/ ')) variantLabel = variantLabel.substring(2);
      }
      const cleanName = product.name || parentName;

      // Fetch inventory for this product via /products/{id}/inventory
      let stock = 0;
      try {
        const invResp = await fetch(`${lsApi(env)}/products/${pbp.product_id}/inventory`, { headers: lsHeaders(env) });
        if (invResp.ok) {
          const invData = await invResp.json();
          const inv = invData.data || [];
          // Sum inventory_level across outlets (typically just one outlet)
          stock = inv.reduce((sum, i) => sum + (i.inventory_level || 0), 0);
        }
      } catch (e) { /* inventory fetch failed, default 0 */ }

      // Check image - skip placeholder, check skuImages first (where Lightspeed stores actual images)
      let imageUrl = null;
      if (product.skuImages && product.skuImages.length > 0) {
        imageUrl = product.skuImages[0].sizes?.standard || product.skuImages[0].sizes?.original || product.skuImages[0].url || null;
      }
      if (!imageUrl && product.images && product.images.length > 0) imageUrl = product.images[0].url || null;
      if (!imageUrl && product.image_url && !product.image_url.includes('no-image-white')) imageUrl = product.image_url;

      enriched.push({
        lightspeedProductId: pbp.product_id,
        parentId: product.variant_parent_id || null,
        name: cleanName,
        variantName: product.variant_name || pbName,
        variantLabel: variantLabel,
        sku: product.sku || '',
        description: product.description || '',
        retailPrice: parseFloat(product.price_including_tax || 0),
        teamPrice: parseFloat(pbp.price || 0),
        imageUrl,
        stock,
        supplyPrice: parseFloat(product.supply_price || 0),
        brand: product.brand?.name || '',
        supplierId: product.supplier_id || product.supplier?.id || null,
        supplierName: product.supplier?.name || '',
        type: product.type?.name || '',
        hasVariants: product.has_variants || false,
        discount: pbp.discount || null,
        taxId: pbp.tax_id || null
      });
    } catch (e) {
      console.error(`Failed to fetch product ${pbp.product_id}:`, e.message);
      // Still include with price book data only
      enriched.push({
        lightspeedProductId: pbp.product_id,
        parentId: null,
        name: pbp.name || 'Unknown',
        variantName: pbp.name || '',
        variantLabel: '',
        sku: '',
        retailPrice: 0,
        teamPrice: parseFloat(pbp.price || 0),
        imageUrl: null,
        stock: 0,
        supplyPrice: 0,
        brand: '',
        type: '',
        hasVariants: false,
        discount: pbp.discount || null,
        taxId: pbp.tax_id || null
      });
    }
  }

  // 3. Cache
  const cacheData = { products: enriched, syncedAt: new Date().toISOString() };
  await env.STORE_DATA.put(`pb_cache:${priceBookId}`, JSON.stringify(cacheData));
  return cacheData;
}

async function getCachedPriceBook(env, priceBookId, forceSync = false) {
  if (forceSync) return null;
  const cached = await env.STORE_DATA.get(`pb_cache:${priceBookId}`, 'json');
  if (!cached) return null;
  // Return cache regardless of age — cron handles freshness every 30 min
  return cached;
}

async function getPriceBookProducts(env, priceBookId) {
  // Always use cache if available; only sync when no cache exists at all
  let cached = await getCachedPriceBook(env, priceBookId);
  if (cached) return cached.products;
  const fresh = await syncPriceBook(env, priceBookId);
  return fresh.products;
}

// ============================================================
// PUBLIC STOREFRONT APIs
// ============================================================
function groupByParent(products) {
  const parents = {};
  const standalone = [];

  for (const p of products) {
    if (p.parentId) {
      if (!parents[p.parentId]) {
        parents[p.parentId] = {
          id: p.parentId,
          name: p.name,
          brand: p.brand,
          type: p.type,
          imageUrl: p.imageUrl,
          retailPrice: p.retailPrice,
          teamPrice: p.teamPrice,
          hasVariants: true,
          totalStock: 0,
          variants: []
        };
      }
      parents[p.parentId].totalStock += (p.stock || 0);
      parents[p.parentId].variants.push(p);
      if (!parents[p.parentId].imageUrl && p.imageUrl) {
        parents[p.parentId].imageUrl = p.imageUrl;
      }
      if (p.teamPrice < parents[p.parentId].teamPrice) {
        parents[p.parentId].teamPrice = p.teamPrice;
        parents[p.parentId].retailPrice = p.retailPrice;
      }
    } else {
      standalone.push(p);
    }
  }

  // Merge standalones into existing parent groups if their product ID matches a parent group ID
  // (happens when price book includes both parent and child products)
  const result = [...Object.values(parents)];
  for (const s of standalone) {
    if (parents[s.lightspeedProductId]) {
      // This standalone IS the parent product — already represented by its children group, skip it
      continue;
    }
    result.push({ ...s, id: s.lightspeedProductId, totalStock: s.stock || 0, hasVariants: false, variants: [] });
  }

  return result;
}

async function apiGetProducts(url, env) {
  const priceBookId = url.searchParams.get('priceBookId');
  if (!priceBookId) return json({ error: 'priceBookId required' }, 400);

  const products = await getPriceBookProducts(env, priceBookId);
  const grouped = groupByParent(products);
  return json(grouped);
}

async function apiGetProduct(url, productId, env) {
  const priceBookId = url.searchParams.get('priceBookId');
  if (!priceBookId) return json({ error: 'priceBookId required' }, 400);

  const products = await getPriceBookProducts(env, priceBookId);

  // Find all variants for this parent
  const variants = products.filter(p => p.parentId === productId);
  if (variants.length > 0) {
    const first = variants[0];
    return json({
      id: productId,
      name: first.name,
      description: first.description || '',
      brand: first.brand,
      type: first.type,
      imageUrl: first.imageUrl || variants.find(v => v.imageUrl)?.imageUrl || null,
      retailPrice: first.retailPrice,
      teamPrice: first.teamPrice,
      supplierId: first.supplierId,
      supplierName: first.supplierName,
      supplyPrice: first.supplyPrice,
      hasVariants: true,
      totalStock: variants.reduce((s, v) => s + (v.stock || 0), 0),
      variants: variants.map(v => ({
        id: v.lightspeedProductId,
        name: v.variantLabel || v.variantName,
        sku: v.sku,
        retailPrice: v.retailPrice,
        teamPrice: v.teamPrice,
        stock: v.stock,
        imageUrl: v.imageUrl,
        supplierId: v.supplierId,
        supplierName: v.supplierName,
        supplyPrice: v.supplyPrice
      }))
    });
  }

  // Standalone product
  const product = products.find(p => p.lightspeedProductId === productId);
  if (!product) return json({ error: 'Product not found' }, 404);

  return json({
    id: product.lightspeedProductId,
    name: product.name,
    description: product.description || '',
    brand: product.brand,
    type: product.type,
    imageUrl: product.imageUrl,
    retailPrice: product.retailPrice,
    teamPrice: product.teamPrice,
    hasVariants: false,
    totalStock: product.stock || 0,
    stock: product.stock || 0,
    variants: []
  });
}

// ============================================================
// CHECKOUT
// ============================================================
async function apiCheckout(request, env) {
  const config = await getConfig(env);
  if (!config.stripeSecretKey) return json({ error: 'Stripe not configured' }, 500);
  const { items, customer, teamName, teamSlug } = await request.json();
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
      'metadata[teamName]': teamName || '',
      'metadata[teamSlug]': teamSlug || '',
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
    const teamName = session.metadata?.teamName || '';

    const order = {
      id: generateId('ord'),
      teamName,
      teamSlug: session.metadata?.teamSlug || '',
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

    // Create Lightspeed sale + auto POs for out-of-stock items
    if (env.LIGHTSPEED_API_TOKEN) {
      try {
        const result = await createLightspeedSale(env, order);
        order.lightspeedSaleId = result.saleId;
        order.lightspeedInvoice = result.invoiceNumber;
        order.poResults = result.poResults || [];
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

    // Send notification
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
// LIGHTSPEED SALE HELPERS — shared by test order + real checkout
// ============================================================

// Find or create customer in Lightspeed
// Search by email (exact match, skip null/empty emails), then by phone, then create
async function lsFindOrCreateCustomer(env, customer, steps) {
  const log = (step, action, status, detail) => { if (steps) steps.push({ step, action, status, detail }); };

  let customerId = null;

  // Step 1a: Search by email
  if (customer.email) {
    try {
      const custSearch = await lsFetch(env, `customers?email=${encodeURIComponent(customer.email)}`);
      const customers = (custSearch.customers || custSearch.data || [])
        .filter(c => c.email && c.email.trim() !== '' && c.email.toLowerCase() === customer.email.toLowerCase());
      if (customers.length > 0) {
        customerId = customers[0].id;
        log(1, 'Search customer by email', 'found', { id: customerId, name: `${customers[0].first_name} ${customers[0].last_name}`, email: customers[0].email });
        return customerId;
      } else {
        log(1, 'Search customer by email', 'not_found', { email: customer.email, note: 'No customer with matching non-null email' });
      }
    } catch (e) {
      log(1, 'Search customer by email', 'error', e.message);
    }
  }

  // Step 1b: Search by phone
  if (!customerId && customer.phone) {
    try {
      const phoneCleaned = customer.phone.replace(/[^0-9]/g, '');
      const custSearch = await lsFetch(env, `customers?phone=${encodeURIComponent(customer.phone)}`);
      const customers = (custSearch.customers || custSearch.data || [])
        .filter(c => c.phone && c.phone.replace(/[^0-9]/g, '').includes(phoneCleaned.slice(-7)));
      if (customers.length > 0) {
        customerId = customers[0].id;
        log('1b', 'Search customer by phone', 'found', { id: customerId, name: `${customers[0].first_name} ${customers[0].last_name}`, phone: customers[0].phone });
        return customerId;
      } else {
        log('1b', 'Search customer by phone', 'not_found', { phone: customer.phone });
      }
    } catch (e) {
      log('1b', 'Search customer by phone', 'error', e.message);
    }
  }

  // Step 2: Create customer
  if (!customerId) {
    try {
      const nameParts = (customer.name || '').split(' ');
      const payload = {
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || '',
        email: customer.email || '',
        phone: customer.phone || ''
      };
      log(2, 'Create customer', 'sending', { payload });
      const newCust = await lsFetch(env, 'customers', { method: 'POST', body: JSON.stringify(payload) });
      const custData = newCust.data || newCust.customer || newCust;
      customerId = custData.id;
      log(2, 'Create customer', 'created', {
        id: customerId,
        response: { id: custData.id, first_name: custData.first_name, last_name: custData.last_name, email: custData.email, phone: custData.phone }
      });
    } catch (e) {
      log(2, 'Create customer', 'error', e.message);
    }
  }

  return customerId;
}

// Get cached Lightspeed config (register ID, user ID, payment type ID)
// Caches in KV for 24 hours to avoid fetching every sale
async function getLightspeedSaleConfig(env, steps) {
  const log = (step, action, status, detail) => { if (steps) steps.push({ step, action, status, detail }); };

  // Check KV cache
  const cached = await env.STORE_DATA.get('ls_sale_config', 'json');
  if (cached && cached.cachedAt && (Date.now() - new Date(cached.cachedAt).getTime() < 24 * 60 * 60 * 1000)) {
    log(3, 'Load cached sale config', 'cached', { registerId: cached.registerId, registerName: cached.registerName, userId: cached.userId, userName: cached.userName, paymentTypeId: cached.paymentTypeId, paymentTypeName: cached.paymentTypeName });
    return cached;
  }

  const config = { registerId: null, registerName: null, userId: null, userName: null, paymentTypeId: null, paymentTypeName: null };

  // Fetch registers — find "Main Register"
  try {
    const registersData = await lsFetch(env, 'registers');
    const registers = registersData.registers || registersData.data || [];
    log(3, 'Fetch registers', 'ok', registers.map(r => ({ id: r.id, name: r.name })));
    const mainReg = registers.find(r => r.name && r.name.toLowerCase().includes('main'));
    const selected = mainReg || registers[0];
    if (selected) {
      config.registerId = selected.id;
      config.registerName = selected.name;
    }
  } catch (e) {
    log(3, 'Fetch registers', 'error', e.message);
  }

  // Fetch users — first user
  try {
    const usersData = await lsFetch(env, 'users');
    const users = usersData.users || usersData.data || [];
    log(4, 'Fetch users', 'ok', users.map(u => ({ id: u.id, name: u.display_name || u.name || u.email })));
    if (users.length) {
      config.userId = users[0].id;
      config.userName = users[0].display_name || users[0].name || users[0].email;
    }
  } catch (e) {
    log(4, 'Fetch users', 'error', e.message);
  }

  // Fetch payment types — find "Lightspeed Payments"
  try {
    const ptData = await lsFetch(env, 'payment_types');
    const paymentTypes = ptData.payment_types || ptData.data || [];
    log(5, 'Fetch payment types', 'ok', paymentTypes.map(pt => ({ id: pt.id, name: pt.name })));
    const lsPay = paymentTypes.find(pt => pt.name === 'Team Store Online');
    const selected = lsPay || paymentTypes[0];
    if (selected) {
      config.paymentTypeId = selected.id;
      config.paymentTypeName = selected.name;
    }
  } catch (e) {
    log(5, 'Fetch payment types', 'error', e.message);
  }

  // Cache for 24 hours
  config.cachedAt = new Date().toISOString();
  await env.STORE_DATA.put('ls_sale_config', JSON.stringify(config));

  return config;
}

// ============================================================
// TEST ORDER — simulates full Lightspeed sale creation step by step
// ============================================================
async function apiTestOrder(request, env) {
  const body = await request.json();
  const steps = [];
  let saleId = null;

  const testCustomer = {
    name: body.name || 'Test Customer',
    email: body.email || 'test@icelabproshop.com',
    phone: body.phone || '555-0100'
  };

  // Get a real product from the first enabled team's price book
  const teams = await getTeams(env);
  const team = teams.find(t => t.enabled && t.priceBookId);
  if (!team) return json({ error: 'No enabled team configured' }, 400);

  const products = await getPriceBookProducts(env, team.priceBookId);
  if (!products.length) return json({ error: 'No products in price book. Sync first.' }, 400);
  const testProduct = products[0];

  // Steps 1-2: Find or create customer
  const customerId = await lsFindOrCreateCustomer(env, testCustomer, steps);

  // Steps 3-5: Get register, user, payment type (cached)
  const saleConfig = await getLightspeedSaleConfig(env, steps);

  // STEP 6: Build sale payload — pickup fulfillment
  const salePayload = {
    register_id: saleConfig.registerId,
    user_id: saleConfig.userId,
    customer_id: customerId,
    status: 'AWAITING_PICKUP',
    state: 'pending',
    register_sale_attributes: ['pickup'],
    note: `TEST ORDER - ${team.name} | Test from Team Store Admin`,
    register_sale_products: [{
      product_id: testProduct.lightspeedProductId,
      quantity: 1,
      price: testProduct.teamPrice,
      tax: 0,
      tax_id: '06f24f8b-21fd-11ef-f4ca-66ee517740dd',
      status: 'CONFIRMED',
      fulfillment_type: 'PICKUP'
    }]
  };
  if (saleConfig.paymentTypeId) {
    salePayload.register_sale_payments = [{ retailer_payment_type_id: saleConfig.paymentTypeId, amount: testProduct.teamPrice }];
  }

  steps.push({ step: 6, action: 'Build sale payload', status: 'ready', detail: {
    payload: salePayload,
    resolved: { register: saleConfig.registerName, user: saleConfig.userName, paymentType: saleConfig.paymentTypeName },
    productUsed: { name: testProduct.variantName || testProduct.name, sku: testProduct.sku, teamPrice: testProduct.teamPrice }
  }});

  // STEP 7: Create sale + POs (only if body.confirm === true)
  if (body.confirm) {
    try {
      const testOrder = {
        id: generateId('ord'),
        teamName: team.name,
        customer: testCustomer,
        items: [{
          lightspeedProductId: testProduct.lightspeedProductId,
          name: testProduct.name,
          variantName: testProduct.variantLabel || testProduct.variantName || '',
          teamPrice: testProduct.teamPrice,
          price: testProduct.teamPrice,
          qty: 1,
          stock: testProduct.stock || 0,
          supplierId: testProduct.supplierId || null,
          supplierName: testProduct.supplierName || '',
          supplyPrice: testProduct.supplyPrice || 0
        }],
        total: testProduct.teamPrice
      };
      const result = await createLightspeedSale(env, testOrder);
      saleId = result.saleId;
      steps.push({ step: 7, action: 'Create sale in Lightspeed', status: 'created', detail: {
        saleId: result.saleId,
        invoiceNumber: result.invoiceNumber,
        status: 'AWAITING_PICKUP'
      }});
      if (result.poResults?.length) {
        steps.push({ step: 8, action: 'Auto-create purchase orders', status: 'created', detail: result.poResults });
      }
    } catch (e) {
      steps.push({ step: 7, action: 'Create sale in Lightspeed', status: 'error', detail: e.message });
    }
  } else {
    steps.push({ step: 7, action: 'Create sale in Lightspeed', status: 'skipped', detail: 'Send with "confirm": true to actually create the sale' });
  }

  return json({ steps, customer: testCustomer, teamName: team.name, saleId, testProduct: { name: testProduct.name, stock: testProduct.stock, supplierId: testProduct.supplierId, supplierName: testProduct.supplierName } });
}

// ============================================================
// LIGHTSPEED SALE CREATION — used by Stripe webhook
// ============================================================
async function createLightspeedSale(env, order) {
  const saleConfig = await getLightspeedSaleConfig(env, null);
  if (!saleConfig.registerId) throw new Error('No register configured');
  if (!saleConfig.userId) throw new Error('No user configured');

  const customerId = await lsFindOrCreateCustomer(env, order.customer, null);

  const orderNum = order.id.slice(-6).toUpperCase();
  const saleProducts = order.items.map(item => ({
    product_id: item.lightspeedProductId || item.lightspeedId || item.productId,
    quantity: item.qty,
    price: item.teamPrice || item.price,
    tax: 0,
    tax_id: '06f24f8b-21fd-11ef-f4ca-66ee517740dd',
    status: 'CONFIRMED',
    fulfillment_type: 'PICKUP'
  }));

  const salePayload = {
    register_id: saleConfig.registerId,
    user_id: saleConfig.userId,
    status: 'AWAITING_PICKUP',
    state: 'pending',
    register_sale_attributes: ['pickup'],
    note: `TEAM ORDER - ${order.teamName || 'Team Store'} | Paid via Stripe | Order #${orderNum}`,
    register_sale_products: saleProducts
  };
  if (customerId) salePayload.customer_id = customerId;
  if (saleConfig.paymentTypeId) {
    salePayload.register_sale_payments = [{ retailer_payment_type_id: saleConfig.paymentTypeId, amount: order.total }];
  }

  const saleResp = await lsFetchLegacy(env, 'register_sales', { method: 'POST', body: JSON.stringify(salePayload) });
  const saleId = saleResp.register_sale?.id || saleResp.id || 'unknown';
  const invoiceNumber = saleResp.register_sale?.invoice_number || saleResp.invoice_number || '';

  // Auto-create POs for out-of-stock items
  let poResults = [];
  try {
    poResults = await createPurchaseOrders(env, order, orderNum);
  } catch (e) { console.error('PO creation failed:', e.message); }

  return { saleId, invoiceNumber, poResults };
}

// ============================================================
// AUTO-CREATE PURCHASE ORDERS for out-of-stock items
// ============================================================
async function createPurchaseOrders(env, order, orderNum) {
  const OUTLET_ID = '06f24f8b-21fd-11ef-f4ca-66ee517e9e59'; // Ice Lab Pro Shop
  const poResults = [];

  // Find out-of-stock items and group by supplier
  const oosItems = (order.items || []).filter(item => (item.stock || 0) <= 0);
  if (!oosItems.length) return poResults;

  // Group by supplierId
  const bySupplier = {};
  for (const item of oosItems) {
    const sid = item.supplierId || 'unknown';
    if (!bySupplier[sid]) bySupplier[sid] = { supplierId: sid, supplierName: item.supplierName || 'Unknown Supplier', items: [] };
    bySupplier[sid].items.push(item);
  }

  for (const [supplierId, group] of Object.entries(bySupplier)) {
    try {
      // Create the consignment (PO)
      const poPayload = {
        name: `Team Order #${orderNum} - ${order.teamName || 'Team Store'}`,
        outlet_id: OUTLET_ID,
        type: 'SUPPLIER',
        status: 'OPEN',
        supplier_id: supplierId !== 'unknown' ? supplierId : undefined
      };

      const poResp = await lsFetch(env, 'consignments', { method: 'POST', body: JSON.stringify(poPayload) });
      const po = poResp.data || poResp;
      const poId = po.id;
      const poRef = po.reference || poId?.slice(-6) || '';

      // Add products to the PO
      for (const item of group.items) {
        const prodId = item.lightspeedProductId || item.lightspeedId || item.productId;
        try {
          await lsFetch(env, `consignments/${poId}/products`, {
            method: 'POST',
            body: JSON.stringify({
              product_id: prodId,
              count: item.qty,
              cost: item.supplyPrice || 0
            })
          });
        } catch (e) { console.error(`Failed to add product ${prodId} to PO:`, e.message); }
      }

      // Calculate PO total (supply cost)
      const poTotal = group.items.reduce((sum, item) => sum + ((item.supplyPrice || 0) * item.qty), 0);
      const belowMinimum = poTotal < 250 && (group.supplierName.toLowerCase().includes('bauer') || group.supplierName.toLowerCase().includes('ccm'));

      poResults.push({
        poId,
        reference: poRef,
        supplierId,
        supplierName: group.supplierName,
        itemCount: group.items.length,
        totalCost: poTotal,
        belowMinimum,
        items: group.items.map(i => ({ name: i.name, variantName: i.variantName, qty: i.qty, supplyPrice: i.supplyPrice || 0 }))
      });
    } catch (e) {
      console.error(`PO creation failed for supplier ${group.supplierName}:`, e.message);
      poResults.push({ error: e.message, supplierName: group.supplierName });
    }
  }

  return poResults;
}

// ============================================================
// EMAIL NOTIFICATION
// ============================================================
async function sendOrderNotification(env, order) {
  const notifyEmail = env.NOTIFICATION_EMAIL || 'hello@icelabproshop.com';
  const orderNum = order.id.slice(-6).toUpperCase();

  // Categorize items by stock status
  const inStockItems = (order.items || []).filter(i => (i.stock || 0) > 0);
  const oosItems = (order.items || []).filter(i => (i.stock || 0) <= 0);

  const itemRows = (order.items || []).map(item => {
    const name = item.name || 'Product';
    const variant = item.variantName ? ` - ${item.variantName}` : '';
    const stockStatus = (item.stock || 0) > 0
      ? '<span style="color:#16a34a;font-weight:600">IN STOCK - Pull from shelf</span>'
      : '<span style="color:#2563eb;font-weight:600">SPECIAL ORDER - PO created</span>';
    return `<tr><td style="padding:8px;border-bottom:1px solid #eee">${name}${variant}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${item.qty}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">$${((item.teamPrice || item.price || 0) * item.qty).toFixed(2)}</td><td style="padding:8px;border-bottom:1px solid #eee">${stockStatus}</td></tr>`;
  }).join('');

  // PO section
  let poHtml = '';
  if (order.poResults?.length) {
    poHtml = '<h3 style="color:#4f46e5;margin-top:24px">Purchase Orders Created</h3>';
    for (const po of order.poResults) {
      if (po.error) {
        poHtml += `<p style="color:#dc2626">PO creation failed for ${po.supplierName}: ${po.error}</p>`;
        continue;
      }
      const warningHtml = po.belowMinimum
        ? `<p style="background:#fffbeb;border:1px solid #fbbf24;padding:8px 12px;border-radius:6px;color:#92400e;margin:8px 0"><strong>WARNING:</strong> PO total $${po.totalCost.toFixed(2)} is under $250 minimum for ${po.supplierName}. Consider combining with other orders before sending.</p>`
        : '';
      const poItems = po.items.map(i => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${i.name}${i.variantName ? ' - ' + i.variantName : ''}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">${i.qty}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">$${(i.supplyPrice * i.qty).toFixed(2)}</td></tr>`).join('');
      poHtml += `<div style="background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
        <p><strong>Supplier:</strong> ${po.supplierName}</p>
        <p><strong>PO #:</strong> ${po.reference}</p>
        <p><strong>Items:</strong> ${po.itemCount} | <strong>Cost Total:</strong> $${po.totalCost.toFixed(2)}</p>
        ${warningHtml}
        <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">
          <thead><tr style="background:#e5e7eb"><th style="padding:6px 8px;text-align:left">Item</th><th style="padding:6px 8px;text-align:center">Qty</th><th style="padding:6px 8px;text-align:right">Cost</th></tr></thead>
          <tbody>${poItems}</tbody>
        </table>
        <p style="margin-top:8px;color:#6b7280;font-size:13px">Review this PO in Lightspeed > Inventory > Stock Orders, then send to supplier.</p>
      </div>`;
    }
  }

  // Action items
  let actionHtml = '<h3 style="margin-top:24px">Action Required</h3><ul style="margin:8px 0;padding-left:20px">';
  if (inStockItems.length) actionHtml += `<li style="margin:4px 0"><strong>${inStockItems.length} item(s) in stock</strong> - Pull from shelf and set aside for customer pickup</li>`;
  if (oosItems.length) actionHtml += `<li style="margin:4px 0"><strong>${oosItems.length} item(s) special order</strong> - PO(s) created in Lightspeed. Review and send to supplier.</li>`;
  actionHtml += '<li style="margin:4px 0">Check Lightspeed > Fulfillments > Customer pickup for this order</li></ul>';

  const html = `
    <div style="font-family:sans-serif;max-width:650px;margin:0 auto">
      <h2 style="color:#4f46e5">New Team Store Order</h2>
      <p><strong>Order #:</strong> ${orderNum}</p>
      <p><strong>Team:</strong> ${order.teamName || 'N/A'}</p>
      <p><strong>Customer:</strong> ${order.customer?.name || 'N/A'}</p>
      <p><strong>Email:</strong> ${order.customer?.email || 'N/A'}</p>
      <p><strong>Phone:</strong> ${order.customer?.phone || 'N/A'}</p>
      ${order.lightspeedSaleId ? `<p><strong>Lightspeed Sale #:</strong> ${order.lightspeedInvoice || order.lightspeedSaleId}</p>` : '<p style="color:#dc2626"><strong>Lightspeed sync failed - create sale manually</strong></p>'}
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead><tr style="background:#f8f9fa"><th style="padding:8px;text-align:left">Item</th><th style="padding:8px;text-align:center">Qty</th><th style="padding:8px;text-align:right">Price</th><th style="padding:8px;text-align:left">Status</th></tr></thead>
        <tbody>${itemRows}</tbody>
        <tfoot><tr><td colspan="2" style="padding:8px;font-weight:bold">Total</td><td style="padding:8px;text-align:right;font-weight:bold">$${(order.total || 0).toFixed(2)}</td><td></td></tr></tfoot>
      </table>
      ${poHtml}
      ${actionHtml}
    </div>`;

  await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: notifyEmail }] }],
      from: { email: 'noreply@icelabproshop.com', name: 'Ice Lab Team Store' },
      subject: `New Team Order #${orderNum} - ${order.teamName || 'Team Store'} - ${order.customer?.name || 'Customer'}`,
      content: [{ type: 'text/html', value: html }]
    })
  });
}

// ============================================================
// ADMIN APIs
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

async function apiLightspeedSyncTeam(request, env) {
  const { priceBookId } = await request.json();
  if (!priceBookId) return json({ error: 'priceBookId required' }, 400);
  if (!env.LIGHTSPEED_API_TOKEN) return json({ error: 'Lightspeed not configured' }, 400);
  try {
    const result = await syncPriceBook(env, priceBookId);
    await env.STORE_DATA.put('ls_sync_timestamp', new Date().toISOString());
    return json({ success: true, totalProducts: result.products.length, syncedAt: result.syncedAt });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function apiLightspeedSyncAll(env) {
  if (!env.LIGHTSPEED_API_TOKEN) return json({ error: 'Lightspeed not configured' }, 400);
  const teams = await getTeams(env);
  const results = [];
  for (const team of teams) {
    if (!team.enabled || !team.priceBookId) continue;
    try {
      const result = await syncPriceBook(env, team.priceBookId);
      results.push({ team: team.name, products: result.products.length, success: true });
    } catch (e) {
      results.push({ team: team.name, error: e.message, success: false });
    }
  }
  await env.STORE_DATA.put('ls_sync_timestamp', new Date().toISOString());
  return json({ success: true, results, syncedAt: new Date().toISOString() });
}

async function apiImportProducts(url, env) {
  const priceBookId = url.searchParams.get('priceBookId');
  if (!priceBookId) return json({ error: 'priceBookId required' }, 400);

  // Try cache first (any age), then sync info
  const cached = await env.STORE_DATA.get(`pb_cache:${priceBookId}`, 'json');
  const syncTimestamp = cached?.syncedAt || await env.STORE_DATA.get('ls_sync_timestamp') || null;

  return json({
    products: cached?.products || [],
    syncTimestamp,
    totalProducts: cached?.products?.length || 0
  });
}

async function apiAdminGetOrders(env) {
  const ids = await env.STORE_DATA.get('orders', 'json') || [];
  const orders = [];
  for (const id of ids.slice(0, 100)) {
    const o = await env.STORE_DATA.get(`order:${id}`, 'json');
    if (o) orders.push(o);
  }
  return json(orders);
}

async function apiAdminAllProducts(env) {
  const teams = await getTeams(env);
  const allProducts = [];
  for (const team of teams) {
    if (!team.enabled || !team.priceBookId) continue;
    const cached = await env.STORE_DATA.get(`pb_cache:${team.priceBookId}`, 'json');
    if (cached?.products) {
      for (const p of cached.products) {
        allProducts.push({ ...p, teamName: team.name, teamSlug: team.slug });
      }
    }
  }
  return json(allProducts);
}

async function apiAdminGetConfig(env) { return json(await getConfig(env)); }

async function apiAdminSaveConfig(request, env) {
  const data = await request.json();
  const existing = await getConfig(env);
  const config = { ...existing, ...data, updatedAt: new Date().toISOString() };
  await env.STORE_DATA.put('config', JSON.stringify(config));
  return json(config);
}

async function apiAdminGetTeams(env) { return json(await getTeams(env)); }

async function apiAdminSaveTeams(request, env) {
  const { teams } = await request.json();
  await env.STORE_DATA.put('store:teams', JSON.stringify(teams || []));
  return json({ success: true, teams });
}

// ============================================================
// CRON SYNC
// ============================================================
async function cronSyncAllTeams(env) {
  if (!env.LIGHTSPEED_API_TOKEN) return;
  const teams = await getTeams(env);
  for (const team of teams) {
    if (!team.enabled || !team.priceBookId) continue;
    try {
      await syncPriceBook(env, team.priceBookId);
      console.log(`Cron sync: ${team.name} (${team.priceBookId}) synced`);
    } catch (e) {
      console.error(`Cron sync failed for ${team.name}:`, e.message);
    }
  }
  await env.STORE_DATA.put('ls_sync_timestamp', new Date().toISOString());
  console.log(`Cron sync complete at ${new Date().toISOString()}`);
}

// ============================================================
// SVG ICONS
// ============================================================
const ICONS = {
  cart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
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
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
};

// ============================================================
// STOREFRONT PAGE
// ============================================================
function storePage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Ice Lab Team Store</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e;min-height:100vh}a{color:#4f46e5;text-decoration:none}
#pin-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}.pin-box{text-align:center;background:#fff;padding:48px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #e5e7eb;max-width:400px;width:100%}.pin-box h1{font-size:24px;font-weight:700;margin-bottom:4px;color:#1a1a2e}.pin-box .team-label{color:#4f46e5;font-size:14px;font-weight:600;margin-bottom:4px}.pin-box p{color:#6b7280;margin-bottom:24px;font-size:14px}.pin-dots{display:flex;gap:12px;justify-content:center;margin-bottom:16px}.pin-dots input{width:48px;height:56px;text-align:center;font-size:22px;background:#fff;border:1px solid #d1d5db;border-radius:8px;color:#1a1a2e;outline:none;transition:border 0.15s}.pin-dots input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.pin-error{color:#dc2626;font-size:13px;min-height:18px}
.sh{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,0.04)}.sh-brand{font-size:16px;font-weight:700;color:#1a1a2e;letter-spacing:0.5px;cursor:pointer}.sh-brand .team-name{color:#4f46e5;font-weight:600}.cart-btn{position:relative;background:#fff;border:1px solid #e5e7eb;color:#1a1a2e;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;display:flex;align-items:center;gap:6px;transition:all 0.15s}.cart-btn:hover{border-color:#d1d5db;background:#f9fafb}.cart-badge{background:#4f46e5;color:#fff;font-size:11px;font-weight:700;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center}
.sc{max-width:1200px;margin:0 auto;padding:32px 24px}.st{font-size:20px;font-weight:700;margin-bottom:20px;color:#1a1a2e}
.pg{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}.pc{background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;cursor:pointer;transition:all 0.15s}.pc:hover{box-shadow:0 4px 12px rgba(0,0,0,0.08);transform:translateY(-2px)}.pc-img{height:200px;background:#f0f1f3;display:flex;align-items:center;justify-content:center}.pc-img img{width:100%;height:100%;object-fit:cover}.pc-info{padding:14px 16px}.pc-info h3{font-size:14px;font-weight:600;margin-bottom:4px;color:#1a1a2e;line-height:1.3}.pc-brand{font-size:11px;color:#6b7280;margin-bottom:6px}.pc-price-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.pc-price{font-size:16px;font-weight:700;color:#1a1a2e}.pc-retail{font-size:12px;color:#9ca3af;text-decoration:line-through}.stock-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap}.stock-instock{background:#f0fdf4;color:#16a34a}.stock-order{background:#eff6ff;color:#2563eb}
.pd{background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.pd-layout{display:grid;grid-template-columns:400px 1fr;gap:40px}.pd-image{height:400px;background:#f0f1f3;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden}.pd-image img{width:100%;height:100%;object-fit:cover}.pd-info h2{font-size:22px;font-weight:700;margin-bottom:4px}.pd-brand{font-size:13px;color:#6b7280;margin-bottom:12px}.pd-desc h3,.pd-desc h4{color:#1a1a2e;margin-bottom:8px;font-size:15px}.pd-desc p{margin-bottom:12px}.pd-desc ul{margin-bottom:12px;padding-left:20px}.pd-desc li{margin-bottom:4px}.pd-desc strong{color:#1a1a2e}.pd-info .price{font-size:24px;font-weight:700;color:#1a1a2e;margin-bottom:4px}.pd-info .retail-price{font-size:14px;color:#9ca3af;text-decoration:line-through;margin-bottom:16px}
.vg{margin-bottom:16px}.vg label{display:block;font-size:12px;color:#6b7280;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}.vg select{width:100%;padding:10px 12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:14px;cursor:pointer;transition:border 0.15s}.vg select:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}
.vo-group{display:flex;flex-wrap:wrap;gap:8px}.vo-btn{padding:8px 16px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#1a1a2e;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;font-family:inherit}.vo-btn:hover{border-color:#4f46e5;background:#f5f3ff}.vo-btn.selected{border-color:#4f46e5;background:#4f46e5;color:#fff}
.qty-row{display:flex;align-items:center;gap:12px;margin-bottom:20px}.qty-btn{width:36px;height:36px;border-radius:6px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s}.qty-btn:hover{background:#f9fafb}
.stock-indicator{font-size:13px;padding:4px 10px;border-radius:4px;display:inline-block;margin-bottom:16px;font-weight:500}.si-green{background:#f0fdf4;color:#16a34a}.si-blue{background:#eff6ff;color:#2563eb}
.back-link{display:inline-flex;align-items:center;gap:4px;color:#6b7280;font-size:13px;margin-bottom:16px;cursor:pointer;font-weight:500;transition:color 0.15s}.back-link:hover{color:#1a1a2e}
.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;gap:6px}.btn-primary{background:#4f46e5;color:#fff}.btn-primary:hover{background:#4338ca}.btn-primary:disabled{background:#c7d2fe;color:#818cf8;cursor:not-allowed}.btn-full{width:100%}.btn-lg{padding:14px 24px;font-size:15px;font-weight:600}
.co{position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:200;display:none}.co.open{display:block}.cs{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:90vw;background:#fff;border-left:1px solid #e5e7eb;z-index:201;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.25s ease}.cs.open{transform:translateX(0)}.cs-header{padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between}.cs-header h2{font-size:16px;font-weight:600}.cs-close{background:none;border:none;color:#6b7280;cursor:pointer;padding:4px}.cs-close:hover{color:#1a1a2e}.cs-items{flex:1;overflow-y:auto;padding:16px 20px}.ci{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #f0f0f0}.ci-info{flex:1}.ci-info h4{font-size:14px;font-weight:600;margin-bottom:2px}.ci-info .opts{font-size:12px;color:#6b7280}.ci-info .ip{font-size:14px;color:#1a1a2e;font-weight:600;margin-top:4px}.ci-qty{display:flex;align-items:center;gap:6px}.ci-qty button{width:26px;height:26px;border-radius:4px;border:1px solid #d1d5db;background:#fff;color:#1a1a2e;cursor:pointer;font-size:13px;transition:all 0.15s}.ci-qty button:hover{background:#f9fafb}.ci-remove{background:none;border:none;color:#dc2626;font-size:12px;cursor:pointer;margin-top:4px;font-weight:500}.ci-remove:hover{text-decoration:underline}.cs-empty{text-align:center;color:#6b7280;padding:40px;font-size:14px}.cs-footer{padding:20px;border-top:1px solid #e5e7eb}.cs-total{display:flex;justify-content:space-between;font-size:16px;font-weight:700;margin-bottom:16px}
.co-form input{width:100%;padding:10px 12px;margin-bottom:8px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:14px;font-family:inherit;transition:border 0.15s}.co-form input:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.co-form input::placeholder{color:#9ca3af}
.toast{position:fixed;bottom:24px;right:24px;background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;z-index:300;transform:translateY(60px);opacity:0;transition:all 0.25s}.toast.show{transform:translateY(0);opacity:1}
.loading{text-align:center;padding:60px;color:#6b7280;font-size:14px}
@media(max-width:900px){.pg{grid-template-columns:repeat(2,1fr)}.pd-layout{grid-template-columns:1fr}}
@media(max-width:480px){.pg{grid-template-columns:1fr}}
</style></head><body>
<div id="pin-screen"><div class="pin-box"><h1>Ice Lab Team Store</h1><div class="team-label" id="pin-team-label" style="display:none"></div><p>Enter your team PIN to access the store</p><div class="pin-dots"><input type="tel" maxlength="1" autofocus><input type="tel" maxlength="1"><input type="tel" maxlength="1"><input type="tel" maxlength="1"></div><div class="pin-error" id="pin-error"></div></div></div>
<div id="store-app" style="display:none">
<header class="sh"><div class="sh-brand" onclick="showHome()">ICE LAB TEAM STORE <span class="team-name" id="header-team-name"></span></div><button class="cart-btn" onclick="toggleCart()">${ICONS.cart}<span id="cart-count" class="cart-badge">0</span></button></header>
<main class="sc" id="main-content"></main></div>
<div class="co" id="cart-overlay" onclick="toggleCart()"></div>
<div class="cs" id="cart-sidebar"><div class="cs-header"><h2>Your Cart</h2><button class="cs-close" onclick="toggleCart()">${ICONS.x}</button></div><div class="cs-items" id="cart-items"></div><div class="cs-footer" id="cart-footer"></div></div>
<div class="toast" id="toast"></div>
<script>
let products=[],cart=JSON.parse(sessionStorage.getItem('team_cart')||'[]'),currentView='home';
let teamContext=JSON.parse(sessionStorage.getItem('team_context')||'null');
let storeSearchQuery='';let _searchDebounce=null;

// Check for ?team=slug param and show team name on PIN page
(function(){
  const params=new URLSearchParams(window.location.search);
  const teamSlug=params.get('team');
  if(teamSlug){
    fetch('/api/teams').then(r=>r.json()).then(teams=>{
      const team=teams.find(t=>t.slug===teamSlug);
      if(team){
        const label=document.getElementById('pin-team-label');
        label.textContent=team.name;
        label.style.display='block';
      }
    }).catch(()=>{});
  }
})();

const pinInputs=document.querySelectorAll('.pin-dots input');
pinInputs.forEach((inp,i)=>{
  inp.addEventListener('input',()=>{inp.value=inp.value.replace(/[^0-9]/g,'').slice(0,1);if(inp.value){if(i<pinInputs.length-1)pinInputs[i+1].focus();else checkPin()}});
  inp.addEventListener('keydown',e=>{if(e.key==='Backspace'){if(!inp.value&&i>0){pinInputs[i-1].value='';pinInputs[i-1].focus()}else{inp.value=''}}});
  inp.addEventListener('focus',()=>inp.select());
});

async function checkPin(){
  const pin=Array.from(pinInputs).map(i=>i.value).join('');
  if(pin.length<4)return;
  try{
    const r=await fetch('/api/verify-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
    const data=await r.json();
    if(r.ok&&data.team){
      teamContext=data.team;
      sessionStorage.setItem('team_context',JSON.stringify(teamContext));
      document.getElementById('pin-screen').style.display='none';
      document.getElementById('store-app').style.display='';
      loadStore();
    }else{
      document.getElementById('pin-error').textContent='Invalid PIN';
      pinInputs.forEach(i=>i.value='');pinInputs[0].focus();
    }
  }catch(e){document.getElementById('pin-error').textContent='Connection error'}
}

if(teamContext){
  document.getElementById('pin-screen').style.display='none';
  document.getElementById('store-app').style.display='';
  loadStore();
}

async function loadStore(){
  if(!teamContext)return;
  document.getElementById('header-team-name').textContent='- '+teamContext.name;
  document.getElementById('main-content').innerHTML='<div class="loading">Loading products...</div>';
  try{
    const r=await fetch('/api/products?priceBookId='+encodeURIComponent(teamContext.priceBookId));
    products=await r.json();
  }catch(e){products=[];}
  updateCartCount();
  showHome();
}

function showHome(){
  currentView='home';
  const m=document.getElementById('main-content');
  const searchIcon='${ICONS.search}';
  const xIcon='${ICONS.x}';
  let html='<h2 class="st">All Products</h2>';
  html+='<div style="margin-bottom:24px"><div style="position:relative"><input id="store-search" type="text" placeholder="Search products..." value="'+esc(storeSearchQuery)+'" oninput="onStoreSearch(this.value)" style="width:100%;padding:10px 12px 10px 36px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;background:#fff;font-family:inherit;outline:none;transition:border 0.15s"><span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#9ca3af;pointer-events:none">'+searchIcon+'</span>'+(storeSearchQuery?'<button onclick="onStoreSearch(\\'\\')" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#9ca3af;cursor:pointer;padding:4px">'+xIcon+'</button>':'')+'</div></div>';
  const filtered=storeSearchQuery?products.filter(p=>fuzzyMatch(storeSearchQuery,p.name||'')):products;
  if(products.length===0){html+='<div class="loading">No products available yet. Check back soon!</div>'}
  else if(filtered.length===0){html+='<div class="loading">No products found for "'+esc(storeSearchQuery)+'"</div>'}
  else{html+='<div class="pg">'+filtered.map(productCard).join('')+'</div>'}
  m.innerHTML=html;
  if(window._scrollPos&&currentView==='home'){setTimeout(()=>{window.scrollTo(0,window._scrollPos);window._scrollPos=null},50)}
  const si=document.getElementById('store-search');if(si&&storeSearchQuery){si.focus();si.setSelectionRange(si.value.length,si.value.length)}
}

function levenshtein(a,b){
  if(a.length===0)return b.length;if(b.length===0)return a.length;
  const matrix=[];
  for(let i=0;i<=b.length;i++)matrix[i]=[i];
  for(let j=0;j<=a.length;j++)matrix[0][j]=j;
  for(let i=1;i<=b.length;i++){for(let j=1;j<=a.length;j++){matrix[i][j]=Math.min(matrix[i-1][j]+1,matrix[i][j-1]+1,matrix[i-1][j-1]+(b[i-1]===a[j-1]?0:1));}}
  return matrix[b.length][a.length];
}

function fuzzyMatch(query,text){
  if(!query)return true;
  const q=query.toLowerCase().trim(),t=text.toLowerCase();
  if(t.includes(q))return true;
  const qWords=q.split(/\s+/),tWords=t.split(/\s+/);
  return qWords.every(qw=>tWords.some(tw=>tw.includes(qw)||qw.includes(tw)||levenshtein(qw,tw)<=2));
}

function onStoreSearch(val){
  storeSearchQuery=val;
  if(_searchDebounce)clearTimeout(_searchDebounce);
  _searchDebounce=setTimeout(()=>showHome(),200);
}

function productCard(p){
  const stock=p.totalStock!=null?p.totalStock:(p.stock||0);
  const stockBadge=stock>0?'<span class="stock-badge stock-instock">In Stock</span>':'<span class="stock-badge stock-order">Available to Order</span>';
  const img=p.imageUrl?'<img src="'+esc(p.imageUrl)+'">':'${ICONS.camera}';
  const teamPrice=p.teamPrice||0;
  const retailPrice=p.retailPrice||0;
  return '<div class="pc" onclick="showProduct(\\''+esc(p.id)+'\\')"><div class="pc-img">'+img+'</div><div class="pc-info">'+(p.brand?'<div class="pc-brand">'+esc(p.brand)+'</div>':'')+'<h3>'+esc(p.name)+'</h3><div class="pc-price-row"><div><span class="pc-price">$'+teamPrice.toFixed(2)+'</span>'+(retailPrice>teamPrice?' <span class="pc-retail">$'+retailPrice.toFixed(2)+'</span>':'')+'</div>'+stockBadge+'</div></div></div>';
}

async function showProduct(prodId){
  window._scrollPos=window.scrollY;
  currentView='product';
  document.getElementById('main-content').innerHTML='<div class="loading">Loading...</div>';
  const r=await fetch('/api/product/'+prodId+'?priceBookId='+encodeURIComponent(teamContext.priceBookId));
  if(!r.ok){showHome();return}
  const p=await r.json();
  window._currentProduct=p;
  window._pdQty=1;

  const img=p.imageUrl?'<img src="'+esc(p.imageUrl)+'">':'${ICONS.camera}';
  const stock=p.totalStock||p.stock||0;
  const stockHtml=stock>0?'<span class="stock-indicator si-green">In Stock - Available Now</span>':'<span class="stock-indicator si-blue">Available to Order</span>';

  let variantHtml='';
  if(p.variants&&p.variants.length>0){
    const {labels,columns}=parseVariantAttributes(p.variants);
    window._selectedVariant=null;
    if(labels.length>0){
      for(let i=0;i<labels.length;i++){
        variantHtml+='<div class="vg"><label>'+esc(labels[i])+'</label><div class="vo-group" data-attr-idx="'+i+'">';
        for(const val of columns[i]){variantHtml+='<button class="vo-btn" onclick="selectVariantOption(this,'+i+')" data-value="'+esc(val)+'">'+esc(val)+'</button>';}
        variantHtml+='</div></div>';
      }
    } else {
      variantHtml='<div class="vg"><label>Options</label><select id="variant-select" onchange="onVariantChange()"><option value="">Select an option</option>'+p.variants.map(v=>'<option value="'+esc(v.id)+'" data-stock="'+(v.stock||0)+'" data-team="'+(v.teamPrice||0)+'" data-retail="'+(v.retailPrice||0)+'" data-name="'+esc(v.name)+'">'+esc(v.name)+(v.stock>0?' (In Stock)':' (Available to Order)')+'</option>').join('')+'</select></div>';
    }
  }

  const m=document.getElementById('main-content');
  m.innerHTML='<a class="back-link" onclick="showHome()">${ICONS.back} Back</a><div class="pd"><div class="pd-layout"><div class="pd-image">'+img+'</div><div class="pd-info"><h2>'+esc(p.name)+'</h2>'+(p.brand?'<div class="pd-brand">'+esc(p.brand)+'</div>':'')+'<div class="price" id="pd-price">$'+(p.teamPrice||0).toFixed(2)+'</div>'+(p.retailPrice>(p.teamPrice||0)?'<div class="retail-price" id="pd-retail">$'+p.retailPrice.toFixed(2)+'</div>':'')+(p.description?'<div style="color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:16px" class="pd-desc">'+p.description+'</div>':'')+'<div id="pd-stock-info">'+stockHtml+'</div>'+variantHtml+'<div class="qty-row"><span style="color:#6b7280;font-size:13px;font-weight:500">Qty</span><button class="qty-btn" onclick="changeQty(-1)">-</button><span class="qty-val" id="pd-qty">1</span><button class="qty-btn" onclick="changeQty(1)">+</button></div><button class="btn btn-primary btn-full btn-lg" id="btn-add" onclick="addToCart()"'+(p.variants&&p.variants.length?' disabled':'')+'>Add to Cart</button></div></div></div>';
}

function parseVariantAttributes(variants){
  if(!variants||!variants.length)return{labels:[],columns:[]};
  const parts=variants.map(v=>(v.name||'').split(' / ').map(s=>s.trim()));
  const colCount=Math.max(...parts.map(p=>p.length));
  if(colCount<1)return{labels:[],columns:[]};
  const columns=[];
  for(let i=0;i<colCount;i++){
    const vals=[...new Set(parts.map(p=>p[i]).filter(Boolean))];
    columns.push(vals);
  }
  const labels=columns.map((vals,idx)=>{
    if(vals.some(v=>/^(Left|Right|LFT|RHT)$/i.test(v)))return'Hand';
    if(vals.every(v=>/^[0-9]+$/.test(v)))return'Flex';
    if(vals.some(v=>/^P[0-9]/.test(v)))return'Curve';
    if(vals.some(v=>/^(XS|S|M|L|XL|2XL|3XL|XXL|[0-9]+"?)$/i.test(v)))return'Size';
    if(vals.some(v=>/^(Black|White|Navy|Red|Blue|Grey|Charcoal|Green)$/i.test(v)))return'Color';
    return'Option '+(idx+1);
  });
  // Sort each column logically
  const sizeOrder={XS:1,S:2,M:3,L:4,XL:5,'2XL':6,XXL:6,'3XL':7};
  const handOrder={Left:1,LFT:1,Right:2,RHT:2};
  for(let i=0;i<columns.length;i++){
    if(labels[i]==='Size')columns[i].sort((a,b)=>(sizeOrder[a]||50+parseFloat(a)||99)-(sizeOrder[b]||50+parseFloat(b)||99));
    else if(labels[i]==='Flex')columns[i].sort((a,b)=>parseInt(a)-parseInt(b));
    else if(labels[i]==='Hand')columns[i].sort((a,b)=>(handOrder[a]||9)-(handOrder[b]||9));
    else if(labels[i]==='Curve')columns[i].sort();
    else if(labels[i]==='Color')columns[i].sort();
  }
  return{labels,columns};
}

function selectVariantOption(btn,attrIdx){
  // Toggle selection within this group
  const group=btn.closest('.vo-group');
  group.querySelectorAll('.vo-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
  onAttrChange();
}
function onAttrChange(){
  const groups=document.querySelectorAll('.vo-group[data-attr-idx]');
  const selected={};
  let allSelected=true;
  groups.forEach(g=>{
    const sel=g.querySelector('.vo-btn.selected');
    if(sel)selected[g.dataset.attrIdx]=sel.dataset.value;
    else allSelected=false;
  });
  const addBtn=document.getElementById('btn-add');
  if(!allSelected){addBtn.disabled=true;return;}
  const p=window._currentProduct;
  const match=p.variants.find(v=>{
    const pts=(v.name||'').split(' / ').map(s=>s.trim());
    return Object.entries(selected).every(([idx,val])=>pts[parseInt(idx)]===val);
  });
  addBtn.disabled=!match;
  if(match){
    document.getElementById('pd-price').textContent='$'+(match.teamPrice||0).toFixed(2);
    const retailEl=document.getElementById('pd-retail');
    if(retailEl)retailEl.textContent=match.retailPrice>match.teamPrice?'$'+match.retailPrice.toFixed(2):'';
    const si=document.getElementById('pd-stock-info');
    si.innerHTML=(match.stock||0)>0?'<span class="stock-indicator si-green">In Stock - Available Now</span>':'<span class="stock-indicator si-blue">Available to Order</span>';
    window._selectedVariant=match;
  }
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
  si.innerHTML=stock>0?'<span class="stock-indicator si-green">In Stock - Available Now</span>':'<span class="stock-indicator si-blue">Available to Order</span>';
}

function changeQty(d){window._pdQty=Math.max(1,(window._pdQty||1)+d);document.getElementById('pd-qty').textContent=window._pdQty}

function addToCart(){
  const p=window._currentProduct;
  if(!p)return;
  const varSel=document.getElementById('variant-select');
  let teamPrice=p.teamPrice||0;
  let variantName='';
  let lightspeedProductId=p.id;

  let stock=p.totalStock||p.stock||0;
  let supplierId=p.supplierId||null;
  let supplierName=p.supplierName||'';
  let supplyPrice=p.supplyPrice||0;

  // Use _selectedVariant from attribute dropdowns if available
  if(window._selectedVariant){
    const sv=window._selectedVariant;
    teamPrice=sv.teamPrice||teamPrice;
    variantName=sv.name||'';
    lightspeedProductId=sv.id;
    stock=sv.stock||0;
    if(sv.supplierId)supplierId=sv.supplierId;
    if(sv.supplierName)supplierName=sv.supplierName;
    if(sv.supplyPrice)supplyPrice=sv.supplyPrice;
  } else if(varSel&&varSel.value){
    const sv=p.variants.find(v=>v.id===varSel.value);
    if(sv){
      teamPrice=sv.teamPrice||teamPrice;
      variantName=sv.name||'';
      lightspeedProductId=sv.id;
      stock=sv.stock||0;
      if(sv.supplierId)supplierId=sv.supplierId;
      if(sv.supplierName)supplierName=sv.supplierName;
      if(sv.supplyPrice)supplyPrice=sv.supplyPrice;
    }
  }

  const ci={
    lightspeedProductId,
    name:p.name,
    variantName,
    teamPrice,
    price:teamPrice,
    qty:window._pdQty||1,
    imageUrl:p.imageUrl||null,
    stock,
    supplierId,
    supplierName,
    supplyPrice
  };
  const ei=cart.findIndex(c=>c.lightspeedProductId===ci.lightspeedProductId);
  if(ei>=0)cart[ei].qty+=ci.qty;
  else cart.push(ci);
  saveCart();
  showToast('Added to cart');
}

function saveCart(){sessionStorage.setItem('team_cart',JSON.stringify(cart));updateCartCount()}
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
    const r=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:cart,customer:{name:n,email:e,phone:ph},teamName:teamContext?.name||'',teamSlug:teamContext?.slug||''})});
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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Order Confirmed</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#f8f9fa;color:#1a1a2e}.rp{display:flex;align-items:center;justify-content:center;min-height:100vh}.rb{background:#fff;padding:48px;border-radius:12px;border:1px solid #e5e7eb;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08)}.rb h2{font-size:22px;font-weight:700;margin:16px 0 8px;color:#1a1a2e}.rb p{color:#6b7280;margin-bottom:24px;font-size:14px;line-height:1.6}.ri{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;background:#f0fdf4;color:#16a34a}.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;font-weight:500;cursor:pointer;background:#4f46e5;color:#fff;text-decoration:none;display:inline-block}</style></head><body><div class="rp"><div class="rb"><div class="ri">${ICONS.check}</div><h2>Order Confirmed</h2><p>Thanks for your order! We will have it ready for pickup at Ice Lab. You will receive a confirmation email shortly.</p><a href="/" class="btn">Continue Shopping</a></div></div><script>sessionStorage.removeItem('team_cart')</script></body></html>`;
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
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:24px}.card-header{padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}.card-header h3{font-size:15px;font-weight:600}.card-body{padding:20px}
table{width:100%;border-collapse:collapse}th{padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e5e7eb;border-right:1px solid #eee}th:last-child{border-right:none}td{padding:10px 16px;font-size:13px;border-bottom:1px solid #f0f0f0;border-right:1px solid #eee;vertical-align:middle}td:last-child{border-right:none}th:nth-child(odd){background:#f3f4f6}th:nth-child(even){background:#f8f9fa}td:nth-child(odd){background:#fafafa}td:nth-child(even){background:#fff}tr:hover td{background:#f5f3ff}
tr.parent-row.expanded td{background:#f5f3ff;border-left:3px solid #4f46e5}tr.parent-row.expanded td:first-child{border-left:3px solid #4f46e5}tr.variant-row td{background:#fafbff}tr.variant-row td:first-child{border-left:3px solid #e5e7eb}
.prod-name{font-weight:600;font-size:13px;color:#1a1a2e}.prod-sku{font-size:11px;color:#6b7280;margin-top:1px}.prod-cell{display:flex;align-items:center;gap:10px}.prod-thumb{width:40px;height:40px;border-radius:4px;background:#f0f1f3;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}.prod-thumb img{width:100%;height:100%;object-fit:cover}
.btn{padding:8px 16px;border-radius:6px;border:none;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit}.btn-primary{background:#4f46e5;color:#fff}.btn-primary:hover{background:#4338ca}.btn-outline{background:#fff;border:1px solid #d1d5db;color:#374151}.btn-outline:hover{background:#f9fafb}.btn-sm{padding:6px 12px;font-size:12px}.btn-danger{background:#dc2626;color:#fff}.btn-danger:hover{background:#b91c1c}.btn-ghost{background:none;border:none;color:#4f46e5;font-weight:500;cursor:pointer;font-size:13px;font-family:inherit;padding:0}.btn-ghost:hover{text-decoration:underline}
.fg{margin-bottom:14px}.fg label{display:block;font-size:12px;color:#374151;margin-bottom:4px;font-weight:600}.fg input,.fg textarea,.fg select{width:100%;padding:8px 12px;background:#fff;border:1px solid #d1d5db;border-radius:6px;color:#1a1a2e;font-size:13px;font-family:inherit;transition:border 0.15s}.fg input:focus,.fg textarea:focus,.fg select:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.fg-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.settings-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:24px;margin-bottom:20px}.settings-card h3{font-size:14px;font-weight:600;margin-bottom:16px;color:#1a1a2e}
.empty-state{text-align:center;color:#6b7280;padding:40px;font-size:14px}
.badge-status{padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;display:inline-block}.badge-success{background:#f0fdf4;color:#16a34a}.badge-warning{background:#fffbeb;color:#d97706}.badge-error{background:#fef2f2;color:#dc2626}.badge-info{background:#eff6ff;color:#2563eb}
.search-bar{background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.search-input{flex:1;position:relative;min-width:200px}.search-input input{width:100%;padding:8px 12px 8px 32px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#1a1a2e;background:#fff;font-family:inherit;transition:border 0.15s}.search-input input:focus{border-color:#4f46e5;outline:none;box-shadow:0 0 0 3px rgba(79,70,229,0.1)}.search-input input::placeholder{color:#9ca3af}.search-input .search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#9ca3af;display:flex}
.filter-select{padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#1a1a2e;background:#fff;font-family:inherit;cursor:pointer}
.stat-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px}.stat-card .label{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-weight:600;margin-bottom:4px}.stat-card .value{font-size:22px;font-weight:700;color:#1a1a2e}
.team-row{display:flex;gap:12px;align-items:flex-end;padding:12px 16px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px;flex-wrap:wrap}.team-row .fg{margin-bottom:0;flex:1;min-width:120px}.team-row .fg.narrow{max-width:100px}.team-row .fg.wide{min-width:200px}
.toggle{position:relative;width:36px;height:20px;display:inline-block}.toggle input{opacity:0;width:0;height:0}.toggle-slider{position:absolute;cursor:pointer;inset:0;background:#d1d5db;border-radius:20px;transition:0.15s}.toggle-slider:before{content:'';position:absolute;height:16px;width:16px;left:2px;bottom:2px;background:#fff;border-radius:50%;transition:0.15s}.toggle input:checked+.toggle-slider{background:#4f46e5}.toggle input:checked+.toggle-slider:before{transform:translateX(16px)}
.toast{position:fixed;bottom:24px;right:24px;background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;z-index:600;transform:translateY(60px);opacity:0;transition:all 0.25s}.toast.show{transform:translateY(0);opacity:1}
@media(max-width:768px){.sidebar{display:none;position:fixed;top:0;left:0;bottom:0;z-index:301;box-shadow:4px 0 12px rgba(0,0,0,0.1)}.sidebar.open{display:flex}.sidebar-overlay.open{display:block}.mobile-header{display:flex}.admin-content{padding:16px}.admin-topbar{padding:0 16px}.fg-row{grid-template-columns:1fr}.stat-cards{grid-template-columns:1fr 1fr}.team-row{flex-direction:column}}
</style></head><body>
<div id="admin-pin-screen"><div class="pin-box"><h1>Admin Access</h1><p>Enter admin PIN</p><div class="pin-dots"><input type="tel" maxlength="1" autofocus><input type="tel" maxlength="1"><input type="tel" maxlength="1"><input type="tel" maxlength="1"></div><div class="pin-error" id="pin-error"></div></div></div>
<div id="admin-app" style="display:none">
<div class="mobile-header"><button class="hamburger" onclick="toggleSidebar()">${ICONS.menu}</button><h1>Ice Lab Team Store <span class="badge">Admin</span></h1><a href="/">${ICONS.store}</a></div>
<div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
<div class="admin-layout">
<aside class="sidebar" id="sidebar"><div class="sidebar-brand">Ice Lab Team Store <span class="badge">Admin</span></div><nav class="sidebar-nav">
<button class="active" onclick="showTab('products')" data-tab="products">${ICONS.products} Products</button>
<button onclick="showTab('orders')" data-tab="orders">${ICONS.orders} Recent Orders</button>
<button onclick="showTab('settings')" data-tab="settings">${ICONS.settings} Settings</button>
</nav><div class="sidebar-footer"><a href="/">${ICONS.store} View Store</a></div></aside>
<div class="admin-main">
<div class="admin-topbar" id="admin-topbar"><h2 id="topbar-title">Import Products</h2><div class="admin-topbar-actions" id="topbar-actions"><a href="/">${ICONS.store} View Store</a></div></div>
<div class="admin-content" id="admin-content"></div>
</div></div></div>
<div class="toast" id="toast"></div>
<script>
let adminTeams=[],importProducts=[],allProducts=[],adminOrders=[],adminConfig={};
let currentTab='products',searchQuery='',selectedTeamIdx=0;
const IC=${JSON.stringify(ICONS)};

// PIN
const pinInputs=document.querySelectorAll('.pin-dots input');
pinInputs.forEach((inp,i)=>{
  inp.addEventListener('input',()=>{inp.value=inp.value.replace(/[^0-9]/g,'').slice(0,1);if(inp.value){if(i<pinInputs.length-1)pinInputs[i+1].focus();else checkAdminPin()}});
  inp.addEventListener('keydown',e=>{if(e.key==='Backspace'){if(!inp.value&&i>0){pinInputs[i-1].value='';pinInputs[i-1].focus()}else{inp.value=''}}});
  inp.addEventListener('focus',()=>inp.select());
});
async function checkAdminPin(){const pin=Array.from(pinInputs).map(i=>i.value).join('');if(pin.length<4)return;try{const r=await fetch('/api/verify-admin-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){sessionStorage.setItem('admin_pin',pin);document.getElementById('admin-pin-screen').style.display='none';document.getElementById('admin-app').style.display='';loadAdmin()}else{document.getElementById('pin-error').textContent='Invalid PIN';pinInputs.forEach(i=>i.value='');pinInputs[0].focus()}}catch(e){document.getElementById('pin-error').textContent='Connection error'}}
if(sessionStorage.getItem('admin_pin')){document.getElementById('admin-pin-screen').style.display='none';document.getElementById('admin-app').style.display='';loadAdmin()}

function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('sidebar-overlay').classList.toggle('open')}

async function loadAdmin(){
  try{
    const[tr,cr]=await Promise.all([fetch('/api/admin/teams'),fetch('/api/admin/config')]);
    adminTeams=await tr.json();
    adminConfig=await cr.json();
  }catch(e){console.error(e)}
  showTab(currentTab);
}

function showTab(tab){
  currentTab=tab;
  document.querySelectorAll('.sidebar-nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  if(tab==='products')renderImport();
  else if(tab==='orders')renderOrders();
  else if(tab==='settings')renderSettings();
}

function setTopbar(title,actions){document.getElementById('topbar-title').textContent=title;document.getElementById('topbar-actions').innerHTML=actions||'<a href="/">${ICONS.store} View Store</a>'}

// ============ IMPORT PRODUCTS ============
async function renderImport(){
  setTopbar('Products');
  const c=document.getElementById('admin-content');
  if(!adminTeams.length){
    c.innerHTML='<div class="settings-card"><h3>No Teams Configured</h3><p style="color:#6b7280;margin-bottom:16px">Add teams in the Settings tab first, then come back here to sync their price book products.</p><button class="btn btn-primary" onclick="showTab(\\\'settings\\\')">Go to Settings</button></div>';
    return;
  }

  const enabledTeams=adminTeams.filter(t=>t.enabled&&t.priceBookId);
  if(!enabledTeams.length){
    c.innerHTML='<div class="settings-card"><h3>No Enabled Teams</h3><p style="color:#6b7280">Enable at least one team with a Price Book ID in Settings.</p></div>';
    return;
  }

  // Team selector
  if(selectedTeamIdx>=enabledTeams.length)selectedTeamIdx=0;
  const team=enabledTeams[selectedTeamIdx];

  c.innerHTML='<div style="margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><select class="filter-select" id="team-select" onchange="selectedTeamIdx=this.selectedIndex;renderImport()">'+enabledTeams.map((t,i)=>'<option'+(i===selectedTeamIdx?' selected':'')+'>'+esc(t.name)+'</option>').join('')+'</select><button class="btn btn-primary btn-sm" onclick="syncTeam(\\''+esc(team.priceBookId)+'\\',\\''+esc(team.name)+'\\')\" id="sync-btn">${ICONS.sync} Sync Price Book</button></div><div class="loading" id="import-loading">Loading products...</div>';

  try{
    const r=await fetch('/api/admin/import-products?priceBookId='+encodeURIComponent(team.priceBookId));
    const data=await r.json();
    importProducts=data.products||[];
    renderImportTable(team);
  }catch(e){
    document.getElementById('import-loading').innerHTML='<p style="color:#dc2626">Failed to load: '+esc(e.message)+'</p>';
  }
}

function renderImportTable(team){
  const c=document.getElementById('admin-content');

  // Two-pass grouping: first collect all parentIds, then assign
  const parentMap={};
  const childProducts=[];
  const parentProducts=[];
  // Pass 1: identify all parentIds from children
  for(const p of importProducts){
    if(p.parentId){
      childProducts.push(p);
      if(!parentMap[p.parentId])parentMap[p.parentId]={products:[],name:p.name};
    }else{
      parentProducts.push(p);
    }
  }
  // Pass 2: add children to their groups
  for(const p of childProducts){
    parentMap[p.parentId].products.push(p);
  }

  // Build parent groups
  let groups=[];
  for(const[parentId,group] of Object.entries(parentMap)){
    const totalStock=group.products.reduce((s,p)=>s+(p.stock||0),0);
    const minTeam=Math.min(...group.products.map(p=>p.teamPrice||999999));
    const minRetail=Math.min(...group.products.map(p=>p.retailPrice||999999));
    const firstSku=group.products[0]?.sku||'';
    groups.push({parentId,name:group.name,sku:firstSku,variantCount:group.products.length,totalStock,teamPrice:minTeam,retailPrice:minRetail,imageUrl:group.products.find(p=>p.imageUrl)?.imageUrl||null,variants:group.products});
  }
  // Only add truly standalone products (not parent products whose children are already grouped)
  for(const p of parentProducts){
    if(!parentMap[p.lightspeedProductId]){
      groups.push({parentId:p.lightspeedProductId,name:p.name,sku:p.sku||'',variantCount:0,totalStock:p.stock||0,teamPrice:p.teamPrice,retailPrice:p.retailPrice,imageUrl:p.imageUrl,variants:[]});
    }
  }

  // Filter
  if(searchQuery){const q=searchQuery.toLowerCase();groups=groups.filter(g=>(g.name||'').toLowerCase().includes(q)||g.variants.some(v=>(v.sku||'').toLowerCase().includes(q)||(v.variantLabel||'').toLowerCase().includes(q)||(v.variantName||'').toLowerCase().includes(q)))}

  const enabledTeams=adminTeams.filter(t=>t.enabled&&t.priceBookId);
  const totalItems=importProducts.length;
  const totalStock=importProducts.reduce((s,p)=>s+(p.stock||0),0);
  const parentCount=groups.length;

  let html='<div class="stat-cards">'+
    '<div class="stat-card"><div class="label">Price Book Items</div><div class="value">'+totalItems+'</div></div>'+
    '<div class="stat-card"><div class="label">Products</div><div class="value">'+parentCount+'</div></div>'+
    '<div class="stat-card"><div class="label">Total Stock</div><div class="value">'+totalStock+'</div></div>'+
  '</div>';

  html+='<div style="margin-bottom:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><select class="filter-select" id="team-select" onchange="selectedTeamIdx=this.selectedIndex;renderImport()">'+enabledTeams.map((t,i)=>'<option'+(i===selectedTeamIdx?' selected':'')+'>'+esc(t.name)+'</option>').join('')+'</select><button class="btn btn-primary btn-sm" onclick="syncTeam(\\''+esc(team.priceBookId)+'\\',\\''+esc(team.name)+'\\')\" id="sync-btn">${ICONS.sync} Sync Price Book</button></div>';

  html+='<div class="card"><div class="card-header"><h3>'+esc(team.name)+' - Price Book Products</h3></div>';
  html+='<div class="search-bar"><div class="search-input"><span class="search-icon">${ICONS.search}</span><input id="import-search" placeholder="Search by name, SKU, variant..." value="'+esc(searchQuery)+'" oninput="searchQuery=this.value;renderImportTable(adminTeams.filter(t=>t.enabled&&t.priceBookId)[selectedTeamIdx])"></div></div>';

  if(groups.length===0){
    html+='<div class="empty-state">'+(importProducts.length===0?'No products in this price book. Click "Sync Price Book" to load.':'No products match your search.')+'</div>';
  }else{
    html+='<div style="overflow-x:auto"><table><thead><tr><th style="width:30px"></th><th>Product</th><th>SKU</th><th>Retail</th><th>Team Price</th><th>Stock</th></tr></thead><tbody>';
    for(const g of groups){
      const hasVariants=g.variants.length>0;
      const chevron=hasVariants?'<button class="edit-btn" onclick="event.stopPropagation();toggleVariants(\\''+g.parentId+'\\',this)" style="transition:transform 0.15s;transform:rotate(180deg)">${ICONS.back}</button>':'';
      if(hasVariants){
        html+='<tr class="parent-row" style="cursor:pointer" onclick="toggleVariants(\\''+g.parentId+'\\',this.querySelector(\\'button\\'))"><td style="text-align:center">'+chevron+'</td><td><strong>'+esc(g.name)+'</strong> <span style="color:#6b7280;font-size:11px">('+g.variantCount+' variants)</span></td><td></td><td style="color:#6b7280;font-size:12px">$'+(g.retailPrice||0).toFixed(2)+'</td><td style="font-weight:600;color:#4f46e5">$'+(g.teamPrice||0).toFixed(2)+'</td><td style="font-weight:600">'+g.totalStock+'</td></tr>';
      }else{
        html+='<tr><td></td><td><strong>'+esc(g.name)+'</strong></td><td style="color:#6b7280;font-size:12px">'+esc(g.sku||'-')+'</td><td style="color:#6b7280;font-size:12px">$'+(g.retailPrice||0).toFixed(2)+'</td><td style="font-weight:600;color:#4f46e5">$'+(g.teamPrice||0).toFixed(2)+'</td><td style="font-weight:600">'+g.totalStock+'</td></tr>';
      }
      // Variant rows - hidden by default, sorted
      if(hasVariants){
        const sorted=[...g.variants].sort(sortVariantLabel);
        for(const v of sorted){
          html+='<tr class="variant-row vr-'+g.parentId+'" style="display:none"><td></td><td style="padding-left:32px;color:#6b7280;font-size:12px">'+esc(v.variantLabel||v.variantName||'-')+'</td><td style="color:#6b7280;font-size:12px">'+esc(v.sku||'-')+'</td><td style="font-size:12px">$'+(v.retailPrice||0).toFixed(2)+'</td><td style="font-weight:600;color:#4f46e5;font-size:12px">$'+(v.teamPrice||0).toFixed(2)+'</td><td style="font-weight:600">'+(v.stock||0)+'</td></tr>';
        }
      }
    }
    html+='</tbody></table></div>';
  }
  html+='</div>';
  c.innerHTML=html;
}

function toggleVariants(parentId,btn){
  const rows=document.querySelectorAll('.vr-'+CSS.escape(parentId));
  const showing=rows[0]&&rows[0].style.display!=='none';
  if(!showing){
    // Close all other open groups first
    document.querySelectorAll('.variant-row').forEach(r=>{if(!r.classList.contains('vr-'+parentId))r.style.display='none'});
    document.querySelectorAll('.parent-row').forEach(r=>{r.classList.remove('expanded')});
    document.querySelectorAll('.edit-btn').forEach(b=>{if(b!==btn)b.style.transform='rotate(180deg)'});
  }
  rows.forEach(r=>r.style.display=showing?'none':'table-row');
  if(btn){btn.style.transform=showing?'rotate(180deg)':'rotate(270deg)';
    const parentRow=btn.closest('tr');
    if(parentRow){parentRow.classList.toggle('expanded',!showing)}
  }
}
function sortVariantLabel(a,b){
  const sizeOrder={XS:1,S:2,M:3,L:4,XL:5,'2XL':6,XXL:6,'3XL':7};
  const pa=(a.variantLabel||a.variantName||'').split(' / ').map(s=>s.trim());
  const pb=(b.variantLabel||b.variantName||'').split(' / ').map(s=>s.trim());
  for(let i=0;i<Math.max(pa.length,pb.length);i++){
    const va=pa[i]||'',vb=pb[i]||'';
    // Size sort
    if(sizeOrder[va]||sizeOrder[vb]){const d=(sizeOrder[va]||50)-(sizeOrder[vb]||50);if(d)return d;continue}
    // Numeric sort (flex) - descending for flex
    const na=parseFloat(va),nb=parseFloat(vb);
    if(!isNaN(na)&&!isNaN(nb)){const d=nb-na;if(d)return d;continue}
    // Alpha sort
    const d=va.localeCompare(vb);if(d)return d;
  }
  return 0;
}
async function syncTeam(priceBookId,teamName){
  const btn=document.getElementById('sync-btn');
  if(btn){btn.disabled=true;btn.innerHTML='Syncing...';}
  try{
    const r=await fetch('/api/admin/lightspeed/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({priceBookId})});
    const data=await r.json();
    if(data.success){
      showToast('Synced '+data.totalProducts+' products for '+teamName);
      renderImport();
    }else{showToast('Sync failed: '+(data.error||'Unknown error'))}
  }catch(e){showToast('Sync failed: '+e.message)}
  finally{if(btn){btn.disabled=false;btn.innerHTML=IC.sync+' Sync Price Book'}}
}

// ============ PRODUCTS ============
async function renderProducts(){
  setTopbar('Products');
  const c=document.getElementById('admin-content');
  c.innerHTML='<div class="loading">Loading products across all teams...</div>';
  try{
    const r=await fetch('/api/admin/products');
    allProducts=await r.json();
  }catch(e){allProducts=[];}

  // Group by team
  const byTeam={};
  for(const p of allProducts){
    const k=p.teamName||'Unknown';
    if(!byTeam[k])byTeam[k]=[];
    byTeam[k].push(p);
  }

  let html='<div class="stat-cards"><div class="stat-card"><div class="label">Total Items</div><div class="value">'+allProducts.length+'</div></div><div class="stat-card"><div class="label">Teams</div><div class="value">'+Object.keys(byTeam).length+'</div></div></div>';

  for(const[teamName,prods] of Object.entries(byTeam)){
    // Two-pass grouping: first collect parentIds from children, then filter standalones
    const parents={};
    const childProds=[];
    const parentProds=[];
    for(const p of prods){
      if(p.parentId){childProds.push(p);if(!parents[p.parentId])parents[p.parentId]={name:p.name,items:[]};}
      else parentProds.push(p);
    }
    for(const p of childProds){parents[p.parentId].items.push(p);}
    const standaloneP=parentProds.filter(p=>!parents[p.lightspeedProductId]);
    const groupCount=Object.keys(parents).length+standaloneP.length;

    html+='<div class="card"><div class="card-header"><h3>'+esc(teamName)+'</h3><span class="badge-status badge-info">'+groupCount+' products ('+prods.length+' items)</span></div><div style="overflow-x:auto"><table><thead><tr><th style="width:30px"></th><th>Product</th><th>SKU</th><th>Team Price</th><th>Retail</th><th>Stock</th></tr></thead><tbody>';

    for(const[pid,group] of Object.entries(parents)){
      const totalStock=group.items.reduce((s,p)=>s+(p.stock||0),0);
      const minTeam=Math.min(...group.items.map(p=>p.teamPrice||999999));
      const minRetail=Math.min(...group.items.map(p=>p.retailPrice||999999));
      const minTeamP=Math.min(...group.items.map(p=>p.teamPrice||999999));
      const minRetailP=Math.min(...group.items.map(p=>p.retailPrice||999999));
      const totalStockP=group.items.reduce((s,p)=>s+(p.stock||0),0);
      html+='<tr class="parent-row" style="cursor:pointer" onclick="toggleVariants(\\'pv-'+pid+'\\',this.querySelector(\\'button\\'))"><td style="text-align:center"><button class="edit-btn" onclick="event.stopPropagation();toggleVariants(\\'pv-'+pid+'\\',this)" style="transition:transform 0.15s;transform:rotate(180deg)">${ICONS.back}</button></td><td><strong>'+esc(group.name)+'</strong> <span style="color:#6b7280;font-size:11px">('+group.items.length+' variants)</span></td><td></td><td style="font-weight:600;color:#4f46e5">$'+minTeamP.toFixed(2)+'</td><td style="color:#9ca3af">$'+minRetailP.toFixed(2)+'</td><td style="font-weight:600">'+totalStockP+'</td></tr>';
      const sortedItems=[...group.items].sort(sortVariantLabel);
      for(const p of sortedItems){
        html+='<tr class="variant-row pv-'+pid+'" style="display:none"><td></td><td style="padding-left:32px;color:#6b7280;font-size:12px">'+esc(p.variantLabel||p.variantName||'-')+'</td><td style="color:#6b7280;font-size:12px">'+esc(p.sku||'-')+'</td><td style="font-weight:600;color:#4f46e5;font-size:12px">$'+(p.teamPrice||0).toFixed(2)+'</td><td style="font-size:12px">$'+(p.retailPrice||0).toFixed(2)+'</td><td style="font-weight:600">'+(p.stock||0)+'</td></tr>';
      }
    }
    for(const p of standaloneP){
      html+='<tr><td></td><td><div class="prod-name">'+esc(p.name)+'</div></td><td style="color:#6b7280;font-size:12px">'+esc(p.sku||'-')+'</td><td style="font-weight:600;color:#4f46e5">$'+(p.teamPrice||0).toFixed(2)+'</td><td style="color:#9ca3af">$'+(p.retailPrice||0).toFixed(2)+'</td><td>'+(p.stock||0)+'</td></tr>';
    }

    html+='</tbody></table></div></div>';
  }

  if(!allProducts.length) html+='<div class="empty-state">No products synced yet. Go to Import Products to sync a team\\'s price book.</div>';
  html+='<p style="color:#6b7280;font-size:12px;text-align:center;margin-top:8px">Product prices and availability are managed in Lightspeed POS.</p>';
  c.innerHTML=html;
}

// ============ ORDERS ============
async function renderOrders(){
  setTopbar('Recent Orders');
  const c=document.getElementById('admin-content');
  c.innerHTML='<div class="loading">Loading orders...</div>';
  try{
    const r=await fetch('/api/admin/orders');
    adminOrders=await r.json();
  }catch(e){adminOrders=[];}

  if(!adminOrders.length){c.innerHTML='<div class="empty-state">No orders yet.</div>';return}

  let html='<div class="card"><div class="card-header"><h3>Recent Orders</h3><span style="color:#6b7280;font-size:12px">Manage orders in Lightspeed POS</span></div><div style="overflow-x:auto"><table><thead><tr><th>Order</th><th>Team</th><th>Customer</th><th>Items</th><th>Total</th><th>Lightspeed</th><th>Date</th></tr></thead><tbody>';
  for(const o of adminOrders){
    const num=o.id.slice(-6).toUpperCase();
    const lsStatus=o.lightspeedSaleId?'<span class="badge-status badge-success">Synced</span>':(o.lightspeedSyncFailed?'<span class="badge-status badge-error">Failed</span>':'<span class="badge-status badge-warning">Pending</span>');
    html+='<tr><td style="font-weight:600">#'+num+'</td><td>'+esc(o.teamName||'-')+'</td><td><div>'+esc(o.customer?.name||'-')+'</div><div style="font-size:11px;color:#6b7280">'+esc(o.customer?.email||'')+'</div></td><td>'+(o.items?.length||0)+'</td><td style="font-weight:600">$'+(o.total||0).toFixed(2)+'</td><td>'+lsStatus+'</td><td style="color:#6b7280;font-size:12px">'+new Date(o.createdAt).toLocaleDateString()+'</td></tr>';
  }
  html+='</tbody></table></div></div>';
  c.innerHTML=html;
}

// ============ SETTINGS ============
async function renderSettings(){
  setTopbar('Settings');
  const c=document.getElementById('admin-content');

  let html='';

  // Store Config
  html+='<div class="settings-card"><h3>Store Configuration</h3><div class="fg-row"><div class="fg"><label>Store Name</label><input id="cfg-store-name" value="'+esc(adminConfig.storeName||'Ice Lab Team Store')+'"></div><div class="fg"><label>Admin PIN</label><input id="cfg-admin-pin" value="'+esc(adminConfig.adminPin||'9999')+'" maxlength="4"></div></div><button class="btn btn-primary btn-sm" onclick="saveConfig()" style="margin-top:8px">Save Configuration</button></div>';

  // Teams
  html+='<div class="settings-card"><h3>Teams Management</h3><p style="color:#6b7280;font-size:13px;margin-bottom:16px">Each team has its own PIN and Lightspeed Price Book for team-specific pricing.</p><div id="teams-list">';
  for(let i=0;i<adminTeams.length;i++){
    const t=adminTeams[i];
    html+=teamRowHtml(i,t);
  }
  html+='</div><button class="btn btn-outline btn-sm" onclick="addTeam()" style="margin-top:8px">${ICONS.plus} Add Team</button><div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="saveTeams()">Save Teams</button></div></div>';

  // Lightspeed
  html+='<div class="settings-card"><h3>Lightspeed Integration</h3><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-outline btn-sm" onclick="testLightspeed()">Test Connection</button><button class="btn btn-primary btn-sm" onclick="fullSync()">Full Sync All Teams</button></div><div id="ls-status" style="margin-top:12px;font-size:13px;color:#6b7280"></div></div>';

  // Stripe
  html+='<div class="settings-card"><h3>Stripe Integration</h3><div class="fg"><label>Publishable Key</label><input id="cfg-stripe-pk" value="'+esc(adminConfig.stripePublishableKey||'')+'" placeholder="pk_..."></div><div class="fg"><label>Secret Key</label><input id="cfg-stripe-sk" value="'+esc(adminConfig.stripeSecretKey||'')+'" placeholder="sk_..." type="password"></div><div class="fg"><label>Webhook Secret</label><input id="cfg-stripe-wh" value="'+esc(adminConfig.stripeWebhookSecret||'')+'" placeholder="whsec_..." type="password"></div><button class="btn btn-primary btn-sm" onclick="saveStripe()">Save Stripe Settings</button></div>';

  c.innerHTML=html;
}

function teamRowHtml(i,t){
  return '<div class="team-row" id="team-row-'+i+'"><div class="fg wide"><label>Team Name</label><input id="team-name-'+i+'" value="'+esc(t.name||'')+'" placeholder="Lynn University Hockey"></div><div class="fg narrow"><label>Slug</label><input id="team-slug-'+i+'" value="'+esc(t.slug||'')+'" placeholder="lynn"></div><div class="fg narrow"><label>PIN</label><input id="team-pin-'+i+'" value="'+esc(t.pin||'')+'" maxlength="4" placeholder="1234"></div><div class="fg wide"><label>Price Book ID</label><input id="team-pb-'+i+'" value="'+esc(t.priceBookId||'')+'" placeholder="UUID from Lightspeed"></div><div class="fg"><label>Logo URL</label><input id="team-logo-'+i+'" value="'+esc(t.logoUrl||'')+'" placeholder="https://..."></div><div style="display:flex;align-items:center;gap:8px;padding-bottom:4px"><label class="toggle"><input type="checkbox" id="team-enabled-'+i+'"'+(t.enabled?' checked':'')+'><span class="toggle-slider"></span></label><button class="btn btn-danger btn-sm" onclick="removeTeam('+i+')" title="Remove">${ICONS.trash}</button></div></div>';
}

function addTeam(){
  adminTeams.push({name:'',slug:'',pin:'',priceBookId:'',logoUrl:'',enabled:true});
  const list=document.getElementById('teams-list');
  const i=adminTeams.length-1;
  list.insertAdjacentHTML('beforeend',teamRowHtml(i,adminTeams[i]));
}

function removeTeam(i){
  adminTeams.splice(i,1);
  renderSettings();
}

function readTeamsFromForm(){
  const teams=[];
  for(let i=0;i<adminTeams.length;i++){
    const nameEl=document.getElementById('team-name-'+i);
    if(!nameEl)continue;
    teams.push({
      name:nameEl.value.trim(),
      slug:document.getElementById('team-slug-'+i).value.trim().toLowerCase().replace(/[^a-z0-9-]/g,''),
      pin:document.getElementById('team-pin-'+i).value.trim(),
      priceBookId:document.getElementById('team-pb-'+i).value.trim(),
      logoUrl:document.getElementById('team-logo-'+i).value.trim(),
      enabled:document.getElementById('team-enabled-'+i).checked
    });
  }
  return teams.filter(t=>t.name);
}

async function saveTeams(){
  const teams=readTeamsFromForm();
  try{
    const r=await fetch('/api/admin/teams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({teams})});
    if(r.ok){adminTeams=teams;showToast('Teams saved')}
    else showToast('Save failed');
  }catch(e){showToast('Error: '+e.message)}
}

async function saveConfig(){
  const data={
    storeName:document.getElementById('cfg-store-name').value.trim()||'Ice Lab Team Store',
    adminPin:document.getElementById('cfg-admin-pin').value.trim()||'9999'
  };
  try{
    const r=await fetch('/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(r.ok){adminConfig={...adminConfig,...data};showToast('Configuration saved')}
    else showToast('Save failed');
  }catch(e){showToast('Error: '+e.message)}
}

async function saveStripe(){
  const data={
    stripePublishableKey:document.getElementById('cfg-stripe-pk').value.trim(),
    stripeSecretKey:document.getElementById('cfg-stripe-sk').value.trim(),
    stripeWebhookSecret:document.getElementById('cfg-stripe-wh').value.trim()
  };
  try{
    const r=await fetch('/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(r.ok){adminConfig={...adminConfig,...data};showToast('Stripe settings saved')}
    else showToast('Save failed');
  }catch(e){showToast('Error: '+e.message)}
}

async function testLightspeed(){
  const el=document.getElementById('ls-status');
  el.innerHTML='Testing connection...';
  try{
    const r=await fetch('/api/admin/lightspeed/test');
    const data=await r.json();
    if(data.success){el.innerHTML='<span style="color:#16a34a">'+esc(data.message)+'</span>'}
    else{el.innerHTML='<span style="color:#dc2626">'+esc(data.error||'Connection failed')+'</span>'}
  }catch(e){el.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'}
}

async function fullSync(){
  const el=document.getElementById('ls-status');
  el.innerHTML='Syncing all teams...';
  try{
    const r=await fetch('/api/admin/lightspeed/sync-all',{method:'POST'});
    const data=await r.json();
    if(data.success){
      const summary=data.results.map(r=>r.team+': '+(r.success?r.products+' products':'FAILED - '+r.error)).join(', ');
      el.innerHTML='<span style="color:#16a34a">Sync complete. '+esc(summary)+'</span>';
    }else{el.innerHTML='<span style="color:#dc2626">'+esc(data.error||'Sync failed')+'</span>'}
  }catch(e){el.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'}
}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
</script></body></html>`;
}
