// worker.js - UPDATED for automated email/password login.

// --- Core Node.js Modules ---
const fs = require('fs').promises;
const https = require('https');

// --- Third-Party Packages ---
const { Pool } = require('pg');
const { chromium } = require('playwright');
const express = require('express');
const bodyParser = require('body-parser');

// --- Local Modules ---
const discordBot = require('./bot.js');

// --- CONFIGURATION & SECURITY ---
const SESSION_FILE_PATH = 'session.json';

// --- Database Connection ---
const pool = new Pool({
    connectionString: process.env.CONNECTION_STRING,
    ssl: { require: true },
});

// =================================================================
// SECTION 1: CORE APPLICATION LOGIC
// =================================================================

let publishingInProgress = new Set();
let publishingQueue = [];
let isQueueProcessing = false;

async function loadData() {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT data FROM app_data WHERE id = 1');
        return result.rows.length > 0 ? result.rows[0].data : {};
    } catch (err) {
        console.error('Error loading data from database', err);
        return {};
    } finally {
        if (client) client.release();
    }
}

async function saveData(appData) {
    let client;
    try {
        client = await pool.connect();
        await client.query('UPDATE app_data SET data = $1 WHERE id = 1', [appData]);
    } catch (err) {
        console.error('Error saving data to database', err);
    } finally {
        if (client) client.release();
    }
}

// NEW: Automated login function
async function loginAndSaveSession() {
    console.log('Attempting to log in to Zedge and save session...');
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        
        await page.goto('https://www.zedge.net/login');
        await page.waitForSelector('input[name="username"]');
        
        await page.fill('input[name="username"]', process.env.ZEDGE_EMAIL);
        await page.fill('input[name="password"]', process.env.ZEDGE_PASSWORD);
        
        await page.click('button[type="submit"]');
        await page.waitForURL('**/upload.zedge.net/**', { timeout: 30000 });
        
        console.log('Login successful. Saving session state...');
        const storageState = await context.storageState();
        await fs.writeFile(SESSION_FILE_PATH, JSON.stringify(storageState));
        
        console.log('Session file has been created/updated.');
        return { loggedIn: true };
    } catch (error) {
        console.error('Failed to log in to Zedge:', error.message);
        try {
            await fs.unlink(SESSION_FILE_PATH);
        } catch (e) { /* ignore if file doesn't exist */ }
        return { loggedIn: false, error: `Login attempt failed.` };
    } finally {
        if (browser) await browser.close();
    }
}

// UPDATED: Self-healing login check
async function checkLoginStatus() {
    console.log('Performing Zedge login status check...');
    let browser;
    try {
        // First, try to use the existing session file
        await fs.access(SESSION_FILE_PATH);
        const storageState = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
        browser = await chromium.launch();
        const context = await browser.newContext({ storageState: JSON.parse(storageState) });
        const page = await context.newPage();
        await page.goto('https://upload.zedge.net/', { waitUntil: 'domcontentloaded' });
        
        const finalUrl = page.url();
        if (finalUrl.includes('account.zedge.net')) {
             console.log('Session is invalid or expired. Attempting to re-login.');
             return await loginAndSaveSession(); // Attempt to log in again
        }
        return { loggedIn: true };

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('session.json not found on server. Attempting initial login.');
            return await loginAndSaveSession(); // No session file, so log in
        }
        console.error('An unknown error occurred during status check. Attempting re-login.', error.message);
        return await loginAndSaveSession();
    } finally {
        if (browser) await browser.close();
    }
}


function sendDiscordNotification(message) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl || !message) return;
    try {
        const payload = JSON.stringify({ content: message });
        const options = { hostname: 'discord.com', path: new URL(webhookUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
        const req = https.request(options);
        req.on('error', (e) => console.error('Discord notification error:', e.message));
        req.write(payload);
        req.end();
    } catch (e) {
        console.error('Invalid Webhook URL:', e.message);
    }
}

async function checkScheduleForPublishing() {
    console.log('--- Running background check ---');
    const data = await loadData();

    if (data.settings?.isAutoPublishingEnabled) {
        console.log('Desktop auto-publishing is active. Cloud worker is standing by.');
        return;
    }
    if (!data.schedule || !Array.isArray(data.schedule) || data.schedule.length === 0) {
        return;
    }

    const now = new Date();
    for (const item of data.schedule) {
        if (!item.scheduledAtUTC) continue;
        const scheduleDateTime = new Date(item.scheduledAtUTC);
        const isDue = now >= scheduleDateTime;
        const isPending = !item.status || item.status === 'Pending';

        if (isDue && isPending && !publishingInProgress.has(item.id)) {
            console.log(`✅ FOUND DUE ITEM: "${item.title}". Adding to queue.`);
            publishingInProgress.add(item.id);
            publishingQueue.push(item);
            if (!isQueueProcessing) {
                processPublishingQueue();
            }
        }
    }
}

async function processPublishingQueue() {
    if (isQueueProcessing || publishingQueue.length === 0) return;
    isQueueProcessing = true;
    while (publishingQueue.length > 0) {
        const itemToPublish = publishingQueue.shift();
        try {
            await executePublishWorkflow(itemToPublish);
        } catch (error) {
            console.error(`A critical error occurred for item "${itemToPublish.title}"`, error);
        } finally {
            publishingInProgress.delete(itemToPublish.id);
        }
    }
    isQueueProcessing = false;
}

async function executePublishWorkflow(scheduledItem) {
    const result = await performPublish(scheduledItem);
    const appData = await loadData();
    try {
        if (appData.schedule && Array.isArray(appData.schedule)) {
            const itemIndex = appData.schedule.findIndex(i => i.id === scheduledItem.id);
            if (itemIndex > -1) {
                appData.schedule[itemIndex].status = result.status === 'success' ? 'Published' : 'Failed';
                appData.schedule[itemIndex].failMessage = result.message;
                await saveData(appData);
                const notificationMessage = result.status === 'success'
                    ? `✅ Successfully published: "${scheduledItem.title}"`
                    : `❌ Failed to publish: "${scheduledItem.title}".\nReason: ${result.message}`;
                sendDiscordNotification(notificationMessage);
            }
        }
    } catch (e) {
        console.error('Failed to update database after publishing:', e);
    }
    return result;
}

async function performPublish(scheduledItem) {
    console.log(`--- Starting publish process for: "${scheduledItem.title}" ---`);
    let browser;
    try {
        // Pre-flight check to ensure we are logged in.
        const loginStatus = await checkLoginStatus();
        if (!loginStatus.loggedIn) {
            throw new Error(`Publishing failed because login is not active. Reason: ${loginStatus.error}`);
        }

        const storageState = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
        browser = await chromium.launch();
        const context = await browser.newContext({ storageState: JSON.parse(storageState) });
        const page = await context.newPage();

        await page.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                route.abort();
            } else {
                route.continue();
            }
        });
        
        const ZEDGE_PROFILES = {
            Normal: 'https://upload.zedge.net/business/4e5d55ef-ea99-4913-90cf-09431dc1f28f/profiles/0c02b238-4bd0-479e-91f7-85c6df9c8b0f/content/WALLPAPER',
            Black: 'https://upload.zedge.net/business/4e5d55ef-ea99-4913-90cf-09431dc1f28f/profiles/a90052da-0ec5-4877-a73f-034c6da5d45a/content/WALLPAPER'
        };
        
        const theme = scheduledItem.theme || '';
        const targetProfileName = theme.toLowerCase().includes('black') ? 'Black' : 'Normal';
        const targetProfileUrl = ZEDGE_PROFILES[targetProfileName];
        if (!targetProfileUrl) throw new Error(`Could not determine a valid profile URL for theme: "${theme}"`);

        console.log(`Loading profile: ${targetProfileName}`);
        await page.goto(targetProfileUrl);

        console.log(`Searching for DRAFT: "${scheduledItem.title}"`);
        const foundAndClicked = await page.evaluate(async (itemTitle) => {
            return new Promise((resolve) => {
                const timeout = 45000, interval = 1500;
                let elapsedTime = 0;
                const searchInterval = setInterval(() => {
                    const elements = document.querySelectorAll('div[class*="StyledTitle"], div[title], span');
                    for (const el of elements) {
                        if (el.textContent.trim() === itemTitle || el.getAttribute('title') === itemTitle) {
                            const statusContainer = el.parentElement;
                            const statusElement = statusContainer ? statusContainer.querySelector('span[type="DEFAULT"]') : null;
                            if (statusElement && statusElement.textContent.trim().toUpperCase() === 'DRAFT') {
                                clearInterval(searchInterval);
                                const clickableTarget = el.closest('div[role="button"], a');
                                if (clickableTarget) { clickableTarget.click(); } else { el.click(); }
                                resolve(true);
                                return;
                            }
                        }
                    }
                    const loadMoreButton = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.trim().toLowerCase() === 'load more');
                    if (loadMoreButton) loadMoreButton.click();
                    elapsedTime += interval;
                    if (elapsedTime >= timeout) {
                        clearInterval(searchInterval);
                        resolve(false);
                    }
                }, interval);
            });
        }, scheduledItem.title);

        if (!foundAndClicked) throw new Error(`Could not find a DRAFT with the title "${scheduledItem.title}"`);
        
        console.log("Found DRAFT, clicking it. Waiting for details page.");
        await page.waitForTimeout(8000);

        const clickedPublish = await page.evaluate(() => {
            return new Promise((resolve) => {
                const timeout = 15000, interval = 1000;
                let elapsedTime = 0;
                const findButtonInterval = setInterval(() => {
                    const publishButton = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.trim().toLowerCase() === 'publish');
                    if (publishButton && !publishButton.disabled) {
                        clearInterval(findButtonInterval);
                        publishButton.click();
                        resolve(true);
                        return;
                    }
                    elapsedTime += interval;
                    if (elapsedTime >= timeout) {
                        clearInterval(findButtonInterval);
                        resolve(false);
                    }
                }, interval);
            });
        });

        if (!clickedPublish) throw new Error('The "Publish" button was not found on the details page.');
        
        console.log("Clicked 'Publish'. Waiting for verification.");
        await page.waitForTimeout(8000);
        
        console.log(`Navigating back to ${targetProfileName} profile for verification.`);
        await page.goto(targetProfileUrl);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);

        console.log(`Verifying PUBLISHED status for: "${scheduledItem.title}"`);
        const isPublished = await page.evaluate(async (itemTitle) => {
             return new Promise((resolve) => {
                const timeout = 45000, interval = 1500;
                let elapsedTime = 0;
                const verifyInterval = setInterval(() => {
                    const elements = document.querySelectorAll('div[class*="StyledTitle"], div[title], span');
                    for (const el of elements) {
                        if (el.textContent.trim() === itemTitle || el.getAttribute('title') === itemTitle) {
                            const container = el.parentElement;
                            const statusElement = container ? container.querySelector('span[type="SUCCESS"]') : null;
                            if (statusElement && statusElement.textContent.trim().toUpperCase() === 'PUBLISHED') {
                                clearInterval(verifyInterval);
                                resolve(true);
                                return;
                            }
                        }
                    }
                    const loadMoreButton = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.trim().toLowerCase() === 'load more');
                    if (loadMoreButton) loadMoreButton.click();
                    elapsedTime += interval;
                    if (elapsedTime >= timeout) {
                        clearInterval(verifyInterval);
                        resolve(false);
                    }
                }, interval);
            });
        }, scheduledItem.title);

        if (!isPublished) throw new Error('Verification failed. Item status was not updated to "Published".');

        console.log(`--- Successfully published and verified "${scheduledItem.title}" ---`);
        return { status: 'success', message: 'Published and verified successfully.' };

    } catch (error) {
        console.error(`Failed to publish "${scheduledItem.title}":`, error);
        return { status: 'failed', message: error.message };
    } finally {
        if (browser) { await browser.close(); }
    }
}

// =================================================================
// SECTION 2: EXPRESS WEB SERVER (Now simplified)
// =================================================================

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.status(200).send('Zedge Publisher worker is alive and running.');
});

// =================================================================
// SECTION 3: WORKER INITIALIZATION
// =================================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    discordBot.startBot(process.env.DISCORD_BOT_TOKEN, {
        loadDataFunc: loadData,
        loginCheckFunc: checkLoginStatus
    });
    startWorker();
});

function startWorker() {
    console.log('Zedge Worker started. Initializing background tasks...');
    // Initial check on startup after a small delay
    setTimeout(checkLoginStatus, 15 * 1000); 

    setInterval(checkScheduleForPublishing, 60 * 1000);
    setInterval(async () => {
        const status = await checkLoginStatus();
        if (!status.loggedIn) {
            sendDiscordNotification(`🔴 **Action Required:** The Zedge worker has been logged out and could not log back in. Manual intervention may be needed. \n**Reason:** ${status.error}`);
        }
    }, 6 * 60 * 60 * 1000);
}