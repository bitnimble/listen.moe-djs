let Discord = require('discord.js');
let config = require('./config.json');
let guilds = require('./guilds.json');
let fs = require('fs');
let merge = require('merge');
let io = require('socket.io-client');
let request = require('request');
let reload = require('require-reload')(require);
let HTTPS = require("https");
let CommandHelper = require('./CommandHelper');

const HELP_MESSAGE = `
**LISTEN.moe streaming bot by Geo1088 & friends**

**Usage:**
    After adding me to your server, join a voice channel and type \`\\~~join\` to bind me to that channel. Keep in mind that you need to have the \`Manage server\` permission to use this command.

**Commands:**
    **\\~~join**: Joins current Voice Channel
    **\\~~np**: Displays the Currently Playing song

For additional commands and help, please visit: <https://github.com/Geo1088/listen.moe-streaming-bot>`;

let client = new Discord.Client();
let commandHelper = new CommandHelper(config.guildDefaults.prefix);

let listeners = 0;

//Setup input stream
let stream;
HTTPS.get(config.stream, (res) => stream = res).once("error", (e) => {
	console.log("HTTPS stream died :O");
	process.exit(1);
});

//Setup stream info socket
let radioJSON = {};
let socket = io.connect(config.streamInfo);
socket.on('update', (obj) => {
    try {
        radioJSON = JSON.parse(obj);
    } catch (e) {
        console.log(e)
    }
});

function writeGuildConfig(guild, object) { // Change a guild's config via an object of options, and save the changes
    var currentConfig = guilds[guild] || {}; // Get gurrent config for this guild, creating it if it doesn't exist
    var newConfig = merge(currentConfig, object); // Merge new options with current
    var _guilds = guilds;
    _guilds[guild] = newConfig; // Write this new config back to the config
    if (!fs.existsSync('./backups'))
        fs.mkdirSync('./backups');
    fs.writeFile(`backups/guilds-${Date.now()}.json`, JSON.stringify(guilds, null, '\t')); // Create a backup before doing anything
    fs.writeFile('guilds.json', JSON.stringify(_guilds, null, '\t'), 'utf-8', err => { // Store the new stuff in the file
        if (err)
            console.log(err);
        else
            guilds = reload('./guilds.json'); // Reload the file
    });
}

//Use this if you are joining multiple voice channels at once. If you join them manually, all the channels after the 10th one or so will just timeout.
function joinVoices(connectList, i) {
    if (i >= connectList.length)
        return;

    let guild = connectList[i].guild;
    let channel = connectList[i].channel;
    let cc = client.voiceConnections.get(guild); // Find a current connection in this guild
    if (cc) {
        console.log("Boop");
    } else { // Looks like we'll need to make a new one
        // Create a new voice connection and join the channel
        let guildObj = client.guilds.get(guild);
        if (guildObj) {
            let voiceChannel = guildObj.channels.get(channel);
            if (!voiceChannel) {
                joinVoices(connectList, i + 1);
                return;
            }
            voiceChannel.join({ shared: true }).then(vc => {
                if (vc) {
                    vc.setSpeaking(true);
                    vc.playSharedStream("listen.moe", stream);
                    let realGuild = client.guilds.get(guild);
                    console.log(`Added voice connection for guild ${realGuild.name} (${realGuild.id})`);
                }
                joinVoices(connectList, i + 1);
            }).catch(error => {
                console.log('Error connecting to channel ' + channel + ' | ' + error);
                joinVoices(connectList, i + 1);
            });
        } else {
            joinVoices(connectList, i + 1);
        }
    }

    // wew that was a lot of comments
}

function joinVoice(guild, channel) {
    joinVoices([{ guild: guild, channel: channel }], 0);
}

function getGuildConfig (guild, option) { // Get a config option from a guild
    let defaults = config.guildDefaults // Grab the defaults, just in case
    if (!guilds[guild] || !guilds[guild][option]) return defaults[option] // logic whee
    return guilds[guild][option]
}

//Commands and stuff
function canManageGuild(member) {
    return member.permissions.hasPermission("MANAGE_GUILD");
}

function splitMessage(message, messageLengthCap) {
    let strs = [];
    while (message.length > messageLengthCap) {
        let pos = message.substring(0, messageLengthCap).lastIndexOf('\n');
        pos = pos <= 0 ? messageLengthCap : pos;
        strs.push(message.substring(0, pos));
        let i = message.indexOf('\n', pos) + 1;
        if (i < pos || i > pos + messageLengthCap) i = pos;
        message = message.substring(i);
    }
    strs.push(message);

    return strs;
}

function commandEval(msg, argument) {
    // Eval command - Allows the owner to dynamically run scripts against the bot from inside Discord
    // Requires explicit owner permission inside the config file
    if (!config.owners.includes(msg.author.id))
        return msg.channel.sendMessage('soz bae must be bot owner');
    let result;
    try {
        console.log(argument);
        result = eval(argument); // eval is harmful my ass
    } catch (e) {
        result = e;
    }
    let strs = splitMessage('' + result, 2000);
    for (let str of strs)
        msg.channel.sendMessage(str);
}

function commandNowPlaying(msg, argument) {
    if (getGuildConfig(msg.guild.id, "denied").includes(msg.channel.id))
        return;

    if (radioJSON === {})
        return;

    let requestedBy = radioJSON.requested_by ? `\n**Requested by:** ${radioJSON.requested_by}` : '';
    let anime = radioJSON.anime_name ? `\n**Anime:** ${radioJSON.anime_name}` : '';
    msg.channel.sendMessage(`**Now playing:** "${radioJSON.song_name}" by ${radioJSON.artist_name}${anime}${requestedBy}`);
}

function commandHelp(msg, argument) {
    msg.channel.sendMessage(HELP_MESSAGE);
}

function commandJoin(msg, argument) {
    if (!canManageGuild(msg.member))
        return;
    let channel = msg.member.voiceChannelID;
    let guild = msg.guild.id;
    if (!guild || !channel)
        msg.channel.sendMessage("Join a voice channel first!");
    else {
        writeGuildConfig(guild, { vc: channel });
        joinVoice(guild, channel);
        msg.channel.sendMessage("\\o/");
    }
}

commandHelper.register("eval", commandEval);
commandHelper.register("np", commandNowPlaying);
commandHelper.register("help", commandHelp);
commandHelper.register("join", commandJoin);

//Now for the main stuff...

client.on("message", msg => {
    commandHelper.process(msg);
})

function currentListeners() {
    let userCount = 0;
    //Iterate through all our voice connections' channels and count the number of other users
    client.voiceConnections
        .map(vc => vc.channel)
        .forEach(c => userCount += c.members.filter(m => !m.selfDeaf && !m.deaf).size - 1);
    
    listeners = userCount;
    setTimeout(currentListeners, 20000);
}

function sendListenersData() {
    request.post(config.listenersReportURL, { 'number': listeners }, (err, res, body) => {
        if (err)
            console.log('Etooo, crap. Couldnt update listeners. Reason: ' + err)
    })

    setTimeout(sendListenersData, 60000)
}

client.once('ready', () => {
    console.log(`Connected as ${client.user.username} / Currently in ${client.guilds.size} servers`)

    // Rejoin channels that we were connected to
    let connectList = [];
    for (let guild of Object.keys(guilds)) { // loop through all the servers recorded
        let channel = getGuildConfig(guild, 'vc') // Get the channel for this guild
        if (channel)
            connectList.push({ guild: guild, channel: channel });
    }
    joinVoices(connectList, 0);

    //Initialise timer loops
    currentListeners();

    if (config.listenersReportURL)
        sendListenersData();
})

client.login(config.token)
