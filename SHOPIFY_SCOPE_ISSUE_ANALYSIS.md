# Shopify Scope Mismatch Issue - Root Cause Analysis

## The Problem
**Error**: `shopify 403: {"errors":"[API] This app is not approved to access REST endpoints with protected customer data.`

Your app cannot import orders from Shopify because it's missing the required API scope to access protected customer data.

---

## Root Cause

### Current Scopes
Both your app configuration and code request only:
- `read_orders`
- `read_customers`

**File 1**: `shopify.app.toml` (line 11)
```toml
scopes = "read_customers,read_orders"
```

**File 2**: `apps/api/src/server/routers/integrations.ts` (line 122)
```typescript
scopes: z.array(z.string()).default(["read_orders", "read_customers"]),
```

### Why It Fails

The `/admin/api/2024-04/orders.json` REST endpoint returns orders with **protected customer data** fields that require explicit permissions:

- `customer.email` ← Protected customer data
- `customer.phone` ← Protected customer data  
- `customer.first_name` ← Protected customer data
- `customer.last_name` ← Protected customer data
- `shipping_address.*` ← Protected customer data

These fields are extracted in your normalization code (`apps/api/src/lib/integrations/shopify.ts`, line 141-198 in `normalizeShopifyOrder()`):
```typescript
customer: {
  name,      // Built from first_name + last_name
  phone,     // customer.phone
  email,     // customer.email or payload.email
  address,   // shipping_address
  district,
}
```

**Shopify's Policy**: To access this data via REST API, you must have the `read_customers_private_data` scope. This applies as of **mid-2026** when Shopify began strictly enforcing access control on protected fields.

---

## The Fix Plan

### ✅ Step 1: Update `shopify.app.toml`
Add `read_customers_private_data` to the required scopes.

**File**: `shopify.app.toml`
```toml
[access_scopes]
scopes = "read_customers_private_data,read_orders"
optional_scopes = [ "read_checkouts", "read_fulfillments", "read_products" ]
```

### ✅ Step 2: Update Default Scopes in Integration Router
Add `read_customers_private_data` to the default scope array.

**File**: `apps/api/src/server/routers/integrations.ts` (line 122)
```typescript
scopes: z.array(z.string()).default(["read_orders", "read_customers_private_data"]),
```

### ✅ Step 3: Re-authorize Shopify
After deploying these changes:
1. Go to ConfirmX dashboard → Settings → Integrations
2. Disconnect your Shopify store
3. Click "Connect Shopify" again
4. You'll be prompted to approve the **new** scopes
5. Accept the scope approval dialog
6. The integration will now have the required permissions

### ✅ Step 4: Test Import
After reconnection, verify that:
- The connection test passes
- You can fetch sample orders
- Orders import with customer data intact

---

## Why This Happened

Shopify phased in enforcement of protected customer data access:
- **Before 2026**: Endpoints returned protected data even without explicit scopes
- **Mid-2026+**: Shopify rejects requests for protected data without the proper scope
- Your app was built with older assumptions and needs updating

---

## Why `read_customers` Isn't Enough

The `read_customers` scope gives you access to the **Customers API** (`/admin/api/2024-04/customers/{id}.json`), which is different from accessing customer data **embedded in orders** through the Orders API.

For orders data: You need `read_customers_private_data` (not `read_customers`).

---

## Files to Change

| File | Line | Current | New |
|------|------|---------|-----|
| `shopify.app.toml` | 11 | `scopes = "read_customers,read_orders"` | `scopes = "read_customers_private_data,read_orders"` |
| `apps/api/src/server/routers/integrations.ts` | 122 | `["read_orders", "read_customers"]` | `["read_orders", "read_customers_private_data"]` |

---

## References

- [Shopify Protected Customer Data Docs](https://shopify.dev/docs/apps/launch/protected-customer-data)
- [Shopify Access Scopes](https://shopify.dev/docs/api/admin-rest/2024-04#access_scopes)
- Shopify API Version: `2024-04` (as seen in your code at line 72 of `shopify.ts`)
