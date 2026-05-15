# Shopify Scope Fix - Changes Verification

All changes have been applied successfully. Here's exactly what was changed:

---

## File 1: shopify.app.toml

**Location**: Line 11  
**What changed**: Scope configuration

```diff
[access_scopes]
# Learn more at https://shopify.dev/docs/apps/tools/cli/configuration#access_scopes
- scopes = "read_customers,read_orders"
+ scopes = "read_customers_private_data,read_orders"
optional_scopes = [ "read_checkouts", "read_fulfillments", "read_products" ]
```

---

## File 2: apps/api/src/server/routers/integrations.ts

**Location**: Line 122  
**What changed**: Default OAuth scopes schema

```diff
  apiKey: z.string().min(1).optional(),
  apiSecret: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
- scopes: z.array(z.string()).default(["read_orders", "read_customers"]),
+ scopes: z.array(z.string()).default(["read_orders", "read_customers_private_data"]),
  /**
   * The merchant has explicitly confirmed they want to overwrite an existing
   * connected integration (rotating credentials / forcing a fresh OAuth).
```

---

## File 3: apps/api/src/server/webhooks/shopify-install.ts

**Location**: Line 62  
**What changed**: Public install flow scopes

```diff
/**
 * Default scopes for the public-distribution app. Read-only by design — see
 * the integrations connect modal copy ("read-only access · read_orders scope
 * only"). Keep this in lock-step with the scopes declared in the Shopify
 * Partners portal; a mismatch causes a `scope_subset_granted` warning during
 * callback.
 */
-const PUBLIC_INSTALL_SCOPES = ["read_orders", "read_customers"] as const;
+const PUBLIC_INSTALL_SCOPES = ["read_orders", "read_customers_private_data"] as const;
```

---

## Why These Changes Fix the Issue

**The Problem**: 
- Shopify 403: "This app is not approved to access REST endpoints with protected customer data"
- Root cause: Your app requested `read_orders` + `read_customers`, but Shopify requires `read_customers_private_data` to access customer email, phone, name, and address fields embedded in orders

**The Solution**:
- Replace `read_customers` with `read_customers_private_data` in all three locations
- This grants permission to access protected customer data fields in the Orders REST API
- Scope is now: `read_orders` + `read_customers_private_data`

**Impact**:
- ✅ New Shopify installs will request the correct scope
- ✅ Merchants who reconnect will get the new scope via OAuth
- ⚠️ Existing merchants with old tokens must disconnect and reconnect

---

## Next Steps

1. Run the git commands from DEPLOYMENT_INSTRUCTIONS.md
2. Push to main → Railway auto-deploys
3. Verify deployment successful in Railway dashboard
4. Send merchants reconnection notification
5. Test with a merchant account that reconnects
