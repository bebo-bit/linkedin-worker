import { chromium } from 'playwright-core';

// Configuration from environment - Multi-agent worker (no AGENT_ID required)
const SUPABASE_URL = process.env.SUPABASE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const GOLOGIN_API_TOKEN = process.env.GOLOGIN_API_TOKEN;
const WORKER_ID = process.env.WORKER_ID || `worker-${Date.now()}`;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000');

// Validate required environment variables
const missingVars = [];
if (!SUPABASE_URL) missingVars.push('SUPABASE_URL');
if (!WORKER_SECRET) missingVars.push('WORKER_SECRET');
if (!GOLOGIN_API_TOKEN) missingVars.push('GOLOGIN_API_TOKEN');

if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars.join(', '));
  console.error('Required: SUPABASE_URL, WORKER_SECRET, GOLOGIN_API_TOKEN');
  process.exit(1);
}

console.log(`Worker ${WORKER_ID} starting in MULTI-AGENT mode`);
console.log('This worker will process actions for ALL agents in the workspace');

// Statistics
let actionsProcessed = 0;
let actionsFailed = 0;

// ============================================
// Edge Function Helpers (replaces direct Supabase access)
// ============================================

async function callEdgeFunction(functionName, body) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-secret': WORKER_SECRET
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge function ${functionName} failed: ${response.status} - ${errorText}`);
  }

  return response.json();
}

async function updateAgentState(agentId, loginState, extraData = {}) {
  try {
    await callEdgeFunction('worker-update-agent', {
      workerId: WORKER_ID,
      agentId,
      loginState,
      ...extraData
    });
  } catch (error) {
    console.error('Failed to update agent state:', error.message);
  }
}

async function sendHeartbeat(status = 'idle', currentActionId = null, agentId = null) {
  try {
    await callEdgeFunction('worker-heartbeat', {
      workerId: WORKER_ID,
      agentId, // Can be null for multi-agent mode
      status,
      currentActionId,
      actionsProcessed,
      actionsFailed
    });
  } catch (error) {
    console.error('Heartbeat error:', error.message);
  }
}

async function pollForActions() {
  try {
    const data = await callEdgeFunction('worker-poll', {
      workerId: WORKER_ID,
      // No agentId - poll for ALL agents
      limit: 1
    });
    
    // Return first action or null
    return data.actions?.[0] || null;
    
  } catch (error) {
    console.error('Poll error:', error.message);
    return null;
  }
}

async function reportResult(actionId, status, result = null, errorMessage = null) {
  try {
    await callEdgeFunction('worker-report', {
      workerId: WORKER_ID,
      actionId,
      status,
      result,
      errorMessage
    });
  } catch (error) {
    console.error('Failed to report result:', error.message);
  }
}

// ============================================
// Human-like behavior utilities
// ============================================

async function humanDelay(min = 500, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

async function typeHuman(page, selector, text) {
  const element = await page.locator(selector).first();
  await element.click();
  await humanDelay(200, 500);
  
  for (const char of text) {
    await element.pressSequentially(char, { delay: Math.random() * 150 + 50 });
    if (Math.random() < 0.1) {
      await humanDelay(300, 800);
    }
  }
}

async function clickHuman(page, selector) {
  const element = await page.locator(selector).first();
  const box = await element.boundingBox();
  if (box) {
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
    await humanDelay(100, 300);
    await page.mouse.click(x, y);
  } else {
    await element.click();
  }
}

async function scrollHuman(page, direction = 'down', amount = null) {
  const scrollAmount = amount || Math.floor(Math.random() * 300) + 200;
  const delta = direction === 'down' ? scrollAmount : -scrollAmount;
  await page.mouse.wheel(0, delta);
  await humanDelay(500, 1500);
}

// ============================================
// GoLogin API integration
// ============================================

async function startGoLoginProfile(profileId) {
  console.log(`Starting GoLogin profile: ${profileId}`);
  
  const response = await fetch(`https://api.gologin.com/browser/${profileId}/start?autostart=true`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${GOLOGIN_API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to start GoLogin profile: ${error}`);
  }

  const data = await response.json();
  console.log('GoLogin profile started:', data);
  return data;
}

async function stopGoLoginProfile(profileId) {
  console.log(`Stopping GoLogin profile: ${profileId}`);
  
  try {
    await fetch(`https://api.gologin.com/browser/${profileId}/stop`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GOLOGIN_API_TOKEN}`
      }
    });
  } catch (error) {
    console.warn('Error stopping GoLogin profile:', error.message);
  }
}

// ============================================
// LinkedIn Login Handler
// ============================================

async function handleLinkedInLogin(page, context, action, agentId) {
  console.log(`Starting LinkedIn login flow for agent ${agentId}...`);
  
  // Update login state via Edge Function
  await updateAgentState(agentId, 'navigating');
  
  // Navigate to LinkedIn login
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 4000);
  
  // Check if already logged in
  if (page.url().includes('/feed') || page.url().includes('/mynetwork')) {
    console.log('Already logged in, extracting cookies...');
    return await extractSessionAndComplete(context, agentId);
  }
  
  // Update state to entering credentials
  await updateAgentState(agentId, 'entering_credentials');
  
  // Get credentials from action payload (provided by worker-poll)
  const email = action.payload?.email;
  const password = action.payload?.password;
  
  if (!email || !password) {
    throw new Error('LinkedIn credentials not provided in action payload');
  }
  
  // Enter email
  console.log('Entering email...');
  await typeHuman(page, '#username', email);
  await humanDelay(500, 1000);
  
  // Enter password
  console.log('Entering password...');
  await typeHuman(page, '#password', password);
  await humanDelay(500, 1000);
  
  // Click sign in
  console.log('Clicking sign in...');
  await clickHuman(page, 'button[type="submit"]');
  
  // Wait for navigation
  await page.waitForLoadState('domcontentloaded');
  await humanDelay(3000, 5000);
  
  // Check for 2FA
  const requires2FA = await check2FARequired(page);
  
  if (requires2FA) {
    console.log('2FA required, waiting for user completion...');
    await updateAgentState(agentId, 'awaiting_2fa', { twoFAMethod: requires2FA.method });
    
    // Wait for 2FA completion (up to 5 minutes)
    const loginCompleted = await waitFor2FACompletion(page, 300000);
    
    if (!loginCompleted) {
      throw new Error('2FA verification timed out');
    }
  }
  
  // Verify successful login
  await updateAgentState(agentId, 'verifying_session');
  
  const isLoggedIn = await verifyLogin(page);
  if (!isLoggedIn) {
    throw new Error('Login verification failed - not on expected page');
  }
  
  // Extract and save session
  return await extractSessionAndComplete(context, agentId);
}

async function check2FARequired(page) {
  const url = page.url();
  
  // Check URL patterns
  if (url.includes('checkpoint') || url.includes('challenge') || url.includes('two-step')) {
    console.log('2FA detected via URL pattern');
  }
  
  // Check for various 2FA indicators
  const indicators = [
    { selector: 'input[name="pin"]', method: 'app' },
    { selector: '#input__phone_verification_pin', method: 'sms' },
    { selector: '#input__email_verification_pin', method: 'email' },
    { selector: '[data-test="verification-code-input"]', method: 'app' },
    { selector: 'input[placeholder*="code"]', method: 'app' },
    { selector: 'input[placeholder*="verification"]', method: 'app' }
  ];
  
  for (const indicator of indicators) {
    const element = await page.locator(indicator.selector).first();
    if (await element.isVisible({ timeout: 1000 }).catch(() => false)) {
      return { required: true, method: indicator.method };
    }
  }
  
  // Check for text indicators
  const pageText = await page.textContent('body');
  if (pageText.includes('verification code') || 
      pageText.includes('two-step verification') ||
      pageText.includes('Enter the code')) {
    return { required: true, method: 'unknown' };
  }
  
  return null;
}

async function waitFor2FACompletion(page, timeout) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const url = page.url();
    
    // Check if we've navigated away from 2FA
    if (url.includes('/feed') || url.includes('/mynetwork') || url.includes('/in/')) {
      return true;
    }
    
    // Check if still on checkpoint
    if (!url.includes('checkpoint') && !url.includes('challenge') && !url.includes('two-step')) {
      // Might have completed, verify
      const isLoggedIn = await verifyLogin(page);
      if (isLoggedIn) return true;
    }
    
    await humanDelay(2000, 3000);
  }
  
  return false;
}

async function verifyLogin(page) {
  const url = page.url();
  
  // Check URL patterns
  if (url.includes('/feed') || url.includes('/mynetwork') || url.includes('/messaging')) {
    return true;
  }
  
  // Check for profile elements
  const profileIndicators = [
    '.global-nav__me',
    '[data-control-name="identity_welcome_message"]',
    '.feed-identity-module',
    'img.global-nav__me-photo'
  ];
  
  for (const selector of profileIndicators) {
    const element = await page.locator(selector).first();
    if (await element.isVisible({ timeout: 2000 }).catch(() => false)) {
      return true;
    }
  }
  
  return false;
}

async function extractSessionAndComplete(context, agentId) {
  await updateAgentState(agentId, 'extracting_profile');
  
  // Get all cookies
  const cookies = await context.cookies();
  
  // Find LinkedIn session cookies
  const liAtCookie = cookies.find(c => c.name === 'li_at');
  const liACookie = cookies.find(c => c.name === 'li_a');
  
  if (!liAtCookie) {
    throw new Error('Failed to extract li_at session cookie');
  }
  
  console.log('Session cookies extracted successfully');
  
  // Update agent via Edge Function with session cookies
  await callEdgeFunction('worker-update-agent', {
    workerId: WORKER_ID,
    agentId,
    loginState: 'completed',
    status: 'connected',
    loginError: null,
    sessionCookies: {
      li_at: liAtCookie.value,
      li_a: liACookie?.value || null
    }
  });
  
  console.log('Login completed successfully');
  
  return {
    success: true,
    message: 'LinkedIn login successful',
    hasCookies: true
  };
}

// ============================================
// Action Processing
// ============================================

async function processAction(action) {
  const agentId = action.agent_id;
  console.log(`Processing action: ${action.action_type} (${action.id}) for agent ${agentId}`);
  
  // Get GoLogin profile ID from enriched action data
  const gologinProfileId = action.gologin_profile?.profile_id;
  if (!gologinProfileId) {
    throw new Error('No GoLogin profile linked to this agent');
  }
  
  let browser = null;
  let context = null;
  
  try {
    // Start GoLogin profile
    const profileData = await startGoLoginProfile(gologinProfileId);
    const wsEndpoint = profileData.wsEndpoint || profileData.ws?.puppeteer;
    
    if (!wsEndpoint) {
      throw new Error('No WebSocket endpoint returned from GoLogin');
    }
    
    // Connect with Playwright
    console.log('Connecting to browser via CDP...');
    browser = await chromium.connectOverCDP(wsEndpoint);
    context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    
    // Set viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    
    // Process based on action type
    let result;
    
    switch (action.action_type) {
      case 'linkedin_login':
      case 'login': // Handle both for backwards compatibility
        result = await handleLinkedInLogin(page, context, action, agentId);
        break;
      
      case 'view_profile':
        result = await handleViewProfile(page, action);
        break;
      
      case 'send_connection':
        result = await handleSendConnection(page, action);
        break;
      
      case 'send_message':
        result = await handleSendMessage(page, action);
        break;
      
      default:
        throw new Error(`Unknown action type: ${action.action_type}`);
    }
    
    return result;
    
  } finally {
    // Cleanup
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn('Error closing browser:', e.message);
      }
    }
    
    // Stop GoLogin profile
    await stopGoLoginProfile(gologinProfileId);
  }
}

// Placeholder handlers for other actions
async function handleViewProfile(page, action) {
  const profileUrl = action.payload?.linkedin_url || action.lead?.linkedin_url;
  if (!profileUrl) throw new Error('No profile URL provided');
  
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(3000, 6000);
  await scrollHuman(page, 'down');
  
  return { success: true, message: 'Profile viewed' };
}

async function handleSendConnection(page, action) {
  const profileUrl = action.payload?.linkedin_url || action.lead?.linkedin_url;
  if (!profileUrl) throw new Error('No profile URL provided');
  
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 4000);
  
  // Find and click connect button
  const connectBtn = page.locator('button:has-text("Connect")').first();
  if (await connectBtn.isVisible()) {
    await clickHuman(page, 'button:has-text("Connect")');
    await humanDelay(1000, 2000);
    
    // Handle optional note
    if (action.payload?.message) {
      const addNoteBtn = page.locator('button:has-text("Add a note")');
      if (await addNoteBtn.isVisible()) {
        await addNoteBtn.click();
        await humanDelay(500, 1000);
        await typeHuman(page, 'textarea[name="message"]', action.payload.message);
      }
    }
    
    // Send the request
    const sendBtn = page.locator('button:has-text("Send")').first();
    if (await sendBtn.isVisible()) {
      await clickHuman(page, 'button:has-text("Send")');
    }
    
    return { success: true, message: 'Connection request sent' };
  }
  
  return { success: false, message: 'Connect button not found' };
}

async function handleSendMessage(page, action) {
  const profileUrl = action.payload?.linkedin_url || action.lead?.linkedin_url;
  const message = action.payload?.message;
  
  if (!profileUrl) throw new Error('No profile URL provided');
  if (!message) throw new Error('No message provided');
  
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 4000);
  
  // Click message button
  const messageBtn = page.locator('button:has-text("Message")').first();
  if (await messageBtn.isVisible()) {
    await clickHuman(page, 'button:has-text("Message")');
    await humanDelay(1000, 2000);
    
    // Type message
    await typeHuman(page, '.msg-form__contenteditable', message);
    await humanDelay(500, 1000);
    
    // Send
    const sendBtn = page.locator('.msg-form__send-button').first();
    if (await sendBtn.isVisible()) {
      await sendBtn.click();
      return { success: true, message: 'Message sent' };
    }
  }
  
  return { success: false, message: 'Message button not found' };
}

// ============================================
// Main Loop
// ============================================

async function main() {
  console.log(`Worker ${WORKER_ID} started`);
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);
  console.log('Mode: MULTI-AGENT (handles all agents in workspace)');
  
  // Send initial heartbeat
  await sendHeartbeat('online');
  
  // Main polling loop
  while (true) {
    try {
      // Send heartbeat
      await sendHeartbeat('polling');
      
      // Poll for actions (from any agent)
      const action = await pollForActions();
      
      if (action) {
        console.log(`Received action: ${action.action_type} (${action.id}) for agent ${action.agent_id}`);
        
        // Update heartbeat with current action
        await sendHeartbeat('busy', action.id, action.agent_id);
        
        try {
          // Process the action
          const result = await processAction(action);
          
          // Report success
          await reportResult(action.id, 'completed', result);
          actionsProcessed++;
          
          console.log(`Action ${action.id} completed successfully`);
          
        } catch (error) {
          console.error(`Action ${action.id} failed:`, error.message);
          
          // Report failure
          await reportResult(action.id, 'failed', null, error.message);
          actionsFailed++;
          
          // Update agent state if it was a login action
          if (action.action_type === 'linkedin_login' || action.action_type === 'login') {
            await updateAgentState(action.agent_id, 'failed', {
              status: 'needs_reauth',
              loginError: error.message
            });
          }
        }
      }
      
    } catch (error) {
      console.error('Main loop error:', error.message);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  await sendHeartbeat('offline');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  await sendHeartbeat('offline');
  process.exit(0);
});

// Start the worker
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
