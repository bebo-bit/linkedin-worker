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
console.log('Using GoLogin Cloud Browser (no local Chrome needed)');

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
// GoLogin Cloud Browser Connection
// ============================================

async function startGoLoginProfile(profileId, maxRetries = 3) {
  console.log(`Connecting to GoLogin Cloud Browser: ${profileId}`);
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // GoLogin Cloud Browser WebSocket URL
      // This connects to GoLogin's cloud infrastructure - no local Chrome needed
      const wsUrl = `wss://cloudbrowser.gologin.com/connect?token=${GOLOGIN_API_TOKEN}&profile=${profileId}`;
      
      console.log(`Attempt ${attempt}: Connecting to GoLogin cloud browser...`);
      
      // Connect via Playwright's CDP connection
      const browser = await chromium.connectOverCDP(wsUrl, {
        timeout: 90000, // 90 second connection timeout
      });
      
      console.log(`Connected to GoLogin Cloud Browser (attempt ${attempt})`);
      
      return { browser, wsUrl, isCloud: true };
      
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || String(error);
      
      console.warn(`Cloud connection failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`);
      
      // Check for specific error types
      if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
        // Profile access denied - don't retry
        throw new Error(`GoLogin profile access denied (403). Profile may not exist or token mismatch.`);
      }
      
      if (errorMsg.includes('404') || errorMsg.includes('not found')) {
        throw new Error(`GoLogin profile not found (404). Profile ID: ${profileId}`);
      }
      
      // Check if error is retryable (transient failures)
      const isRetryable = 
        errorMsg.includes('500') ||
        errorMsg.includes('502') ||
        errorMsg.includes('503') ||
        errorMsg.includes('504') ||
        errorMsg.includes('ECONNRESET') ||
        errorMsg.includes('ECONNREFUSED') ||
        errorMsg.includes('timeout') ||
        errorMsg.includes('ETIMEDOUT') ||
        errorMsg.includes('network') ||
        errorMsg.includes('socket hang up') ||
        errorMsg.includes('WebSocket');
      
      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 2000; // 4s, 8s, 16s exponential backoff
        console.log(`Retrying in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else if (!isRetryable) {
        throw error;
      }
    }
  }
  
  throw lastError;
}

async function stopGoLoginProfile(browser) {
  // For cloud browser, just close the connection
  if (browser) {
    try {
      await browser.close();
      console.log('GoLogin Cloud Browser connection closed');
    } catch (error) {
      console.warn('Error closing cloud browser:', error.message);
    }
  }
}

// ============================================
// LinkedIn Login Handler
// ============================================

// Check for app approval requirement (different from SMS/Email 2FA)
async function checkAppApprovalRequired(page) {
  const pageText = await page.textContent('body').catch(() => '');
  const appApprovalIndicators = [
    'Approve this sign-in from your LinkedIn app',
    'Open the LinkedIn app to confirm',
    'Confirm it\'s you',
    'We sent a notification to your LinkedIn app',
    'Approve from the LinkedIn app'
  ];
  
  for (const indicator of appApprovalIndicators) {
    if (pageText.toLowerCase().includes(indicator.toLowerCase())) {
      console.log('App approval detected via text:', indicator);
      return true;
    }
  }
  
  // Also check for: on checkpoint page but no OTP input = likely app approval
  const url = page.url();
  if (url.includes('checkpoint')) {
    const hasOTPInput = await page.locator('input[name="pin"]').isVisible({ timeout: 1000 }).catch(() => false);
    const hasCodeInput = await page.locator('input[placeholder*="code"]').isVisible({ timeout: 500 }).catch(() => false);
    if (!hasOTPInput && !hasCodeInput) {
      console.log('On checkpoint page but no OTP input - likely app approval');
      return true;
    }
  }
  
  return false;
}

// Check for login failure (bad password, account locked)
async function checkLoginFailed(page) {
  const pageText = await page.textContent('body').catch(() => '');
  const url = page.url();
  
  const errorIndicators = [
    { text: "that's not the right password", type: 'invalid_credentials' },
    { text: "wrong password", type: 'invalid_credentials' },
    { text: "incorrect password", type: 'invalid_credentials' },
    { text: "please check your password", type: 'invalid_credentials' },
    { text: "couldn't find a linkedin account", type: 'invalid_credentials' },
    { text: "account has been restricted", type: 'account_locked' },
    { text: "temporarily locked", type: 'account_locked' },
    { text: "unusual activity", type: 'account_locked' },
    { text: "your account has been temporarily restricted", type: 'account_locked' },
    { text: "we've restricted your account", type: 'account_locked' },
  ];
  
  const lowerText = pageText.toLowerCase();
  
  for (const indicator of errorIndicators) {
    if (lowerText.includes(indicator.text)) {
      console.log(`Login error detected: ${indicator.type} - "${indicator.text}"`);
      return { failed: true, type: indicator.type };
    }
  }
  
  // Check: still on login page after submission = possible error
  if (url.includes('/login') || url.includes('/uas/login')) {
    // Check for visible error banner
    const errorBanner = await page.locator('.form__label--error, [data-test="form-error"], .alert-error').isVisible({ timeout: 1000 }).catch(() => false);
    if (errorBanner) {
      console.log('Error banner detected on login page');
      return { failed: true, type: 'invalid_credentials' };
    }
  }
  
  return null;
}

// Validate full session cookies for confidence
async function validateFullSession(context) {
  const cookies = await context.cookies();
  
  const liAtCookie = cookies.find(c => c.name === 'li_at');
  const jsessionId = cookies.find(c => c.name === 'JSESSIONID');
  const bcookie = cookies.find(c => c.name === 'bcookie');
  const liACookie = cookies.find(c => c.name === 'li_a');
  
  // li_at is the crown jewel - must have this
  if (!liAtCookie || !liAtCookie.value) {
    return { valid: false, reason: 'Missing li_at cookie' };
  }
  
  // Calculate confidence based on additional cookies
  const confidenceSignals = {
    hasLiAt: !!liAtCookie?.value,
    hasLiA: !!liACookie?.value,
    hasJSessionId: !!jsessionId?.value,
    hasBcookie: !!bcookie?.value,
  };
  
  const confidence = Object.values(confidenceSignals).filter(Boolean).length / 4;
  
  console.log(`Session validation: li_at=${!!liAtCookie?.value}, confidence=${(confidence * 100).toFixed(0)}%`);
  
  return { 
    valid: true, 
    cookies: { 
      li_at: liAtCookie.value,
      li_a: liACookie?.value || null
    },
    confidence
  };
}

async function handleLinkedInLogin(page, context, action, agentId) {
  console.log(`Starting LinkedIn login flow for agent ${agentId}...`);
  
  // CRITICAL: Check if we have valid existing cookies - NEVER re-enter credentials if so
  const existingCookies = action.payload?.existingCookies;
  if (existingCookies?.li_at) {
    console.log('Existing session cookies found - attempting cookie-based login...');
    
    // Set cookies first before navigating
    await context.addCookies([
      { name: 'li_at', value: existingCookies.li_at, domain: '.linkedin.com', path: '/' },
      ...(existingCookies.li_a ? [{ name: 'li_a', value: existingCookies.li_a, domain: '.linkedin.com', path: '/' }] : [])
    ]);
    
    // Navigate to feed to verify session
    await page.goto('https://www.linkedin.com/feed', { waitUntil: 'domcontentloaded' });
    await humanDelay(2000, 4000);
    
    const isValid = await verifyLogin(page);
    if (isValid) {
      console.log('Existing cookies valid - session restored without re-login');
      return await extractSessionAndComplete(context, agentId);
    }
    
    console.log('Existing cookies invalid - falling back to full login');
  }
  
  // Update login state via Edge Function
  await updateAgentState(agentId, 'navigating');
  
  // Navigate to LinkedIn login
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 4000);
  
  // Check if already logged in (maybe cookies worked after navigation)
  if (page.url().includes('/feed') || page.url().includes('/mynetwork')) {
    console.log('Already logged in, extracting cookies...');
    return await extractSessionAndComplete(context, agentId);
  }
  
  // Update state to entering credentials
  await updateAgentState(agentId, 'entering_credentials');
  
  // Get credentials from action payload (provided by worker-poll)
  // Support both naming conventions: email/password and linkedinEmail/linkedinPassword
  const email = action.payload?.email || action.payload?.linkedinEmail;
  const password = action.payload?.password || action.payload?.linkedinPassword;
  
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
  
  // 1. Check for failed login FIRST (don't retry!)
  const loginError = await checkLoginFailed(page);
  if (loginError) {
    const errorMessage = loginError.type === 'invalid_credentials' 
      ? 'Wrong password - do NOT retry'
      : 'Account locked by LinkedIn';
    
    await updateAgentState(agentId, loginError.type, {
      status: 'needs_reauth',
      loginError: errorMessage
    });
    
    throw new Error(`Login failed: ${errorMessage}`);
  }
  
  // 2. Check for app approval (different from SMS/Email 2FA)
  const needsAppApproval = await checkAppApprovalRequired(page);
  if (needsAppApproval) {
    console.log('LinkedIn app approval required...');
    await updateAgentState(agentId, 'awaiting_app_approval', { twoFAMethod: 'linkedin_app' });
    
    // Wait for completion (up to 5 minutes)
    const completed = await waitFor2FACompletion(page, 300000);
    if (!completed) {
      throw new Error('LinkedIn app approval timed out');
    }
  }
  
  // 3. Check for SMS/Email 2FA
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
    // Final check for any error state we missed
    const finalError = await checkLoginFailed(page);
    if (finalError) {
      await updateAgentState(agentId, finalError.type, {
        status: 'needs_reauth',
        loginError: `Login verification failed: ${finalError.type}`
      });
      throw new Error(`Login failed after verification: ${finalError.type}`);
    }
    
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
    // Connect to GoLogin Cloud Browser
    const profileData = await startGoLoginProfile(gologinProfileId);
    browser = profileData.browser;
    
    // Get existing context or create new one
    const contexts = browser.contexts();
    context = contexts[0] || await browser.newContext();
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
    // Cleanup: close cloud browser connection
    await stopGoLoginProfile(browser);
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
  console.log('Browser: GoLogin Cloud Browser (remote)');
  
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
