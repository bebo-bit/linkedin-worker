```javascript
const GoLogin = require('gologin');
const puppeteer = require('puppeteer-core');

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const GOLOGIN_API_TOKEN = process.env.GOLOGIN_API_TOKEN;
const WORKER_ID = process.env.WORKER_ID || 'worker-001';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30000'); // 30 seconds

// Validate required env vars
if (!SUPABASE_URL || !WORKER_SECRET || !GOLOGIN_API_TOKEN) {
  console.error('Missing required environment variables');
  console.error('Required: SUPABASE_URL, WORKER_SECRET, GOLOGIN_API_TOKEN');
  process.exit(1);
}

console.log(`[${WORKER_ID}] Starting worker...`);
console.log(`[${WORKER_ID}] Supabase URL: ${SUPABASE_URL}`);
console.log(`[${WORKER_ID}] Poll interval: ${POLL_INTERVAL}ms`);

// Poll for actions via edge function
async function pollForActions() {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/worker-poll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': WORKER_SECRET,
      },
      body: JSON.stringify({
        workerId: WORKER_ID,
        limit: 1, // Process one at a time for safety
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${WORKER_ID}] Poll failed (${response.status}):`, errorText);
      return [];
    }

    const data = await response.json();
    return data.actions || [];
  } catch (error) {
    console.error(`[${WORKER_ID}] Poll error:`, error.message);
    return [];
  }
}

// Report action result via edge function
async function reportResult(actionId, success, result = null, errorMessage = null, shouldRetry = false) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/worker-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': WORKER_SECRET,
      },
      body: JSON.stringify({
        workerId: WORKER_ID,
        actionId,
        success,
        result,
        errorMessage,
        shouldRetry,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${WORKER_ID}] Report failed (${response.status}):`, errorText);
    }
  } catch (error) {
    console.error(`[${WORKER_ID}] Report error:`, error.message);
  }
}

// Process a single action
async function processAction(action) {
  const { id, action_type, payload, gologin_profile, lead } = action;
  
  console.log(`[${WORKER_ID}] Processing action: ${action_type} (${id})`);
  
  if (!gologin_profile?.profile_id) {
    console.error(`[${WORKER_ID}] No GoLogin profile linked`);
    await reportResult(id, false, null, 'No GoLogin profile linked', false);
    return;
  }

  let browser = null;
  let GL = null;

  try {
    // Initialize GoLogin
    GL = new GoLogin({
      token: GOLOGIN_API_TOKEN,
      profile_id: gologin_profile.profile_id,
    });

    // Start profile and get browser
    const { status, wsUrl } = await GL.start();
    
    if (status !== 'success') {
      throw new Error(`Failed to start GoLogin profile: ${status}`);
    }

    browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Execute action based on type
    let result = null;
    
    switch (action_type) {
      case 'view_profile':
        result = await viewProfile(page, lead);
        break;
      case 'connect':
        result = await sendConnection(page, lead, payload);
        break;
      case 'message':
        result = await sendMessage(page, lead, payload);
        break;
      case 'like':
        result = await likePost(page, payload);
        break;
      case 'comment':
        result = await commentOnPost(page, payload);
        break;
      default:
        throw new Error(`Unknown action type: ${action_type}`);
    }

    console.log(`[${WORKER_ID}] Action ${action_type} completed successfully`);
    await reportResult(id, true, result);

  } catch (error) {
    console.error(`[${WORKER_ID}] Action ${action_type} failed:`, error.message);
    await reportResult(id, false, null, error.message, true);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (GL) {
      await GL.stop().catch(() => {});
    }
  }
}

// Action implementations
async function viewProfile(page, lead) {
  if (!lead?.linkedin_url) {
    throw new Error('No LinkedIn URL for lead');
  }
  
  await page.goto(lead.linkedin_url, { waitUntil: 'networkidle2', timeout: 30000 });
  await humanDelay(2000, 4000);
  
  // Scroll down to simulate viewing
  await page.evaluate(() => window.scrollBy(0, 500));
  await humanDelay(1000, 2000);
  
  return { viewed: true, url: lead.linkedin_url };
}

async function sendConnection(page, lead, payload) {
  if (!lead?.linkedin_url) {
    throw new Error('No LinkedIn URL for lead');
  }
  
  await page.goto(lead.linkedin_url, { waitUntil: 'networkidle2', timeout: 30000 });
  await humanDelay(2000, 4000);
  
  // Find and click Connect button
  const connectBtn = await page.$('button[aria-label*="Connect"]');
  if (!connectBtn) {
    throw new Error('Connect button not found');
  }
  
  await connectBtn.click();
  await humanDelay(1000, 2000);
  
  // Add note if provided
  if (payload?.message) {
    const addNoteBtn = await page.$('button[aria-label*="Add a note"]');
    if (addNoteBtn) {
      await addNoteBtn.click();
      await humanDelay(500, 1000);
      
      const noteField = await page.$('textarea[name="message"]');
      if (noteField) {
        await typeHuman(noteField, payload.message);
        await humanDelay(500, 1000);
      }
    }
  }
  
  // Click Send
  const sendBtn = await page.$('button[aria-label*="Send"]');
  if (sendBtn) {
    await sendBtn.click();
    await humanDelay(1000, 2000);
  }
  
  return { connected: true, url: lead.linkedin_url };
}

async function sendMessage(page, lead, payload) {
  if (!lead?.linkedin_url) {
    throw new Error('No LinkedIn URL for lead');
  }
  if (!payload?.message) {
    throw new Error('No message provided');
  }
  
  await page.goto(lead.linkedin_url, { waitUntil: 'networkidle2', timeout: 30000 });
  await humanDelay(2000, 4000);
  
  // Find and click Message button
  const messageBtn = await page.$('button[aria-label*="Message"]');
  if (!messageBtn) {
    throw new Error('Message button not found - may not be connected');
  }
  
  await messageBtn.click();
  await humanDelay(1500, 2500);
  
  // Type message
  const messageField = await page.$('div[role="textbox"]');
  if (!messageField) {
    throw new Error('Message field not found');
  }
  
  await typeHuman(messageField, payload.message);
  await humanDelay(500, 1000);
  
  // Click Send
  const sendBtn = await page.$('button[aria-label*="Send"]');
  if (sendBtn) {
    await sendBtn.click();
    await humanDelay(1000, 2000);
  }
  
  return { sent: true, url: lead.linkedin_url };
}

async function likePost(page, payload) {
  if (!payload?.post_url) {
    throw new Error('No post URL provided');
  }
  
  await page.goto(payload.post_url, { waitUntil: 'networkidle2', timeout: 30000 });
  await humanDelay(2000, 4000);
  
  const likeBtn = await page.$('button[aria-label*="Like"]');
  if (!likeBtn) {
    throw new Error('Like button not found');
  }
  
  await likeBtn.click();
  await humanDelay(1000, 2000);
  
  return { liked: true, url: payload.post_url };
}

async function commentOnPost(page, payload) {
  if (!payload?.post_url || !payload?.comment_text) {
    throw new Error('Post URL and comment text required');
  }
  
  await page.goto(payload.post_url, { waitUntil: 'networkidle2', timeout: 30000 });
  await humanDelay(2000, 4000);
  
  // Click comment button to focus comment field
  const commentBtn = await page.$('button[aria-label*="Comment"]');
  if (commentBtn) {
    await commentBtn.click();
    await humanDelay(1000, 2000);
  }
  
  // Type comment
  const commentField = await page.$('div[data-placeholder*="Add a comment"]');
  if (!commentField) {
    throw new Error('Comment field not found');
  }
  
  await typeHuman(commentField, payload.comment_text);
  await humanDelay(500, 1000);
  
  // Submit comment
  const postBtn = await page.$('button[aria-label*="Post"]');
  if (postBtn) {
    await postBtn.click();
    await humanDelay(1000, 2000);
  }
  
  return { commented: true, url: payload.post_url };
}

// Helper functions
async function humanDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

async function typeHuman(element, text) {
  for (const char of text) {
    await element.type(char, { delay: Math.random() * 100 + 50 });
    if (Math.random() < 0.1) {
      await humanDelay(200, 500);
    }
  }
}

// Main loop
async function main() {
  console.log(`[${WORKER_ID}] Worker started, polling every ${POLL_INTERVAL}ms`);
  
  while (true) {
    try {
      const actions = await pollForActions();
      
      if (actions.length > 0) {
        console.log(`[${WORKER_ID}] Got ${actions.length} action(s) to process`);
        
        for (const action of actions) {
          await processAction(action);
          await humanDelay(5000, 10000); // Wait between actions
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    } catch (error) {
      console.error(`[${WORKER_ID}] Main loop error:`, error.message);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`[${WORKER_ID}] Shutting down...`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`[${WORKER_ID}] Shutting down...`);
  process.exit(0);
});

main();
