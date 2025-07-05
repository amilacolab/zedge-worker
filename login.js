// login.js - FINAL VERSION
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
    const userDataDir = path.join(__dirname, 'zedge_user_data');

    console.log('Launching browser with automation flags disabled...');
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [ // Add this block to hide automation flags
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    const page = await context.newPage();

    console.log('Please log in to your Zedge account in the browser window...');
    await page.goto('https://upload.zedge.net/');

    // This will pause the script and wait for you to successfully log in.
    await page.waitForURL('https://upload.zedge.net/business/**', { timeout: 300000 }); // 5 minute timeout

    console.log('Login successful! Saving session state to session.json...');
    const storageState = await context.storageState();
    fs.writeFileSync('session.json', JSON.stringify(storageState, null, 2));

    await context.close();
    console.log('Session saved! You can now upload the contents of session.json to Render.');
})();