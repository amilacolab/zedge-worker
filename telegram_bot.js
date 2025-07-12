// telegram_bot.js - CORRECTED WITH RESCHEDULE AND NOTIFICATIONS

const TelegramBot = require('node-telegram-bot-api');

let bot;
let workerFunctions = {};
let notificationChatId; // To store the chat ID for notifications

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

    bot.onText(/\/help|\/start/, (msg) => {
        handleHelpCommand(msg.chat.id);
    });

    bot.onText(/\/schedule/, async (msg) => {
        await handleScheduleCommand(msg.chat.id);
    });

    bot.onText(/\/loginstatus/, async (msg) => {
        await handleLoginStatusCommand(msg.chat.id);
    });
    
    bot.onText(/\/status (.+)/, async (msg, match) => {
        await handleStatusCommand(msg.chat.id, match[1]);
    });

    bot.onText(/\/publish (.+)/, (msg, match) => {
        handlePublishCommand(msg.chat.id, match[1]);
    });

    // Added the missing Reschedule command
    bot.onText(/\/rs (.+)/, async (msg, match) => {
        await handleRescheduleCommand(msg.chat.id, match[1].split(' '));
    });

    bot.onText(/\/clearmissed/, (msg) => {
        if (typeof workerFunctions.clearMissedCacheFunc === 'function') {
            const result = workerFunctions.clearMissedCacheFunc();
            bot.sendMessage(msg.chat.id, `✅ ${result}`);
        }
    });
}

// Function for worker to send notifications
function sendNotification(message) {
    if (bot && notificationChatId) {
        bot.sendMessage(notificationChatId, message, { parse_mode: 'Markdown' });
    } else {
        console.log(`[Notification] ${message}`);
    }
}

// --- Command Logic Functions ---

function handleHelpCommand(chatId) {
    const helpMessage = [
        "**Zedge Worker Bot Commands:**",
        "`/help` or `/start` - Shows this help message.",
        "`/schedule` - Lists upcoming, unpublished items.",
        "`/status <title>` - Searches for an item by title.",
        "`/loginstatus` - Checks if the worker is logged in to Zedge.",
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

// Added missing reschedule logic
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

module.exports = { startBot, sendNotification };