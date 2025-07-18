// worker.js - CORRECTED FOR TELEGRAM

// --- Core Node.js Modules ---
const fs = require('fs').promises;

// --- Third-Party Packages ---
const { Pool } = require('pg');
const { chromium } = require('playwright');
const express = require('express');
const bodyParser = require('body-parser');

// --- Local Modules ---
const telegramBot = require('./telegram_bot.js'); // Only import the telegram bot

// --- CONFIGURATION & SECURITY ---
const SESSION_FILE_PATH = 'session.json';

let publishingInProgress = new Set();
let publishingQueue = [];
let isQueueProcessing = false;
let missedItemsCache = [];
let missedItemsNotificationSent = false;


// --- Database Connection ---
const pool = new Pool({
    connectionString: process.env.CONNECTION_STRING,
    ssl: { require: true },
});

// =================================================================
// SECTION 1: CORE APPLICATION LOGIC
// =================================================================

async function loadData() {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT data FROM app_data WHERE id = 1');
        return result.rows.length > 0 && result.rows[0].data ? result.rows[0].data : { settings: {}, activeResults: {}, recycleBin: [], schedule: [] };
    } catch (err) {
        console.error('Error loading data from database', err);
        return { settings: {}, activeResults: {}, recycleBin: [], schedule: [] };
    } finally {
        if (client) client.release();
    }
}

async function saveData(appData) {
    let client;
    try {
        client = await pool.connect();
        await client.query('INSERT INTO app_data (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [appData]);
    } catch (err) {
        console.error('Error saving data to database', err);
    } finally {
        if (client) client.release();
    }
}

async function loginAndSaveSession() {
    if (!process.env.ZEDGE_EMAIL || !process.env.ZEDGE_PASSWORD) {
        console.error('CRITICAL: ZEDGE_EMAIL or ZEDGE_PASSWORD environment variables are not set on the server.');
        return { loggedIn: false, error: 'Server is missing credentials. Please set them in the Render dashboard.' };
    }

    console.log('Attempting to log in to Zedge (2-step process)...');
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        
        await page.goto('https://account.zedge.net/v2/login-with-email', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log('Filling email address...');
        await page.waitForSelector('input[type="email"]');
        await page.fill('input[type="email"]', process.env.ZEDGE_EMAIL);
        
        console.log('Clicking "Continue with password"...');
        await page.click('button:has-text("Continue with password")');
        
        console.log('Waiting for password page...');
        await page.waitForSelector('input[type="password"]');
        await page.fill('input[type="password"]', process.env.ZEDGE_PASSWORD);
        
        console.log('Clicking final "Continue" button...');
        await page.click('button:has-text("Continue")');

        await page.waitForURL('**/account.zedge.net/v2/user**', { timeout: 60000 });
        
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


async function checkLoginStatus() {
    console.log('Performing Zedge login status check...');
    let browser;
    try {
        await fs.access(SESSION_FILE_PATH);
        const storageState = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
        browser = await chromium.launch();
        const context = await browser.newContext({ storageState: JSON.parse(storageState) });
        const page = await context.newPage();
        await page.goto('https://upload.zedge.net/', { waitUntil: 'domcontentloaded' });
        
        const finalUrl = page.url();
        if (finalUrl.includes('account.zedge.net')) {
             console.log('Session is invalid or expired. Attempting to re-login.');
             return await loginAndSaveSession();
        }
        return { loggedIn: true };

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('session.json not found on server. Attempting initial login.');
            return await loginAndSaveSession();
        }
        console.error('An unknown error occurred during status check. Attempting re-login.', error.message);
        return await loginAndSaveSession();
    } finally {
        if (browser) await browser.close();
    }
}

// Replaced Discord function with a generic one that calls the bot
function sendNotification(message) {
    telegramBot.sendNotification(message);
}

async function rescheduleMissedItem(identifier, timeString) {
    const appData = await loadData();
    if (!appData.schedule || !Array.isArray(appData.schedule)) {
        return { success: false, message: "Schedule data is not available." };
    }

    const now = new Date();
    const value = parseInt(timeString.slice(0, -1), 10);
    const unit = timeString.slice(-1).toLowerCase();

    if (isNaN(value)) {
        return { success: false, message: "Invalid time value. Please use a format like `10m`, `1h`, or `30s`." };
    }

    let newScheduledDate = new Date(now);
    if (unit === 's') {
        newScheduledDate.setSeconds(now.getSeconds() + value);
    } else if (unit === 'm') {
        newScheduledDate.setMinutes(now.getMinutes() + value);
    } else if (unit === 'h') {
        newScheduledDate.setHours(now.getHours() + value);
    } else {
        return { success: false, message: "Invalid time unit. Please use `s` (seconds), `m` (minutes), or `h` (hours)." };
    }

    const itemsToReschedule = [];
    if (identifier.toLowerCase() === 'all') {
        itemsToReschedule.push(...missedItemsCache);
    } else {
        const item = missedItemsCache.find(i => i.title.toLowerCase() === identifier.toLowerCase());
        if (item) {
            itemsToReschedule.push(item);
        } else {
            return { success: false, message: `Could not find "${identifier}" in the missed items list.` };
        }
    }

    if (itemsToReschedule.length === 0) {
        return { success: false, message: "No items to reschedule." };
    }

    itemsToReschedule.forEach(itemToUpdate => {
        const scheduleIndex = appData.schedule.findIndex(i => i.id === itemToUpdate.id);
        if (scheduleIndex > -1) {
            appData.schedule[scheduleIndex].scheduledAtUTC = newScheduledDate.toISOString();
            appData.schedule[scheduleIndex].status = 'Pending';
        }
    });

    await saveData(appData);

    if (identifier.toLowerCase() === 'all') {
        missedItemsCache = [];
    } else {
        missedItemsCache = missedItemsCache.filter(item => !itemsToReschedule.find(updated => updated.id === item.id));
    }
    
    if (missedItemsCache.length === 0) {
        missedItemsNotificationSent = false;
    }

    return { success: true, message: `Successfully rescheduled ${itemsToReschedule.length} item(s) to publish at approximately ${newScheduledDate.toLocaleTimeString()}.` };
}

async function checkScheduleForPublishing() {
    const now = new Date();
    console.log(`--- Running background check [UTC: ${now.toUTCString()}] ---`);
    const data = await loadData();
    
    const schedule = data.schedule || [];
    if (schedule.length > 0) {
        console.log(`[${schedule.length} items in schedule] Checking for due/missed items...`);
    } else {
        console.log("[Schedule is empty] No items to check.");
    }

    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const newlyMissedItems = [];

    for (const item of schedule) {
        if (!item.scheduledAtUTC) continue;
        const isPending = !item.status || item.status === 'Pending';
        if (!isPending) continue; 
        const scheduleDateTime = new Date(item.scheduledAtUTC);
        if (scheduleDateTime > now) continue; 

        if (scheduleDateTime < fiveMinutesAgo) {
            if (!missedItemsCache.find(cached => cached.id === item.id) && !publishingInProgress.has(item.id)) {
                newlyMissedItems.push(item);
            }
        } else {
            if (!publishingInProgress.has(item.id)) {
                console.log(`✅ FOUND DUE ITEM: "${item.title}". Adding to queue.`);
                publishingInProgress.add(item.id);
                publishingQueue.push(item);
            }
        }
    }

    if (newlyMissedItems.length > 0) {
        missedItemsCache.push(...newlyMissedItems);
    }
    
    if (!isQueueProcessing && publishingQueue.length > 0) {
        processPublishingQueue();
    }
    
    if (missedItemsCache.length > 0 && !missedItemsNotificationSent) {
        const itemTitles = missedItemsCache.map(item => `- \`${item.title}\``).join('\n');
        const notificationMessage = `🔴 **Missed Publications Detected!**\n\nThe following items were not published at their scheduled time:\n${itemTitles}\n\n**Use a command to proceed:**\n\`/publish all-missed\` - Publishes all items now.\n\`/publish <title>\` - Publishes a specific item.\n\n*To reschedule, use the \`/rs\` command. You can then use \`/clearmissed\` to remove this message.*`;
        sendNotification(notificationMessage);
        missedItemsNotificationSent = true;
    }
    
    console.log('--- Finished check. ---');
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

    if (!appData.schedule || !Array.isArray(appData.schedule)) {
        console.error('Could not find schedule array in data to update status.');
        return;
    }

    const itemIndex = appData.schedule.findIndex(i => i.id === scheduledItem.id);

    if (itemIndex > -1) {
        const itemTitle = appData.schedule[itemIndex].title;
        if (result.status === 'success') {
            appData.schedule.splice(itemIndex, 1);
            const notificationMessage = `✅ **Published:** "${itemTitle}" has been successfully published and removed from the schedule.`;
            sendNotification(notificationMessage);
        } else {
            appData.schedule[itemIndex].status = 'Failed';
            appData.schedule[itemIndex].failMessage = result.message || 'An unknown error occurred during publishing.';
            const notificationMessage = `❌ **Failed to publish:** "${itemTitle}".\nReason: ${result.message}`;
            sendNotification(notificationMessage);
        }
        await saveData(appData);
    } else {
         console.log(`Item "${scheduledItem.title}" was already processed or removed from the schedule.`);
    }
}

async function performPublish(scheduledItem) {
    console.log(`--- Starting publish process for: "${scheduledItem.title}" ---`);
    let browser;
    try {
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
        await page.goto(targetProfileUrl, { waitUntil: 'domcontentloaded' });

        console.log(`Searching for DRAFT: "${scheduledItem.title}"`);

        // --- NEW & IMPROVED "FIND DRAFT" LOGIC ---
        const draftLocator = page.locator('div[role="button"]', { hasText: scheduledItem.title }).filter({ has: page.locator('span:text("DRAFT")') });
        const loadMoreButtonLocator = page.locator('button:has-text("Load More")');

        const searchTimeout = 60000; // 60 seconds total to find the item
        const startTime = Date.now();
        let draftFound = false;

        while (Date.now() - startTime < searchTimeout) {
            if (await draftLocator.isVisible()) {
                await draftLocator.click();
                draftFound = true;
                break;
            }

            const isLoadMoreVisible = await loadMoreButtonLocator.isVisible();
            if (isLoadMoreVisible) {
                console.log('Draft not visible, clicking "Load More"...');
                await loadMoreButtonLocator.click();
                await page.waitForTimeout(2000); // Wait for content to load
            } else {
                // If the "Load More" button is gone, we've loaded everything.
                await page.waitForTimeout(2000); // Final wait for any straggling elements
                if (await draftLocator.isVisible()) {
                    await draftLocator.click();
                    draftFound = true;
                }
                break; // Exit loop, nothing more to load
            }
        }

        if (!draftFound) {
            throw new Error(`Could not find a DRAFT with the title "${scheduledItem.title}" after clicking "Load More".`);
        }
        // --- END OF NEW LOGIC ---

        console.log("Found and clicked DRAFT. Waiting for details page to load.");
        const publishButton = page.locator('button:has-text("Publish")');
        await publishButton.waitFor({ state: 'enabled', timeout: 30000 });

        console.log("Details page loaded. Clicking 'Publish'.");
        await publishButton.click();

        await page.waitForSelector('button:has-text("Upload")', { timeout: 30000 });

        console.log(`Navigating back to ${targetProfileName} profile for verification.`);
        await page.goto(targetProfileUrl, { waitUntil: 'domcontentloaded' });

        console.log(`Verifying PUBLISHED status for: "${scheduledItem.title}"`);
        const itemContainerLocator = page.locator('div[class*="StyledContainer"]', { has: page.locator(`div[title="${scheduledItem.title}"]`) });
        const publishedBadgeLocator = itemContainerLocator.locator('span:text("PUBLISHED")');
        
        await publishedBadgeLocator.waitFor({ state: 'visible', timeout: 60000 });

        console.log(`--- Successfully published and verified "${scheduledItem.title}" ---`);
        return { status: 'success', message: 'Published and verified successfully.' };

    } catch (error) {
        console.error(`Failed to publish "${scheduledItem.title}":`, error);
        return { status: 'failed', message: error.message };
    } finally {
        if (browser) { await browser.close(); }
    }
}
function getMissedItems() {
    return missedItemsCache;
}
function publishMissedItems(identifier) {
    const itemsToPublish = [];
    if (identifier === 'all missed') { // Changed to match telegram bot
        itemsToPublish.push(...missedItemsCache);
        missedItemsCache = [];
    } else {
        const itemIndex = missedItemsCache.findIndex(item => item.title.toLowerCase() === identifier.toLowerCase());
        if (itemIndex > -1) {
            itemsToPublish.push(missedItemsCache[itemIndex]);
            missedItemsCache.splice(itemIndex, 1);
        } else {
            return { success: false, message: `Could not find "${identifier}" in the missed items list.` };
        }
    }

    if (itemsToPublish.length > 0) {
        publishingQueue.push(...itemsToPublish);
        if (!isQueueProcessing) {
            processPublishingQueue();
        }
        return { success: true, message: `Queued ${itemsToPublish.length} item(s) for publishing.` };
    }
    return { success: false, message: 'No items to publish.' };
}

function clearMissedItemsCache() {
    missedItemsCache = [];
    missedItemsNotificationSent = false;
    return 'Missed items cache has been cleared.';
}


// =================================================================
// SECTION 2: EXPRESS WEB SERVER
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

    // Start only the Telegram bot
    telegramBot.startBot(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, {
        loadDataFunc: loadData,
        loginCheckFunc: checkLoginStatus,
        getMissedItemsFunc: getMissedItems,
        publishMissedItemsFunc: publishMissedItems,
        clearMissedCacheFunc: clearMissedItemsCache,
        rescheduleMissedItemFunc: rescheduleMissedItem
    });
    
    startWorker();
});

function startWorker() {
    console.log('Zedge Worker started. Initializing background tasks...');
    setTimeout(checkScheduleForPublishing, 15 * 1000); 

    // Main scheduling check
    setInterval(checkScheduleForPublishing, 60 * 1000);

    // Periodic re-login check
    setInterval(async () => {
        const status = await checkLoginStatus();
        if (!status.loggedIn) {
            sendNotification(`🔴 **Action Required:** The Zedge worker has been logged out and could not log back in. Manual intervention may be needed. \n**Reason:** ${status.error}`);
        }
    }, 6 * 60 * 60 * 1000);
}