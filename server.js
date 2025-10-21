const express = require('express');
const crypto = require('crypto');
const app = express();

// ============================================
// CONFIGURATION
// ============================================
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'your-store.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'your-token-here';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'your-secret-here';

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ 
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ============================================
// VERIFY SHOPIFY WEBHOOK
// ============================================
function verifyWebhook(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac) return false;
  
  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');
  
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

// ============================================
// SHOPIFY API HELPER
// ============================================
async function shopifyAPI(endpoint, method = 'GET', body = null) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${error}`);
  }
  
  return response.json();
}

// ============================================
// GET INVENTORY DETAILS
// ============================================
async function getInventoryDetails(variantId) {
  try {
    const variantData = await shopifyAPI(`variants/${variantId}.json`);
    const inventoryItemId = variantData.variant.inventory_item_id;
    
    const levelsData = await shopifyAPI(`inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
    
    if (!levelsData.inventory_levels || levelsData.inventory_levels.length === 0) {
      return null;
    }
    
    return {
      inventoryItemId,
      locationId: levelsData.inventory_levels[0].location_id,
      available: levelsData.inventory_levels[0].available || 0
    };
  } catch (error) {
    console.error(`Error getting inventory details for variant ${variantId}:`, error.message);
    return null;
  }
}

// ============================================
// SET INVENTORY LEVELS (for committed stock)
// ============================================
async function setInventoryLevel(variantId, available, reason = '') {
  try {
    console.log(`📊 Setting inventory for variant ${variantId}: ${available} available (${reason})`);
    
    const details = await getInventoryDetails(variantId);
    if (!details) {
      console.warn(`⚠️ No inventory location found for variant ${variantId}`);
      return;
    }
    
    // Use inventory_levels/set to update available quantity
    await shopifyAPI('inventory_levels/set.json', 'POST', {
      location_id: details.locationId,
      inventory_item_id: details.inventoryItemId,
      available: available
    });
    
    console.log(`✅ Successfully set inventory for variant ${variantId} to ${available}`);
  } catch (error) {
    console.error(`❌ Error setting inventory for variant ${variantId}:`, error.message);
  }
}

// ============================================
// COMMIT STOCK (Reserve on order creation)
// ============================================
async function commitStock(variantId, quantity, reason = '') {
  try {
    console.log(`🔒 Committing ${quantity} units of variant ${variantId} (${reason})`);
    
    const details = await getInventoryDetails(variantId);
    if (!details) {
      console.warn(`⚠️ No inventory location found for variant ${variantId}`);
      return;
    }
    
    // Reduce available quantity (commits the stock)
    const newAvailable = Math.max(0, details.available - quantity);
    
    await shopifyAPI('inventory_levels/set.json', 'POST', {
      location_id: details.locationId,
      inventory_item_id: details.inventoryItemId,
      available: newAvailable
    });
    
    console.log(`✅ Committed ${quantity} units (${details.available} → ${newAvailable})`);
  } catch (error) {
    console.error(`❌ Error committing stock for variant ${variantId}:`, error.message);
  }
}

// ============================================
// RELEASE COMMITTED STOCK (On cancellation)
// ============================================
async function releaseStock(variantId, quantity, reason = '') {
  try {
    console.log(`🔓 Releasing ${quantity} units of variant ${variantId} (${reason})`);
    
    const details = await getInventoryDetails(variantId);
    if (!details) {
      console.warn(`⚠️ No inventory location found for variant ${variantId}`);
      return;
    }
    
    // Add back to available quantity
    const newAvailable = details.available + quantity;
    
    await shopifyAPI('inventory_levels/set.json', 'POST', {
      location_id: details.locationId,
      inventory_item_id: details.inventoryItemId,
      available: newAvailable
    });
    
    console.log(`✅ Released ${quantity} units (${details.available} → ${newAvailable})`);
  } catch (error) {
    console.error(`❌ Error releasing stock for variant ${variantId}:`, error.message);
  }
}

// ============================================
// PARSE BUNDLE COMPONENTS
// ============================================
function parseBundleComponents(lineItem) {
  const properties = lineItem.properties || [];
  const componentsProperty = properties.find(p => p.name === '_clv_components');
  
  if (!componentsProperty) {
    return null;
  }
  
  try {
    return JSON.parse(componentsProperty.value);
  } catch (error) {
    console.error('Error parsing bundle components:', error.message);
    return null;
  }
}

// ============================================
// PROCESS ORDER CREATED (Commit Stock)
// ============================================
async function processOrderCreated(order) {
  console.log(`\n📦 ORDER CREATED: ${order.name} (ID: ${order.id})`);
  console.log(`💰 Financial Status: ${order.financial_status}`);
  console.log(`📋 Fulfillment Status: ${order.fulfillment_status || 'unfulfilled'}`);
  
  for (const lineItem of order.line_items) {
    const components = parseBundleComponents(lineItem);
    if (!components) continue;
    
    console.log(`\n🎨 Found bundle: ${lineItem.title}`);
    
    // Commit cable stock
    if (components.cable_variant_id) {
      await commitStock(
        components.cable_variant_id, 
        lineItem.quantity,
        `Cable from order ${order.name}`
      );
    }
    
    // Commit cotton ball stock
    if (components.cotton && Array.isArray(components.cotton)) {
      for (const cotton of components.cotton) {
        const totalQty = cotton.qty * lineItem.quantity;
        await commitStock(
          cotton.variant_id,
          totalQty,
          `${cotton.title} from order ${order.name}`
        );
      }
    }
  }
  
  console.log(`\n✅ Stock committed for order ${order.name}`);
}

// ============================================
// PROCESS ORDER FULFILLED (Stock already committed, just log)
// ============================================
async function processOrderFulfilled(order) {
  console.log(`\n📮 ORDER FULFILLED: ${order.name} (ID: ${order.id})`);
  console.log(`✅ Stock was already committed when order was created`);
  console.log(`📊 No additional inventory action needed`);
  
  // Note: Stock is already deducted from "available" when order was created
  // Shopify automatically tracks this as "committed" inventory
}

// ============================================
// PROCESS ORDER CANCELLED (Release Stock)
// ============================================
async function processOrderCancelled(order) {
  console.log(`\n❌ ORDER CANCELLED: ${order.name} (ID: ${order.id})`);
  console.log(`🔙 Releasing committed stock back to available`);
  
  for (const lineItem of order.line_items) {
    const components = parseBundleComponents(lineItem);
    if (!components) continue;
    
    console.log(`\n🎨 Releasing bundle: ${lineItem.title}`);
    
    // Release cable stock
    if (components.cable_variant_id) {
      await releaseStock(
        components.cable_variant_id,
        lineItem.quantity,
        `Cancelled order ${order.name}`
      );
    }
    
    // Release cotton ball stock
    if (components.cotton && Array.isArray(components.cotton)) {
      for (const cotton of components.cotton) {
        const totalQty = cotton.qty * lineItem.quantity;
        await releaseStock(
          cotton.variant_id,
          totalQty,
          `${cotton.title} from cancelled order ${order.name}`
        );
      }
    }
  }
  
  console.log(`\n✅ Stock released for cancelled order ${order.name}`);
}

// ============================================
// WEBHOOK ENDPOINTS
// ============================================

// Order Created - Commit Stock
app.post('/webhooks/orders/create', async (req, res) => {
  console.log('\n🔔 Received ORDER CREATED webhook');
  
  if (!verifyWebhook(req)) {
    console.error('❌ Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  res.status(200).send('OK');
  
  try {
    await processOrderCreated(req.body);
  } catch (error) {
    console.error('❌ Error processing order creation:', error.message);
  }
});

// Order Fulfilled - Log Only (stock already committed)
app.post('/webhooks/orders/fulfilled', async (req, res) => {
  console.log('\n🔔 Received ORDER FULFILLED webhook');
  
  if (!verifyWebhook(req)) {
    console.error('❌ Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  res.status(200).send('OK');
  
  try {
    await processOrderFulfilled(req.body);
  } catch (error) {
    console.error('❌ Error processing order fulfillment:', error.message);
  }
});

// Order Cancelled - Release Stock
app.post('/webhooks/orders/cancelled', async (req, res) => {
  console.log('\n🔔 Received ORDER CANCELLED webhook');
  
  if (!verifyWebhook(req)) {
    console.error('❌ Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  res.status(200).send('OK');
  
  try {
    await processOrderCancelled(req.body);
  } catch (error) {
    console.error('❌ Error processing order cancellation:', error.message);
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    message: 'Cable Lights Bundle Inventory Manager (Committed Stock)',
    endpoints: {
      orderCreate: '/webhooks/orders/create',
      orderFulfilled: '/webhooks/orders/fulfilled',
      orderCancelled: '/webhooks/orders/cancelled',
      health: '/'
    },
    inventorySystem: 'committed-stock'
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📍 Webhook URLs:`);
  console.log(`   - Order Created: /webhooks/orders/create`);
  console.log(`   - Order Fulfilled: /webhooks/orders/fulfilled`);
  console.log(`   - Order Cancelled: /webhooks/orders/cancelled`);
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Store: ${SHOPIFY_STORE}`);
  console.log(`   Token: ${SHOPIFY_ACCESS_TOKEN ? '✅ Set' : '❌ Not set'}`);
  console.log(`   Secret: ${SHOPIFY_WEBHOOK_SECRET ? '✅ Set' : '❌ Not set'}`);
  console.log(`\n💡 Inventory System: Committed Stock`);
  console.log(`   • Order Created → Commit (reserve) stock`);
  console.log(`   • Order Fulfilled → Already committed`);
  console.log(`   • Order Cancelled → Release stock\n`);
});