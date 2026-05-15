# Shopify Scope Fix - Deployment Instructions

## Status
✅ **All code changes are complete and verified**

## Files Changed
1. `shopify.app.toml` - Line 11
2. `apps/api/src/server/routers/integrations.ts` - Line 122  
3. `apps/api/src/server/webhooks/shopify-install.ts` - Line 62

## Changes Summary
All changes add `read_customers_private_data` scope to fix Shopify 403 errors on order imports.

---

## How to Deploy (Run from your local machine)

### Step 1: Pull Latest Changes
```bash
cd /path/to/ecommerce-logistics
git pull origin main
```

### Step 2: Review Changes
The three files should already be modified with `read_customers_private_data` scope.

Verify:
```bash
grep "read_customers_private_data" shopify.app.toml
grep "read_customers_private_data" apps/api/src/server/routers/integrations.ts  
grep "read_customers_private_data" apps/api/src/server/webhooks/shopify-install.ts
```

Should all show the new scope.

### Step 3: Commit & Push
```bash
git add shopify.app.toml \
    "apps/api/src/server/routers/integrations.ts" \
    "apps/api/src/server/webhooks/shopify-install.ts"

git commit -m "fix(shopify): add read_customers_private_data scope for protected customer data access

Fixes scope mismatch that prevented order imports due to Shopify 403 errors.

Shopify enforces strict access control for protected customer data fields
(email, phone, name, address) when accessed via the Orders REST API. The
read_customers scope alone is insufficient; read_customers_private_data is
required.

Changes:
- shopify.app.toml: Add read_customers_private_data to scopes
- apps/api/src/server/routers/integrations.ts: Update default scopes
- apps/api/src/server/webhooks/shopify-install.ts: Update PUBLIC_INSTALL_SCOPES

Merchants must disconnect and reconnect their Shopify stores to receive the
new scope via OAuth re-authorization."

git push origin main
```

### Step 4: Monitor Deployment
Railway will automatically detect the push to main and start deployment.
- Check Railway dashboard for deployment status
- Takes ~5-10 minutes typically
- API will restart with new scopes

---

## What Happens Next (Post-Deployment)

⚠️ **Important: Merchants MUST Reconnect**

1. Existing merchants' Shopify tokens will still have old scopes
2. Orders import will still fail until they reconnect
3. Send merchants this message:

```
Subject: Action Required - Shopify Store Reconnection

Hi,

We've updated our Shopify integration with improved data access. To continue 
importing orders, please:

1. Go to Settings → Integrations
2. Click "Disconnect" on your Shopify store  
3. Click "Connect Shopify" again
4. Approve the new permission request

This takes 1 minute and will restore order imports immediately.

Thanks,
Support Team
```

---

## Verification Checklist

After deployment to production:

- [ ] Push to main successful
- [ ] Railway deployment completed
- [ ] API server restarted
- [ ] Test Shopify connection works (for test merchant)
- [ ] Orders import without 403 errors
- [ ] Send merchant notification about reconnection requirement
