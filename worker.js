const puppeteer = require('puppeteer-core');

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const GOLOGIN_API_TOKEN = process.env.GOLOGIN_API_TOKEN;
const WORKER_ID = process.env.WORKER_ID || 'worker-001';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30000');

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
        limit: 1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${WORKER_ID}] Poll failed (${response.status}):`, errorText);
      return [];
    }

    const data = await response.json();
    console.log(`[${WORKER_ID}] Polled ${data.actions?.length || 0} actions`);
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
    } else {
      console.log(`[${WORKER_ID}] Reported result for action ${actionId}: ${success ? 'SUCCESS' : 'FAILED'}`);
    }
  } catch (error) {
    console.error(`[${WORKER_ID}] Report error:`, error.message);
  }
}

// Connect to GoLogin Cloud Browser
async function connectToGoLoginProfile(profileId) {
  const cloudBrowserUrl = `https://cloudbrowser.gologin.com/connect?token=${GOLOGIN_API_TOKEN}&profile=${profileId}`;
  
  console.log(`[${WORKER_ID}] Connecting to GoLogin Cloud Browser for profile: ${profileId}`);
  
  const browser = await puppeteer.connect({
    browserWSEndpoint: cloudBrowserUrl,
    defaultViewport: null,
  });
  
  return browser;
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

  try {
    // Connect to GoLogin Cloud Browser
    browser = await connectToGoLoginProfile(gologin_profile.profile_id);
    
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

    await reportResult(id, true, result);
    console.log(`[${WORKER_ID}] Action ${action_type} completed successfully`);

  } catch (error) {
    console.error(`[${WORKER_ID}] Action failed:`, error.message);
    await reportResult(id, false, null, error.message, true);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error(`[${WORKER_ID}] Error closing browser:`, e.message);
      }
    }
  }
}

// LinkedIn action implementations
async function viewProfile(page, lead) {
  const profileUrl = lead?.linkedin_url || lead?.profile_url;
  if (!profileUrl) throw new Error('No LinkedIn URL for lead');
  
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await humanDelay(3000, 6000);
  
  // Scroll to simulate reading
  await page.evaluate(() => window.scrollBy(0, 500));
  await humanDelay(2000, 4000);
  
  return { viewed: true, url: profileUrl };
}

async function sendConnection(page, lead, payload) {
  const profileUrl = lead?.linkedin_url || lead?.profile_url;
  if (!profileUrl) throw new Error('No LinkedIn URL for lead');
  
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await humanDelay(2000, 4000);
  
  // Find and click Connect button
  const connectBtn = await page.$('button[aria-label*="Connect"]');
  if (!connectBtn) throw new Error('Connect button not found');
  
  await connectBtn.click();
  await humanDelay(1000, 2000);
  
  // Add note if provided
  if (payload?.message) {
    const addNoteBtn = await page.$('button[aria-label*="Add a note"]');
    if (addNoteBtn) {
      await addNoteBtn.click();
      await humanDelay(500, 1000);
      
      const noteTextarea = await page.$('textarea[name="message"]');
      if (noteTextarea) {
        await typeHuman(page, noteTextarea, payload.message);
      }
    }
  }
  
  // Click Send
  const sendBtn = await page.$('button[aria-label*="Send"]');
  if (sendBtn) {
    await sendBtn.click();
    await humanDelay(1000, 2000);
  }
  
  return { connected: true, url: profileUrl };
}

async function sendMessage(page, lead, payload) {
  const profileUrl = lead?.linkedin_url || lead?.profile_url;
  if (!profileUrl) throw new Error('No LinkedIn URL for lead');
  if (!payload?.message) throw new Error('No message content');
  
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await humanDelay(2000, 4000);
  
  // Click Message button
  const messageBtn = await page.$('button[aria-label*="Message"]');
  if (!messageBtn) throw new Error('Message button not found');
  
  await messageBtn.click();
  await humanDelay(1500, 3000);
  
  // Type message
  const messageBox = await page.$('div[role="textbox"]');
  if (!messageBox) throw new Error('Message input not found');
  
  await typeHuman(page, messageBox, payload.message);
  await humanDelay(500, 1000);
  
  // Send message
  const sendBtn = await page.$('button[type="submit"]');
  if (sendBtn) {
    await sendBtn.click();
    await humanDelay(1000, 2000);
  }
  
  return { sent: true, url: profileUrl };
}

async function likePost(page, payload) {
  if (!payload?.post_url) throw new Error('No post URL');
  
  await page.goto(payload.post_url, { waitUntil: 'networkidle2', timeout: 60000 });
  await humanDelay(2000, 4000);
  
  const likeBtn = await page.$('button[aria-label*="Like"]');
  if (!likeBtn) throw new Error('Like button not found');
  
  await likeBtn.click();
  await humanDelay(1000, 2000);
  
  return { liked: true, url: payload.post_url };
}

async function commentOnPost(page, payload) {
  if (!payload?.post_url) throw new Error('No post URL');
  if (!payload?.comment) throw new Error('No comment content');
  
  await page.goto(payload.post_url, { waitUntil: 'networkidle2', timeout: 60000 });
  await humanDelay(2000, 4000);
  
  // Click comment button to open comment box
  const commentBtn = await page.$('button[aria-label*="Comment"]');
  if (commentBtn) {
    await commentBtn.click();
    await humanDelay(1000, 2000);
  }
  
  // Type comment
  const commentBox = await page.$('div[role="textbox"]');
  if (!commentBox) throw new Error('Comment input not found');
  
  await typeHuman(page, commentBox, payload.comment);
  await humanDelay(500, 1000);
  
  // Submit comment
  const postBtn = await page.$('button[aria-label*="Post"]');
  if (postBtn) {
    await postBtn.click();
    await humanDelay(1000, 2000);
  }
  
  return { commented: true, url: payload.post_url };
}

// Human-like delays
function humanDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Human-like typing
async function typeHuman(page, element, text) {
  await element.click();
  for (const char of text) {
    await page.keyboard.type(char);
    await humanDelay(50, 150);
  }
}

// Main loop
async function main() {
  console.log(`[${WORKER_ID}] Worker started, polling every ${POLL_INTERVAL}ms`);
  
  while (true) {
    try {
      const actions = await pollForActions();
      
      for (const action of actions) {
        await processAction(action);
      }
    } catch (error) {
      console.error(`[${WORKER_ID}] Main loop error:`, error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
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

main().catch(console.error);
