#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const appJson = path.join(__dirname, '../app.json');
const app = JSON.parse(fs.readFileSync(appJson, 'utf8'));
const next = String((parseInt(app.expo.ios.buildNumber || '0', 10) + 1));
app.expo.ios.buildNumber = next;
fs.writeFileSync(appJson, JSON.stringify(app, null, 2) + '\n');
console.log(`iOS build number → ${next}`);
