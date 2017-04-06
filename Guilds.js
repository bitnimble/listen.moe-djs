const request = require('https');
const winston = require('winston');

const config = require('./config');

let stream;
function getStream() {
	return new Promise(resolve => request.get(config.stream, res => resolve(res))
		.on('error', () => process.exit(1)));
}
getStream().then(res => stream = res);

class Guilds {
	constructor(db, client) {
		this.db = db;
		this.client = client;
		this.settings = new Map();
		this.listeners = new Map();
		this.insertOrReplaceStmt = null;
		this.deleteStmt = null;
	}

	async startup() {
		await this.db.run('CREATE TABLE IF NOT EXISTS guilds (guild INTEGER PRIMARY KEY, settings TEXT)');

		const rows = await this.db.all('SELECT CAST(guild as TEXT) as guild, settings FROM guilds');

		const statements = await Promise.all([
			this.db.prepare('INSERT OR REPLACE INTO guilds VALUES(?, ?)'),
			this.db.prepare('DELETE FROM guilds WHERE guild = ?')
		]);
		this.insertOrReplaceStmt = statements[0];
		this.deleteStmt = statements[1];

		for (const { settings: settingsStr, guild } of rows) {
			let settings;
			try {
				settings = JSON.parse(settingsStr);
			} catch (error) {
				continue;
			}

			const allGuildIDs = (await this.client.shard.broadcastEval('this.guilds.keyArray()')).reduce((prev, next) => prev.concat(next));

			if (!allGuildIDs.includes(guild)) {
				this.clear(guild);
				continue;
			}

			if (!this.client.guilds.has(guild)) continue;

			this.settings.set(guild, settings);
			this.setupGuild(guild, settings);

			await new Promise(r => setTimeout(r, 1000));
		}

		this.listeners
			.set('guildCreate', guild => {
				const settings = this.settings.get(guild.id);
				if (!settings) return;
				this.setupGuild(guild.id, settings);
			});

		for (const [event, listener] of this.listeners) this.client.on(event, listener);
	}

	async destroy() {
		await Promise.all([
			this.insertOrReplaceStmt.finalize(),
			this.deleteStmt.finalize()
		]);

		for (const [event, listener] of this.listeners) this.client.removeListener(event, listener);
		this.listeners.clear();
	}

	get(guild, key, defVal) {
		const settings = this.settings.get(guild);

		return settings ? typeof settings[key] !== 'undefined' ? settings[key] : defVal : defVal;
	}

	async set(guild, key, val) {
		let settings = this.settings.get(guild);
		if (!settings) {
			settings = {};
			this.settings.set(guild, settings);
		}

		settings[key] = val;
		await this.insertOrReplaceStmt.run(guild, JSON.stringify(settings));

		return val;
	}

	async remove(guild, key) {
		const settings = this.settings.get(guild);
		if (!settings || typeof settings[key] === 'undefined') return undefined;

		const val = settings[key];
		settings[key] = undefined;
		await this.insertOrReplaceStmt.run(guild, JSON.stringify(settings));

		return val;
	}

	async clear(guild) {
		if (!this.settings.has(guild)) return;
		this.settings.delete(guild);
		await this.deleteStmt.run(guild);
	}

	setupGuild(guild, settings) {
		if (typeof guild !== 'string') throw new TypeError('The guild must be a guild ID.');
		guild = this.client.guilds.get(guild);

		if (typeof settings.prefix !== 'undefined') guild.commandPrefix = settings.prefix;
		if (typeof settings.voiceChannel !== 'undefined') {
			const voiceChannel = guild.channels.get(settings.voiceChannel);
			if (!voiceChannel) return;

			this.joinVoice(guild, voiceChannel);
		}
	}

	joinVoice(guild, voiceChannel) {
		voiceChannel.join({ shared: true }).then(async vc => {
			winston.info(`[SHARD: ${this.client.shard.id}] ADDED VOICE CONNECTION: (${voiceChannel.id}) for guild ${guild.name} (${guild.id})`);
			vc.playSharedStream('listen.moe', stream);
		}).catch(error => {
			winston.error(`[SHARD: ${this.client.shard.id}] ERROR VOICE CONNECTION: (${voiceChannel.id}) for guild ${guild.name} (${guild.id})`);
			winston.error(error.message);
		});
	}

	leaveVoice(guild, voiceChannel) {
		winston.info(`[SHARD: ${this.client.shard.id}] REMOVED VOICE CONNECTION: For guild ${guild.name} (${guild.id})`);
		voiceChannel.leaveSharedStream();
		voiceChannel.disconnect();
	}
}

module.exports = Guilds;
