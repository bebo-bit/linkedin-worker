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

// Comprehensive challenge detection - distinguishes between different LinkedIn security challenges
async function detectChallengeType(page) {
  const pageText = await page.textContent('body').catch(() => '');
  const lowerText = pageText.toLowerCase();
  const url = page.url().toLowerCase();
  
  console.log('=== Challenge Detection Debug ===');
  console.log('Current URL:', url);
  console.log('Page text preview (first 500 chars):', lowerText.substring(0, 500));
  
  // 1. Check for CAPTCHA first (highest priority blocker)
  const captchaIframe = await page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="arkose"]').first();
  if (await captchaIframe.isVisible({ timeout: 1000 }).catch(() => false)) {
    console.log('CAPTCHA DETECTED: Found captcha iframe');
    return { type: 'captcha', indicator: 'captcha_iframe' };
  }
  
  const captchaIndicators = [
    'prove you\'re human',
    'security verification required',
    'complete the security check',
    'verify you\'re not a robot'
  ];
  for (const indicator of captchaIndicators) {
    if (lowerText.includes(indicator)) {
      console.log(`CAPTCHA DETECTED: matched "${indicator}"`);
      return { type: 'captcha', indicator };
    }
  }
  
  // 2. Check for invalid credentials
  const invalidCredentialIndicators = [
    'that\'s not the right password',
    'wrong password',
    'incorrect password',
    'please check your password',
    'couldn\'t find a linkedin account',
    'couldn\'t find an account',
    'please enter a valid email'
  ];
  for (const indicator of invalidCredentialIndicators) {
    if (lowerText.includes(indicator)) {
      console.log(`INVALID CREDENTIALS DETECTED: matched "${indicator}"`);
      return { type: 'invalid_credentials', indicator };
    }
  }
  
  // 3. Check for account locked/restricted
  const accountLockedIndicators = [
    'account has been restricted',
    'your account has been temporarily restricted',
    'we\'ve restricted your account',
    'temporarily locked',
    'unusual activity detected',
    'account is temporarily restricted'
  ];
  for (const indicator of accountLockedIndicators) {
    if (lowerText.includes(indicator)) {
      console.log(`ACCOUNT LOCKED DETECTED: matched "${indicator}"`);
      return { type: 'account_locked', indicator };
    }
  }
  
  // 4. Check for LinkedIn App Push Notification (VERY SPECIFIC phrases only)
  const appApprovalIndicators = [
    'approve this sign-in from your linkedin app',
    'open the linkedin app to confirm',
    'we sent a notification to your linkedin app',
    'approve from the linkedin app',
    'tap yes on the linkedin app',
    'check your linkedin app',
    'we\'ll send a push notification'
  ];
  for (const indicator of appApprovalIndicators) {
    if (lowerText.includes(indicator)) {
      console.log(`APP APPROVAL DETECTED: matched "${indicator}"`);
      return { type: 'app_approval', indicator };
    }
  }
  
  // 5. Check for Email/SMS 2FA (code entry)
  const emailSms2FAIndicators = [
    'enter the code we sent',
    'we sent a code to',
    'check your email for a code',
    'check your phone for a code',
    'enter the 6 digit code',
    'enter the 6-digit code',
    'verification code sent',
    'we\'ve sent a verification code'
  ];
  for (const indicator of emailSms2FAIndicators) {
    if (lowerText.includes(indicator)) {
      console.log(`EMAIL/SMS 2FA DETECTED: matched "${indicator}"`);
      // Determine if email or SMS
      const method = lowerText.includes('phone') || lowerText.includes('sms') || lowerText.includes('text message') ? 'sms' : 'email';
      return { type: 'email_sms_2fa', indicator, method };
    }
  }
  
  // 6. Check for Authenticator App 2FA
  const authenticator2FAIndicators = [
    'authenticator app',
    'authentication app',
    'google authenticator',
    'microsoft authenticator',
    'enter the code from your authenticator'
  ];
  for (const indicator of authenticator2FAIndicators) {
    if (lowerText.includes(indicator)) {
      console.log(`AUTHENTICATOR 2FA DETECTED: matched "${indicator}"`);
      return { type: 'authenticator_2fa', indicator };
    }
  }
  
  // 7. Check if on checkpoint/challenge page with code input field
  if (url.includes('checkpoint') || url.includes('challenge') || url.includes('two-step')) {
    // Check for code input fields
    const codeInputSelectors = [
      'input[name="pin"]',
      '#input__phone_verification_pin',
      '#input__email_verification_pin',
      '[data-test="verification-code-input"]',
      'input[placeholder*="code" i]',
      'input[aria-label*="code" i]',
      'input[maxlength="6"]'
    ];
    
    for (const selector of codeInputSelectors) {
      const element = await page.locator(selector).first();
      if (await element.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`2FA CODE INPUT DETECTED: found "${selector}"`);
        
        // Try to determine type from surrounding text
        if (lowerText.includes('phone') || lowerText.includes('sms')) {
          return { type: 'email_sms_2fa', indicator: selector, method: 'sms' };
        } else if (lowerText.includes('email')) {
          return { type: 'email_sms_2fa', indicator: selector, method: 'email' };
        }
        return { type: 'email_sms_2fa', indicator: selector, method: 'unknown' };
      }
    }
    
    // On checkpoint but NO code input - check for app approval button/text more broadly
    const hasApproveTapButton = await page.locator('button:has-text("I\'ve approved"), button:has-text("Done")').first().isVisible({ timeout: 500 }).catch(() => false);
    if (hasApproveTapButton) {
      console.log('APP APPROVAL DETECTED: Found approval confirmation button on checkpoint page');
      return { type: 'app_approval', indicator: 'approval_button_present' };
    }
    
    // Generic checkpoint with no clear indicator - DON'T assume app approval
    console.log('UNKNOWN CHALLENGE: On checkpoint page but no clear indicator');
    return { type: 'unknown_challenge', indicator: 'generic_checkpoint' };
  }
  
  // 8. Handle generic "Confirm it's you" - need more context
  if (lowerText.includes('confirm it\'s you') || lowerText.includes('let\'s do a quick security check')) {
    // Check what options are available on the page
    const hasSendCodeButton = await page.locator('button:has-text("Send"), button:has-text("Get code")').first().isVisible({ timeout: 500 }).catch(() => false);
    if (hasSendCodeButton) {
      console.log('EMAIL/SMS 2FA DETECTED: Security check with send code option');
      return { type: 'email_sms_2fa', indicator: 'security_check_send_code', method: 'unknown' };
    }
    
    // Don't assume - this could be many things
    console.log('UNKNOWN CHALLENGE: Generic security check page');
    return { type: 'unknown_challenge', indicator: 'generic_security_check' };
  }
  
  return { type: 'none', indicator: null };
}

// Check for login failure (bad password, account locked) - LEGACY, uses detectChallengeType internally
async function checkLoginFailed(page) {
  const challenge = await detectChallengeType(page);
  
  if (challenge.type === 'invalid_credentials') {
    return { failed: true, type: 'invalid_credentials' };
  }
  if (challenge.type === 'account_locked') {
    return { failed: true, type: 'account_locked' };
  }
  
  return null;
}

// Check for app approval - LEGACY wrapper
async function checkAppApprovalRequired(page) {
  const challenge = await detectChallengeType(page);
  return challenge.type === 'app_approval';
}

// Check for 2FA requirement - LEGACY wrapper  
async function check2FARequired(page) {
  const challenge = await detectChallengeType(page);
  
  if (challenge.type === 'email_sms_2fa' || challenge.type === 'authenticator_2fa') {
    return { required: true, method: challenge.method || challenge.type };
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

// Poll for 2FA code from database and enter it on the page
async function pollAndEnter2FACode(page, agentId, timeout) {
  const startTime = Date.now();
  const pollInterval = 3000; // Poll every 3 seconds
  
  console.log(`[2FA] Polling for 2FA code for agent ${agentId}...`);
  
  while (Date.now() - startTime < timeout) {
    try {
      // Fetch agent's 2FA code via edge function
      const response = await fetch(`${SUPABASE_URL}/functions/v1/worker-poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': WORKER_SECRET
        },
        body: JSON.stringify({
          workerId: WORKER_ID,
          checkAgent2FA: agentId
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        const twoFACode = data.twoFACode;
        
        if (twoFACode && twoFACode.length === 6) {
          console.log(`[2FA] Received code, entering on page...`);
          
          // Find code input field
          const codeInputSelectors = [
            'input[name="pin"]',
            '#input__phone_verification_pin',
            '#input__email_verification_pin',
            '[data-test="verification-code-input"]',
            'input[placeholder*="code" i]',
            'input[aria-label*="code" i]',
            'input[maxlength="6"]',
            'input[type="text"]'
          ];
          
          for (const selector of codeInputSelectors) {
            const element = await page.locator(selector).first();
            if (await element.isVisible({ timeout: 500 }).catch(() => false)) {
              console.log(`[2FA] Found input with selector: ${selector}`);
              
              // Clear and enter the code
              await element.click();
              await humanDelay(200, 400);
              await element.fill('');
              await humanDelay(100, 200);
              
              // Type code with human-like delays
              for (const char of twoFACode) {
                await element.pressSequentially(char, { delay: Math.random() * 100 + 50 });
              }
              
              await humanDelay(500, 1000);
              
              // Find and click submit button
              const submitSelectors = [
                'button[type="submit"]',
                'button:has-text("Submit")',
                'button:has-text("Verify")',
                'button:has-text("Next")',
                '#two-step-submit-button'
              ];
              
              for (const submitSelector of submitSelectors) {
                const submitBtn = await page.locator(submitSelector).first();
                if (await submitBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                  console.log(`[2FA] Clicking submit button: ${submitSelector}`);
                  await clickHuman(page, submitSelector);
                  
                  // Clear the code from the database
                  await clearAgent2FACode(agentId);
                  
                  return true;
                }
              }
              
              // If no submit button found, code might auto-submit
              console.log('[2FA] No submit button found, code may auto-submit');
              await clearAgent2FACode(agentId);
              return true;
            }
          }
          
          console.log('[2FA] Code received but no input field found on page');
        }
      }
    } catch (error) {
      console.error('[2FA] Error polling for code:', error.message);
    }
    
    // Check if we've already navigated away (user manually completed or auto-submit worked)
    const url = page.url();
    if (url.includes('/feed') || url.includes('/mynetwork') || url.includes('/in/')) {
      console.log('[2FA] Already navigated to logged-in page');
      return true;
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  console.log('[2FA] Timeout waiting for code');
  return false;
}

// Clear the 2FA code from the database after use
async function clearAgent2FACode(agentId) {
  try {
    await callEdgeFunction('worker-update-agent', {
      workerId: WORKER_ID,
      agentId,
      clearTwoFACode: true
    });
    console.log('[2FA] Cleared 2FA code from database');
  } catch (error) {
    console.error('[2FA] Failed to clear 2FA code:', error.message);
  }
}

// Wait for CAPTCHA to be solved by user (polls database for resolution)
async function waitForCaptchaSolved(page, agentId, timeout) {
  const startTime = Date.now();
  const pollInterval = 5000; // Poll every 5 seconds
  const screenshotInterval = 15000; // Update screenshot every 15 seconds
  let lastScreenshotTime = 0;
  
  console.log(`[CAPTCHA] Waiting for user to solve CAPTCHA for agent ${agentId}...`);
  
  // Update agent state to awaiting_captcha
  await updateAgentState(agentId, 'awaiting_captcha');
  
  // Capture initial screenshot and send to database
  try {
    const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
    const screenshotBase64 = screenshotBuffer.toString('base64');
    const screenshotDataUrl = `data:image/png;base64,${screenshotBase64}`;
    
    await callEdgeFunction('worker-update-agent', {
      workerId: WORKER_ID,
      agentId,
      captchaScreenshot: screenshotDataUrl
    });
    console.log('[CAPTCHA] Initial screenshot uploaded to database');
    lastScreenshotTime = Date.now();
  } catch (error) {
    console.error('[CAPTCHA] Failed to capture initial screenshot:', error.message);
  }
  
  while (Date.now() - startTime < timeout) {
    // Check if we've navigated away from CAPTCHA page (user solved it)
    const url = page.url().toLowerCase();
    const pageText = await page.textContent('body').catch(() => '');
    const lowerText = pageText.toLowerCase();
    
    // Check if CAPTCHA is gone
    const captchaIndicators = [
      'prove you\'re human',
      'security verification required',
      'complete the security check',
      'verify you\'re not a robot'
    ];
    
    let captchaStillPresent = false;
    for (const indicator of captchaIndicators) {
      if (lowerText.includes(indicator)) {
        captchaStillPresent = true;
        break;
      }
    }
    
    // Also check for CAPTCHA iframe
    const captchaIframe = await page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="arkose"]').first();
    if (await captchaIframe.isVisible({ timeout: 1000 }).catch(() => false)) {
      captchaStillPresent = true;
    }
    
    // If navigated to feed or no captcha indicators, CAPTCHA is solved
    if (url.includes('/feed') || url.includes('/mynetwork') || url.includes('/in/')) {
      console.log('[CAPTCHA] Navigated to logged-in page - CAPTCHA solved!');
      // Clear the screenshot from database
      await callEdgeFunction('worker-update-agent', {
        workerId: WORKER_ID,
        agentId,
        captchaScreenshot: null
      });
      return true;
    }
    
    if (!captchaStillPresent && !url.includes('checkpoint') && !url.includes('challenge')) {
      console.log('[CAPTCHA] CAPTCHA indicators gone - checking login status...');
      // Clear the screenshot from database
      await callEdgeFunction('worker-update-agent', {
        workerId: WORKER_ID,
        agentId,
        captchaScreenshot: null
      });
      return true;
    }
    
    // Update screenshot periodically
    if (Date.now() - lastScreenshotTime > screenshotInterval) {
      try {
        const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
        const screenshotBase64 = screenshotBuffer.toString('base64');
        const screenshotDataUrl = `data:image/png;base64,${screenshotBase64}`;
        
        await callEdgeFunction('worker-update-agent', {
          workerId: WORKER_ID,
          agentId,
          captchaScreenshot: screenshotDataUrl
        });
        console.log('[CAPTCHA] Screenshot updated');
        lastScreenshotTime = Date.now();
      } catch (error) {
        console.error('[CAPTCHA] Failed to update screenshot:', error.message);
      }
    }
    
    console.log(`[CAPTCHA] Still waiting... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  console.log('[CAPTCHA] Timeout waiting for CAPTCHA to be solved');
  // Clear the screenshot from database on timeout
  await callEdgeFunction('worker-update-agent', {
    workerId: WORKER_ID,
    agentId,
    captchaScreenshot: null
  });
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
// Challenge Debug Logger with Screenshot
// ============================================

async function logChallengeDebug(page, agentId, challengeType) {
  try {
    const url = page.url();
    const pageText = await page.textContent('body').catch(() => '');
    
    // Get all input fields on the page
    const inputFields = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input, button');
      return Array.from(inputs).slice(0, 20).map(el => ({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        text: el.textContent?.substring(0, 50) || '',
        ariaLabel: el.getAttribute('aria-label') || ''
      }));
    });
    
    // Take screenshot as base64
    let screenshotBase64 = '';
    try {
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
      screenshotBase64 = screenshotBuffer.toString('base64');
      console.log(`[DEBUG] Screenshot captured (${screenshotBase64.length} chars base64)`);
    } catch (screenshotError) {
      console.error('[DEBUG] Failed to capture screenshot:', screenshotError.message);
    }
    
    // Log detailed debug info
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║             CHALLENGE DEBUG INFO                           ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║ Agent ID: ${agentId}`);
    console.log(`║ Challenge Type: ${challengeType}`);
    console.log(`║ URL: ${url}`);
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║ Page Text (first 1500 chars):');
    console.log(pageText.substring(0, 1500));
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║ Input Fields:', JSON.stringify(inputFields, null, 2));
    console.log('╚════════════════════════════════════════════════════════════╝');
    
    // Log the full screenshot base64 on a separate line for easy extraction from Railway logs
    if (screenshotBase64) {
      console.log('[SCREENSHOT_START]');
      console.log(screenshotBase64);
      console.log('[SCREENSHOT_END]');
    }
    
    return { url, pageText: pageText.substring(0, 1500), inputFields, screenshotBase64 };
  } catch (error) {
    console.error('[DEBUG] Error logging challenge debug:', error.message);
    return null;
  }
}

// ============================================
// LinkedIn Login Handler (THE MISSING FUNCTION!)
// ============================================

async function handleLinkedInLogin(page, context, action, agentId) {
  const payload = action.payload || {};
  const email = payload.email || payload.linkedinEmail;
  const password = payload.password || payload.linkedinPassword;
  const useCookies = payload.useCookies;
  const liAtCookie = payload.liAtCookie;
  const liACookie = payload.liACookie;
  
  console.log(`[LOGIN] Starting LinkedIn login for agent ${agentId}`);
  console.log(`[LOGIN] Has email: ${!!email}, Has password: ${!!password}, Use cookies: ${useCookies}`);
  
  try {
    // Step 1: Update status to navigating
    await updateAgentState(agentId, 'navigating');
    
    // Step 2: If using cookies, try cookie-based login first
    if (useCookies && liAtCookie) {
      console.log('[LOGIN] Attempting cookie-based login...');
      await context.addCookies([
        {
          name: 'li_at',
          value: liAtCookie,
          domain: '.linkedin.com',
          path: '/',
          httpOnly: true,
          secure: true,
        },
        ...(liACookie ? [{
          name: 'li_a',
          value: liACookie,
          domain: '.linkedin.com',
          path: '/',
          httpOnly: true,
          secure: true,
        }] : []),
      ]);
      
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 60000 });
      
      if (await verifyLogin(page)) {
        console.log('[LOGIN] Cookie login successful!');
        return await extractSessionAndComplete(context, agentId);
      }
      console.log('[LOGIN] Cookies invalid or expired, falling back to credentials');
    }
    
    // Step 3: Navigate to LinkedIn login page
    console.log('[LOGIN] Navigating to LinkedIn login page...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle', timeout: 60000 });
    await humanDelay(1500, 2500);
    
    // Check if already logged in
    if (await verifyLogin(page)) {
      console.log('[LOGIN] Already logged in!');
      return await extractSessionAndComplete(context, agentId);
    }
    
    // Step 4: Enter credentials
    if (!email || !password) {
      throw new Error('Missing email or password for login');
    }
    
    await updateAgentState(agentId, 'entering_credentials');
    
    console.log('[LOGIN] Entering email...');
    await typeHuman(page, 'input#username, input[name="session_key"]', email);
    await humanDelay(500, 1000);
    
    console.log('[LOGIN] Entering password...');
    await typeHuman(page, 'input#password, input[name="session_password"]', password);
    await humanDelay(500, 1000);
    
    console.log('[LOGIN] Clicking sign in button...');
    await clickHuman(page, 'button[type="submit"]');
    
    // Step 5: Wait for response and check for challenges
    console.log('[LOGIN] Waiting for response...');
    await humanDelay(4000, 6000);
    
    // Step 6: Detect any challenges
    const challenge = await detectChallengeType(page);
    console.log(`[LOGIN] Challenge detection result: ${JSON.stringify(challenge)}`);
    
    // ALWAYS log debug info when any challenge is detected
    if (challenge.type !== 'none') {
      console.log('[LOGIN] Challenge detected, logging debug info with screenshot...');
      await logChallengeDebug(page, agentId, challenge.type);
    }
    
    // Step 7: Handle different challenge types
    switch (challenge.type) {
      case 'none':
        // No challenge - check if login succeeded
        if (await verifyLogin(page)) {
          console.log('[LOGIN] Login successful - no challenges!');
          return await extractSessionAndComplete(context, agentId);
        }
        // Unknown state
        console.log('[LOGIN] No challenge detected but not logged in - unknown state');
        await logChallengeDebug(page, agentId, 'unknown_no_challenge');
        throw new Error('Login failed - ended in unknown state');
        
      case 'invalid_credentials':
        await updateAgentState(agentId, 'invalid_credentials', {
          loginError: 'Invalid email or password'
        });
        throw new Error('Invalid credentials');
        
      case 'account_locked':
        await updateAgentState(agentId, 'account_locked', {
          loginError: 'Account is locked or restricted'
        });
        throw new Error('Account locked');
        
      case 'captcha':
        console.log('[LOGIN] CAPTCHA detected, waiting for user to solve...');
        const captchaSolved = await waitForCaptchaSolved(page, agentId, 300000); // 5 minute timeout
        
        if (captchaSolved) {
          console.log('[LOGIN] CAPTCHA solved! Checking login status...');
          
          // Wait a moment for page to settle
          await humanDelay(2000, 3000);
          
          // Check if we're now logged in
          if (await verifyLogin(page)) {
            console.log('[LOGIN] CAPTCHA solved - login successful!');
            return await extractSessionAndComplete(context, agentId);
          }
          
          // Check for any follow-up challenges after CAPTCHA
          const postCaptchaChallenge = await detectChallengeType(page);
          console.log(`[LOGIN] Post-CAPTCHA challenge: ${JSON.stringify(postCaptchaChallenge)}`);
          
          if (postCaptchaChallenge.type === 'none') {
            // Try login verification one more time
            if (await verifyLogin(page)) {
              return await extractSessionAndComplete(context, agentId);
            }
          } else if (postCaptchaChallenge.type === 'email_sms_2fa' || postCaptchaChallenge.type === 'authenticator_2fa') {
            // Handle 2FA after CAPTCHA
            console.log('[LOGIN] 2FA required after CAPTCHA');
            await updateAgentState(agentId, 'awaiting_2fa', {
              twoFAMethod: postCaptchaChallenge.method || 'unknown'
            });
            const postCaptcha2FA = await pollAndEnter2FACode(page, agentId, 300000);
            if (postCaptcha2FA) {
              await humanDelay(3000, 5000);
              if (await verifyLogin(page)) {
                return await extractSessionAndComplete(context, agentId);
              }
            }
            throw new Error('2FA failed after CAPTCHA');
          } else if (postCaptchaChallenge.type === 'app_approval') {
            console.log('[LOGIN] App approval required after CAPTCHA');
            await updateAgentState(agentId, 'awaiting_app_approval');
            const appApproved = await waitFor2FACompletion(page, 120000);
            if (appApproved) {
              return await extractSessionAndComplete(context, agentId);
            }
            throw new Error('App approval timeout after CAPTCHA');
          }
          
          // Unknown state after CAPTCHA
          await logChallengeDebug(page, agentId, 'post_captcha_unknown');
          throw new Error('Unknown state after CAPTCHA solved');
        }
        
        // CAPTCHA timeout
        await updateAgentState(agentId, 'failed', {
          loginError: 'CAPTCHA timeout - please try again'
        });
        throw new Error('CAPTCHA timeout');
        
      case 'app_approval':
        console.log('[LOGIN] LinkedIn App Approval required');
        await updateAgentState(agentId, 'awaiting_app_approval', {
          twoFAMethod: 'linkedin_app'
        });
        
        // Wait for user to approve in app
        const approvalCompleted = await waitFor2FACompletion(page, 120000);
        
        if (approvalCompleted) {
          console.log('[LOGIN] App approval completed!');
          return await extractSessionAndComplete(context, agentId);
        }
        throw new Error('App approval timeout');
        
      case 'email_sms_2fa':
        console.log(`[LOGIN] Email/SMS 2FA required (method: ${challenge.method})`);
        await updateAgentState(agentId, 'awaiting_2fa', {
          twoFAMethod: challenge.method === 'sms' ? 'sms' : 'email'
        });
        
        // Poll for 2FA code from user and enter it
        const codeEntered = await pollAndEnter2FACode(page, agentId, 300000);
        
        if (codeEntered) {
          // Wait for navigation after code submission
          await humanDelay(3000, 5000);
          
          if (await verifyLogin(page)) {
            console.log('[LOGIN] 2FA completed - login successful!');
            return await extractSessionAndComplete(context, agentId);
          }
          
          // Check for invalid code
          const afterCodeChallenge = await detectChallengeType(page);
          if (afterCodeChallenge.type === 'email_sms_2fa') {
            console.log('[LOGIN] Code may be invalid, still on 2FA page');
            throw new Error('Invalid 2FA code - please try again');
          }
        }
        throw new Error('2FA timeout - no code received');
        
      case 'authenticator_2fa':
        console.log('[LOGIN] Authenticator 2FA required');
        await updateAgentState(agentId, 'awaiting_2fa', {
          twoFAMethod: 'authenticator'
        });
        
        // Poll for authenticator code from user
        const authCodeEntered = await pollAndEnter2FACode(page, agentId, 300000);
        
        if (authCodeEntered) {
          await humanDelay(3000, 5000);
          
          if (await verifyLogin(page)) {
            console.log('[LOGIN] Authenticator 2FA completed!');
            return await extractSessionAndComplete(context, agentId);
          }
        }
        throw new Error('Authenticator 2FA timeout');
        
      case 'unknown_challenge':
        console.log('[LOGIN] Unknown challenge type detected');
        await updateAgentState(agentId, 'failed', {
          loginError: `Unknown challenge: ${challenge.indicator}`
        });
        throw new Error(`Unknown challenge: ${challenge.indicator}`);
        
      default:
        throw new Error(`Unhandled challenge type: ${challenge.type}`);
    }
    
  } catch (error) {
    console.error('[LOGIN] Login failed:', error.message);
    throw error;
  }
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
