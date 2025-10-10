// =================================================================
//                 ZEDGE PUBLISHER WORKER v2 (worker.js)
// =================================================================
// This worker runs on a server and handles all background tasks,
// including checking the schedule, publishing items, and interacting
// with the Telegram bot and the new interactive web app.
// It communicates with a separate Publisher Service for browser tasks.
// =================================================================

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('CRITICAL: Uncaught Exception:', error);
  process.exit(1);
});

// --- SECTION 1: IMPORTS & GLOBAL SETUP ---
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const telegramBot = require('./telegram_bot.js');

// --- CONFIGURATION & STATE ---
const RECENTLY_PUBLISHED_LIMIT = 20;

let publishingInProgress = new Set();
let publishingQueue = [];
let isQueueProcessing = false;
let missedItemsCache = [];
let missedItemsNotificationSent = false;
let isWorkerPaused = false;
let mainIntervalId = null;
let lastCheckTime = null;

// Database state
let primaryPools = [];
let backupPool;
let activePool;
let activeDbIndex = 0;

// =================================================================
// SECTION 2: DATABASE MANAGEMENT (No changes)
// =================================================================
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
    if (primaryPools.length === 0) throw new Error("CRITICAL: No PRIMARY_DB_X environment variables found.");
    const backupConnString = process.env.BACKUP_DB;
    if (backupConnString) {
        backupPool = new Pool({ connectionString: backupConnString, ssl: { require: true } });
        console.log("Found and created pool for BACKUP_DB.");
    } else {
        console.warn("WARNING: BACKUP_DB is not configured.");
    }
    activePool = primaryPools[0];
    activeDbIndex = 0;
}

async function reconcileActiveDbIndex() {
    if (!backupPool) return;
    console.log("Reconciling active DB index...");
    let client;
    try {
        client = await backupPool.connect();
        const res = await client.query('SELECT data FROM app_data WHERE id = 1');
        if (res.rows.length > 0 && res.rows[0].data) {
            const backupIndex = res.rows[0].data?.db_config?.active_index;
            if (backupIndex !== undefined && backupIndex !== activeDbIndex && backupIndex < primaryPools.length) {
                console.log(`Discrepancy found! Switching to DB Index: ${backupIndex}.`);
                activeDbIndex = backupIndex;
                activePool = primaryPools[backupIndex];
            }
        }
    } catch (error) {
        console.error("CRITICAL: Failed to reconcile DB index:", error.message);
        sendNotification(`🔴 **CRITICAL ALERT:** Worker failed to read config from backup DB. Reason: ${error.message}`);
    } finally {
        if (client) client.release();
    }
}

async function migrateData(sourcePool, destPool) {
    let sourceClient, destClient;
    try {
        sourceClient = await sourcePool.connect();
        const result = await sourceClient.query('SELECT data FROM app_data WHERE id = 1');
        const dataToMigrate = result.rows.length > 0 ? result.rows[0].data : null;
        if (!dataToMigrate) return { success: false, error: "No data in source." };
        
        destClient = await destPool.connect();
        await destClient.query('INSERT INTO app_data (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [dataToMigrate]);
        return { success: true, data: dataToMigrate };
    } catch (err) {
        console.error('Error during data migration:', err);
        return { success: false, error: err.message };
    } finally {
        if (sourceClient) sourceClient.release();
        if (destClient) destClient.release();
    }
}

async function switchDatabase() {
    if (!backupPool || primaryPools.length < 2) {
        const message = "🔴 **DB Switch Failed:** Not enough databases configured.";
        sendNotification(message);
        return { success: false, message };
    }

    const nextDbIndex = (activeDbIndex + 1) % primaryPools.length;
    const currentDbName = `DB ${activeDbIndex + 1}`;
    const nextDbName = `DB ${nextDbIndex + 1}`;
    const nextPool = primaryPools[nextDbIndex];

    sendNotification(`🔄 Starting DB switch from **${currentDbName}** to **${nextDbName}**...`);

    try {
        await migrateData(activePool, backupPool);
        const restoreResult = await migrateData(backupPool, nextPool);
        if (!restoreResult.success) throw new Error(`Could not migrate to ${nextDbName}.`);

        let finalData = restoreResult.data;
        if (!finalData.db_config) finalData.db_config = {};
        finalData.db_config.active_index = nextDbIndex;

        const clientNext = await nextPool.connect();
        await clientNext.query('UPDATE app_data SET data = $1 WHERE id = 1', [finalData]);
        clientNext.release();

        const clientBackup = await backupPool.connect();
        await clientBackup.query('UPDATE app_data SET data = $1 WHERE id = 1', [finalData]);
        clientBackup.release();

        activePool = nextPool;
        activeDbIndex = nextDbIndex;

        const successMessage = `✅ **DB Switch Complete!** Active DB is now **${nextDbName}**.`;
        sendNotification(successMessage);
        return { success: true, message: successMessage };
    } catch (err) {
        const errorMessage = `❌ **CRITICAL FAILURE:** Switch aborted. Active DB is still **${currentDbName}**. Reason: ${err.message}`;
        sendNotification(errorMessage);
        return { success: false, message: errorMessage };
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
        const data = result.rows.length > 0 && result.rows[0].data ? result.rows[0].data : { settings: {}, activeResults: {}, recycleBin: [], schedule: [], recentlyPublished: [], db_config: { active_index: 0 } };
        if (!Array.isArray(data.recentlyPublished)) {
            data.recentlyPublished = [];
        }
        return data;
    } catch (err) {
        console.error('Error loading data from database', err);
        return { settings: {}, activeResults: {}, recycleBin: [], schedule: [], recentlyPublished: [], db_config: { active_index: 0 } };
    } finally {
        if (client) client.release();
    }
}

async function saveData(appData) {
    let client;
    try {
        if (!appData.db_config) appData.db_config = {};
        appData.db_config.active_index = activeDbIndex;
        client = await activePool.connect();
        await client.query('INSERT INTO app_data (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [appData]);
    } catch (err) {
        console.error('Error saving data to database', err);
    } finally {
        if (client) client.release();
    }
}

// --- NEW API-BASED LOGIN & PUBLISHING LOGIC ---
async function checkLoginStatus() {
    console.log('Performing Zedge login status check via Publisher service...');
    try {
        const publisherServiceUrl = process.env.PUBLISHER_SERVICE_URL;
        if (!publisherServiceUrl) {
            return { loggedIn: false, error: 'PUBLISHER_SERVICE_URL not set.' };
        }
        const response = await fetch(`${publisherServiceUrl}/status`);
        return await response.json();
    } catch (error) {
        console.error('Could not communicate with Publisher service for status check:', error.message);
        return { loggedIn: false, error: 'Could not reach Publisher service.' };
    }
}

// --- Worker & Bot Functions ---
function sendNotification(message) { telegramBot.sendNotification(message); }

function pauseWorker() {
    if (mainIntervalId) {
        clearInterval(mainIntervalId);
        mainIntervalId = null;
        isWorkerPaused = true;
        console.log("Worker has been PAUSED.");
        return { success: true, message: "Worker paused successfully." };
    }
    return { success: false, message: "Worker was not running." };
}

function resumeWorker() {
    if (!mainIntervalId) {
        startWorkerIntervals();
        isWorkerPaused = false;
        console.log("Worker has been RESUMED.");
        return { success: true, message: "Worker resumed successfully." };
    }
    return { success: false, message: "Worker is already running." };
}

async function publishNowByIds(itemIds) {
    const appData = await loadData();
    const itemsToPublish = appData.schedule.filter(item => itemIds.includes(item.id));
    if (itemsToPublish.length === 0) return { success: false, message: "No valid items found to publish." };
    publishingQueue.push(...itemsToPublish);
    if (!isQueueProcessing) processPublishingQueue();
    return { success: true, message: `Queued ${itemsToPublish.length} item(s) for immediate publishing.` };
}

async function rescheduleItemsByIds(itemIds, timeString = '10m') {
    const appData = await loadData();
    const now = new Date();
    const value = parseInt(timeString.slice(0, -1), 10);
    const unit = timeString.slice(-1).toLowerCase();
    if (isNaN(value)) return { success: false, message: "Invalid time value." };

    let newScheduledDate = new Date(now);
    if (unit === 'm') newScheduledDate.setMinutes(now.getMinutes() + value);
    else if (unit === 'h') newScheduledDate.setHours(now.getHours() + value);
    else newScheduledDate.setSeconds(now.getSeconds() + value);
    
    let updatedCount = 0;
    appData.schedule.forEach(item => {
        if (itemIds.includes(item.id)) {
            item.scheduledAtUTC = newScheduledDate.toISOString();
            item.status = 'Pending';
            updatedCount++;
        }
    });

    if (updatedCount > 0) {
        await saveData(appData);
        return { success: true, message: `Rescheduled ${updatedCount} item(s).` };
    }
    return { success: false, message: "No items were found to reschedule." };
}

function publishMissedItems(identifier) {
    const itemsToPublish = [];
    if (identifier === 'all-missed') {
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
        if (!isQueueProcessing) processPublishingQueue();
        return { success: true, message: `Queued ${itemsToPublish.length} item(s) for publishing.` };
    }
    return { success: false, message: 'No items to publish.' };
}

async function rescheduleMissedItem(identifier, timeString) {
    const item = missedItemsCache.find(i => i.title.toLowerCase() === identifier.toLowerCase());
    if (!item) return { success: false, message: `Could not find "${identifier}" in the missed items list.` };
    
    const result = await rescheduleItemsByIds([item.id], timeString);
    if (result.success) {
        missedItemsCache = missedItemsCache.filter(i => i.id !== item.id);
        if (missedItemsCache.length === 0) missedItemsNotificationSent = false;
    }
    return result;
}

// --- Core Worker Loop ---
async function checkScheduleForPublishing() {
    if (isWorkerPaused) {
        console.log("Worker is paused. Skipping schedule check.");
        return;
    }

    lastCheckTime = new Date().toISOString(); 
    const now = new Date();
    console.log(`--- Running background check [${now.toLocaleTimeString()}] [DB: ${activeDbIndex + 1}] ---`);
    
    const data = await loadData();
    const schedule = data.schedule || [];
    
    if (schedule.length === 0) {
        console.log("[Schedule is empty] No items to check.");
        return;
    }

    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const newlyMissedItems = [];
    let dataWasChanged = false;

    for (const item of schedule) {
        if (!item.scheduledAtUTC) continue;
        
        const isPending = !item.status || item.status === 'Pending';
        if (!isPending) continue;

        const scheduleDateTime = new Date(item.scheduledAtUTC);
        if (scheduleDateTime > now) continue;

        if (scheduleDateTime < fiveMinutesAgo) {
            if (!missedItemsCache.find(cached => cached.id === item.id) && !publishingInProgress.has(item.id)) {
                newlyMissedItems.push(item);
                item.status = "Failed";
                item.failMessage = "Publication was missed at the scheduled time.";
                dataWasChanged = true;
            }
        } else {
            if (!publishingInProgress.has(item.id)) {
                console.log(`✅ FOUND DUE ITEM: "${item.title}". Adding to queue.`);
                publishingInProgress.add(item.id);
                publishingQueue.push(item);
            }
        }
    }

    if (dataWasChanged) {
        await saveData(data);
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
    let result;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90-second timeout for cold starts

    try {
        const publisherServiceUrl = process.env.PUBLISHER_SERVICE_URL;
        if (!publisherServiceUrl) {
            throw new Error("PUBLISHER_SERVICE_URL is not set.");
        }

        console.log(`Sending publish request for "${scheduledItem.title}" to Publisher service...`);
        const response = await fetch(`${publisherServiceUrl}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(scheduledItem),
            signal: controller.signal // Link the timeout controller
        });

        result = await response.json();
        if (!response.ok) {
            throw new Error(result.message || `Publisher service returned status ${response.status}`);
        }

    } catch (error) {
        console.error(`Failed to execute publish workflow for "${scheduledItem.title}":`, error.message);
        result = { status: 'failed', message: `Communication error with publisher: ${error.message}` };
    } finally {
        clearTimeout(timeoutId);
    }
    
    // The rest of this function (updating the database, sending notifications) remains EXACTLY THE SAME.
    const appData = await loadData();
    const itemIndex = appData.schedule.findIndex(i => i.id === scheduledItem.id);

    if (itemIndex > -1) {
        const itemToProcess = JSON.parse(JSON.stringify(appData.schedule[itemIndex]));
        
        if (result.status === 'success') {
            appData.schedule.splice(itemIndex, 1);
            if (!Array.isArray(appData.recentlyPublished)) appData.recentlyPublished = [];
            itemToProcess.status = 'Published';
            itemToProcess.publishedAtUTC = new Date().toISOString();
            appData.recentlyPublished.unshift(itemToProcess);
            appData.recentlyPublished = appData.recentlyPublished.slice(0, RECENTLY_PUBLISHED_LIMIT);
            sendNotification(`✅ **Published:** "${itemToProcess.title}"`);
        } else {
            appData.schedule[itemIndex].status = 'Failed';
            appData.schedule[itemIndex].failMessage = result.message;
            sendNotification(`❌ **Failed:** "${itemToProcess.title}". Reason: ${result.message}`);
        }
        await saveData(appData);
    }
}


function clearMissedItemsCache() { missedItemsCache = []; missedItemsNotificationSent = false; return {success: true, message: "Missed items cache cleared."};}
function getMissedItems() { return missedItemsCache; }

// =================================================================
// SECTION 4: EXPRESS WEB SERVER & APP STARTUP
// =================================================================
const app = express();
app.use(cors());
app.use(express.static('.')); 
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.status(200).send(`Zedge Worker v2 is alive. DB: ${activeDbIndex + 1}`));

// --- v2 API ENDPOINTS ---
app.get('/webapp/v2/data', async (req, res) => {
    try {
        const appData = await loadData();
        const loginStatus = await checkLoginStatus();
        
        res.json({
            schedule: appData.schedule || [],
            history: appData.recentlyPublished || [],
            status: {
                loggedIn: loginStatus.loggedIn,
                activeDb: `DB ${activeDbIndex + 1}`,
                queueCount: publishingQueue.length,
                lastCheckTime: lastCheckTime,
                isWorkerPaused: isWorkerPaused
            }
        });
    } catch (error) {
        console.error('Error fetching v2 data:', error);
        res.status(500).json({ error: 'Failed to retrieve server data.' });
    }
});

app.post('/webapp/v2/action', async (req, res) => {
    const { action, itemIds, time } = req.body;
    let result = { success: false, message: 'Unknown action' };

    switch (action) {
        case 'publish-now':
            result = await publishNowByIds(itemIds);
            break;
        case 'reschedule':
            result = await rescheduleItemsByIds(itemIds, time);
            break;
        case 'pause-worker':
            result = pauseWorker();
            break;
        case 'resume-worker':
            result = resumeWorker();
            break;
        case 'switch-db':
            result = await switchDatabase();
            break;
        case 'clear-cache':
            result = clearMissedItemsCache();
            break;
    }
    
    res.status(result.success ? 200 : 400).json(result);
});

// --- APP STARTUP ---
const PORT = process.env.PORT || 10000;

async function startApp() {
    try {
        await initializeDatabases();
        await reconcileActiveDbIndex();
        
        app.listen(PORT, () => {
            console.log(`Server v2 listening on port ${PORT}`);
            
            telegramBot.startBot(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, {
                loadDataFunc: loadData,
                loginCheckFunc: checkLoginStatus,
                getMissedItemsFunc: getMissedItems,
                publishMissedItemsFunc: publishMissedItems,
                rescheduleMissedItemFunc: rescheduleMissedItem,
                clearMissedCacheFunc: clearMissedItemsCache,
                switchDatabaseFunc: switchDatabase
            });

            startWorkerIntervals();
        });
    } catch (error) {
        console.error("Failed to start the application:", error.message);
        process.exit(1);
    }
}

function startWorkerIntervals() {
    console.log('Zedge Worker started. Initializing background tasks...');
    setTimeout(checkScheduleForPublishing, 5 * 1000);
    mainIntervalId = setInterval(checkScheduleForPublishing, 60 * 1000);
}

startApp();