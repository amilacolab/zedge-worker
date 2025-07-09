// worker.js - FINALIZED with login and restored logging.

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

let publishingInProgress = new Set();
let publishingQueue = [];
let isQueueProcessing = false;
let missedItemsCache = []; // NEW: Cache for missed items
let missedItemsNotificationSent = false; // NEW: Flag to prevent spam


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

// RESTORED detailed logging
async function checkScheduleForPublishing() {
    console.log('--- Running background check ---');
    const data = await loadData();

    if (data.settings?.isAutoPublishingEnabled) { /* ... logic remains the same ... */ }
    if (!data.schedule || !Array.isArray(data.schedule) || data.schedule.length === 0) { /* ... logic remains the same ... */ }

    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const newlyMissedItems = [];

    for (const item of data.schedule) {
        if (!item.scheduledAtUTC) continue;

        const isPending = !item.status || item.status === 'Pending';
        if (!isPending) continue; // Skip already published or failed items

        const scheduleDateTime = new Date(item.scheduledAtUTC);
        if (scheduleDateTime > now) continue; // Skip items scheduled for the future

        // Item is due or missed
        if (scheduleDateTime < fiveMinutesAgo) {
            // This item was missed
            if (!missedItemsCache.find(cached => cached.id === item.id) && !publishingInProgress.has(item.id)) {
                newlyMissedItems.push(item);
            }
        } else {
            // This item is due now
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
    
    // Process the normal queue
    if (!isQueueProcessing && publishingQueue.length > 0) {
        processPublishingQueue();
    }
    
    // Send one-time notification for missed items
    if (missedItemsCache.length > 0 && !missedItemsNotificationSent) {
        const itemTitles = missedItemsCache.map(item => `- \`${item.title}\``).join('\n');
        const notificationMessage = `🔴 **Missed Publications Detected!**\n\nThe following items were not published at their scheduled time:\n${itemTitles}\n\n**Use a command to proceed:**\n\`!publish all-missed\` - Publishes all items now.\n\`!publish <title>\` - Publishes a specific item.\n\n*To reschedule, please use the desktop app. You can then use \`!clear-missed\` to remove this message.*`;
        sendDiscordNotification(notificationMessage);
        missedItemsNotificationSent = true;
    }
    
    console.log('Finished check.');
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

async function executePublishWorkflow(scheduledItem) {async function executePublishWorkflow(scheduledItem) {
    // This function runs after a successful or failed publish attempt
    const result = await performPublish(scheduledItem);
    const appData = await loadData(); // Load the most current data from the database

    try {
        if (appData.schedule && Array.isArray(appData.schedule)) {
            const itemIndex = appData.schedule.findIndex(i => i.id === scheduledItem.id);

            if (itemIndex > -1) {
                // Update the status based on the result of the publish attempt
                appData.schedule[itemIndex].status = result.status === 'success' ? 'Published' : 'Failed';
                appData.schedule[itemIndex].failMessage = result.message;

                // Save the updated data back to the database
                await saveData(appData);

                // Send a Discord notification about the outcome
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
function getMissedItems() {
    return missedItemsCache;
}
function publishMissedItems(identifier) {
    const itemsToPublish = [];
    if (identifier === 'all') {
        itemsToPublish.push(...missedItemsCache);
        missedItemsCache = []; // Clear the cache
    } else {
        const itemIndex = missedItemsCache.findIndex(item => item.title.toLowerCase() === identifier.toLowerCase());
        if (itemIndex > -1) {
            itemsToPublish.push(missedItemsCache[itemIndex]);
            missedItemsCache.splice(itemIndex, 1); // Remove from cache
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
    // This can be used if you manually reschedule and want to clear the alert
    missedItemsCache = [];
    missedItemsNotificationSent = false;
    return 'Missed items cache has been cleared.';
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
    setTimeout(checkLoginStatus, 15 * 1000); 

    setInterval(checkScheduleForPublishing, 60 * 1000);
    setInterval(async () => {
        const status = await checkLoginStatus();
        if (!status.loggedIn) {
            sendDiscordNotification(`🔴 **Action Required:** The Zedge worker has been logged out and could not log back in. Manual intervention may be needed. \n**Reason:** ${status.error}`);
        }
    }, 6 * 60 * 60 * 1000);
}
// Add this new function to worker.js
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
            appData.schedule[scheduleIndex].status = 'Pending'; // Reset status
        }
    });

    await saveData(appData);

    // Clear the rescheduled items from the cache
    missedItemsCache = missedItemsCache.filter(item => !itemsToReschedule.find(updated => updated.id === item.id));
    if (missedItemsCache.length === 0) {
        missedItemsNotificationSent = false;
    }

    return { success: true, message: `Successfully rescheduled ${itemsToReschedule.length} item(s) to publish at approximately ${newScheduledDate.toLocaleTimeString()}.` };
}