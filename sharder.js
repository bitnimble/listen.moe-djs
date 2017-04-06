const { ShardingManager } = require('discord.js');
const path = require('path');

const config = require('./config');

const manager = new ShardingManager(path.join(__dirname, 'listenmoe.js'), { token: config.token });

manager.spawn();
