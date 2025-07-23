// =================================================================
//                 ZEDGE PUBLISHER WORKER (telegram_bot.js)
// =================================================================
// This module initializes and manages the Telegram bot, handling all
// user commands and sending notifications from the worker.
// =================================================================

const TelegramBot = require('node-telegram-bot-api');

let bot;
let workerFunctions = {};
let notificationChatId; // To store the chat ID for notifications

/**
 * Starts the Telegram bot and sets up all command listeners.
 * @param {string} token - The Telegram bot token.
 * @param {string} chatId - The chat ID to send notifications to.
 * @param {object} dependencies - An object containing functions from the worker.
 */
function startBot(token, chatId, dependencies) {
    if (!token) {
        console.log('Telegram Bot Token not provided, bot will not start.');
        return;
    }
    if (!chatId) {
        console.log('Telegram Chat ID not provided, notifications will not be sent.');
    }
    notificationChatId = chatId;
    workerFunctions = dependencies;

    bot = new TelegramBot(token, { polling: true });
    console.log('Telegram Bot has started successfully!');

    // --- Command Handlers ---

    // --- NEW: Set Bot Commands for easy access in Telegram UI ---
    bot.setMyCommands([
        { command: '/app', description: 'Open the status web app' },
        { command: '/schedule', description: 'View upcoming schedule' },
        { command: 'loginstatus', description: 'Check Zedge login status' },
        { command: '/status', description: 'Find an item by title' },
        { command: '/help', description: 'Show all available commands' }
    ]);
    // --- END OF NEW SECTION ---


    bot.on('message', (msg) => {
        const text = msg.text;
        const chatId = msg.chat.id;

        if (!text) return;
        
        // --- NEW: Command for launching the Web App ---
        if (text.startsWith('/app')) {
            handleWebAppCommand(chatId);
            return; // Stop processing after this command
        }
        // --- END OF NEW SECTION ---

        // Using an if/else if structure for clarity
        if (text.startsWith('/help') || text.startsWith('/start')) {
            handleHelpCommand(chatId);
        } else if (text.startsWith('/schedule')) {
            handleScheduleCommand(chatId);
        } else if (text.startsWith('/loginstatus')) {
            handleLoginStatusCommand(chatId);
        } else if (text.startsWith('/status')) {
            const match = text.match(/\/status (.+)/);
            if (match) handleStatusCommand(chatId, match[1]);
        } else if (text.startsWith('/publish')) {
            const match = text.match(/\/publish (.+)/);
            if (match) handlePublishCommand(chatId, match[1]);
        } else if (text.startsWith('/rs')) {
            const match = text.match(/\/rs (.+)/);
            if (match) handleRescheduleCommand(chatId, match[1].split(' '));
        } else if (text.startsWith('/clearmissed')) {
            handleClearMissedCommand(chatId);
        } else if (text.startsWith('/switchdb')) {
            // This command takes no arguments
            if (dependencies.switchDatabaseFunc) {
                bot.sendMessage(chatId, "Command received. Initiating database switch. This may take a moment...");
                // This is an async function, but we don't need to wait for it here.
                // It will send its own notifications.
                dependencies.switchDatabaseFunc();
            } else {
                bot.sendMessage(chatId, "Database switching is not configured on the server.");
            }
        }
    });
}

/**
 * Sends a notification message to the pre-configured chat ID.
 * @param {string} message - The message to send.
 */
function sendNotification(message) {
    if (bot && notificationChatId) {
        bot.sendMessage(notificationChatId, message, { parse_mode: 'Markdown' });
    } else {
        // Fallback to console if bot is not running
        console.log(`[Notification] ${message}`);
    }
}


// --- Command Logic Functions ---

// --- NEW: Handler for the /app command ---
function handleWebAppCommand(chatId) {
    // IMPORTANT: Replace this URL with the public URL of your server
    const webAppUrl = process.env.WEB_APP_URL || 'https://your-render-app-name.onrender.com/telegram_webapp.html';

    if (webAppUrl.includes('your-render-app-name')) {
         bot.sendMessage(chatId, "Web App URL is not configured on the server. Please set the `WEB_APP_URL` environment variable.");
         return;
    }

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📊 Open Status App', web_app: { url: webAppUrl } }]
            ]
        }
    };
    bot.sendMessage(chatId, 'Click the button below to open the web app and view the live schedule and status.', opts);
}
// --- END OF NEW FUNCTION ---

function handleHelpCommand(chatId) {
    const helpMessage = [
        "**Zedge Worker Bot Commands:**",
        "`/app` - Opens a web app with the live schedule.", // MODIFIED
        "`/help` or `/start` - Shows this help message.",
        "`/schedule` - Lists upcoming, unpublished items.",
        "`/status <title>` - Searches for an item by title.",
        "`/loginstatus` - Checks if the worker is logged in to Zedge.",
        "`/switchdb` - Migrates data and switches to the next primary database.",
        "",
        "**Commands for Missed Publications:**",
        "`/publish all-missed` - Publishes all missed items.",
        "`/publish <title>` - Publishes a specific missed item.",
        "`/rs <all | \"title\"> <time>` - Reschedules item(s). Ex: `/rs all 10m`, `/rs \"My Title\" 1h`",
        "`/clearmissed` - Clears the missed items list."
    ].join('\n');
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
}

async function handleScheduleCommand(chatId) {
    if (typeof workerFunctions.loadDataFunc !== 'function') return bot.sendMessage(chatId, 'Error: data functions not available.');

    const currentData = await workerFunctions.loadDataFunc();
    const upcomingItems = [];

    if (currentData.schedule && Array.isArray(currentData.schedule)) {
        // Sort by date ascending to show nearest first
        currentData.schedule.sort((a, b) => new Date(a.scheduledAtUTC) - new Date(b.scheduledAtUTC));
        currentData.schedule.forEach(item => {
            if (item.status !== 'Published') {
                upcomingItems.push(`- \`${item.title}\` on ${new Date(item.scheduledAtUTC).toLocaleString()}`);

            }
        });
    }

    if (upcomingItems.length > 0) {
        bot.sendMessage(chatId, `**Upcoming Scheduled Items:**\n${upcomingItems.slice(0, 15).join('\n')}`, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, 'No upcoming items are scheduled.');
    }
}

async function handleLoginStatusCommand(chatId) {
    if (typeof workerFunctions.loginCheckFunc !== 'function') return bot.sendMessage(chatId, 'Error: status check function not available.');

    await bot.sendMessage(chatId, 'Checking Zedge login status, please wait...');
    const result = await workerFunctions.loginCheckFunc();

    if (result.loggedIn) {
        bot.sendMessage(chatId, '✅ **Zedge Status:** Currently Logged In.');
    } else {
        bot.sendMessage(chatId, `❌ **Zedge Status:** Logged Out.\n**Reason:** ${result.error}`);
    }
}

async function handleStatusCommand(chatId, query) {
    if (typeof workerFunctions.loadDataFunc !== 'function') return bot.sendMessage(chatId, 'Error: data functions not available.');

    const currentData = await workerFunctions.loadDataFunc();
    const matches = [];

    if (currentData.schedule && Array.isArray(currentData.schedule)) {
        currentData.schedule.forEach(item => {
            if (item.title.toLowerCase().includes(query.toLowerCase())) {
                matches.push(`- \`${item.title}\` -> **${item.status || 'Pending'}**`);
            }
        });
    }

    if (matches.length > 0) {
        bot.sendMessage(chatId, `**Found ${matches.length} match(es) for "${query}":**\n${matches.join('\n')}`, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, `No scheduled items found matching "${query}".`);
    }
}

function handlePublishCommand(chatId, identifier) {
    if (typeof workerFunctions.publishMissedItemsFunc !== 'function') return bot.sendMessage(chatId, 'Error: publishing function not available.');

    const result = workerFunctions.publishMissedItemsFunc(identifier.replace('-', ' ')); // Accommodate "all-missed"
    if (result.success) {
        bot.sendMessage(chatId, `✅ **Success!** ${result.message}`);
    } else {
        bot.sendMessage(chatId, `❌ **Failed!** ${result.message}`);
    }
}

async function handleRescheduleCommand(chatId, args) {
    if (typeof workerFunctions.rescheduleMissedItemFunc !== 'function') {
        return bot.sendMessage(chatId, 'Error: rescheduling function not available.');
    }

    if (args.length < 2) {
        return bot.sendMessage(chatId, "Invalid format. Use: `/rs <all | \"item title\"> <time>` (e.g., `/rs all 10m`)");
    }

    const timeString = args.pop();
    const identifier = args.join(' ').replace(/"/g, ''); // The rest is the identifier, remove quotes

    const result = await workerFunctions.rescheduleMissedItemFunc(identifier, timeString);
    if (result.success) {
        bot.sendMessage(chatId, `✅ **Success!** ${result.message}`);
    } else {
        bot.sendMessage(chatId, `❌ **Failed!** ${result.message}`);
    }
}

function handleClearMissedCommand(chatId) {
    if (typeof workerFunctions.clearMissedCacheFunc === 'function') {
        const result = workerFunctions.clearMissedCacheFunc();
        bot.sendMessage(chatId, `✅ ${result}`);
    }
}

module.exports = { startBot, sendNotification };