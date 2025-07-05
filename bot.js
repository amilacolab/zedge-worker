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
        }
    });

    client.login(token).catch(error => {
        console.error('Failed to log in to Discord. Please check your Bot Token.', error.message);
        client = null;
    });
}

async function handleScheduleCommand(message) {
    if (typeof workerFunctions.loadDataFunc !== 'function') return message.reply('Error: data functions not available.');
    const currentData = await workerFunctions.loadDataFunc();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const upcomingItems = [];
    if (currentData.schedule) {
        Object.keys(currentData.schedule).sort().forEach(dateKey => {
            const date = new Date(dateKey + 'T00:00:00');
            if (date >= today) {
                Object.keys(currentData.schedule[dateKey]).sort().forEach(timeKey => {
                    currentData.schedule[dateKey][timeKey].forEach(item => {
                        if (item.status !== 'Published') {
                            const scheduledDate = new Date(`${dateKey}T${timeKey}`);
                            upcomingItems.push(`- \`${item.title}\` on ${scheduledDate.toLocaleDateString()} at ${scheduledDate.toLocaleTimeString()}`);
                        }
                    });
                });
            }
        });
    }
    if (upcomingItems.length > 0) {
        message.channel.send(`**Upcoming Scheduled Items:**\n${upcomingItems.slice(0, 15).join('\n')}`);
    } else {
        message.channel.send('No upcoming items are scheduled.');
    }
}

async function handleStatusCommand(message, args) {
    if (typeof workerFunctions.loadDataFunc !== 'function') return message.reply('Error: data functions not available.');
    const query = args.join(' ').toLowerCase();
    if (!query) {
        message.channel.send('Please provide a title to search for. Usage: `!status <title query>`');
        return;
    }
    const currentData = await workerFunctions.loadDataFunc();
    const matches = [];
    if (currentData.schedule) {
        Object.keys(currentData.schedule).forEach(dateKey => {
            Object.keys(currentData.schedule[dateKey]).forEach(timeKey => {
                currentData.schedule[dateKey][timeKey].forEach(item => {
                    if (item.title.toLowerCase().includes(query)) {
                        matches.push(`- \`${item.title}\` -> **${item.status || 'Pending'}**`);
                    }
                });
            });
        });
    }
    if (matches.length > 0) {
        message.channel.send(`**Found ${matches.length} match(es) for "${query}":**\n${matches.slice(0, 15).join('\n')}`);
    } else {
        message.channel.send(`No scheduled items found matching "${query}".`);
    }
}

async function handleLoginStatusCommand(message) {
    if (typeof workerFunctions.loginCheckFunc !== 'function') return message.reply('Error: status check function not available.');
    message.reply('Checking Zedge login status, please wait...');
    const result = await workerFunctions.loginCheckFunc();
    if (result.loggedIn) {
        message.reply('✅ **Zedge Status:** Currently Logged In.');
    } else {
        message.reply(`❌ **Zedge Status:** Logged Out. \n**Reason:** ${result.error}`);
    }
}

function handleHelpCommand(message) {
    const helpMessage = [
        "**Zedge Worker Bot Commands:**",
        "`!help` - Shows this help message.",
        "`!schedule` - Lists upcoming, unpublished items.",
        "`!status <title>` - Searches for an item by its title and shows its status.",
        "`!loginstatus` - Checks if the worker is currently logged in to Zedge."
    ].join('\n');
    message.channel.send(helpMessage);
}

module.exports = { startBot };