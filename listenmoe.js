global.Promise = require('bluebird');

const Discord = require('discord.js');
const oneLine = require('common-tags').oneLine;
const path = require('path');
const Raven = require('raven');
const sqlite = require('sqlite');
const stripIndents = require('common-tags').stripIndents;
const WebSocket = require('ws');
const winston = require('winston');

const config = require('./config');
const Guilds = require('./Guilds');

const client = new Discord.Client({
	disableEveryone: true,
	messageCacheMaxSize: 1
});

let guilds;
let radioJSON;
let ws;

sqlite.open(path.join(__dirname, 'settings.db')).then(db => guilds = new Guilds(db, client));

//Raven.config(config.ravenKey);
//Raven.install();

function connectWS(info) {
	if (ws) ws.removeAllListeners();
	try {
		ws = new WebSocket(info);
		winston.info('WEBSOCKET: Connection A-OK!');
	} catch (error) {
		setTimeout(() => { connectWS(info); }, 3000);
		winston.warn('WEBSOCKET: Couldn\'t connect, reconnecting...');
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
		winston.warn('WEBSOCKET: Connection closed, reconnecting...');
	});
	ws.on('error', winston.error);
}

client.on('error', winston.error)
	.on('warn', winston.warn)
	.on('ready', () => {
		winston.info(oneLine`
			CLIENT: Listen.moe ready!
			${client.user.username}#${client.user.discriminator} (ID: ${client.user.id})
			Currently in ${client.guilds.size} servers.
		`);
		guilds.startup();
	})
	.once('ready', () => { connectWS(config.streamInfo); })
	.on('disconnect', () => { winston.warn('CLIENT: Disconnected!'); })
	.on('reconnect', () => { winston.warn('CLIENT: Reconnecting...'); })
	.on('guildCreate', guild => {  })
	.on('guildDelete', guild => { guilds.clear(guild.id); })
	.on('message', msg => {
		if (msg.channel.type === 'dm') return;

		const permission = msg.channel.permissionsFor(msg.client.user);
		if (!permission.hasPermission('SEND_MESSAGES')) return;

		const prefix = guilds.get(msg.guild.id, 'prefix', '~~');
		const message = msg.content.toLowerCase();
		const manageGuild = msg.member.permissions.hasPermission('MANAGE_GUILD');

		if (message.startsWith(`${prefix}join`)) {
			if (!manageGuild) {
				msg.reply('only a member with manage guild permission can add me to a voice channel, gomen!');
				return;
			}

			if (client.voiceConnections.get(msg.guild.id)) {
				msg.reply('I am already in a voice channel here, baka!');
				return;
			}

			if (!msg.member.voiceChannel) {
				msg.reply('you have to be in a voice channel to add me, baka!');
				return;
			}

			const voiceChannel = msg.guild.channels.get(msg.member.voiceChannel.id);

			guilds.set(msg.guild.id, 'voiceChannel', voiceChannel.id);
			guilds.joinVoice(msg.guild, voiceChannel);
		} else if (message.startsWith(`${prefix}leave`)) {
			if (!manageGuild) {
				msg.reply('only a member with manage guild permission can remove me from a voice channel, gomen!');
				return;
			}

			if (!client.voiceConnections.get(msg.guild.id)) {
				msg.reply('you didn\'t add me to a voice channel yet, baka!');
				return;
			}

			if (!msg.member.voiceChannel) {
				msg.reply('you have to be in a voice channel to remove me, baka!');
				return;
			}

			guilds.set(msg.guild.id, 'voiceChannel', undefined);
			guilds.leaveVoice(msg.guild, client.voiceConnections.get(msg.guild.id));
		} else if (message.startsWith(`${prefix}stats`)) {
			if (!config.owners.includes(msg.author.id)) {
				msg.channel.sendMessage('Only the Botowners can view stats, gomen!');
				return;
			}

			const users = client.voiceConnections
				.map(vc => vc.channel.members.filter(me => !(me.user.bot || me.selfDeaf || me.deaf)).size)
				.reduce((sum, members) => sum + members);

			let nowplaying = `**Now playing:** ${radioJSON.song_name} **by** ${radioJSON.artist_name}`;
			let requestedBy = radioJSON.requested_by ? `\n**Requested by:** [${radioJSON.requested_by}](https://forum.listen.moe/u/${radioJSON.requested_by})` : '';
			let description = `\n${nowplaying}${requestedBy}\n`;

			msg.channel.sendEmbed({
				title: 'LISTEN.moe (Click here to add the radio bot to your server)',
				url: 'https://discordapp.com/oauth2/authorize?&client_id=222167140004790273&scope=bot&permissions=36702208',
				description: description,
				color: 15473237,
				fields: [
					{ name: 'Radio Listeners', value: `${radioJSON.listeners}`, inline: true },
					{ name: 'Discord Listeners', value: users, inline: true },
					{ name: 'Servers', value: client.guilds.size, inline: true },
					{ name: 'Voice Channels', value: client.voiceConnections.size, inline: true }
				],
				timestamp: new Date(),
				thumbnail: { url: 'http://i.imgur.com/Jfz6qak.png' },
				author: {
					url: 'https://github.com/WeebDev/listen.moe-discord',
					name: 'Crawl'
				}
			});
		} else if (message.startsWith(`${prefix}help`)) {
			msg.channel.sendEmbed({
				description: stripIndents`**LISTEN.moe discord bot by Crawl**

					**Usage:**
					After adding me to your server, join a voice channel and type \`~~join\` to bind me to that voice channel.
					Keep in mind that you need to have the \`Manage Server\` permission to use this command.

					**Commands:**
					**\\~~join**: Joins the voice channel you are currently in.
					**\\~~leave**: Leaves the voice channel the bot is currently in.
					**\\~~np**: Displays the currently playing song.

					For additional commands and help, please visit [Github](https://github.com/WeebDev/listen.moe-discord)`,
				color: 15473237
			});
		} else if (message.startsWith(`${prefix}np`)) {
			let nowplaying = `**Now playing:** ${radioJSON.song_name} **by** ${radioJSON.artist_name}`;
			let requestedBy = radioJSON.requested_by ? `\n**Requested by:** [${radioJSON.requested_by}](https://forum.listen.moe/u/${radioJSON.requested_by})` : '';
			let description = `\n${nowplaying}${requestedBy}\n`;

			msg.channel.sendEmbed({
				description: description,
				color: 15473237
			});
		} else if (message.startsWith(`${prefix}eval`)) {
			if (!config.owners.includes(msg.author.id)) {
				msg.channel.sendMessage('Only the Botowners can eval, gomen!');
				return;
			}

			let result;
			try {
				winston.info(`EVAL: ${msg.content.substr(prefix.length + 5)} FROM ${msg.author.username}`);
				result = eval(msg.content.substr(prefix.length + 5));
			} catch (error) {
				result = error;
			}

			msg.channel.sendCode('javascript', result, { split: true });
		} else if (message.startsWith(`${prefix}prefix`)) {
			if (!manageGuild) {
				msg.reply('only a member with manage guild permission can change my prefix, gomen!');
				return;
			}

			if (msg.content === `${prefix}prefix`) {
				winston.info(`PREFIX RESET: "~~" ON GUILD ${msg.guild.name} (${msg.guild.id})`);
				guilds.remove(msg.guild.id, 'prefix');
				msg.channel.sendMessage(`Prefix resetted to \`~~\``);
				return;
			}

			if (/[a-zA-Z0-9\s\n]/.test()) {
				msg.channel.sendMessage('Prefix can\'t be a letter, number, or whitespace character, gomen!');
				return;
			}

			winston.info(`PREFIX CHANGE: "${msg.content.substr(prefix.length + 7)}" ON GUILD ${msg.guild.name} (${msg.guild.id})`);
			guilds.set(msg.guild.id, 'prefix', msg.content.substr(prefix.length + 7));
			msg.channel.sendMessage(`Prefix changed to \`${msg.content.substr(prefix.length + 7)}\``);
		}
	});

client.login(config.token);

process.on('unhandledRejection', err => {
	winston.error(`Uncaught Promise Error:\n${err.stack}`);
});
