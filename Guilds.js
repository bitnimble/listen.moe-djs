const request = require('request-promise');
const winston = require('winston');

const config = require('./config');
const stream = request(config.stream);

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

		let currentRow = 0;

		const inverval = setInterval(() => {
			let settings;
			try {
				settings = JSON.parse(rows[currentRow].settings);
			} catch (error) {
				return;
			}

			const guild = rows[currentRow].guild;
			if (!this.client.guilds.has(guild)) {
				this.clear(guild.id);
				currentRow++;
				return;
			}
			this.settings.set(guild, settings);
			this.setupGuild(guild, settings);

			currentRow++;

			if (currentRow === rows.length) clearInterval(inverval);
		}, 1000);

		const statements = await Promise.all([
			this.db.prepare('INSERT OR REPLACE INTO guilds VALUES(?, ?)'),
			this.db.prepare('DELETE FROM guilds WHERE guild = ?')
		]);
		this.insertOrReplaceStmt = statements[0];
		this.deleteStmt = statements[1];

		this.listeners
			.set('guildCreate', guild => {
				const settings = this.settings.get(guild.id);
				if (!settings) return;
				this.setupGuild(guild.id, settings);
			});

		for (const [event, listener] of this.listeners) this.client.on(event, listener);
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
		voiceChannel.join({ shared: true }).then(vc => {
			winston.info(`ADDED VOICE CONNECTION: (${voiceChannel.id}) for guild ${guild.name} (${guild.id})`);
			vc.playSharedStream('listen.moe', stream);
		}).catch(error => {
			winston.error(`ERROR VOICE CONNECTION: (${voiceChannel.id}) for guild ${guild.name} (${guild.id})`);
			winston.error(error.message);
			this.remove(guild.id, 'voiceChannel');
		});
	}

	leaveVoice(guild, voiceChannel) {
		winston.info(`REMOVED VOICE CONNECTION: For guild ${guild.name} (${guild.id})`);
		voiceChannel.leaveSharedStream();
		voiceChannel.disconnect();
	}
}

module.exports = Guilds;
