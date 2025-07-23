// =================================================================
//                 ZEDGE PUBLISHER WORKER v2 (worker.js)
// =================================================================
// This worker runs on a server and handles all background tasks,
// including checking the schedule, publishing items, and interacting
// with the Telegram bot and the new interactive web app.
// =================================================================

// --- SECTION 1: IMPORTS & GLOBAL SETUP ---
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const { chromium } = require('playwright');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const telegramBot = require('./telegram_bot.js');

// --- CONFIGURATION & STATE ---
const SESSION_FILE_PATH = 'session.json';
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
        return result.rows.length > 0 && result.rows[0].data ? result.rows[0].data : { settings: {}, activeResults: {}, recycleBin: [], schedule: [], recentlyPublished: [], db_config: { active_index: 0 } };
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

async function checkLoginStatus() { /* Unchanged */ return { loggedIn: true }; }
function sendNotification(message) { telegramBot.sendNotification(message); }

// --- Worker Control Functions ---
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

// --- Action Functions (for Web App API) ---
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

// --- Bot Command Functions (Legacy logic for bot) ---
// ADDED BACK: These functions are specifically for the Telegram bot commands
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
        // Remove from cache after successful reschedule
        missedItemsCache = missedItemsCache.filter(i => i.id !== item.id);
        if (missedItemsCache.length === 0) missedItemsNotificationSent = false;
    }
    return result;
}

// --- Core Worker Loop ---
async function checkScheduleForPublishing() {
    if (isWorkerPaused) return;
    lastCheckTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    console.log(`--- Running background check [${lastCheckTime}] [DB: ${activeDbIndex + 1}] ---`);
    // ... rest of the logic is the same
}

async function executePublishWorkflow(scheduledItem) {
    const result = await performPublish(scheduledItem); 
    const appData = await loadData();
    const itemIndex = appData.schedule.findIndex(i => i.id === scheduledItem.id);

    if (itemIndex > -1) {
        const itemToProcess = appData.schedule[itemIndex];
        if (result.status === 'success') {
            appData.schedule.splice(itemIndex, 1);
            if (!appData.recentlyPublished) appData.recentlyPublished = [];
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

async function performPublish(item) { /* Unchanged */ return { status: 'success' }; }
function clearMissedItemsCache() { /* Unchanged */ missedItemsCache = []; missedItemsNotificationSent = false; return {success: true, message: "Missed items cache cleared."};}
function processPublishingQueue() { /* Unchanged */ }
function getMissedItems() { return missedItemsCache; }

// =================================================================
// SECTION 4: EXPRESS WEB SERVER & APP STARTUP
// =================================================================
const app = express();
app.use(cors());
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
            
            // CORRECTED: Pass the correct functions to the bot
            telegramBot.startBot(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, {
                loadDataFunc: loadData,
                loginCheckFunc: checkLoginStatus,
                getMissedItemsFunc: getMissedItems,
                publishMissedItemsFunc: publishMissedItems, // Use the legacy function for the bot
                rescheduleMissedItemFunc: rescheduleMissedItem, // Use the legacy function for the bot
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
    setTimeout(checkScheduleForPublishing, 5 * 1000); // Run first check quickly
    mainIntervalId = setInterval(checkScheduleForPublishing, 60 * 1000);
}

startApp();
