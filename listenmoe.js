global.Promise = require('bluebird');

const Discord = require('discord.js');
const { oneLine, stripIndents } = require('common-tags');
const path = require('path');
const sqlite = require('sqlite');
const WebSocket = require('ws');
const winston = require('winston');
const request = require('superagent');

const config = require('./config');
const Guilds = require('./Guilds');

const client = new Discord.Client({
	disableEveryone: true,
	messageCacheMaxSize: 1
});

let guilds;
let listeners = 0;
let radioJSON;
let ws;
let streaming = false;

sqlite.open(path.join(__dirname, 'settings.db')).then(db => guilds = new Guilds(db, client)); // eslint-disable-line no-return-assign

function connectWS(info) {
	if (ws) ws.removeAllListeners();
	try {
		ws = new WebSocket(info);
		winston.info(`[SHARD: ${client.shard.id}] WEBSOCKET: Connection A-OK!`);
	} catch (error) {
		setTimeout(() => connectWS(info), 3000);
		winston.warn(`[SHARD: ${client.shard.id}] WEBSOCKET: Couldn't connect, reconnecting...`);
	}

	ws.on('message', data => {
		try {
			if (data) radioJSON = JSON.parse(data);
		} catch (error) {
			winston.error(error);
		}
	});
	ws.on('close', () => {
		setTimeout(() => connectWS(info), 3000);
		winston.warn(`[SHARD: ${client.shard.id}] WEBSOCKET: Connection closed, reconnecting...`);
	});
	ws.on('error', winston.error);
}

const streamCheck = setInterval(() => {
	client.shard.broadcastEval(`
		this.voiceConnections
			.map(vc => vc.channel.members.filter(me => !(me.user.bot || me.selfDeaf || me.deaf)).size)
			.reduce((sum, members) => sum + members, 0);
	`)
		.then(results => listeners = results.reduce((prev, next) => prev + next, 0))
		.catch(error => {
			winston.error(error);
			listeners = 0;
		});

	request
		.get('https://api.twitch.tv/kraken/streams/?limit=1&channel=listen_moe')
		.set('Accept', 'application/vnd.twitchtv.v3+json')
		.set('Client-ID', config.twitchClientID)
		.end((err, res) => {
			if (err || !res.streams) {
				winston.info(`[SHARD: ${client.shard.id}] TWITCH: Setting streaming to FALSE.`);
				streaming = false;
			} else {
				winston.info(`[SHARD: ${client.shard.id}] TWITCH: Setting streaming to TRUE.`);
				streaming = true;
			}
		});
}, 30000);

function currentUsersAndGuildsGame() {
	client.shard.fetchClientValues('guilds.size').then(results => {
		const guildsAmount = results.reduce((prev, next) => prev + next, 0);

		if (streaming) {
			winston.info(`[SHARD: ${client.shard.id}] PLAYING GAME: Setting playing game WITH streaming!`);
			client.user.setGame(`for ${listeners} on ${guildsAmount} servers`, 'https://twitch.tv/listen_moe');
		} else {
			winston.info(`[SHARD: ${client.shard.id}] PLAYING GAME: Setting playing game WITHOUT streaming!`);
			client.user.setGame(`for ${listeners} on ${guildsAmount} servers`);
		}
	});

	return setTimeout(currentSongGame, 10000);
}

function currentSongGame() {
	let game = 'Loading data...';
	if (radioJSON !== {}) game = `${radioJSON.artist_name} - ${radioJSON.song_name}`;
	if (streaming) {
		winston.info(`[SHARD: ${client.shard.id}] PLAYING GAME: Setting playing game WITH streaming!`);
		client.user.setGame(game, 'https://twitch.tv/listen_moe');
	} else {
		winston.info(`[SHARD: ${client.shard.id}] PLAYING GAME: Setting playing game WITHOUT streaming!`);
		client.user.setGame(game);
	}

	return setTimeout(currentUsersAndGuildsGame, 20000);
}

client.on('error', winston.error)
	.on('warn', winston.warn)
	.on('ready', () => {
		winston.info(oneLine`
			[SHARD: ${client.shard.id}]
			CLIENT: Ready!
			${client.user.username}#${client.user.discriminator} (ID: ${client.user.id})
			This shard is currently in ${client.guilds.size} servers.
		`);
		guilds.startup();
		connectWS(config.streamInfo);
		currentUsersAndGuildsGame();
	})
	.on('disconnect', () => {
		winston.warn(`[SHARD: ${client.shard.id}] CLIENT: Disconnected!`);
		clearInterval(streamCheck);
		guilds.destroy();
		process.exit(1);
	})
	.on('guildCreate', guild => {
		return guild.defaultChannel.sendEmbed({
			description: stripIndents`**LISTEN.moe discord bot by Crawl**

				**Usage:**
				After adding me to your server, join a voice channel and type \`~~join\` to bind me to that voice channel.
				Keep in mind that you need to have the \`Manage Server\` permission to use this command.

				**Commands:**
				**\\~~join**: Type this while in a voice channel to have the bot join that channel and start playing there. Limited to users with the "manage server" permission.
				**\\~~leave**: Makes the bot leave the voice channel it's currently in.
				**\\~~np**: Gets the currently playing song and artist. If the song was requested by someone, also gives their name.
				**\\~~ignore**: Ignores commands in the current channel. Admin commands are exempt from the ignore.
				**\\~~unignore**: Unignores commands in the current channel.
				**\\~~ignore all**: Ignores commands in all channels on the guild.
				**\\~~unignore all**: Unignores all channels on the guild.
				**\\~~prefix !** Changes the bot's prefix for this server. Prefixes cannot contain whitespace, letters, or numbers - anything else is fair game. It's recommended that you stick with the default prefix of ~~, but this command is provided in case you find conflicts with other bots.

				For additional commands and help, please visit [Github](https://github.com/WeebDev/listen.moe-discord)`,
			color: 15473237
		});
	})
	.on('guildDelete', guild => { guilds.clear(guild.id); })
	/* eslint-disable consistent-return */
	.on('message', async msg => { // eslint-disable-line complexity
		if (msg.channel.type === 'dm') return;
		if (msg.author.bot) return;
		const prefix = guilds.get(msg.guild.id, 'prefix', '~~');

		if (!msg.content.startsWith(prefix)) return;

		const permission = msg.channel.permissionsFor(msg.client.user);
		if (!permission || !permission.hasPermission('SEND_MESSAGES')) return;

		const ignored = guilds.get(msg.guild.id, 'ignore', []);
		const manageGuild = msg.member.hasPermission('MANAGE_GUILD');
		if (!config.owners.includes(msg.author.id) && !manageGuild && ignored.includes(msg.channel.id)) return;

		const message = msg.content.toLowerCase();

		if (message.startsWith(`${prefix}join`)) {
			if (!config.owners.includes(msg.author.id) && !manageGuild) {
				if (msg.author.id === '83700966167150592') {
					return msg.channel.sendMessage('I won\'t do that, tawake. （｀Δ´）！');
				}

				return msg.reply('only a member with manage guild permission can add me to a voice channel, gomen! <(￢0￢)>');
			}

			if (msg.guild.voiceConnection) {
				return msg.reply('I am already in a voice channel here, baka! ｡゜(｀Д´)゜｡');
			}

			if (!msg.member.voiceChannel) {
				return msg.reply('you have to be in a voice channel to add me, baka! ｡゜(｀Д´)゜｡');
			}

			const voiceChannel = msg.member.voiceChannel;

			guilds.set(msg.guild.id, 'voiceChannel', voiceChannel.id);
			guilds.joinVoice(msg.guild, voiceChannel);
			return msg.channel.sendMessage(`Streaming to your server now, ${msg.author}-san! (* ^ ω ^)`);
		} else if (message.startsWith(`${prefix}leave`)) {
			if (!config.owners.includes(msg.author.id) && !manageGuild) {
				if (msg.author.id === '83700966167150592') {
					return msg.channel.sendMessage('I won\'t do that, tawake. （｀Δ´）！');
				}

				return msg.reply('only a member with manage guild permission can remove me from a voice channel, gomen! <(￢0￢)>');
			}

			if (!msg.guild.voiceConnection) {
				return msg.reply('you didn\'t add me to a voice channel yet, baka! ｡゜(｀Д´)゜｡');
			}

			if (!msg.member.voiceChannel) {
				return msg.reply('you have to be in a voice channel to remove me, baka! ｡゜(｀Д´)゜｡');
			}

			const voiceChannel = msg.guild.voiceConnection;

			guilds.remove(msg.guild.id, 'voiceChannel');
			guilds.leaveVoice(msg.guild, voiceChannel);
			return msg.channel.sendMessage(`I will stop streaming to your server now, ${msg.author}-san. (-ω-、)`);
		} else if (message.startsWith(`${prefix}stats`)) {
			if (!config.owners.includes(msg.author.id)) {
				if (msg.author.id === '83700966167150592') {
					return msg.channel.sendMessage('I won\'t do that, tawake. （｀Δ´）！');
				}

				return msg.channel.sendMessage('Only the Botowners can view stats, gomen! 	<(￢0￢)>');
			}

			try {
				listeners = (await client.shard.broadcastEval(`
					this.voiceConnections
						.map(vc => vc.channel.members.filter(me => !(me.user.bot || me.selfDeaf || me.deaf)).size)
						.reduce((sum, members) => sum + members, 0);
				`)).reduce((prev, next) => prev + next);
			} catch (error) {
				listeners = 0;
			}

			const guildsAmount = (await client.shard.fetchClientValues('guilds.size')).reduce((prev, next) => prev + next, 0);
			const voiceConnectionsAmount = (await client.shard.fetchClientValues('voiceConnections.size')).reduce((prev, next) => prev + next, 0);

			const nowplaying = `${radioJSON.artist_name ? `${radioJSON.artist_name} - ` : ''}${radioJSON.song_name}`;
			const anime = radioJSON.anime_name ? `Anime: ${radioJSON.anime_name}` : '';
			const requestedBy = radioJSON.requested_by ? `Requested by: [${radioJSON.requested_by}](https://forum.listen.moe/u/${radioJSON.requested_by})` : '';
			const song = `${nowplaying}\n\n${anime}\n${requestedBy}`;

			return msg.channel.sendEmbed({
				color: 15473237,
				author: {
					url: 'https://github.com/WeebDev/listen.moe-discord',
					name: 'Crawl, Geo, Anon & Kana'
				},
				title: 'LISTEN.moe (Click here to add the radio bot to your server)',
				url: 'https://discordapp.com/oauth2/authorize?&client_id=222167140004790273&scope=bot&permissions=36702208',
				fields: [
					{ name: 'Now playing', value: song },
					{ name: 'Radio Listeners', value: radioJSON.listeners, inline: true },
					{ name: 'Discord Listeners', value: listeners, inline: true },
					{ name: 'Servers', value: guildsAmount, inline: true },
					{ name: 'Voice Channels', value: voiceConnectionsAmount, inline: true }
				],
				timestamp: new Date(),
				thumbnail: { url: 'http://i.imgur.com/Jfz6qak.png' }
			});
		} else if (message.startsWith(`${prefix}help`)) {
			return msg.channel.sendEmbed({
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
			const nowplaying = `${radioJSON.artist_name ? `${radioJSON.artist_name} - ` : ''}${radioJSON.song_name}`;
			const anime = radioJSON.anime_name ? `Anime: ${radioJSON.anime_name}` : '';
			const requestedBy = radioJSON.requested_by ? `Requested by: [${radioJSON.requested_by}](https://forum.listen.moe/u/${radioJSON.requested_by})` : '';
			const song = `${nowplaying}\n\n${anime}\n${requestedBy}`;

			return msg.channel.sendEmbed({
				color: 15473237,
				fields: [{ name: 'Now playing', value: song }]
			});
		} else if (message.startsWith(`${prefix}eval`)) {
			if (!config.owners.includes(msg.author.id)) {
				return msg.channel.sendMessage('Only the Botowners can eval, gomen! <(￢0￢)>');
			}

			let result;
			try {
				winston.info(`[SHARD: ${client.shard.id}] EVAL: ${msg.content.substr(prefix.length + 5)} FROM ${msg.author.username}`);
				result = eval(msg.content.substr(prefix.length + 5));
			} catch (error) {
				result = error;
			}

			return msg.channel.sendCode('javascript', result, { split: true });
		} else if (message.startsWith(`${prefix}prefix`)) {
			if (!config.owners.includes(msg.author.id) && !manageGuild) {
				if (msg.author.id === '83700966167150592') {
					return msg.channel.sendMessage('I won\'t do that, tawake. （｀Δ´）！');
				}

				return msg.reply('only a member with manage guild permission can change my prefix, gomen! <(￢0￢)>');
			}

			if (msg.content === `${prefix}prefix default`) {
				winston.info(`[SHARD: ${client.shard.id}] PREFIX RESET: "~~" ON GUILD ${msg.guild.name} (${msg.guild.id})`);
				guilds.remove(msg.guild.id, 'prefix');
				return msg.channel.sendMessage(`Prefix resetted to \`~~\` (⌒_⌒;)`);
			}

			if (/[a-zA-Z0-9\s\n]/.test(msg.content.substr(prefix.length + 7))) {
				return msg.channel.sendMessage('Prefix can\'t be a letter, number, or whitespace character, gomen! <(￢0￢)>');
			}

			winston.info(`[SHARD: ${client.shard.id}] PREFIX CHANGE: "${msg.content.substr(prefix.length + 7)}" ON GUILD ${msg.guild.name} (${msg.guild.id})`);
			guilds.set(msg.guild.id, 'prefix', msg.content.substr(prefix.length + 7));
			return msg.channel.sendMessage(`Prefix changed to \`${msg.content.substr(prefix.length + 7)}\` (⌒_⌒;)`);
		} else if (message.startsWith(`${prefix}ignore`)) {
			if (!config.owners.includes(msg.author.id) && !manageGuild) {
				return msg.reply('only a member with manage guild permission can change ignored channels, gomen! <(￢0￢)>');
			}

			if (msg.content === `${prefix}ignore all`) {
				const channels = msg.guild.channels;

				winston.info(`[SHARD: ${client.shard.id}] CHANNEL IGNORE: All channels ON GUILD ${msg.guild.name} (${msg.guild.id})`);
				for (const [key] of channels) ignored.push(key);
				guilds.set(msg.guild.id, 'ignore', ignored);
				return msg.reply('gotcha! I\'m going to ignore all channels now. (￣▽￣)');
			}

			if (ignored.includes(msg.channel.id)) {
				return msg.reply('this channel is already on the ignore list, baka! ｡゜(｀Д´)゜｡');
			}

			ignored.push(msg.channel.id);

			winston.info(`[SHARD: ${client.shard.id}] CHANNEL IGNORE: (${msg.channel.id}) ON GUILD ${msg.guild.name} (${msg.guild.id})`);
			guilds.set(msg.guild.id, 'ignore', ignored);
			return msg.reply('gotcha! I\'m going to ignore this channel now. (￣▽￣)');
		} else if (message.startsWith(`${prefix}unignore`)) {
			if (!config.owners.includes(msg.author.id) && !manageGuild) {
				return msg.reply('only a member with manage guild permission can change ignored channels, gomen! <(￢0￢)>');
			}

			if (typeof ignored === 'undefined') {
				return msg.reply('there are  no channels on the ignore list, gomen! <(￢0￢)>');
			}

			if (msg.content === `${prefix}unignore all`) {
				winston.info(`[SHARD: ${client.shard.id}] CHANNEL UNIGNORE: All channels ON GUILD ${msg.guild.name} (${msg.guild.id})`);
				guilds.remove(msg.guild.id, 'ignore');
				return msg.reply('gotcha! I\'m baaack!  ＼(≧▽≦)／ (not going to ignore any channels anymore).');
			}

			if (!ignored.includes(msg.channel.id)) {
				return msg.reply('this channel isn\'t on the ignore list, gomen! <(￢0￢)>');
			}

			if (ignored.length === 1) {
				winston.info(`[SHARD: ${client.shard.id}] CHANNEL UNIGNORE: (${msg.channel.id}) ON GUILD ${msg.guild.name} (${msg.guild.id})`);
				guilds.remove(msg.guild.id, 'ignore');
				return msg.reply('gotcha! I\'m baaack!  ＼(≧▽≦)／ (not going to ignore this channel anymore).');
			}

			const findIgnored = ignored.indexOf(msg.channel.id);

			if (findIgnored > -1) {
				ignored.splice(findIgnored, 1);
			}

			winston.info(`[SHARD: ${client.shard.id}] CHANNEL UNIGNORE: (${msg.channel.id}) ON GUILD ${msg.guild.name} (${msg.guild.id})`);
			guilds.set(msg.guild.id, 'ignore', ignored);
			return msg.reply('I\'m baaack!  ＼(≧▽≦)／ (not going to ignore this channel anymore).');
		}
	});

client.login();

process.on('unhandledRejection', err => {
	winston.error(`[SHARD: ${client.shard.id}] Uncaught Promise Error:\n${err.stack}`);
});
