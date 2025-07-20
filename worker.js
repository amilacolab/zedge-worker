// =================================================================
//                 ZEDGE PUBLISHER WORKER (worker.js)
// =================================================================
// This worker runs on a server (e.g., Render) and handles all
// background tasks, including checking the schedule, publishing
// items via Playwright, and interacting with the Telegram bot.
// It now supports multiple primary databases and a backup for resilience.
// =================================================================

// --- SECTION 1: IMPORTS & GLOBAL SETUP ---

// --- Core Node.js Modules ---
const fs = require('fs').promises;

// --- Third-Party Packages ---
const { Pool } = require('pg');
const { chromium } = require('playwright');
const express = require('express');
const bodyParser = require('body-parser');

// --- Local Modules ---
const telegramBot = require('./telegram_bot.js');

// --- CONFIGURATION & STATE ---
const SESSION_FILE_PATH = 'session.json';

let publishingInProgress = new Set();
let publishingQueue = [];
let isQueueProcessing = false;
let missedItemsCache = [];
let missedItemsNotificationSent = false;

// --- Database Connection Variables ---
let primaryPools = [];
let backupPool;
let activePool;
let activeDbIndex = 0;


// =================================================================
// SECTION 2: DATABASE MANAGEMENT
// =================================================================

/**
 * Initializes all database pools from environment variables.
 */
async function initializeDatabases() {
    console.log("Initializing database connections...");
    for (let i = 1; ; i++) {
        const connString = process.env[`PRIMARY_DB_${i}`];
        if (connString) {
            primaryPools.push(new Pool({ connectionString: connString, ssl: { require: true } }));
            console.log(`Found and created pool for PRIMARY_DB_${i}`);
        } else {
            break;
        }
    }

    if (primaryPools.length === 0) {
        throw new Error("CRITICAL: No PRIMARY_DB_X environment variables found.");
    }

    const backupConnString = process.env.BACKUP_DB;
    if (backupConnString) {
        backupPool = new Pool({ connectionString: backupConnString, ssl: { require: true } });
        console.log("Found and created pool for BACKUP_DB.");
    } else {
        console.warn("WARNING: BACKUP_DB is not configured.");
    }

    // Default to the first DB, but this will be corrected by reconciliation.
    activePool = primaryPools[0];
    activeDbIndex = 0;
}

/**
 * (NEW) Compares the worker's active DB index with the one from the backup DB
 * and corrects it on startup if there is a mismatch.
 */
async function reconcileActiveDbIndex() {
    if (!backupPool) {
        console.log("Skipping DB index reconciliation on startup: No backup DB configured.");
        return;
    }

    console.log("Reconciling active DB index with backup database on startup...");
    let client;
    try {
        client = await backupPool.connect();
        const res = await client.query('SELECT data FROM app_data WHERE id = 1');

        if (res.rows.length > 0 && res.rows[0].data) {
            const backupIndex = res.rows[0].data?.db_config?.active_index;

            if (backupIndex !== undefined && backupIndex !== activeDbIndex && backupIndex < primaryPools.length) {
                console.log(`Discrepancy found! Worker default index: ${activeDbIndex}, Backup index: ${backupIndex}. Correcting worker state.`);
                activeDbIndex = backupIndex;
                activePool = primaryPools[backupIndex];
                console.log(`Worker has successfully switched to PRIMARY_DB_${backupIndex + 1}.`);
            } else {
                console.log("Worker and backup DB indexes match. No action needed.");
            }
        }
    } catch (error) {
        console.error("CRITICAL: Failed to reconcile DB index with backup on startup:", error.message);
        sendNotification(`🔴 **CRITICAL ALERT:** The server worker failed to read the configuration from the backup database on startup. It may be operating on the wrong database. Please investigate. \nReason: ${error.message}`);
    } finally {
        if (client) client.release();
    }
}

/**
 * Copies all application data from a source pool to a destination pool.
 */
async function migrateData(sourcePool, destPool) {
    let sourceClient, destClient;
    try {
        console.log("Starting data migration...");
        sourceClient = await sourcePool.connect();
        const result = await sourceClient.query('SELECT data FROM app_data WHERE id = 1');
        const dataToMigrate = result.rows.length > 0 ? result.rows[0].data : null;

        if (!dataToMigrate) {
            return { success: false, data: null, error: "No data found in the source database." };
        }

        console.log("Data retrieved from source. Writing to destination...");
        destClient = await destPool.connect();
        await destClient.query('INSERT INTO app_data (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [dataToMigrate]);

        console.log("Migration successful.");
        return { success: true, data: dataToMigrate, error: null };

    } catch (err) {
        console.error('Error during data migration:', err);
        return { success: false, data: null, error: err.message };
    } finally {
        if (sourceClient) sourceClient.release();
        if (destClient) destClient.release();
    }
}

/**
 * The main command handler for switching the active database.
 */
async function switchDatabase() {
    if (!backupPool || primaryPools.length < 2) {
        const message = "🔴 **DB Switch Failed:** Not enough databases are configured.";
        console.error(message);
        sendNotification(message);
        return;
    }

    const nextDbIndex = (activeDbIndex + 1) % primaryPools.length;
    const currentDbName = `PRIMARY_DB_${activeDbIndex + 1}`;
    const nextDbName = `PRIMARY_DB_${nextDbIndex + 1}`;
    const nextPool = primaryPools[nextDbIndex];

    sendNotification(`🔄 Starting database switch from **${currentDbName}** to **${nextDbName}**...`);

    let clientNext = null;
    let clientBackup = null;
    try {
        const backupResult = await migrateData(activePool, backupPool);
        if (!backupResult.success) {
            sendNotification(`⚠️ **Warning:** Could not back up from **${currentDbName}**. Proceeding with last known backup.`);
        } else {
            sendNotification(`✅ Data from **${currentDbName}** successfully backed up.`);
        }

        const restoreResult = await migrateData(backupPool, nextPool);
        if (!restoreResult.success) {
            throw new Error(`Could not migrate to ${nextDbName}. Reason: ${restoreResult.error}`);
        }

        let finalData = restoreResult.data;
        if (!finalData.db_config) finalData.db_config = {};
        finalData.db_config.active_index = nextDbIndex;

        console.log(`Updating index to ${nextDbIndex} in ${nextDbName} and the backup DB.`);

        clientNext = await nextPool.connect();
        await clientNext.query('UPDATE app_data SET data = $1 WHERE id = 1', [finalData]);

        clientBackup = await backupPool.connect();
        await clientBackup.query('UPDATE app_data SET data = $1 WHERE id = 1', [finalData]);

        activePool = nextPool;
        activeDbIndex = nextDbIndex;

        const successMessage = `✅ **Database Switch Complete!** The active database is now **${nextDbName}**.`;
        console.log(successMessage);
        sendNotification(successMessage);

    } catch (err) {
        const errorMessage = `❌ **CRITICAL FAILURE:** Switch aborted. Active DB is still **${currentDbName}**. Reason: ${err.message}`;
        console.error(errorMessage);
        sendNotification(errorMessage);
    } finally {
        if (clientNext) clientNext.release();
        if (clientBackup) clientBackup.release();
    }
}


// =================================================================
// SECTION 3: CORE APPLICATION LOGIC
// =================================================================

async function loadData() {
    let client;
    try {
        client = await activePool.connect();
        const result = await client.query('SELECT data FROM app_data WHERE id = 1');
        return result.rows.length > 0 && result.rows[0].data ? result.rows[0].data : { settings: {}, activeResults: {}, recycleBin: [], schedule: [], db_config: { active_index: 0 } };
    } catch (err) {
        console.error('Error loading data from database', err);
        if (err.message && err.message.includes("compute endpoint is suspended")) {
            sendNotification(`🔴 **CRITICAL:** The active database (**PRIMARY_DB_${activeDbIndex + 1}**) has reached its compute limit. Use the \`/switchdb\` command.`);
        }
        return { settings: {}, activeResults: {}, recycleBin: [], schedule: [], db_config: { active_index: 0 } };
    } finally {
        if (client) client.release();
    }
}

async function saveData(appData) {
    let client;
    try {
        if (!appData.db_config) {
            appData.db_config = { active_index: activeDbIndex };
        } else {
            appData.db_config.active_index = activeDbIndex;
        }

        client = await activePool.connect();
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
    console.log(`--- Running background check [UTC: ${now.toUTCString()}] [DB: ${activeDbIndex + 1}] ---`);
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

        if (!clickedPublish) throw new Error('The "Publish" button was not found or was disabled.');

        console.log("Clicked 'Publish'. Waiting for system to process...");
        await page.waitForTimeout(8000);

        console.log(`Navigating back to ${targetProfileName} profile for verification.`);
        await page.goto(targetProfileUrl);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);

        console.log(`Verifying PUBLISHED status for: "${scheduledItem.title}"`);
        const isPublished = await page.evaluate(async (itemTitle) => {
            return new Promise((resolve) => {
                const timeout = 60000, interval = 2000;
                let elapsedTime = 0;
                const verifyInterval = setInterval(() => {
                    const elements = document.querySelectorAll('div[class*="StyledTitle"], div[title], span');
                    for (const el of elements) {
                        if (el.textContent.trim() === itemTitle || el.getAttribute('title') === itemTitle) {
                            const container = el.closest('div[role="button"]')?.parentElement ?? el.parentElement;
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

        if (!isPublished) {
            throw new Error('Verification failed. Item status was not updated to "Published" after waiting.');
        }

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
    if (identifier === 'all missed') {
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
// SECTION 4: EXPRESS WEB SERVER & APP STARTUP
// =================================================================

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.status(200).send(`Zedge Publisher worker is alive and running. Active DB: PRIMARY_DB_${activeDbIndex + 1}`);
});

const PORT = process.env.PORT || 10000;

// (MODIFIED) Main application startup function
async function startApp() {
    try {
        await initializeDatabases();

        // (NEW) Reconcile the active database index on startup
        await reconcileActiveDbIndex();

        app.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);

            telegramBot.startBot(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, {
                loadDataFunc: loadData,
                loginCheckFunc: checkLoginStatus,
                getMissedItemsFunc: getMissedItems,
                publishMissedItemsFunc: publishMissedItems,
                clearMissedCacheFunc: clearMissedItemsCache,
                rescheduleMissedItemFunc: rescheduleMissedItem,
                switchDatabaseFunc: switchDatabase
            });

            startWorker();
        });
    } catch (error) {
        console.error("Failed to start the application:", error.message);
        process.exit(1);
    }
}

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

    // Daily backup job
    if (backupPool) {
        console.log("Scheduling daily backup job.");
        setInterval(async () => {
            console.log("--- Running daily backup job ---");
            const backupResult = await migrateData(activePool, backupPool);
            if (backupResult.success) {
                console.log("Daily backup completed successfully.");
            } else {
                console.error("Daily backup failed:", backupResult.error);
                sendNotification(`⚠️ **Warning:** The scheduled daily database backup failed. Reason: ${backupResult.error}`);
            }
        }, 24 * 60 * 60 * 1000); // 24 hours
    }
}

// Start the application
startApp();
