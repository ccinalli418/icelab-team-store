# Ice Lab Team Store - Development Rules

## CRITICAL: Deployment
- **Deploy command**: `npx wrangler deploy` (NO `--name` flag!)
- **wrangler.toml name**: `icelab-team-store`
- **Worker URL**: `https://icelab-team-store.chris-2b8.workers.dev`
- This is a SEPARATE project from ice-lab-memberships

## File Structure
- Main worker: `worker.js`
- Single file contains all server-side and client-side code
- Config: `wrangler.toml`

## KV Namespace
- `STORE_DATA` — all store data (products, categories, orders, config)

## KV Key Schema
- `config` — store settings (name, PINs, Stripe keys)
- `category:{id}` — category object
- `categories` — array of category IDs
- `product:{id}` — product object with variants
- `products` — array of product IDs
- `order:{id}` — order object
- `orders` — array of order IDs (newest first)

## Store Access
- Storefront is PIN-protected (configurable in admin)
- Admin panel has separate PIN at `/admin`
- Guest checkout only, local pickup only

## Stripe Integration
- Uses Stripe Checkout (redirect flow)
- Webhook at `POST /api/stripe/webhook`
- Orders created on `checkout.session.completed` event
- Stock decremented on successful payment
