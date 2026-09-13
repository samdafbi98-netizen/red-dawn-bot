const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const API_BASE = 'https://api.nitrado.net';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const START_TIME = Date.now();
const CACHE = new Map();
const FEED_BUFFER = [];
const PLAYER_STATS = new Map();
let feedTimer = null;
let botReady = false;

function loadConfig() {
  const defaults = { guildId: process.env.DISCORD_GUILD_ID || '', adminRoleIds: [], modRoleIds: [], statusChannelId: '', logChannelId: '', announceChannelId: '', generalChannelId: '', maintenance: false, feedChannels: {}, feedFiles: [], feedsEnabled: false, watchlistIds: [], notes: {}, reports: [], tickets: {}, warnings: {}, events: [], suggestions: [] };
  if (!fs.existsSync(CONFIG_PATH)) return defaults;
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch (e) { console.error('config.json error:', e.message); return defaults; }
}
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
const config = loadConfig();

if (!process.env.DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN in .env'); process.exit(1); }

function mk(name, desc) { return new SlashCommandBuilder().setName(name).setDescription(desc); }
const commandDefinitions = [
  new SlashCommandBuilder().setName('help').setDescription('Show the Red Dawn command center'),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot and API latency'),
  new SlashCommandBuilder().setName('uptime').setDescription('Show bot uptime'),
  new SlashCommandBuilder().setName('about').setDescription('Show Red Dawn Bot info'),
  new SlashCommandBuilder().setName('status').setDescription('Show live DayZ server status'),
  new SlashCommandBuilder().setName('server').setDescription('Open the live server dashboard'),
  new SlashCommandBuilder().setName('players').setDescription('List online players'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show detailed server information'),
  new SlashCommandBuilder().setName('nitrado').setDescription('Test Nitrado authentication'),
  new SlashCommandBuilder().setName('services').setDescription('List your Nitrado services'),
  new SlashCommandBuilder().setName('ip').setDescription('Show the configured server address'),
  new SlashCommandBuilder().setName('map').setDescription('Show the current map'),
  new SlashCommandBuilder().setName('slots').setDescription('Show player slots'),
  new SlashCommandBuilder().setName('online').setDescription('Show online count'),
  new SlashCommandBuilder().setName('refresh').setDescription('Refresh Nitrado server cache'),
  new SlashCommandBuilder().setName('restart').setDescription('Restart the DayZ server').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the DayZ server').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('maintenance').setDescription('Toggle maintenance mode').addStringOption(o=>o.setName('mode').setDescription('Maintenance mode').setRequired(true).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('announce').setDescription('Send a server announcement').addStringOption(o=>o.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName('say').setDescription('Send a server broadcast').addStringOption(o=>o.setName('message').setDescription('Message to broadcast').setRequired(true).setMaxLength(160)),
  new SlashCommandBuilder().setName('setchannel').setDescription('Set a bot channel').addStringOption(o=>o.setName('type').setDescription('Channel type').setRequired(true).addChoices({name:'Status',value:'statusChannelId'},{name:'Logs',value:'logChannelId'},{name:'Announcements',value:'announceChannelId'},{name:'General',value:'generalChannelId'})).addChannelOption(o=>o.setName('channel').setDescription('Discord channel').setRequired(true)),
  new SlashCommandBuilder().setName('setadminrole').setDescription('Add/remove an admin role').addRoleOption(o=>o.setName('role').setDescription('Role to toggle').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setmodrole').setDescription('Add/remove a moderator role').addRoleOption(o=>o.setName('role').setDescription('Role to toggle').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('config').setDescription('Show bot configuration').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('permissions').setDescription('Show your bot permissions').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('staff').setDescription('Show configured staff roles').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('botstats').setDescription('Show bot performance stats'),
  new SlashCommandBuilder().setName('cache').setDescription('Show API cache stats'),
  new SlashCommandBuilder().setName('health').setDescription('Run a bot health check'),
  new SlashCommandBuilder().setName('latency').setDescription('Show Discord/Nitrado latency'),
  new SlashCommandBuilder().setName('logs').setDescription('Show configured feed files'),
  new SlashCommandBuilder().setName('findlogs').setDescription('Search Nitrado for log files'),
  new SlashCommandBuilder().setName('feedstatus').setDescription('Show feed engine status'),
  new SlashCommandBuilder().setName('feedsetup').setDescription('Show feed setup instructions'),
  new SlashCommandBuilder().setName('feedstart').setDescription('Start automatic feeds').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('feedstop').setDescription('Stop automatic feeds').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('feedtest').setDescription('Test the configured feeds').addStringOption(o=>o.setName('type').setDescription('Feed type').setRequired(false).addChoices({name:'Kill',value:'kill'},{name:'PvP',value:'pvp'},{name:'Hit',value:'hit'},{name:'Build',value:'build'},{name:'Placement',value:'placement'},{name:'Join',value:'join'},{name:'Leave',value:'leave'})),
  new SlashCommandBuilder().setName('feedfile').setDescription('Add/remove a Nitrado log file').addStringOption(o=>o.setName('path').setDescription('Remote Nitrado file path').setRequired(true).setMaxLength(250)).addBooleanOption(o=>o.setName('remove').setDescription('Remove this path instead').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setkillfeed').setDescription('Set kill-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setpvpfeed').setDescription('Set PvP-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('sethitfeed').setDescription('Set hit-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setbuildfeed').setDescription('Set build-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setbasefeed').setDescription('Set base-building feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setconnectfeed').setDescription('Set connect-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setdeathfeed').setDescription('Set death-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setplacementfeed').setDescription('Set placement-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setchatfeed').setDescription('Set Discord chat-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('seteventfeed').setDescription('Set event-feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('setadminlogfeed').setDescription('Set admin-log feed channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('clearfeeds').setDescription('Clear feed channels').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('lastkills').setDescription('Show recent detected kills'),
  new SlashCommandBuilder().setName('lastpvp').setDescription('Show recent PvP events'),
  new SlashCommandBuilder().setName('lasthits').setDescription('Show recent hit events'),
  new SlashCommandBuilder().setName('lastbuilds').setDescription('Show recent build events'),
  new SlashCommandBuilder().setName('lastjoins').setDescription('Show recent joins'),
  new SlashCommandBuilder().setName('lastleaves').setDescription('Show recent leaves'),
  new SlashCommandBuilder().setName('lastplacements').setDescription('Show recent placements'),
  new SlashCommandBuilder().setName('lastdeaths').setDescription('Show recent deaths'),
  new SlashCommandBuilder().setName('stats').setDescription('Show stored player stats'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show top players by stored kills'),
  new SlashCommandBuilder().setName('topkills').setDescription('Show top killers'),
  new SlashCommandBuilder().setName('topdeaths').setDescription('Show players with most deaths'),
  new SlashCommandBuilder().setName('kd').setDescription('Show a player K/D snapshot').addStringOption(o=>o.setName('player').setDescription('Player name').setRequired(true)),
  new SlashCommandBuilder().setName('pingplayer').setDescription('Show a stored player latency').addStringOption(o=>o.setName('player').setDescription('Player name').setRequired(true)),
  new SlashCommandBuilder().setName('lookup').setDescription('Look up a stored player').addStringOption(o=>o.setName('player').setDescription('Player name').setRequired(true)),
  new SlashCommandBuilder().setName('watchlistadd').setDescription('Add a player to the watchlist').addStringOption(o=>o.setName('player').setDescription('Player name or Xbox gamertag').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('watchlistremove').setDescription('Remove a player from the watchlist').addStringOption(o=>o.setName('player').setDescription('Player name or Xbox gamertag').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('watchlist').setDescription('Show watched players'),
  new SlashCommandBuilder().setName('noteset').setDescription('Set a staff note on a player').addStringOption(o=>o.setName('player').setDescription('Player name').setRequired(true)).addStringOption(o=>o.setName('note').setDescription('Staff note').setRequired(true).setMaxLength(1000)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('note').setDescription('Show a staff note').addStringOption(o=>o.setName('player').setDescription('Player name').setRequired(true)),
  new SlashCommandBuilder().setName('noteremove').setDescription('Remove a staff note').addStringOption(o=>o.setName('player').setDescription('Player name').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('report').setDescription('Report a player or issue').addStringOption(o=>o.setName('subject').setDescription('Player or issue').setRequired(true)).addStringOption(o=>o.setName('details').setDescription('What happened').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('reports').setDescription('List open reports').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('reportclose').setDescription('Close a report').addIntegerOption(o=>o.setName('id').setDescription('Report ID').setRequired(true).setMinValue(1)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('ticket').setDescription('Create a staff ticket').addStringOption(o=>o.setName('reason').setDescription('Reason for contacting staff').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('suggest').setDescription('Submit a server suggestion').addStringOption(o=>o.setName('idea').setDescription('Suggestion').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('vote').setDescription('Start a Discord vote').addStringOption(o=>o.setName('question').setDescription('Question').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName('event').setDescription('Create a server event').addStringOption(o=>o.setName('name').setDescription('Event name').setRequired(true)).addStringOption(o=>o.setName('details').setDescription('Event details').setRequired(true).setMaxLength(1000)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('eventlist').setDescription('List active events'),
  new SlashCommandBuilder().setName('eventend').setDescription('End a server event').addStringOption(o=>o.setName('name').setDescription('Event name').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('giveaway').setDescription('Create a simple giveaway').addStringOption(o=>o.setName('prize').setDescription('Prize').setRequired(true)).addIntegerOption(o=>o.setName('minutes').setDescription('Length in minutes').setRequired(true).setMinValue(1).setMaxValue(10080)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('verify').setDescription('Show verification instructions'),
  new SlashCommandBuilder().setName('rules').setDescription('Show Red Dawn rules'),
  new SlashCommandBuilder().setName('links').setDescription('Show configured Red Dawn links'),
  new SlashCommandBuilder().setName('faq').setDescription('Show common Red Dawn answers'),
  new SlashCommandBuilder().setName('poll').setDescription('Create a quick poll').addStringOption(o=>o.setName('question').setDescription('Poll question').setRequired(true)).addStringOption(o=>o.setName('option1').setDescription('Option 1').setRequired(true)).addStringOption(o=>o.setName('option2').setDescription('Option 2').setRequired(true)).addStringOption(o=>o.setName('option3').setDescription('Optional option 3').setRequired(false)),
  new SlashCommandBuilder().setName('clear').setDescription('Delete recent Discord messages').addIntegerOption(o=>o.setName('amount').setDescription('Messages to delete').setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('slowmode').setDescription('Set channel slowmode').addIntegerOption(o=>o.setName('seconds').setDescription('Slowmode seconds').setRequired(true).setMinValue(0).setMaxValue(21600)).setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('purge').setDescription('Bulk delete recent messages').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName('timeout').setDescription('Timeout a Discord member').addUserOption(o=>o.setName('user').setDescription('Member to timeout').setRequired(true)).addIntegerOption(o=>o.setName('minutes').setDescription('Minutes').setRequired(true).setMinValue(1).setMaxValue(40320)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a Discord member').addUserOption(o=>o.setName('user').setDescription('Member to warn').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('warnings').setDescription('Show Discord warnings').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('unwarn').setDescription('Remove a Discord warning').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addIntegerOption(o=>o.setName('id').setDescription('Warning ID').setRequired(true).setMinValue(1)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a Discord member').addUserOption(o=>o.setName('user').setDescription('Member to kick').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a Discord member').addUserOption(o=>o.setName('user').setDescription('Member to ban').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('unban').setDescription('Unban a Discord member').addStringOption(o=>o.setName('user_id').setDescription('User ID').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('audit').setDescription('Show recent Red Dawn bot actions').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('feedlist').setDescription('Show configured feed channels'),
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

function eph(text, extra={}) { return { content: text, flags: MessageFlags.Ephemeral, ...extra }; }
function formatDuration(ms) { const s=Math.floor(ms/1000), d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), sec=s%60; return `${d}d ${h}h ${m}m ${sec}s`; }
function humanStatus(status) { const v=String(status||'unknown').toLowerCase(); if(v.includes('started')||v.includes('online'))return '🟢 Online'; if(v.includes('restarting')||v.includes('starting'))return '🟡 Starting'; if(v.includes('stopped')||v.includes('offline'))return '🔴 Offline'; return `⚪ ${status||'Unknown'}`; }
function getServiceId(){ const id=process.env.NITRADO_SERVICE_ID; if(!id) throw new Error('NITRADO_SERVICE_ID is missing from .env'); return id; }
function adminLike(i){ return i.memberPermissions?.has(PermissionFlagsBits.Administrator) || (config.adminRoleIds||[]).some(id=>i.member?.roles?.cache?.has(id)); }
function modLike(i){ return adminLike(i) || i.memberPermissions?.has(PermissionFlagsBits.ManageMessages) || (config.modRoleIds||[]).some(id=>i.member?.roles?.cache?.has(id)); }
function needAdmin(i){ if(!adminLike(i)){ return i.reply(eph('⛔ Administrator/staff permission required.')).then(()=>false); } return true; }
function needMod(i){ if(!modLike(i)){ return i.reply(eph('⛔ Moderator permission required.')).then(()=>false); } return true; }
function safe(s){ return String(s||'').replace(/[`*_~|]/g,'').slice(0,300); }

async function nitradoRequest(endpoint, options={}, cacheMs=0){
  if(!process.env.NITRADO_TOKEN) throw new Error('NITRADO_TOKEN is missing from .env');
  const method=options.method||'GET'; const key=`${method} ${endpoint}`;
  if(method==='GET' && cacheMs){ const hit=CACHE.get(key); if(hit && Date.now()-hit.time<cacheMs)return hit.data; }
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const r=await fetch(API_BASE+endpoint,{...options,headers:{Authorization:`Bearer ${process.env.NITRADO_TOKEN}`,Accept:'application/json',...(options.headers||{})},signal:controller.signal});
    const text=await r.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{data={raw:text};}
    if(!r.ok) throw new Error(`Nitrado API ${r.status}: ${data.message||'Request failed'}`);
    if(method==='GET'&&cacheMs) CACHE.set(key,{time:Date.now(),data});
    return data;
  }catch(e){ if(e.name==='AbortError')throw new Error('Nitrado request timed out after 10 seconds.'); throw e; } finally{ clearTimeout(timeout); }
}
async function getGameServer(){ return nitradoRequest(`/services/${getServiceId()}/gameservers`,{},5000); }
async function getPlayers(){ return nitradoRequest(`/services/${getServiceId()}/gameservers/games/players`,{},3000); }
async function getServices(){ return nitradoRequest('/services',{},15000); }
async function performAction(action){ return nitradoRequest(`/services/${getServiceId()}/gameservers/${action}`,{method:'POST'}); }
async function fileList(dir='', search=''){ const q=new URLSearchParams(); if(dir)q.set('dir',dir); if(search)q.set('search',search); const data=await nitradoRequest(`/services/${getServiceId()}/gameservers/file_server/list?${q.toString()}`,{},15000); return data.data?.entries||[]; }
async function fileDownload(pathname){ const data=await nitradoRequest(`/services/${getServiceId()}/gameservers/file_server/download?file=${encodeURIComponent(pathname)}`,{},0); const token=data.data?.token; if(!token?.url)throw new Error('Nitrado did not return a file download token.'); const r=await fetch(token.url.includes('?')?token.url:`${token.url}?token=${encodeURIComponent(token.token)}`,{headers:{Authorization:`Bearer ${process.env.NITRADO_TOKEN}`}}); if(!r.ok)throw new Error(`Log download failed (${r.status}).`); return await r.text(); }
async function tailRemoteFile(pathname, maxBytes=50000){ const qs=new URLSearchParams({file:pathname,offset:String(-maxBytes),length:String(maxBytes),mode:'raw'}); const data=await nitradoRequest(`/services/${getServiceId()}/gameservers/file_server/seek?${qs.toString()}`,{},0); const token=data.data?.token; if(!token?.url)throw new Error('No seek token for log file.'); const sep=token.url.includes('?')?'&':'?'; const r=await fetch(`${token.url}${sep}token=${encodeURIComponent(token.token)}`,{headers:{Authorization:`Bearer ${process.env.NITRADO_TOKEN}`}}); if(!r.ok) throw new Error(`Log tail failed (${r.status}).`); return await r.text(); }

function addEvent(evt){ FEED_BUFFER.unshift({...evt,time:Date.now()}); while(FEED_BUFFER.length>500)FEED_BUFFER.pop();
  if(evt.attacker){ const s=PLAYER_STATS.get(evt.attacker)||{kills:0,deaths:0,hits:0}; if(evt.type==='hit') s.hits++; else if(evt.type==='kill') s.kills++; PLAYER_STATS.set(evt.attacker,s); }
  if(evt.victim){ const s=PLAYER_STATS.get(evt.victim)||{kills:0,deaths:0,hits:0}; s.deaths++; PLAYER_STATS.set(evt.victim,s); }
  if(evt.attacker&&evt.victim){ const s=PLAYER_STATS.get(evt.attacker)||{kills:0,deaths:0,hits:0}; s.kills=(s.kills||0); PLAYER_STATS.set(evt.attacker,s); }
}
function detectLine(line, file){
  const l=line.trim(); if(!l)return null; let m;
  m=l.match(/Player\s+"([^"]+)".*?has been killed/i)||l.match(/"([^"]+)".*?died/i)||l.match(/Player\s+([^:]+?)\s+(?:died|was killed)/i);
  if(m)return {type:'death',victim:safe(m[1]),text:l,file};
  m=l.match(/"([^"]+)".*?killed.*?"([^"]+)"/i)||l.match(/(?:Player )?([^:]+?) killed (?:Player )?([^:]+)$/i);
  if(m)return {type:'kill',attacker:safe(m[1]),victim:safe(m[2]),text:l,file};
  m=l.match(/"([^"]+)".*?(?:hit|damage).*?"([^"]+)"/i)||l.match(/([^:]+?) hit ([^:]+)$/i);
  if(m)return {type:'hit',attacker:safe(m[1]),victim:safe(m[2]),text:l,file};
  if(/(?:built|dismantled|destroyed|placed|construction|basebuilding)/i.test(l))return {type:/placed/i.test(l)?'placement':'build',text:l,file};
  m=l.match(/(?:connected|joined).*?"?([^"]+)"?$/i); if(m)return {type:'join',player:safe(m[1]),text:l,file};
  m=l.match(/(?:disconnected|left).*?"?([^"]+)"?$/i); if(m)return {type:'leave',player:safe(m[1]),text:l,file};
  return null;
}

async function sendFeed(evt){
  const channelId=config.feedChannels?.[evt.type] || (evt.type==='death'?config.feedChannels.kill:null) || (evt.type==='hit'?config.feedChannels.pvp:null) || (evt.type==='build'?config.feedChannels.base:null);
  if(!channelId)return;
  try{
    const ch=await client.channels.fetch(channelId); if(!ch?.isTextBased())return;
    const titles={kill:'☠️ KILL FEED',death:'💀 DEATH FEED',hit:'🎯 PVP / HIT FEED',build:'🔨 BUILD FEED',placement:'📦 PLACEMENT FEED',join:'🟢 PLAYER JOIN',leave:'🔴 PLAYER LEAVE'};
    const embed=new EmbedBuilder().setTitle(titles[evt.type]||'📡 RED DAWN FEED').setTimestamp();
    if(evt.attacker)embed.addFields({name:'Attacker',value:`**${safe(evt.attacker)}**`,inline:true});
    if(evt.victim)embed.addFields({name:'Victim',value:`**${safe(evt.victim)}**`,inline:true});
    if(evt.player)embed.addFields({name:'Player',value:`**${safe(evt.player)}**`,inline:true});
    if(evt.text)embed.setDescription(`\`\`\`\n${safe(evt.text).slice(0,850)}\n\`\`\``);
    await ch.send({embeds:[embed]});
  }catch(e){ console.error('feed send:',e.message); }
}
async function pollFeeds(){
  if(!config.feedsEnabled || !config.feedFiles?.length || !process.env.NITRADO_TOKEN) return;
  for(const file of config.feedFiles){
    try{
      const text=await tailRemoteFile(file,40000); const lines=text.split(/\r?\n/).slice(-500);
      const signature=file+'::'+lines.join('\n'); const prev=CACHE.get('feed-sig:'+file)?.data;
      if(prev===signature)continue; CACHE.set('feed-sig:'+file,{time:Date.now(),data:signature});
      for(const line of lines.slice(-80)){
        const evt=detectLine(line,file); if(!evt)continue;
        const lastSig=`event::${file}::${line}`; if(CACHE.has(lastSig))continue; CACHE.set(lastSig,{time:Date.now(),data:true});
        addEvent(evt); if(config.feedsEnabled) await sendFeed(evt);
      }
    }catch(e){ console.error(`feed poll ${file}:`,e.message); }
  }
}
function startFeeds(){ if(feedTimer||!config.feedsEnabled)return; feedTimer=setInterval(pollFeeds,Number(process.env.FEED_POLL_MS||10000)); pollFeeds().catch(()=>{}); }
function stopFeeds(){ if(feedTimer){clearInterval(feedTimer);feedTimer=null;} }

async function registerCommands(){ const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN); const guild=config.guildId||process.env.DISCORD_GUILD_ID; if(!guild)throw new Error('Missing DISCORD_GUILD_ID.'); await rest.put(Routes.applicationGuildCommands(client.user.id,guild),{body:commandDefinitions}); }
function helpEmbed(){ return new EmbedBuilder().setTitle('🌅 RED DAWN BOT — COMMAND CENTER').setDescription('100 commands • fast server tools • staff tools • log-based feeds').addFields(
{name:'🎮 Server',value:'/status /server /players /serverinfo /nitrado /restart /stop /maintenance /announce /say'},
{name:'📡 Feeds',value:'/findlogs /feedfile /feedstart /feedstop /feedtest /setkillfeed /setpvpfeed /sethitfeed /setbuildfeed /setbasefeed /setconnectfeed /setdeathfeed /setplacementfeed'},
{name:'📊 Stats',value:'/stats /leaderboard /topkills /topdeaths /kd /lookup /watchlist'},
{name:'🛡️ Staff',value:'/warn /warnings /unwarn /kick /ban /unban /timeout /audit /reports /reportclose'},
{name:'💬 Community',value:'/ticket /suggest /vote /event /eventlist /eventend /giveaway /poll /rules /links /faq'},
{name:'⚙️ Bot',value:'/config /permissions /staff /botstats /cache /health /latency /logs /feedstatus /feedsetup /help'}); }

client.once('clientReady', async()=>{ botReady=true; console.log(`${client.user.tag} is online!`); try{await registerCommands();console.log(`Registered ${commandDefinitions.length} slash commands.`);}catch(e){console.error('Command registration error:',e);} client.user.setPresence({activities:[{name:'Red Dawn DayZ',type:ActivityType.Watching}],status:'online'}); if(config.feedsEnabled)startFeeds(); });

client.on('interactionCreate', async i=>{
  if(!i.isChatInputCommand())return;
  try{
    const c=i.commandName;
    if(c==='help')return i.reply({embeds:[helpEmbed()]});
    if(c==='ping'){const t=Date.now()-i.createdTimestamp;return i.reply(`🏓 **Pong!** ${t}ms • Gateway ${Math.round(client.ws.ping)}ms`);}
    if(c==='uptime')return i.reply(`⏱️ Uptime: **${formatDuration(Date.now()-START_TIME)}**`);
    if(c==='about')return i.reply({embeds:[new EmbedBuilder().setTitle('🌅 Red Dawn Bot').setDescription('Fast Discord + Nitrado tools for Red Dawn DayZ.').addFields({name:'Commands',value:String(commandDefinitions.length),inline:true},{name:'Node',value:process.version,inline:true},{name:'Feeds',value:config.feedsEnabled?'Enabled':'Disabled',inline:true})]});
    if(c==='status'||c==='server'){await i.deferReply();const [sd,pd]=await Promise.all([getGameServer(),getPlayers()]);const s=sd.data?.gameserver;const p=pd.data?.players||[];if(!s)throw new Error('No gameserver data.');const q=s.query||{};const e=new EmbedBuilder().setTitle(`🌅 ${q.server_name||s.settings?.config?.hostname||process.env.RED_DAWN_NAME||'Red Dawn'}`).setDescription('Live Red Dawn DayZ dashboard').addFields({name:'Status',value:humanStatus(s.status),inline:true},{name:'Players',value:`${q.player_current??p.length}/${q.player_max??s.slots??'?'}`,inline:true},{name:'Map',value:String(q.map||s.settings?.config?.mission||'DayZ'),inline:true},{name:'IP',value:String(s.connect_ip||s.ip||'Hidden'),inline:true},{name:'Port',value:String(s.port||'Unknown'),inline:true}).setTimestamp();return i.editReply({embeds:[e]});}
    if(c==='players'||c==='online'){await i.deferReply();const d=await getPlayers();const p=d.data?.players||[];return i.editReply(p.length?`👥 **${p.length} online**\n\n`+p.slice(0,60).map((x,n)=>`${n+1}. **${safe(x.name||x.username||'Unknown')}**`).join('\n'):'👤 **No players online.**');}
    if(c==='serverinfo'){await i.deferReply({flags:MessageFlags.Ephemeral});const d=await getGameServer();const s=d.data?.gameserver||{};return i.editReply('```json\n'+JSON.stringify({serviceId:getServiceId(),status:s.status,ip:s.connect_ip||s.ip,port:s.port,queryPort:s.query_port,game:s.game_human||s.game,slots:s.slots},null,2)+'\n```');}
    if(c==='nitrado'){await i.deferReply({flags:MessageFlags.Ephemeral});const [sv,gs]=await Promise.all([getServices(),getGameServer()]);const ms=(sv.data?.services||[]).find(x=>String(x.id)===String(getServiceId()));return i.editReply(`✅ **Nitrado connected**\nService: **${safe(ms?.details?.name||ms?.name||getServiceId())}**\nStatus: **${humanStatus(gs.data?.gameserver?.status)}**`);}
    if(c==='services'){if(!(await needAdmin(i)))return;const d=await getServices();const arr=d.data?.services||[];return i.reply(eph(arr.length?arr.map(s=>`• **${safe(s.details?.name||s.name||'Service')}** — ${s.id}`).join('\n'):'No services returned.'));}
    if(c==='ip'){const d=await getGameServer();const s=d.data?.gameserver||{};return i.reply(`🌐 Server address: **${s.connect_ip||s.ip||'Hidden'}:${s.port||''}**`);}
    if(c==='map'){const d=await getGameServer();const s=d.data?.gameserver||{};return i.reply(`🗺️ Map: **${s.query?.map||s.settings?.config?.mission||'DayZ'}**`);}
    if(c==='slots'){const d=await getGameServer();const s=d.data?.gameserver||{};return i.reply(`🎟️ Slots: **${s.slots??s.query?.player_max??'Unknown'}**`);}
    if(c==='refresh'){if(!(await needMod(i)))return; CACHE.clear();return i.reply(eph('✅ Nitrado cache cleared. Next server request will refresh.'));}
    if(c==='restart'){if(!(await needAdmin(i)))return;await i.deferReply({flags:MessageFlags.Ephemeral});await performAction('restart');return i.editReply('🔄 **Restart requested.**');}
    if(c==='stop'){if(!(await needAdmin(i)))return;await i.deferReply({flags:MessageFlags.Ephemeral});await performAction('stop');return i.editReply('🛑 **Stop requested.**');}
    if(c==='maintenance'){if(!(await needAdmin(i)))return;const mode=i.options.getString('mode',true);config.maintenance=mode==='on';saveConfig();return i.reply(`🛠️ Maintenance mode: **${config.maintenance?'ON':'OFF'}**`);}
    if(c==='announce'||c==='say'){if(!(await needMod(i)))return;const msg=i.options.getString('message',true);const chId=config.announceChannelId||i.channelId;const ch=await client.channels.fetch(chId);if(!ch?.isTextBased())throw new Error('Announcement channel is not text-based.');await ch.send({embeds:[new EmbedBuilder().setTitle(c==='announce'?'🌅 RED DAWN ANNOUNCEMENT':'📣 RED DAWN BROADCAST').setDescription(msg).setTimestamp()]});return i.reply(eph('✅ Sent.'));}
    if(c==='setchannel'){if(!(await needAdmin(i)))return;const type=i.options.getString('type',true), ch=i.options.getChannel('channel',true);config[type]=ch.id;saveConfig();return i.reply(eph(`✅ ${type} → <#${ch.id}>`));}
    if(c==='setadminrole'||c==='setmodrole'){if(!(await needAdmin(i)))return;const r=i.options.getRole('role',true);const key=c==='setadminrole'?'adminRoleIds':'modRoleIds';config[key]??=[];if(config[key].includes(r.id))config[key]=config[key].filter(x=>x!==r.id);else config[key].push(r.id);saveConfig();return i.reply(eph(`✅ ${r.name} is ${config[key].includes(r.id)?'enabled':'removed'} for ${c==='setadminrole'?'admin':'mod'} access.`));}
    if(c==='config'){if(!(await needAdmin(i)))return;return i.reply(eph(JSON.stringify({guildId:config.guildId,maintenance:config.maintenance,feedChannels:config.feedChannels,feedFiles:config.feedFiles,feedsEnabled:config.feedsEnabled,adminRoles:config.adminRoleIds.length,modRoles:config.modRoleIds.length},null,2)));}
    if(c==='permissions'||c==='staff'){return i.reply(eph(`👤 **${i.user.tag}**\nAdministrator: **${!!i.memberPermissions?.has(PermissionFlagsBits.Administrator)}**\nAdmin roles configured: **${config.adminRoleIds.length}**\nModerator roles configured: **${config.modRoleIds.length}**`));}
    if(c==='botstats'){return i.reply({embeds:[new EmbedBuilder().setTitle('📊 Red Dawn Bot Stats').addFields({name:'Commands',value:String(commandDefinitions.length),inline:true},{name:'Cache',value:String(CACHE.size),inline:true},{name:'Feed events',value:String(FEED_BUFFER.length),inline:true},{name:'Uptime',value:formatDuration(Date.now()-START_TIME),inline:true})]});}
    if(c==='cache')return i.reply(eph(`🧠 Cache entries: **${CACHE.size}**`));
    if(c==='health'){const out=[];try{await getGameServer();out.push('✅ Nitrado API')}catch(e){out.push('❌ Nitrado API: '+e.message)}out.push(botReady?'✅ Discord bot':'❌ Discord bot');return i.reply(eph(out.join('\n')));}
    if(c==='latency'){const start=Date.now();try{await getGameServer();out=Date.now()-start;return i.reply(`⚡ Discord: **${Math.round(client.ws.ping)}ms** • Nitrado: **${out}ms**`);}catch(e){return i.reply(eph(`⚠️ Discord: **${Math.round(client.ws.ping)}ms** • Nitrado failed`));}}
    if(c==='logs'){if(!(await needAdmin(i)))return;return i.reply(eph(config.feedFiles?.length?config.feedFiles.map(x=>'• `'+x+'`').join('\n'):'No feed files configured. Use /findlogs then /feedfile.'));}
    if(c==='findlogs'){if(!(await needAdmin(i)))return;await i.deferReply({flags:MessageFlags.Ephemeral});const root=process.env.NITRADO_LOG_DIR||'dayzstandalone/logs';const a=await fileList(root);const logs=a.filter(x=>x.type==='file'&&/\.log$|admin|damage|server|player/i.test(x.name||x.path||''));return i.editReply(logs.length?logs.slice(0,40).map(x=>'`'+(x.path||x.name)+'`').join('\n'):`No obvious logs found under \`${root}\`. Try setting NITRADO_LOG_DIR in .env.`);}
    if(c==='feedstatus'){return i.reply(eph(`📡 Feeds: **${config.feedsEnabled?'RUNNING':'STOPPED'}**\nFiles: **${config.feedFiles?.length||0}**\nBuffered events: **${FEED_BUFFER.length}**\nPoll: **${process.env.FEED_POLL_MS||10000}ms**`));}
    if(c==='feedsetup'){return i.reply(eph('1) /findlogs\n2) /feedfile path:<remote-log-path>\n3) /setkillfeed #channel, /setpvpfeed #channel, etc.\n4) /feedstart\n5) /feedtest to validate patterns.\nFeeds are log-based and depend on the exact DayZ/Nitrado log format.'));}
    if(c==='feedstart'){if(!(await needAdmin(i)))return;config.feedsEnabled=true;saveConfig();startFeeds();return i.reply(eph('📡 **Automatic feeds started.**'));}
    if(c==='feedstop'){if(!(await needAdmin(i)))return;config.feedsEnabled=false;saveConfig();stopFeeds();return i.reply(eph('⏹️ **Automatic feeds stopped.**'));}
    if(c==='feedfile'){if(!(await needAdmin(i)))return;const p=i.options.getString('path',true);const rem=i.options.getBoolean('remove')||false;config.feedFiles??=[];if(rem)config.feedFiles=config.feedFiles.filter(x=>x!==p);else if(!config.feedFiles.includes(p))config.feedFiles.push(p);saveConfig();return i.reply(eph(`${rem?'🗑️ Removed':'✅ Added'} \`${p}\``));}
    const feedSet={'setkillfeed':'kill','setpvpfeed':'pvp','sethitfeed':'hit','setbuildfeed':'build','setbasefeed':'build','setconnectfeed':'join','setdeathfeed':'death','setplacementfeed':'placement','setchatfeed':'chat','seteventfeed':'event','setadminlogfeed':'admin'};
    if(feedSet[c]){if(!(await needAdmin(i)))return;config.feedChannels??={};config.feedChannels[feedSet[c]]=i.options.getChannel('channel',false)?.id||i.channelId;saveConfig();return i.reply(eph(`✅ ${c} → <#${config.feedChannels[feedSet[c]]}>`));}
    if(c==='clearfeeds'){if(!(await needAdmin(i)))return;config.feedChannels={};saveConfig();return i.reply(eph('🧹 Feed channel mappings cleared.'));}
    if(c==='feedlist'){const f=config.feedChannels||{};return i.reply(eph(Object.keys(f).length?Object.entries(f).map(([k,v])=>`• **${k}** → <#${v}>`).join('\n'):'No feed channels configured.'));}
    if(c==='feedlist'){const f=config.feedChannels||{};return i.reply(eph(Object.keys(f).length?Object.entries(f).map(([k,v])=>`• **${k}** → <#${v}>`).join('\n'):'No feed channels configured.'));}
    if(c==='feedtest'){if(!(await needMod(i)))return;const type=i.options.getString('type')||'kill';const sample={kill:'Player "Alpha" killed "Bravo"',pvp:'Player "Alpha" hit "Bravo"',hit:'Player "Alpha" hit "Bravo"',build:'Player "Alpha" built a fence',placement:'Player "Alpha" placed a crate',join:'Player "Alpha" connected',leave:'Player "Alpha" disconnected'}[type];const evt=detectLine(sample,'sample.log');return i.reply(eph(evt?`✅ Parsed as **${evt.type}**\n${JSON.stringify(evt,null,2)}`:'⚠️ No parser match.'));}
    const recentMap={'lastkills':'kill','lastpvp':'hit','lasthits':'hit','lastbuilds':'build','lastjoins':'join','lastleaves':'leave','lastplacements':'placement','lastdeaths':'death'};
    if(recentMap[c]){const arr=FEED_BUFFER.filter(x=>x.type===recentMap[c]).slice(0,15);return i.reply(arr.length?arr.map(x=>`${new Date(x.time).toLocaleTimeString()} • ${x.attacker?safe(x.attacker)+' → ':''}${x.victim?safe(x.victim):safe(x.player)||safe(x.text)}`).join('\n'):'No matching events stored yet.');}
    if(c==='stats'||c==='leaderboard'||c==='topkills'||c==='topdeaths'){const entries=[...PLAYER_STATS.entries()];if(!entries.length)return i.reply('📊 No detected player stats yet.');entries.sort((a,b)=>(c==='topdeaths'?b[1].deaths-a[1].deaths:b[1].kills-a[1].kills));return i.reply(entries.slice(0,15).map(([n,s],idx)=>`${idx+1}. **${safe(n)}** — K:${s.kills||0} D:${s.deaths||0} H:${s.hits||0}`).join('\n'));}
    if(c==='kd'||c==='pingplayer'||c==='lookup'){const n=i.options.getString('player',true);const match=[...PLAYER_STATS.entries()].find(([p])=>p.toLowerCase()===n.toLowerCase());if(c==='kd')return i.reply(match?`📈 **${safe(match[0])}** — K/D **${(match[1].kills/(match[1].deaths||1)).toFixed(2)}** (${match[1].kills||0}/${match[1].deaths||0})`:'No stored stats for that player.');if(c==='pingplayer')return i.reply('📶 Xbox player ping is only available when your server log exposes it; no direct value is stored yet.');return i.reply(match?`🔎 **${safe(match[0])}** — K ${match[1].kills||0} • D ${match[1].deaths||0} • H ${match[1].hits||0}`:'No stored player record.');}
    if(c==='watchlistadd'||c==='watchlistremove'){if(!(await needMod(i)))return;const n=i.options.getString('player',true);config.watchlistIds??=[];if(c==='watchlistadd'&&!config.watchlistIds.includes(n))config.watchlistIds.push(n);if(c==='watchlistremove')config.watchlistIds=config.watchlistIds.filter(x=>x.toLowerCase()!==n.toLowerCase());saveConfig();return i.reply(eph(`👀 Watchlist updated.`));}
    if(c==='watchlist')return i.reply(eph(config.watchlistIds?.length?config.watchlistIds.map(x=>'• '+safe(x)).join('\n'):'Watchlist is empty.'));
    if(c==='noteset'||c==='noteremove'||c==='note'){if(c!=='note'&&!(await needMod(i)))return;const n=i.options.getString('player',true);config.notes??={};if(c==='noteset'){config.notes[n]={text:i.options.getString('note',true),by:i.user.id,at:Date.now()};saveConfig();return i.reply(eph(`📝 Note saved for **${safe(n)}**.`));}if(c==='noteremove'){delete config.notes[n];saveConfig();return i.reply(eph(`🗑️ Note removed.`));}return i.reply(eph(config.notes[n]?.text||'No note found.'));}
    if(c==='report'){config.reports??=[];const id=(config.reports.at(-1)?.id||0)+1;config.reports.push({id,subject:i.options.getString('subject',true),details:i.options.getString('details',true),user:i.user.tag,open:true,at:Date.now()});saveConfig();return i.reply(`🚩 Report **#${id}** created. Staff will review it.`);}
    if(c==='reports'){if(!(await needMod(i)))return;const arr=(config.reports||[]).filter(r=>r.open);return i.reply(eph(arr.length?arr.map(r=>`#${r.id} • **${safe(r.subject)}** • ${safe(r.details)}`).join('\n'):'No open reports.'));}
    if(c==='reportclose'){if(!(await needMod(i)))return;const id=i.options.getInteger('id',true);const r=(config.reports||[]).find(x=>x.id===id);if(!r)return i.reply(eph('Report not found.'));r.open=false;r.closedBy=i.user.tag;r.closedAt=Date.now();saveConfig();return i.reply(eph(`✅ Report #${id} closed.`));}
    if(c==='ticket'){return i.reply(`🎫 Ticket request received. Staff can use this channel to assist you.
**Reason:** ${safe(i.options.getString('reason',true))}`);}
    if(c==='suggest'){config.suggestions??=[];config.suggestions.push({idea:i.options.getString('idea',true),user:i.user.tag,at:Date.now()});saveConfig();return i.reply('💡 Suggestion saved. Thanks!');}
    if(c==='vote'){const q=i.options.getString('question',true);const m=await i.reply({content:`📊 **${q}**\n👍 Yes\n👎 No`,fetchReply:true});await m.react('👍');await m.react('👎');return;}
    if(c==='event'){if(!(await needMod(i)))return;const n=i.options.getString('name',true);config.events??=[];config.events.push({name:n,details:i.options.getString('details',true),by:i.user.tag,at:Date.now(),active:true});saveConfig();return i.reply(`🎉 Event **${safe(n)}** created.`);}
    if(c==='eventlist')return i.reply((config.events||[]).filter(e=>e.active).map(e=>`🎯 **${safe(e.name)}** — ${safe(e.details)}`).join('\n')||'No active events.');
    if(c==='eventend'){if(!(await needMod(i)))return;const n=i.options.getString('name',true);const e=(config.events||[]).find(x=>x.name.toLowerCase()===n.toLowerCase()&&x.active);if(!e)return i.reply(eph('Event not found.'));e.active=false;saveConfig();return i.reply('✅ Event ended.');}
    if(c==='giveaway'){if(!(await needMod(i)))return;const prize=i.options.getString('prize',true), mins=i.options.getInteger('minutes',true);const e=new EmbedBuilder().setTitle('🎁 RED DAWN GIVEAWAY').setDescription(`Prize: **${safe(prize)}**\nReact with 🎉 to enter!\nEnds in **${mins} minutes**.`);const m=await i.reply({embeds:[e],fetchReply:true});await m.react('🎉');setTimeout(async()=>{try{const msg=await m.fetch();const react=msg.reactions.cache.get('🎉');const users=react?await react.users.fetch():new Map();const entries=users.filter(u=>!u.bot);const winner=[...entries.values()][Math.floor(Math.random()*entries.size)];await m.reply(winner?`🎉 Winner: ${winner}! Prize: **${safe(prize)}**`:'No valid entries.');}catch{}},mins*60000);return;}
    if(c==='verify')return i.reply('✅ Ask staff for Red Dawn verification instructions.');
    if(c==='rules')return i.reply('📜 **Red Dawn Rules**\n1. No cheating/exploits.\n2. Respect staff and players.\n3. Follow raid/PvP rules posted by staff.\n4. No harassment/spam.');
    if(c==='links')return i.reply('🔗 Configure your Red Dawn links in the bot README/config before publishing them.');
    if(c==='faq')return i.reply('❓ Common: use `/status` for live server info, `/players` for online players, `/server` for the dashboard, and `/help` for commands.');
    if(c==='poll'){const q=i.options.getString('question',true);const a=i.options.getString('option1',true),b=i.options.getString('option2',true),d=i.options.getString('option3');const m=await i.reply({content:`📊 **${q}**\n1️⃣ ${a}\n2️⃣ ${b}${d?'\n3️⃣ '+d:''}`,fetchReply:true});await m.react('1️⃣');await m.react('2️⃣');if(d)await m.react('3️⃣');return;}
    if(c==='clear'||c==='purge'){if(!(await needMod(i)))return;const n=i.options.getInteger('amount',false)||25;const count=Math.min(n,100);await i.deferReply({flags:MessageFlags.Ephemeral});if(!i.channel?.isTextBased()||!i.channel.bulkDelete)throw new Error('This command only works in text channels.');const deleted=await i.channel.bulkDelete(count,true);return i.editReply(`🧹 Deleted **${deleted.size}** messages.`);}
    if(c==='slowmode'){if(!(await needMod(i)))return;const s=i.options.getInteger('seconds',true);await i.channel.setRateLimitPerUser(s);return i.reply(eph(`🐢 Slowmode set to **${s}s**.`));}
    if(c==='lock'||c==='unlock'){if(!(await needMod(i)))return;const ch=i.channel;await ch.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:c==='unlock'?null:false});return i.reply(`${c==='lock'?'🔒 Locked':'🔓 Unlocked'} **${ch.name}**.`);}
    if(c==='timeout'){if(!(await needMod(i)))return;const u=i.options.getUser('user',true), mins=i.options.getInteger('minutes',true), reason=i.options.getString('reason')||'Red Dawn moderation';const m=await i.guild.members.fetch(u.id);await m.timeout(mins*60000,reason);return i.reply(eph(`⏳ ${u} timed out for **${mins} min**.`));}
    if(c==='warn'||c==='warnings'||c==='unwarn'){if(!(await needMod(i)))return;config.warnings??={};if(c==='warn'){const u=i.options.getUser('user',true),reason=i.options.getString('reason',true);config.warnings[u.id]??=[];const id=(config.warnings[u.id].at(-1)?.id||0)+1;config.warnings[u.id].push({id,reason,by:i.user.tag,at:Date.now()});saveConfig();return i.reply(eph(`⚠️ ${u} warned. Warning #${id}.`));}const u=i.options.getUser('user',true);if(c==='warnings')return i.reply(eph(config.warnings[u.id]?.length?config.warnings[u.id].map(w=>`#${w.id} — ${safe(w.reason)} — ${safe(w.by)}`).join('\n'):'No warnings.'));const id=i.options.getInteger('id',true);config.warnings[u.id]=config.warnings[u.id]?.filter(w=>w.id!==id)||[];saveConfig();return i.reply(eph(`✅ Warning #${id} removed.`));}
    if(c==='kick'||c==='ban'){if(!(await needMod(i)))return;const u=i.options.getUser('user',true), reason=i.options.getString('reason')||'Red Dawn moderation';const m=await i.guild.members.fetch(u.id);if(c==='kick')await m.kick(reason);else await m.ban({reason});return i.reply(eph(`✅ ${u.tag} ${c}ed.`));}
    if(c==='unban'){if(!(await needMod(i)))return;const id=i.options.getString('user_id',true);await i.guild.members.unban(id,'Red Dawn moderation');return i.reply(eph(`✅ User ${id} unbanned.`));}
    if(c==='audit'){if(!(await needAdmin(i)))return;return i.reply(eph(FEED_BUFFER.length?FEED_BUFFER.slice(0,15).map(e=>`${new Date(e.time).toLocaleTimeString()} • ${e.type} • ${safe(e.text)}`).join('\n'):'No recent bot feed events.'));}
    return i.reply(eph('Command recognized but no handler is installed yet.'));
  }catch(e){console.error('['+i.commandName+']',e);const msg=`❌ ${e.message||'Something went wrong.'}`;if(i.deferred||i.replied)return i.editReply(msg).catch(()=>{});return i.reply(eph(msg)).catch(()=>{});}
});

client.on('messageCreate', async message => {
  if(message.author.bot || !config.feedChannels?.chat || !message.guild) return;
  try {
    const ch = await client.channels.fetch(config.feedChannels.chat);
    if(ch?.isTextBased() && ch.id !== message.channelId) {
      await ch.send({embeds:[new EmbedBuilder().setTitle('💬 RED DAWN CHAT FEED').setDescription(`**${safe(message.author.tag)}** in <#${message.channelId}>
${safe(message.content).slice(0,900)}`).setTimestamp()]});
    }
  } catch(e) { console.error('chat feed:',e.message); }
});

client.login(process.env.DISCORD_TOKEN);
