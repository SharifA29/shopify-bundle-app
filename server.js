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
// ADJUST INVENTORY
// ============================================
async function adjustInventory(variantId, quantityChange, reason = '') {
  try {
    const action = quantityChange > 0 ? 'Adding' : 'Removing';
    console.log(`📊 ${action} ${Math.abs(quantityChange)} units for variant ${variantId} (${reason})`);
    
    const details = await getInventoryDetails(variantId);
    if (!details) {
      console.warn(`⚠️ No inventory location found for variant ${variantId}`);
      return;
    }
    
    const newAvailable = Math.max(0, details.available + quantityChange);
    
    await shopifyAPI('inventory_levels/set.json', 'POST', {
      location_id: details.locationId,
      inventory_item_id: details.inventoryItemId,
      available: newAvailable
    });
    
    const symbol = quantityChange > 0 ? '+' : '';
    console.log(`✅ Adjusted inventory: ${details.available} → ${newAvailable} (${symbol}${quantityChange})`);
  } catch (error) {
    console.error(`❌ Error adjusting inventory for variant ${variantId}:`, error.message);
  }
}

// ============================================
// REMOVE STOCK (negative adjustment)
// ============================================
async function removeStock(variantId, quantity, reason = '') {
  await adjustInventory(variantId, -quantity, reason);
}

// ============================================
// ADD STOCK (positive adjustment)
// ============================================
async function addStock(variantId, quantity, reason = '') {
  await adjustInventory(variantId, quantity, reason);
}

// ============================================
// PARSE BUNDLE COMPONENTS
// ============================================
function parseBundleComponents(lineItem, order) {
  // First try line item properties (for backwards compatibility)
  const properties = lineItem.properties || [];
  const componentsProperty = properties.find(p => p.name === '_clv_components');
  
  if (componentsProperty) {
    try {
      return JSON.parse(componentsProperty.value);
    } catch (error) {
      console.error('Error parsing bundle components from properties:', error.message);
    }
  }
  
  // If not in properties, try cart/order attributes
  if (order && order.note_attributes) {
    const componentAttr = order.note_attributes.find(attr => attr.name === '_clv_components');
    if (componentAttr) {
      try {
        return JSON.parse(componentAttr.value);
      } catch (error) {
        console.error('Error parsing bundle components from attributes:', error.message);
      }
    }
  }
  
  return null;
}

// ============================================
// PROCESS BUNDLE LINE ITEM - REMOVE STOCK
// ============================================
async function removeBundleStock(lineItem, quantity, orderName) {
  const components = parseBundleComponents(lineItem);
  if (!components) return;
  
  console.log(`\n🎨 Removing stock for bundle: ${lineItem.title}`);
  
  // Remove cable stock
  if (components.cable_variant_id) {
    await removeStock(
      components.cable_variant_id,
      quantity,
      `Cable from order ${orderName}`
    );
  }
  
  // Remove cotton ball stock
  if (components.cotton && Array.isArray(components.cotton)) {
    for (const cotton of components.cotton) {
      const totalQty = cotton.qty * quantity;
      await removeStock(
        cotton.variant_id,
        totalQty,
        `${cotton.title} from order ${orderName}`
      );
    }
  }
}

// ============================================
// PROCESS BUNDLE LINE ITEM - ADD STOCK
// ============================================
async function addBundleStock(lineItem, quantity, orderName, reason = 'returned') {
  const components = parseBundleComponents(lineItem);
  if (!components) return;
  
  console.log(`\n🎨 Restocking bundle: ${lineItem.title} (${reason})`);
  
  // Add cable stock back
  if (components.cable_variant_id) {
    await addStock(
      components.cable_variant_id,
      quantity,
      `Cable ${reason} from order ${orderName}`
    );
  }
  
  // Add cotton ball stock back
  if (components.cotton && Array.isArray(components.cotton)) {
    for (const cotton of components.cotton) {
      const totalQty = cotton.qty * quantity;
      await addStock(
        cotton.variant_id,
        totalQty,
        `${cotton.title} ${reason} from order ${orderName}`
      );
    }
  }
}

// ============================================
// PROCESS ORDER CREATED
// ============================================
async function processOrderCreated(order) {
  console.log(`\n📦 ORDER CREATED: ${order.name} (ID: ${order.id})`);
  console.log(`💰 Financial Status: ${order.financial_status}`);
  console.log(`📋 Fulfillment Status: ${order.fulfillment_status || 'unfulfilled'}`);
  
  for (const lineItem of order.line_items) {
    await removeBundleStock(lineItem, lineItem.quantity, order.name);
  }
  
  console.log(`\n✅ Stock removed for order ${order.name}`);
}

// ============================================
// PROCESS ORDER FULFILLED
// ============================================
async function processOrderFulfilled(order) {
  console.log(`\n📮 ORDER FULFILLED: ${order.name} (ID: ${order.id})`);
  console.log(`✅ Stock was already removed when order was created`);
  console.log(`📊 No additional inventory action needed`);
}

// ============================================
// PROCESS ORDER CANCELLED
// ============================================
async function processOrderCancelled(order) {
  console.log(`\n❌ ORDER CANCELLED: ${order.name} (ID: ${order.id})`);
  console.log(`🔙 Restocking all items from cancelled order`);
  
  for (const lineItem of order.line_items) {
    await addBundleStock(lineItem, lineItem.quantity, order.name, 'cancelled');
  }
  
  console.log(`\n✅ Stock restored for cancelled order ${order.name}`);
}

// ============================================
// PROCESS REFUND (with restock)
// ============================================
async function processRefundCreated(refund) {
  console.log(`\n💰 REFUND CREATED: For order ${refund.order_id}`);
  
  // Get the full order details to access line items
  const orderData = await shopifyAPI(`orders/${refund.order_id}.json`);
  const order = orderData.order;
  
  console.log(`📋 Processing refund for order: ${order.name}`);
  
  // Check each refund line item
  for (const refundLineItem of refund.refund_line_items) {
    const restockType = refundLineItem.restock_type;
    const quantity = refundLineItem.quantity;
    const lineItemId = refundLineItem.line_item_id;
    
    console.log(`\n🔍 Refund line item ${lineItemId}: ${quantity} units, restock_type: ${restockType}`);
    
    // Only restock if restock_type is not "no_restock"
    if (restockType !== 'no_restock' && quantity > 0) {
      // Find the original line item
      const originalLineItem = order.line_items.find(item => item.id === lineItemId);
      
      if (originalLineItem) {
        await addBundleStock(originalLineItem, quantity, order.name, 'refunded');
      }
    } else if (restockType === 'no_restock') {
      console.log(`⏭️ Skipping restock (customer keeping item)`);
    }
  }
  
  console.log(`\n✅ Refund processed for order ${order.name}`);
}

// ============================================
// PROCESS ORDER EDITED (items removed)
// ============================================
async function processOrderEdited(order) {
  console.log(`\n✏️ ORDER EDITED: ${order.name} (ID: ${order.id})`);
  
  // Note: This is complex because we need to compare what changed
  // For now, we'll log it. In practice, removing items through "Edit order" 
  // typically creates a refund webhook which we handle above
  
  console.log(`📋 Order edited - refund webhook will handle restocking if items removed`);
}

// ============================================
// FETCH ORDER BY ID
// ============================================
async function fetchOrder(orderId) {
  try {
    const orderData = await shopifyAPI(`orders/${orderId}.json`);
    return orderData.order;
  } catch (error) {
    console.error(`Error fetching order ${orderId}:`, error.message);
    return null;
  }
}

// ============================================
// WEBHOOK ENDPOINTS
// ============================================

// Order Created - Remove Stock
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

// Order Fulfilled - Log Only
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

// Order Cancelled - Restock Everything
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

// Refund Created - Restock Based on Restock Type
app.post('/webhooks/refunds/create', async (req, res) => {
  console.log('\n🔔 Received REFUND CREATED webhook');
  
  if (!verifyWebhook(req)) {
    console.error('❌ Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  res.status(200).send('OK');
  
  try {
    await processRefundCreated(req.body);
  } catch (error) {
    console.error('❌ Error processing refund:', error.message);
  }
});

// Order Edited
app.post('/webhooks/orders/edited', async (req, res) => {
  console.log('\n🔔 Received ORDER EDITED webhook');
  
  if (!verifyWebhook(req)) {
    console.error('❌ Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  res.status(200).send('OK');
  
  try {
    await processOrderEdited(req.body);
  } catch (error) {
    console.error('❌ Error processing order edit:', error.message);
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    message: 'Cable Lights Bundle Inventory Manager (Complete Restocking)',
    version: '2.0',
    endpoints: {
      orderCreate: '/webhooks/orders/create',
      orderFulfilled: '/webhooks/orders/fulfilled',
      orderCancelled: '/webhooks/orders/cancelled',
      refundCreate: '/webhooks/refunds/create',
      orderEdited: '/webhooks/orders/edited',
      health: '/'
    },
    features: [
      'Remove stock on order creation',
      'Restore stock on order cancellation',
      'Restore stock on refunds (when restocked)',
      'Handle partial refunds',
      'Handle order edits'
    ]
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`\n📍 Webhook URLs:`);
  console.log(`   • Order Created: /webhooks/orders/create`);
  console.log(`   • Order Fulfilled: /webhooks/orders/fulfilled`);
  console.log(`   • Order Cancelled: /webhooks/orders/cancelled`);
  console.log(`   • Refund Created: /webhooks/refunds/create`);
  console.log(`   • Order Edited: /webhooks/orders/edited`);
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Store: ${SHOPIFY_STORE}`);
  console.log(`   Token: ${SHOPIFY_ACCESS_TOKEN ? '✅ Set' : '❌ Not set'}`);
  console.log(`   Secret: ${SHOPIFY_WEBHOOK_SECRET ? '✅ Set' : '❌ Not set'}`);
  console.log(`\n💡 Inventory Actions:`);
  console.log(`   📦 Order Created → Remove stock`);
  console.log(`   ❌ Order Cancelled → Restore all stock`);
  console.log(`   💰 Refund (restock) → Restore refunded items`);
  console.log(`   💰 Refund (no restock) → Keep stock removed`);
  console.log(`   ✏️  Order Edited → Handled via refund webhook\n`);
});