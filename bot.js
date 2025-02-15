const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus } = require('@discordjs/voice');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const icy = require('icy');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const TOKEN = 'Bot_token_here!'; // Bot token 
const logFilePath = path.join('./', 'logs.txt');
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// Server-specific state
const serverState = new Map();

client.once('ready', () => {
    const readyMessage = `Logged in as ${client.user.tag}`;
    console.log(readyMessage);
    logStream.write(readyMessage + '\n');
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const trimmedContent = message.content.trim();

    if (trimmedContent.startsWith('!')) {
        const receivedCommandMessage = `Received command: "${trimmedContent}" from ${message.author.tag}`;
        console.log(receivedCommandMessage);
        logStream.write(receivedCommandMessage + '\n');
    }

    const serverId = message.guild.id;
    if (!serverState.has(serverId)) {
        serverState.set(serverId, {
            currentSong: '',
            songChannel: null,
            currentStreamUrl: null,
            metadataInterval: null,
            icyRequest: null,
            axiosStream: null
        });
    }
    const state = serverState.get(serverId);

    if (trimmedContent.startsWith('!play')) {
        state.songChannel = message.channel;
        const args = trimmedContent.split(' ');
        if (args.length !== 2) {
            message.reply('☠️ Please provide a valid Shoutcast v2 stream link Example: `!play [shoutcast v2 stream link]`');
            return;
        }
        const streamUrl = args[1];

        if (!isValidUrl(streamUrl)) {
            message.reply('☠️ The provided link is not a valid URL. Please provide a valid Shoutcast stream link.');
            return;
        }

        state.currentStreamUrl = streamUrl;
        playStream(message, streamUrl, state);
    } else if (trimmedContent === '!leave') {
        disconnectFromVoice(message.guild.id);
        message.reply('👋 Seeya Later, Gator!');
    } else if (trimmedContent === '!song') {
        if (state.currentStreamUrl) {
            state.songChannel = message.channel;
            fetchMetadata(state.currentStreamUrl, true, state);
        } else {
            message.reply('No stream is currently playing. 🥱');
        }
    } else if (trimmedContent === '!refresh') {
        if (state.currentStreamUrl) {
            if (state.axiosStream) {
                state.axiosStream.destroy();
                state.axiosStream = null;
            }
            message.reply('🐉 Stream refreshed. Boss!');
            playStream(message, state.currentStreamUrl, state);
        } else {
            message.reply('🥱 No stream is currently playing.');
        }
    }
});

function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

async function playStream(message, streamUrl, state, isRetry = false) {
    try {
        logStream.write(`Attempting to play stream: ${streamUrl}, Retry: ${isRetry}\n`);

        const response = await axios.get(streamUrl, { responseType: 'stream' });
        state.axiosStream = response.data; // Track the Axios stream for cleanup

        if (response.headers['icy-br']) {
            if (message.member.voice.channel) {
                if (state.metadataInterval) {
                    clearInterval(state.metadataInterval);
                    state.metadataInterval = null;
                }
                if (state.icyRequest) {
                    state.icyRequest.abort();
                    state.icyRequest = null;
                }

                const connection = joinVoiceChannel({
                    channelId: message.member.voice.channel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });

                const audioPlayer = createAudioPlayer();
                connection.subscribe(audioPlayer);
                const audioResource = createAudioResource(response.data);
                audioPlayer.play(audioResource);

                audioPlayer.on('error', error => {
                    console.error(`Error: ${error.message}`);
                    logStream.write(`Error: ${error.message}\n`);
                    cleanupState(state);
                });

                audioPlayer.on(AudioPlayerStatus.Idle, () => {
                    const idleMessage = 'Stream is idle. Disconnecting...';
                    console.log(idleMessage);
                    logStream.write(idleMessage + '\n');

                    if (state.songChannel) {
                        const disconnectEmbed = new EmbedBuilder()
                            .setColor('#ff0000')
                            .setTitle('Peace! 💤')
                            .setDescription('Stream ended, So I went to sleep! 🪫')
                            .setTimestamp();
                        state.songChannel.send({ embeds: [disconnectEmbed] });
                        logStream.write('Embed Push!: Disconnected due to stream inactivity.\n');
                    }

                    cleanupState(state);
                    disconnectFromVoice(message.guild.id);
                });

                state.currentStreamUrl = streamUrl;
                message.reply('Playing toonz! 🐇');

                monitorStream(streamUrl, state);
            } else {
                message.reply('📣 You need to join a voice channel first!');
            }
        } else {
            message.reply('❌ The provided link is not a valid Shoutcast stream.');
        }
    } catch (error) {
        cleanupState(state);
        if (isRetry) {
            message.reply('Error fetching audio stream. Please check the URL or try again later.');
            logStream.write(`Error fetching stream: ${error.message}\n`);
        } else if (streamUrl.startsWith('https://')) {
            const fallbackUrl = streamUrl.replace('https://', 'http://');
            playStream(message, fallbackUrl, state, true);
        }
    }
}

function monitorStream(streamUrl, state) {
    if (state.metadataInterval) {
        clearInterval(state.metadataInterval);
        state.metadataInterval = null;
    }
    if (state.icyRequest) {
        state.icyRequest.abort();
        state.icyRequest = null;
    }

    fetchMetadata(streamUrl, false, state);
    state.metadataInterval = setInterval(() => fetchMetadata(streamUrl, false, state), 15000);
}

function fetchMetadata(streamUrl, sendUpdate, state) {
    if (streamUrl !== state.currentStreamUrl) {
        return;
    }

    try {
        if (state.icyRequest) {
            state.icyRequest.abort();
            state.icyRequest = null;
        }

        state.icyRequest = icy.get(streamUrl, response => {
            response.on('metadata', metadata => {
                const parsed = icy.parse(metadata);
                const songTitle = parsed.StreamTitle || 'Unknown Title';

                if (songTitle !== state.currentSong || sendUpdate) {
                    state.currentSong = songTitle;

                    if (state.songChannel) {
                        const songEmbed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setTitle('Now Playing')
                            .setDescription(`🎶 ${state.currentSong} 🎶 `)
                            .setFooter({ text: `Source: ${state.currentStreamUrl}` })
                            .setTimestamp();
                        state.songChannel.send({ embeds: [songEmbed] });
                        logStream.write(`Song updated: ${state.currentSong}\n`);
                    }
                }
            });

            response.on('end', () => {
                if (!response.destroyed) {
                    response.destroy(); // Explicitly close the connection
                }
                logStream.write('Metadata fetch connection closed.\n');
            });

            response.on('error', error => {
                console.error('Error fetching metadata:', error.message);
                logStream.write(`Error fetching metadata: ${error.message}\n`);
                if (!response.destroyed) {
                    response.destroy(); // Close connection on error
                }
            });
        });
    } catch (error) {
        console.error('Error fetching metadata:', error.message);
        logStream.write(`Error fetching metadata: ${error.message}\n`);
    }
}

function disconnectFromVoice(serverId) {
    console.log(`Disconnecting from voice in server: ${serverId}`);
    logStream.write(`Disconnecting from voice in server: ${serverId}\n`);

    const connection = getVoiceConnection(serverId);
    if (connection) {
        connection.destroy();
        console.log(`Voice connection destroyed for server: ${serverId}`);
        logStream.write(`Voice connection destroyed for server: ${serverId}\n`);
    } else {
        console.log(`No active voice connection found for server: ${serverId}`);
    }

    const state = serverState.get(serverId);
    if (state) {
        cleanupState(state);
    }
}

function cleanupState(state) {
    if (state.metadataInterval) {
        clearInterval(state.metadataInterval);
        state.metadataInterval = null;
        logStream.write('Metadata interval cleared.\n');
    }
    if (state.icyRequest) {
        state.icyRequest.abort();
        state.icyRequest = null;
        logStream.write('ICY request aborted.\n');
    }
    if (state.axiosStream) {
        state.axiosStream.destroy();
        state.axiosStream = null;
        logStream.write('Axios stream destroyed.\n');
    }
    state.currentStreamUrl = null;
    state.currentSong = '';
    logStream.write('State cleaned up.\n');
}

client.login(TOKEN);
