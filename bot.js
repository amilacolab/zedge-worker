// bot.js

const { Client, GatewayIntentBits } = require('discord.js');

let client;
let workerFunctions = {};

function startBot(token, dependencies) {
    if (!token) {
        console.log('Discord Bot Token not provided, bot will not start.');
        return;
    }
    workerFunctions = dependencies;

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    client.once('ready', () => {
        console.log(`Discord Bot logged in as ${client.user.tag}!`);
    });

    client.on('messageCreate', async message => {
        if (message.author.bot || !message.content.startsWith('!')) return;
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        if (command === 'schedule') {
            await handleScheduleCommand(message);
        } else if (command === 'status') {
            await handleStatusCommand(message, args);
        } else if (command === 'loginstatus') {
            await handleLoginStatusCommand(message);
        } else if (command === 'help') {
            handleHelpCommand(message);
        } else if (command === 'publish') { // NEW COMMAND
            await handlePublishCommand(message, args);
        } else if (command === 'clear-missed') { // NEW COMMAND
            if (typeof workerFunctions.clearMissedCacheFunc === 'function') {
                const result = workerFunctions.clearMissedCacheFunc();
                message.reply(`✅ ${result}`);
            }
        } else if (command === 'rs') { // Add this new command handler
                // Clean quotes from arguments
                const cleanedArgs = args.map(arg => arg.replace(/"/g, ''));
                await handleRescheduleCommand(message, cleanedArgs);
        }
    });

    client.login(token).catch(error => {
        console.error('Failed to log in to Discord. Please check your Bot Token.', error.message);
        client = null;
    });
}

// In zedge-worker/bot.js


async function handlePublishCommand(message, args) {
    if (typeof workerFunctions.publishMissedItemsFunc !== 'function') return message.reply('Error: publishing function not available.');

    const identifier = args.join(' ').trim();
    if (!identifier) {
        return message.reply('Please specify `all-missed` or the title of a specific item. Example: `!publish all-missed`');
    }

    const result = workerFunctions.publishMissedItemsFunc(identifier);
    if (result.success) {
        message.reply(`✅ **Success!** ${result.message}`);
    } else {
        message.reply(`❌ **Failed!** ${result.message}`);
    }
}

async function handleScheduleCommand(message) {
    if (typeof workerFunctions.loadDataFunc !== 'function') return message.reply('Error: data functions not available.');
    const currentData = await workerFunctions.loadDataFunc();
    const today = new Date();
    const upcomingItems = [];

    if (currentData.schedule && Array.isArray(currentData.schedule)) {
        currentData.schedule.forEach(item => {
            const scheduledDate = new Date(item.scheduledAtUTC);
            if (scheduledDate >= today && item.status !== 'Published') {
                upcomingItems.push(`- \`${item.title}\` on ${scheduledDate.toLocaleString()}`);
            }
        });
    }

    upcomingItems.sort(); // Sort by date implicitly
    if (upcomingItems.length > 0) {
        message.channel.send(`**Upcoming Scheduled Items:**\n${upcomingItems.slice(0, 15).join('\n')}`);
    } else {
        message.channel.send('No upcoming items are scheduled.');
    }
}

async function handleStatusCommand(message, args) {
    if (typeof workerFunctions.loadDataFunc !== 'function') return message.reply('Error: data functions not available.');
    const query = args.join(' ').toLowerCase();
    if (!query) return message.channel.send('Please provide a title to search for.');

    const currentData = await workerFunctions.loadDataFunc();
    const matches = [];

    if (currentData.schedule && Array.isArray(currentData.schedule)) {
        currentData.schedule.forEach(item => {
            if (item.title.toLowerCase().includes(query)) {
                matches.push(`- \`${item.title}\` -> **${item.status || 'Pending'}**`);
            }
        });
    }
    
    if (matches.length > 0) {
        message.channel.send(`**Found ${matches.length} match(es) for "${query}":**\n${matches.slice(0, 15).join('\n')}`);
    } else {
        message.channel.send(`No scheduled items found matching "${query}".`);
    }
}

async function handleLoginStatusCommand(message) {
    // Check if the required function exists
    if (typeof workerFunctions.loginCheckFunc !== 'function') {
        return message.reply('Error: The status check function is not available.');
    }

    try {
        // 1. Send the initial "please wait" message
        await message.reply('Checking Zedge login status, please wait...');

        // 2. Call the long-running function
        const result = await workerFunctions.loginCheckFunc();

        // 3. Send the final result
        if (result.loggedIn) {
            await message.reply('✅ **Zedge Status:** Currently Logged In.');
        } else {
            await message.reply(`❌ **Zedge Status:** Logged Out. \n**Reason:** ${result.error}`);
        }
    } catch (error) {
        // 4. If any of the 'await' calls fail, log the detailed error
        console.error(`[CRITICAL] Failed to send a reply in '#${message.channel.name}'.`, error);
        
        // Optionally, notify the user that the command failed if possible
        if (!error.message.includes('Missing Permissions')) {
            try {
                await message.reply('An unexpected error occurred. Please check the server logs.');
            } catch (e) {
                console.error('[CRITICAL] Could not even send an error message. Check bot permissions.', e);
            }
        }
    }
}
async function handleRescheduleCommand(message, args) {
    if (typeof workerFunctions.rescheduleMissedItemFunc !== 'function') {
        return message.reply('Error: rescheduling function not available.');
    }

    if (args.length < 2) {
        return message.reply("Invalid format. Use: `!RS <all | \"item title\"> <time>` (e.g., `!RS all 10m`)");
    }

    const timeString = args.pop(); // The time is the last argument
    const identifier = args.join(' '); // The rest is the identifier

    const result = await workerFunctions.rescheduleMissedItemFunc(identifier, timeString);
    if (result.success) {
        message.reply(`✅ **Success!** ${result.message}`);
    } else {
        message.reply(`❌ **Failed!** ${result.message}`);
    }
}

function handleHelpCommand(message) {
    const helpMessage = [
        "**Zedge Worker Bot Commands:**",
        "`!help` - Shows this help message.",
        "`!schedule` - Lists upcoming, unpublished items.",
        "`!status <title>` - Searches for an item by its title and shows its status.",
        "`!loginstatus` - Checks if the worker is currently logged in to Zedge.",
        "",
        "**Commands for Missed Publications:**",
        "`!publish all-missed` - Publishes all items that were missed.",
        "`!publish <title>` - Publishes a specific missed item by its full title.",
        "`!rs <all | \"title\"> <time>` - Reschedules item(s). Ex: `!rs all 10m`, `!rs \"My Title\" 1h`",
        "`!clear-missed` - Clears the missed items list after you have rescheduled them manually."
    ].join('\n');
    message.channel.send(helpMessage);
}

module.exports = { startBot };