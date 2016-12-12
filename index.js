/* eslint-disable no-console */
const Discord = require('discord.js');
const fs = require('fs');
const HTTPS = require('https');
const merge = require('merge');
const request = require('request');
const reload = require('require-reload')(require);
const WebSocket = require('ws');

const CommandHelper = require('./CommandHelper');
const config = require('./config.json');
let guilds = require('./guilds.json');

const client = new Discord.Client();
const commandHelper = new CommandHelper(config.guildDefaults.prefix);

let listeners = 0;

const HELP_MESSAGE = `
**LISTEN.moe streaming bot by Geo1088 & friends**

**Usage:**
    After adding me to your server, join a voice channel and type \`~~join\` to bind me to that voice channel.
    Keep in mind that you need to have the \`Manage Server\` permission to use this command.

**Commands:**
    **\\~~join**: Joins the voice channel you are currently in.
    **\\~~np**: Displays the currently playing song.

For additional commands and help, please visit: <https://github.com/anonymousthing/listen.moe-djs>`;

/*
 * Setup input stream from the radio.
 */
let stream;
HTTPS.get(config.stream, res => stream = res).once('error', error => { // eslint-disable-line no-return-assign
    console.log(`HTTPS stream died :O\n${error}`);
    process.exit(1);
});

/*
 * Setup stream info socket from the radio.
 */
let radioJSON;
let ws;
function connectWS(info) {
    if (ws) ws.removeAllListeners();
    ws = new WebSocket(info);

    ws.on('message', data => {
        try {
            if (data) radioJSON = JSON.parse(data);
        } catch (error) {
            console.log(error);
        }
    });
    ws.on('close', () => {
        setTimeout(connectWS, 3000);
        console.log('Websocket connection closed, reconnecting...');
    });
    ws.on('error', console.error);
}

/*
 * Change a guild's config via an object of options, and save the changes.
 */
function writeGuildConfig(guild, object) {
    /*
     * Get gurrent config for this guild, creating it if it doesn't exist.
     */
    let currentConfig = guilds[guild] || {};

    /*
     * Merge new options with current.
     */
    let newConfig = merge(currentConfig, object);
    let _guilds = guilds;

    /*
     * Write this new config back to the config.
     */
    _guilds[guild] = newConfig;
    if (!fs.existsSync('./backups')) fs.mkdirSync('./backups');

    /*
     * Create a backup before doing anything.
     */
    fs.writeFile(`backups/guilds-${Date.now()}.json`, JSON.stringify(guilds, null, '\t'));

    /*
     * Store the new stuff in the file.
     */
    fs.writeFile('guilds.json', JSON.stringify(_guilds, null, '\t'), 'utf-8', err => {
        if (err) {
            console.log(err);
        } else {
            /*
             * Reload the file.
             */
            guilds = reload('./guilds.json');
        }
    });
}

/*
 * Get a config option from a guild.
 */
function getGuildConfig(guild, option) {
    /*
     * Grab the defaults, just in case.
     */
    let defaults = config.guildDefaults;
    if (!guilds[guild] || !guilds[guild][option]) return defaults[option];

    return guilds[guild][option];
}

/*
 * Use this if you are joining multiple voice channels at once.
 * If you join them manually, all the channels after the 10th one or so will just timeout.
 */
function joinVoices(connectList, i) {
    if (i >= connectList.length) return;

    let guild = connectList[i].guild;
    let channel = connectList[i].channel;

    /*
     * Find a current connection in this guild.
     */
    let cc = client.voiceConnections.get(guild);
    let isNewConnection = !cc;

    let guildObj = client.guilds.get(guild);
    if (guildObj) {
        let voiceChannel = guildObj.channels.get(channel);
        if (!voiceChannel) {
            return joinVoices(connectList, i + 1);
        }
        return voiceChannel.join({ shared: true }).then(vc => {
            if (vc) {
                let realGuild = client.guilds.get(guild);
                if (isNewConnection) {
                    console.log(`Added voice connection for guild ${realGuild.name} (${realGuild.id})`);
                    vc.setSpeaking(true);

                    vc.playSharedStream('listen.moe', stream);
                } else {
                    console.log(`Moved voice connection for guild ${realGuild.name} (${realGuild.id}) to a different channel`);
                }
            }
            joinVoices(connectList, i + 1);
        }).catch(error => {
            if (isNewConnection) {
                console.log(`Error connecting to channel ${channel} | ${error}`);
            } else {
                console.log(`Error moving to channel ${channel} | ${error}`);
            }

            return joinVoices(connectList, i + 1);
        });
    } else {
        return joinVoices(connectList, i + 1);
    }
}

function joinVoice(guild, channel) {
    return joinVoices([{ guild: guild, channel: channel }], 0);
}

/*
 * Helper function to check manage server permission.
 */
function canManageGuild(member) {
    return member.permissions.hasPermission('MANAGE_GUILD');
}

/*
 * Allows the owner to dynamically run scripts against the bot from inside Discord.
 * Requires explicit owner permission inside the config file.
 */
function commandEval(msg, argument) {
    if (!config.owners.includes(msg.author.id)) return msg.channel.sendMessage('soz bae must be bot owner');

    let result;
    try {
        console.log(argument);
        result = eval(argument);
    } catch (error) {
        result = error;
    }

    return msg.channel.sendMessage(result, { split: true });
}

/*
 * Gets the currently playing song and artist.
 * If the song was requested by someone also gives their name
 * and a link to their profile on forum.listen.moe.
 */
function commandNowPlaying(msg) {
    if (getGuildConfig(msg.guild.id, 'denied').includes(msg.channel.id)) return;

    if (radioJSON === {}) return;

    let requestedBy = radioJSON.requested_by ? `\n**Requested by:** ${radioJSON.requested_by}` : '';
    let anime = radioJSON.anime_name ? `\n**Anime:** ${radioJSON.anime_name}` : '';

    return msg.channel.sendMessage(`**Now playing:** "${radioJSON.song_name}" by ${radioJSON.artist_name}${anime}${requestedBy}`);
}

/*
 * Shows a real basic usage help.
 */
function commandHelp(msg) {
    return msg.channel.sendMessage(HELP_MESSAGE);
}

/*
 * Type this while in a voice channel to have the bot join that channel and start playing.
 * Limited to users with the "manage server" permission.
 */
function commandJoin(msg) {
    if (!canManageGuild(msg.member)) return;

    let channel = msg.member.voiceChannelID;
    let guild = msg.guild.id;
    if (!guild || !channel) {
        return msg.channel.sendMessage('Join a voice channel first!');
    } else {
        channel = channel.toString();
        guild = guild.toString();
        writeGuildConfig(guild, { vc: channel });
        joinVoice(guild, channel);

        return msg.channel.sendMessage('\\o/');
    }
}

/*
 * Type this while in a voice channel to have the bot leave that channel and stop playing.
 * Limited to users with the "manage server" permission.
 */
function commandLeave(msg) {
    if (!canManageGuild(msg.member)) return;

    let guild = msg.guild.id.toString();
    let vc = client.voiceConnections.get(guild);
    if (!vc) {
        return msg.channel.sendMessage('Bot is not in a channel!');
    } else {
        vc.leaveSharedStream();
        vc.disconnect();
        writeGuildConfig(guild, { vc: null });

        return msg.channel.sendMessage(';_; o-okay...');
    }
}

/*
 * Allows the owner to show stats from the bot from inside Discord.
 * Requires explicit owner permission inside the config file.
 */
function commandStats(msg) {
    if (!config.owners.includes(msg.author.id)) return msg.channel.sendMessage('soz bae must be bot owner');

    let users = 0;
    client.voiceConnections.map(vc => users += vc.channel.members // eslint-disable-line no-return-assign
        .filter(m => !m.user.bot && !m.selfDeaf && !m.deaf).size);

    let nowplaying = `**Now playing:** ${radioJSON.song_name} **by** ${radioJSON.artist_name}`;
    let requestedBy = radioJSON.requested_by ? `\n**Requested by:** [${radioJSON.requested_by}](https://forum.listen.moe/u/${radioJSON.requested_by})` : '';
    let description = `\n${nowplaying}${requestedBy}\n`;

    return msg.channel.sendMessage('', {
        embed: {
            title: 'LISTEN.moe (Click here to add the radio bot to your server)',
            url: 'https://discordapp.com/oauth2/authorize?&client_id=222167140004790273&scope=bot',
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
                url: 'https://github.com/anonymousthing/listen.moe-djs',
                name: 'by Geo1088 & friends',
                icon_url: 'https://avatars0.githubusercontent.com/u/4165301?v=3&s=72' // eslint-disable-line camelcase
            }
        }
    });
}

/*
 * Type this to have the bot change prefix.
 * Limited to users with the "manage server" permission.
 */
function commandPrefix(msg, argument) {
    if (!canManageGuild(msg.member)) return;

    if (/[a-zA-Z0-9\s\n]/.test(argument)) {
        return msg.channel.sendMessage('Invalid prefix. Can\'t be a letter, number, or whitespace character.');
    }

    writeGuildConfig(msg.guild.id, { prefix: argument });

    return msg.channel.sendMessage('\\o/');
}

/*
 * Helper function to get current listeners.
 */
function currentListeners() {
    let userCount = 0;
    /*
     * Iterate through all our voice connections' channels and count the number of other users.
     */
    client.voiceConnections
        .map(vc => vc.channel)
        .forEach(c => userCount += c.members // eslint-disable-line no-return-assign
            .filter(m => !m.selfDeaf && !m.deaf).size - 1);

    listeners = userCount;

    return setTimeout(currentListeners, 20000);
}

/*
 * Changes the bot's game to the currently playing song.
 */
function gameCurrentSong() {
    let game = 'music probably';
    if (radioJSON !== {}) game = `${radioJSON.artist_name} ${config.separator || '-'} ${radioJSON.song_name}`;

    client.user.setGame(game);

    return setTimeout(gameCurrentUsersAndGuilds, 20000);
}

/*
 * Changes the bot's game to a listener and guild count.
 */
function gameCurrentUsersAndGuilds() {
    client.user.setGame(`for ${listeners} on ${client.guilds.size} servers`);

    return setTimeout(gameCurrentSong, 10000);
}

function sendListenersData() { // eslint-disable-line no-unused-vars
    request.post(config.listenersReportURL, { number: listeners }, (err, res, body) => { // eslint-disable-line no-unused-vars
        if (err) console.log(`Etooo, crap. Couldnt update listeners. Reason: ${err}`);
    });

    return setTimeout(sendListenersData, 60000);
}

commandHelper.register('eval', commandEval);
commandHelper.register('np', commandNowPlaying);
commandHelper.register('help', commandHelp);
commandHelper.register('join', commandJoin);
commandHelper.register('stats', commandStats);
commandHelper.register('leave', commandLeave);
commandHelper.register('prefix', commandPrefix);

client.once('ready', () => {
    console.log(`Connected as ${client.user.username} / Currently in ${client.guilds.size} servers`);
    connectWS(config.streamInfo);

    /*
     * Rejoin channels that we were connected to.
     */
    let connectList = [];

    /*
     * Loop through all the servers recorded.
     */
    for (let guild of Object.keys(guilds)) {
        /*
         * Get the channel for this guild.
         */
        let channel = getGuildConfig(guild, 'vc');
        if (channel) connectList.push({ guild: guild, channel: channel });
    }
    joinVoices(connectList, 0);

    /*
     * Initialise timer loops.
     */
    currentListeners();
    gameCurrentUsersAndGuilds();

    // if (config.listenersReportURL) sendListenersData();
});

client.on('guildCreate', guild => { guild.defaultChannel.sendMessage(HELP_MESSAGE); });

client.on('message', msg => {
    if (msg.channel.type === 'dm') return;

    const permission = msg.channel.permissionsFor(msg.client.user);
    if (!permission.hasPermission('SEND_MESSAGES')) return;

    const guildConfig = guilds[msg.guild.id] || {};
    let prefix = guildConfig.prefix;

    return commandHelper.process(msg, prefix);
});

client.login(config.token);

process.on('unhandledRejection', err => {
    console.error(`Uncaught Promise Error:\n${err.stack}`);
});
