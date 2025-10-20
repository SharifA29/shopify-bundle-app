const express = require('express');
const crypto = require('crypto');
const app = express();

// ============================================
// CONFIGURATION
// ============================================
// For local development, fill these in directly:
// For production (Render), use environment variables

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'your-store.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'your-token-here';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'your--here';

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ 
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Enable CORS for your Shopify store
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
// ADJUST INVENTORY
// ============================================
async function adjustInventory(variantId, quantity, reason = 'Bundle component deduction') {
  try {
    console.log(`Adjusting inventory for variant ${variantId}: ${quantity}`);
    
    // First, get the inventory item ID
    const variantData = await shopifyAPI(`variants/${variantId}.json`);
    const inventoryItemId = variantData.variant.inventory_item_id;
    
    // Get inventory levels to find the location ID
    const levelsData = await shopifyAPI(`inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
    
    if (!levelsData.inventory_levels || levelsData.inventory_levels.length === 0) {
      console.warn(`No inventory location found for variant ${variantId}`);
      return;
    }
    
    const locationId = levelsData.inventory_levels[0].location_id;
    
    // Adjust inventory using inventory_levels/adjust endpoint
    await shopifyAPI('inventory_levels/adjust.json', 'POST', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available_adjustment: -quantity // Negative to deduct
    });
    
    console.log(`✅ Successfully adjusted inventory for variant ${variantId}`);
  } catch (error) {
    console.error(`❌ Error adjusting inventory for variant ${variantId}:`, error.message);
  }
}

// ============================================
// PROCESS BUNDLE ORDER
// ============================================
async function processBundleOrder(order) {
  console.log(`\n📦 Processing order: ${order.name} (ID: ${order.id})`);
  
  for (const lineItem of order.line_items) {
    // Check if this line item has our bundle components
    const properties = lineItem.properties || [];
    const componentsProperty = properties.find(p => p.name === '_clv_components');
    
    if (!componentsProperty) {
      continue; // Not a bundle item, skip
    }
    
    console.log(`\n🎨 Found bundle item: ${lineItem.title}`);
    
    try {
      const components = JSON.parse(componentsProperty.value);
      
      // Deduct cable inventory
      if (components.cable_variant_id) {
        await adjustInventory(components.cable_variant_id, lineItem.quantity, 'Cable from bundle');
      }
      
      // Deduct cotton ball inventory
      if (components.cotton && Array.isArray(components.cotton)) {
        for (const cotton of components.cotton) {
          const totalQty = cotton.qty * lineItem.quantity; // Multiply by line item quantity
          await adjustInventory(cotton.variant_id, totalQty, `Cotton ball: ${cotton.title}`);
        }
      }
      
      console.log(`✅ Bundle processed successfully`);
    } catch (error) {
      console.error(`❌ Error processing bundle:`, error.message);
    }
  }
}

// ============================================
// WEBHOOK ENDPOINT - ORDER CREATED
// ============================================
app.post('/webhooks/orders/create', async (req, res) => {
  console.log('\n🔔 Received order webhook');
  
  // Verify the webhook is from Shopify
  if (!verifyWebhook(req)) {
    console.error('❌ Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  // Respond immediately to Shopify (they expect quick response)
  res.status(200).send('OK');
  
  // Process the order asynchronously
  const order = req.body;
  
  try {
    await processBundleOrder(order);
  } catch (error) {
    console.error('❌ Error processing order:', error.message);
  }
});

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    message: 'Cable Lights Bundle Inventory Manager',
    endpoints: {
      webhook: '/webhooks/orders/create',
      health: '/'
    }
  });
});

// ============================================
// CHECK INVENTORY ENDPOINT (Optional - for frontend)
// ============================================
app.get('/api/inventory/:variantId', async (req, res) => {
  try {
    const { variantId } = req.params;
    
    const variantData = await shopifyAPI(`variants/${variantId}.json`);
    const inventoryItemId = variantData.variant.inventory_item_id;
    
    const levelsData = await shopifyAPI(`inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
    
    const totalAvailable = levelsData.inventory_levels.reduce((sum, level) => {
      return sum + (level.available || 0);
    }, 0);
    
    res.json({
      variant_id: variantId,
      inventory_quantity: totalAvailable
    });
  } catch (error) {
    console.error('Error checking inventory:', error.message);
    res.status(500).json({ error: 'Failed to check inventory' });
  }
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📍 Webhook URL: http://localhost:${PORT}/webhooks/orders/create`);
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Store: ${SHOPIFY_STORE}`);
  console.log(`   Token: ${SHOPIFY_ACCESS_TOKEN ? '✅ Set' : '❌ Not set'}`);
  console.log(`   Secret: ${SHOPIFY_WEBHOOK_SECRET ? '✅ Set' : '❌ Not set'}`);
  console.log('\n💡 Make sure to configure webhooks in Shopify Admin\n');
});