global.Promise = require('bluebird');

const Discord = require('discord.js');
const oneLine = require('common-tags').oneLine;
const path = require('path');
const Raven = require('raven');
const sqlite = require('sqlite');
const WebSocket = require('ws');
const winston = require('winston');

const config = require('./config');
const Guilds = require('./Guilds');

const client = new Discord.Client({
	disableEveryone: true,
	messageCacheMaxSize: 1
});

let guilds;
sqlite.open(path.join(__dirname, 'settings.db')).then(db => guilds = new Guilds(db, client));

let radioJSON;
let ws;

Raven.config(config.ravenKey);
Raven.install();

function connectWS(info) {
	if (ws) ws.removeAllListeners();
	try {
		ws = new WebSocket(info);
		winston.info('Websocket connection A-OK!');
	} catch (error) {
		setTimeout(() => { connectWS(info); }, 3000);
		winston.warn('Websocket couldn\'t connect, reconnecting...');
	}

	ws.on('message', data => {
		try {
			if (data) radioJSON = JSON.parse(data);
		} catch (error) {
			winston.error(error);
		}
	});
	ws.on('close', () => {
		setTimeout(() => { connectWS(info); }, 3000);
		winston.warn('Websocket connection closed, reconnecting...');
	});
	ws.on('error', winston.error);
}

client.on('error', winston.error)
	.on('warn', winston.warn)
	.on('ready', () => {
		winston.info(oneLine`
			Listen.moe ready!
			${client.user.username}#${client.user.discriminator} (ID: ${client.user.id})
			Currently in ${client.guilds.size} servers.
		`);
		guilds.startup();
	})
	.once('ready', () => { connectWS(config.streamInfo); })
	.on('disconnect', () => { winston.warn('Disconnected!'); })
	.on('reconnect', () => { winston.warn('Reconnecting...'); })
	.on('guildCreate', () => { })
	.on('guildDelete', () => { })
	.on('message', msg => {
		if (msg.channel.type === 'dm') return;

		const permission = msg.channel.permissionsFor(msg.client.user);
		if (!permission.hasPermission('SEND_MESSAGES')) return;

		if (msg.content === '~~join') {
			const voiceChannel = msg.guild.channels.get(msg.member.voiceChannel.id);
			guilds.set(msg.guild.id, 'voiceChannel', voiceChannel.id);
			guilds.joinVoice(voiceChannel);
		}
	});

client.login(config.token);

process.on('unhandledRejection', err => {
	winston.error(`Uncaught Promise Error:\n${err.stack}`);
});
