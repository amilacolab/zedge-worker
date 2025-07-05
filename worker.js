// worker.js - FINAL VERSION

const { Pool } = require('pg');
const puppeteer = require('puppeteer');
require('dotenv').config();
const CONNECTION_STRING = process.env.CONNECTION_STRING;
const pool = new Pool({
    connectionString: CONNECTION_STRING,
});

async function loadData() {
    console.log('Fetching latest data from cloud database...');
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT data FROM app_data WHERE id = 1');
        if (result.rows.length > 0) {
            return result.rows[0].data;
        }
        return {}; // Return empty object if no data found
    } catch (err) {
        console.error('Error loading data from database', err);
        return {}; // Return empty object on error
    } finally {
        if (client) {
            client.release();
        }
    }
}

async function saveData(appData) {
    console.log('Saving data to cloud database...');
    let client;
    try {
        client = await pool.connect();
        await client.query('UPDATE app_data SET data = $1 WHERE id = 1', [appData]);
    } catch (err) {
        console.error('Error saving data to database', err);
    } finally {
        if (client) {
            client.release();
        }
    }
}

const publishingInProgress = new Set();
let publishingQueue = [];
let isQueueProcessing = false;

async function checkScheduleForPublishing() {
    console.log('Running background check for scheduled items to publish...');
    const data = await loadData();
    const now = new Date();

    if (!data.schedule) {
        console.log("No schedule found in database.");
        return;
    }
    
    for (const dateKey in data.schedule) {
        for (const timeKey in data.schedule[dateKey]) {
            const items = data.schedule[dateKey][timeKey];
            for (const item of items) {
                const scheduleDateTime = new Date(`${dateKey}T${timeKey}`);
                const isDue = now >= scheduleDateTime;
                const isPending = !item.status || item.status === 'Pending';
                if (isDue && isPending && !publishingInProgress.has(item.id)) {
                    publishingInProgress.add(item.id);
                    console.log(`Found due item: "${item.title}". Adding to publish queue.`);
                    publishingQueue.push({ ...item, date: `${dateKey}T${timeKey}` });
                    if (!isQueueProcessing) {
                        processPublishingQueue();
                    }
                }
            }
        }
    }
}

async function processPublishingQueue() {
    if (isQueueProcessing || publishingQueue.length === 0) return;
    isQueueProcessing = true;
    console.log(`--- Starting to process publish queue with ${publishingQueue.length} item(s). ---`);
    while (publishingQueue.length > 0) {
        const itemToPublish = publishingQueue.shift(); 
        console.log(`--> Now publishing: "${itemToPublish.title}"`);
        try {
            await executePublishWorkflow(itemToPublish);
        } catch (error) {
            console.error(`A critical error occurred in the queue processor for item "${itemToPublish.title}"`, error);
        } finally {
            publishingInProgress.delete(itemToPublish.id);
            console.log(`<-- Finished processing: "${itemToPublish.title}"`);
        }
    }
    isQueueProcessing = false;
    console.log('--- Publish queue is now empty. ---');
}

async function executePublishWorkflow(scheduledItem) {
    // Perform the publishing task
    const result = await performPublish(scheduledItem);
    
    // After publishing, load the entire dataset to update it
    const appData = await loadData();

    try {
        const dateKey = scheduledItem.date.split('T')[0];
        const timeKey = scheduledItem.date.split('T')[1];
        if (appData.schedule && appData.schedule[dateKey] && appData.schedule[dateKey][timeKey]) {
            const itemToUpdate = appData.schedule[dateKey][timeKey].find(i => i.id === scheduledItem.id);
            if (itemToUpdate) {
                itemToUpdate.status = result.status === 'success' ? 'Published' : 'Failed';
                itemToUpdate.failMessage = result.message;
                
                // Save the modified appData object back to the database
                await saveData(appData); 
                console.log(`Updated database for "${scheduledItem.title}" with status: ${itemToUpdate.status}`);
            }
        }
    } catch (e) {
        console.error('Failed to update database after publishing:', e);
    }

    // We can add Discord notifications back in later. For now, we are focusing on publishing.
    return result;
}

async function performPublish(scheduledItem) {
    console.log(`--- Starting publish process for: "${scheduledItem.title}" ---`);
    let browser;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        const ZEDGE_PROFILES = {
            Normal: 'https://upload.zedge.net/business/4e5d55ef-ea99-4913-90cf-09431dc1f28f/profiles/0c02b238-4bd0-479e-91f7-85c6df9c8b0f/content/WALLPAPER',
            Black: 'https://upload.zedge.net/business/4e5d55ef-ea99-4913-90cf-09431dc1f28f/profiles/a90052da-0ec5-4877-a73f-034c6da5d45a/content/WALLPAPER'
        };

        const theme = scheduledItem.theme || '';
        const targetProfileName = theme.toLowerCase().includes('black') ? 'Black' : 'Normal';
        const targetProfileUrl = ZEDGE_PROFILES[targetProfileName];
        if (!targetProfileUrl) throw new Error(`Could not determine a valid profile URL for theme: "${theme}"`);

        console.log(`Loading profile: ${targetProfileName} at ${targetProfileUrl}`);
        await page.goto(targetProfileUrl, { waitUntil: 'networkidle2' });

        console.log(`Searching for DRAFT: "${scheduledItem.title}"`);
        const foundAndClicked = await page.evaluate((title) => {
            const elements = document.querySelectorAll('div[class*="StyledTitle"], div[title], span');
            for (const el of elements) {
                if (el.textContent.trim() === title || el.getAttribute('title') === title) {
                    const clickableParent = el.closest('div[role="button"], a');
                    if (clickableParent) {
                        clickableParent.click();
                        return true;
                    }
                }
            }
            return false;
        }, scheduledItem.title);
        
        if (!foundAndClicked) throw new Error(`Could not find a DRAFT with the title "${scheduledItem.title}"`);

        console.log("Found DRAFT, clicking it. Waiting for details page.");
        await page.waitForTimeout(8000);

        const clickedPublish = await page.evaluate(() => {
            const publishButton = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.trim().toLowerCase() === 'publish');
            if (publishButton && !publishButton.disabled) {
                publishButton.click();
                return true;
            }
            return false;
        });

        if (!clickedPublish) throw new Error('The "Publish" button was not found or was disabled on the details page.');
        console.log("Clicked 'Publish'.");

        console.log(`--- Successfully published: "${scheduledItem.title}" ---`);
        return { status: 'success', message: 'Published successfully.' };

    } catch (error) {
        console.error(`Failed to publish "${scheduledItem.title}":`, error);
        return { status: 'failed', message: error.message };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Publisher worker is alive.\n');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    // Start the main worker logic ONLY after the server is running
    startWorker();
});

// This is the main loop that will run continuously on the server.
function startWorker() {
    console.log('Zedge Worker started. Checking for scheduled posts every 60 seconds.');
    setInterval(checkScheduleForPublishing, 60 * 1000); // 60 seconds
}
