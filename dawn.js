const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionOverwrites,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  AttachmentBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { AsyncLocalStorage } = require('node:async_hooks');
const { initDatabase, getGuild, saveGuild, listGuilds, closeDatabase } = require('./db');
const { encryptJson, decryptJson } = require('./security');

const VERSION = '5.0.0';
const START_TIME = Date.now();
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATS_PATH = path.join(ROOT, 'stats.json');

function mergeConfig(base, incoming) {
  return {
    ...base,
    ...incoming,
    feedChannels: { ...(base.feedChannels || {}), ...(incoming.feedChannels || {}) },
    feedFiles: Array.isArray(incoming.feedFiles) ? incoming.feedFiles : base.feedFiles,
    watchlist: Array.isArray(incoming.watchlist) ? incoming.watchlist : base.watchlist,
    notes: { ...(base.notes || {}), ...(incoming.notes || {}) },
    warnings: { ...(base.warnings || {}), ...(incoming.warnings || {}) },
    reports: Array.isArray(incoming.reports) ? incoming.reports : base.reports,
    events: Array.isArray(incoming.events) ? incoming.events : base.events,
  };
}

const DEFAULT_CONFIG = {
  adminRoleId: '',
  modRoleId: '',
  maintenance: false,
  feedsEnabled: false,
  feedIntervalMs: Math.max(5000, Number(process.env.FEED_POLL_MS) || 10000),
  feedChannels: {},
  feedFiles: [],
  watchlist: [],
  notes: {},
  warnings: {},
  reports: [],
  events: [],
  scheduledRestartAt: null,
  recurringRestart: null,
  audit: [],
  nitradoServiceId: '',
  nitradoToken: '',
  setupCompletedAt: null,
};

const DEFAULT_STATS = {
  players: {},
  lastEvents: [],
  lastPlayerSnapshot: [],
};

const tenantALS = new AsyncLocalStorage();
const tenantCache = new Map();

function activeContext() {
  const ctx = tenantALS.getStore();
  if (!ctx) throw new Error('No server context is active.');
  return ctx;
}
function activeConfig() { return activeContext().config; }
function activeStats() { return activeContext().stats; }

const config = new Proxy({}, {
  get(_target, prop) { return activeConfig()[prop]; },
  set(_target, prop, value) { activeConfig()[prop] = value; activeContext().dirty = true; return true; },
  ownKeys() { return Reflect.ownKeys(activeConfig()); },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});
const stats = new Proxy({}, {
  get(_target, prop) { return activeStats()[prop]; },
  set(_target, prop, value) { activeStats()[prop] = value; activeContext().dirty = true; return true; },
  ownKeys() { return Reflect.ownKeys(activeStats()); },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});

function saveJson(file) {
  const ctx = tenantALS.getStore();
  if (ctx && (file === CONFIG_PATH || file === STATS_PATH)) ctx.dirty = true;
}

async function loadTenant(guildId, ownerId) {
  const cached = tenantCache.get(guildId);
  if (cached) {
    if (ownerId && cached.ownerId !== ownerId) cached.ownerId = ownerId;
    return cached;
  }
  const row = await getGuild(guildId);
  let configValue = mergeConfig(DEFAULT_CONFIG, {});
  let statsValue = JSON.parse(JSON.stringify(DEFAULT_STATS));
  if (row) {
    configValue = mergeConfig(DEFAULT_CONFIG, decryptJson(row.config_enc));
    statsValue = decryptJson(row.stats_enc);
  }
  const tenant = { guildId, ownerId: ownerId || row?.owner_id || '', config: configValue, stats: statsValue };
  tenantCache.set(guildId, tenant);
  if (!row) {
    await persistTenant(tenant);
  } else if (ownerId && row.owner_id !== ownerId) {
    await persistTenant(tenant);
  }
  return tenant;
}

async function persistTenant(tenant) {
  await saveGuild({
    guildId: tenant.guildId,
    ownerId: tenant.ownerId || '',
    configEnc: encryptJson(tenant.config),
    statsEnc: encryptJson(tenant.stats),
  });
}

async function withGuildContext(guildId, ownerId, fn) {
  const tenant = await loadTenant(guildId, ownerId);
  const ctx = { guildId, ownerId: tenant.ownerId, config: tenant.config, stats: tenant.stats, dirty: false };
  return tenantALS.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      tenant.ownerId = ctx.ownerId || tenant.ownerId;
      if (ctx.dirty) await persistTenant(tenant);
    }
  });
}

async function ensureConnectedGuilds() {
  for (const guild of tenantCache.values()) {
    // no-op: cache entries are already ready
  }
  for (const guild of client.guilds.cache.values()) {
    await loadTenant(guild.id, guild.ownerId);
  }
}

function safe(value, max = 900) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
function eph(content) {
  return { content, flags: MessageFlags.Ephemeral };
}
function msDuration(ms) {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(seconds / 86400); seconds %= 86400;
  const h = Math.floor(seconds / 3600); seconds %= 3600;
  const m = Math.floor(seconds / 60); seconds %= 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : '', `${seconds}s`].filter(Boolean).join(' ');
}
function serviceId() {
  const id = String(activeConfig().nitradoServiceId || '').trim();
  if (!id) throw new Error('This Discord server is not connected to Nitrado. An owner must run /setup connect.');
  return id;
}
function nitradoToken() {
  const token = String(activeConfig().nitradoToken || '').trim();
  if (!token) throw new Error('This Discord server is not connected to Nitrado. An owner must run /setup connect.');
  return token;
}
function requireNitrado() {
  nitradoToken();
  serviceId();
}
function guildOnly(i) {
  if (!i.guild) {
    i.reply(eph('❌ This command can only be used in a Discord server.'));
    return false;
  }
  return true;
}
function hasRole(i, roleId) {
  return Boolean(roleId && i.member?.roles?.cache?.has(roleId));
}
async function requireOwner(i) {
  if (!guildOnly(i)) return false;
  if (i.guild.ownerId === i.user.id) return true;
  await i.reply(eph('❌ Only the Discord server owner can change Nitrado credentials or Red Dawn security settings.'));
  return false;
}

async function requireAdmin(i) {
  if (!guildOnly(i)) return false;
  if (i.guild.ownerId === i.user.id || i.member.permissions.has(PermissionFlagsBits.Administrator) || i.member.permissions.has(PermissionFlagsBits.ManageGuild) || hasRole(i, config.adminRoleId)) return true;
  await i.reply(eph('❌ Administrator permission or the configured Red Dawn admin role is required.'));
  return false;
}
async function requireMod(i) {
  if (!guildOnly(i)) return false;
  if (
    i.member.permissions.has(PermissionFlagsBits.Administrator) ||
    i.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    hasRole(i, config.adminRoleId) ||
    hasRole(i, config.modRoleId)
  ) return true;
  await i.reply(eph('❌ Moderator permission or the configured Red Dawn staff role is required.'));
  return false;
}
function audit(actor, action, details = {}) {
  config.audit = Array.isArray(config.audit) ? config.audit : [];
  config.audit.unshift({ at: Date.now(), actor, action, details });
  config.audit = config.audit.slice(0, 250);
  saveJson(CONFIG_PATH, config);
}
function upsertStat(name, key, amount = 1) {
  if (!name) return;
  if (!stats.players[name]) stats.players[name] = { kills: 0, deaths: 0, hits: 0, joins: 0, leaves: 0, builds: 0, placements: 0 };
  stats.players[name][key] = (stats.players[name][key] || 0) + amount;
}
function recordEvent(evt) {
  stats.lastEvents = [{ ...evt, at: evt.at || Date.now(), id: evt.id || crypto.randomUUID() }, ...(stats.lastEvents || [])].slice(0, 300);
  saveJson(STATS_PATH, stats);
}
function parseName(line) {
  const patterns = [
    /Player\s+['"]?([^'"\[]+)['"]?\s+(?:hit|killed|died|joined|left)/i,
    /(?:hit|killed|died|joined|left)\s+(?:player\s+)?['"]?([^'"\[]+)['"]?/i,
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}
function parseLogLine(line) {
  const text = String(line);
  const lower = text.toLowerCase();
  if (/connect|connected|login|joined|enter(ed)?/.test(lower)) {
    const name = parseName(text);
    return { type: 'join', player: name, line: text };
  }
  if (/disconnect|disconnected|logout|left|leav(e|es|ing)/.test(lower)) {
    const name = parseName(text);
    return { type: 'leave', player: name, line: text };
  }
  if (/died|death|killed|kill(ed)?/.test(lower)) {
    const victim = parseName(text);
    const attacker = text.match(/(?:by|killer|from)\s+['"]?([^'",:]+)['"]?/i)?.[1]?.trim() || null;
    const weapon = text.match(/(?:weapon|with)\s*[:=]?\s*['"]?([^'",:]+)['"]?/i)?.[1]?.trim() || null;
    return { type: 'kill', attacker, victim, weapon, line: text };
  }
  if (/hit|damage|bleed|shot/.test(lower)) {
    const victim = text.match(/(?:hit|damag(?:e|ed)|shot)\s+(?:player\s+)?['"]?([^'",:]+)['"]?/i)?.[1]?.trim() || null;
    const attacker = text.match(/(?:by|attacker|from)\s+['"]?([^'",:]+)['"]?/i)?.[1]?.trim() || null;
    return { type: attacker && victim ? 'pvp' : 'hit', attacker, victim, line: text };
  }
  if (/build|built|dismantl|destroy.*base|basebuilding/.test(lower)) {
    const player = parseName(text);
    return { type: 'build', player, line: text };
  }
  if (/place|placed|placement/.test(lower)) {
    const player = parseName(text);
    return { type: 'placement', player, line: text };
  }
  return { type: 'raw', line: text };
}

const API_BASE = 'https://api.nitrado.net';
const apiCache = new Map();
async function nitradoRequest(endpoint, options = {}) {
  requireNitrado();
  const method = options.method || 'GET';
  const ttl = options.cacheMs || 0;
  const key = `${method}:${endpoint}:${JSON.stringify(options.body || {})}`;
  if (method === 'GET' && ttl && apiCache.has(key)) {
    const hit = apiCache.get(key);
    if (Date.now() - hit.at < ttl) return hit.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || Number(process.env.NITRADO_API_TIMEOUT_MS) || 12000);
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${nitradoToken()}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) throw new Error(`Nitrado API ${response.status}: ${safe(data?.message || data?.error || response.statusText, 500)}`);
    if (method === 'GET' && ttl) apiCache.set(key, { at: Date.now(), value: data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function testNitradoCredentials(token, svcId) {
  if (!/^\d{6,}$/.test(String(svcId))) throw new Error('Nitrado Service ID must be numeric.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.NITRADO_API_TIMEOUT_MS) || 12000);
  try {
    const response = await fetch(`${API_BASE}/services/${svcId}/gameservers`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch {}
    if (!response.ok) throw new Error(`Nitrado API ${response.status}: ${safe(data?.message || data?.error || response.statusText, 500)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getServer(force = false) {
  return nitradoRequest(`/services/${serviceId()}/gameservers`, { cacheMs: force ? 0 : 6000 });
}
async function getPlayers(force = false) {
  return nitradoRequest(`/services/${serviceId()}/gameservers/games/players`, { cacheMs: force ? 0 : 5000 });
}
async function getServices() {
  return nitradoRequest('/services', { cacheMs: 10000 });
}
async function getNotifications() {
  return nitradoRequest(`/services/${serviceId()}/gameservers/notifications`, { cacheMs: 3000 });
}
async function getSettingsSets() {
  return nitradoRequest(`/services/${serviceId()}/gameservers/settings/sets`, { cacheMs: 15000 });
}
async function getSettingsDefaults() {
  return nitradoRequest(`/services/${serviceId()}/gameservers/settings/defaults`, { cacheMs: 15000 });
}
async function updateSetting(category, key, value) {
  return nitradoRequest(`/services/${serviceId()}/gameservers/settings`, { method: 'POST', body: { category, key, value } });
}
async function serverAction(name) {
  return nitradoRequest(`/services/${serviceId()}/gameservers/${name}`, { method: 'POST' });
}
async function fileList(dir = '', search = '') {
  const q = new URLSearchParams();
  if (dir) q.set('dir', dir);
  if (search) q.set('search', search);
  return nitradoRequest(`/services/${serviceId()}/gameservers/file_server/list?${q.toString()}`, { cacheMs: 3000 });
}
async function fileStat(remotePath) {
  const q = new URLSearchParams({ files: remotePath });
  return nitradoRequest(`/services/${serviceId()}/gameservers/file_server/stat?${q.toString()}`, { cacheMs: 1000 });
}
async function fileSize(remotePath) {
  const q = new URLSearchParams({ path: remotePath });
  return nitradoRequest(`/services/${serviceId()}/gameservers/file_server/size?${q.toString()}`, { cacheMs: 1000 });
}
async function fileSeek(remotePath, offset, length, mode = 'raw') {
  const q = new URLSearchParams({ file: remotePath, offset: String(offset), length: String(length), mode });
  const tokenInfo = await nitradoRequest(`/services/${serviceId()}/gameservers/file_server/seek?${q.toString()}`, { cacheMs: 0, timeoutMs: 15000 });
  const token = tokenInfo?.data?.token || tokenInfo?.token;
  if (!token?.url || !token?.token) throw new Error('Nitrado did not return a seek token.');
  const readUrl = new URL(token.url);
  readUrl.searchParams.set('token', token.token);
  const r = await fetch(readUrl, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`File seek failed: HTTP ${r.status}`);
  return await r.text();
}
async function fileDownload(remotePath) {
  const q = new URLSearchParams({ file: remotePath });
  const tokenInfo = await nitradoRequest(`/services/${serviceId()}/gameservers/file_server/download?${q.toString()}`, { cacheMs: 1000 });
  const token = tokenInfo?.data?.token || tokenInfo?.token;
  if (!token?.url || !token?.token) throw new Error('Nitrado did not return a download token.');
  const downloadUrl = new URL(token.url);
  downloadUrl.searchParams.set('token', token.token);
  const r = await fetch(downloadUrl, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`File download failed: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function fileDelete(remotePath) {
  return nitradoRequest(`/services/${serviceId()}/gameservers/file_server/delete`, { method: 'DELETE', body: { path: remotePath } });
}
function splitTarget(destination, fallbackName) {
  const clean = validateRemotePath(destination).replace(/\\/g, '/').replace(/\/+$/, '');
  const targetDir = path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean);
  const targetFilename = path.posix.basename(clean) || fallbackName;
  return { targetDir, targetFilename };
}
async function fileMove(source, destination) {
  const target = splitTarget(destination, path.posix.basename(source));
  return nitradoRequest(`/services/${serviceId()}/gameservers/file_server/move`, { method: 'POST', body: { source_path: source, target_path: target.targetDir, target_filename: target.targetFilename } });
}
async function fileCopy(source, destination) {
  const target = splitTarget(destination, path.posix.basename(source));
  return nitradoRequest(`/services/${serviceId()}/gameservers/file_server/copy`, { method: 'POST', body: { source_path: source, target_path: target.targetDir, target_name: target.targetFilename } });
}
async function fileMkdir(dir) {
  const clean = validateRemotePath(dir);
  const parent = path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean);
  const name = path.posix.basename(clean);
  return nitradoRequest(`/services/${serviceId()}/gameservers/file_server/mkdir`, { method: 'POST', body: { path: parent, name } });
}
async function fileUpload(remoteDir, fileName, buffer) {
  const tokenInfo = await nitradoRequest(`/services/${serviceId()}/gameservers/file_server/upload`, { method: 'POST', body: { path: remoteDir, file: fileName } });
  const token = tokenInfo?.data?.token || tokenInfo?.token;
  if (!token?.url || !token?.token) throw new Error('Nitrado did not return an upload token.');
  const r = await fetch(token.url, { method: 'POST', headers: { 'content-type': 'application/binary', token: token.token }, body: buffer, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`File upload failed: HTTP ${r.status}`);
  return true;
}
async function getBackups() {
  return nitradoRequest(`/services/${serviceId()}/gameservers/backups`, { cacheMs: 10000 });
}
async function getCurrentLists() {
  const data = await getServer(true);
  const settings = data?.data?.gameserver?.settings?.general || {};
  const parse = (x) => String(x || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return { bans: parse(settings.bans), whitelist: parse(settings.whitelist), priority: parse(settings.priority) };
}
async function modifyList(listType, actionName, identifier) {
  const lists = await getCurrentLists();
  const current = new Set(lists[listType] || []);
  if (actionName === 'add') current.add(identifier);
  else current.delete(identifier);
  const value = Array.from(current).sort().join('\r\n');
  return updateSetting('general', listType, value);
}
function validateRemotePath(value) {
  const p = String(value || '').replace(/^\/+/, '');
  if (!p || p.includes('..')) throw new Error('Invalid remote path. Use a server-relative path without .. segments.');
  return p;
}
function findChannel(guild, id) {
  return guild.channels.cache.get(id) || null;
}
function feedChannel(type) {
  const id = config.feedChannels[type];
  return id || null;
}
function formatFeedEvent(evt) {
  const icons = { kill: '☠️', pvp: '🎯', hit: '💥', death: '💀', build: '🔨', placement: '📦', join: '🟢', leave: '🔴', chat: '💬', raw: '📜' };
  const title = `${icons[evt.type] || '📡'} RED DAWN ${String(evt.type || 'event').toUpperCase()}`;
  const fields = [];
  if (evt.attacker) fields.push({ name: 'Attacker', value: safe(evt.attacker, 200), inline: true });
  if (evt.victim) fields.push({ name: 'Victim', value: safe(evt.victim, 200), inline: true });
  if (evt.player) fields.push({ name: 'Player', value: safe(evt.player, 200), inline: true });
  if (evt.weapon) fields.push({ name: 'Weapon', value: safe(evt.weapon, 200), inline: true });
  if (evt.line) fields.push({ name: 'Log', value: `\`${safe(evt.line, 900)}\`` });
  return new EmbedBuilder().setTitle(title).addFields(fields.length ? fields : [{ name: 'Event', value: 'No parsed fields.' }]).setTimestamp(evt.at || Date.now());
}
function isWatched(evt) {
  const hay = [evt.player, evt.attacker, evt.victim].filter(Boolean).map(x => String(x).toLowerCase());
  return (config.watchlist || []).some(w => hay.some(x => x === String(w).toLowerCase() || x.includes(String(w).toLowerCase())));
}
async function publishFeed(evt) {
  const targets = new Set();
  if (evt.type === 'pvp' && feedChannel('pvp')) targets.add(feedChannel('pvp'));
  if (feedChannel(evt.type)) targets.add(feedChannel(evt.type));
  if (evt.type === 'kill' && feedChannel('death')) targets.add(feedChannel('death'));
  if (isWatched(evt) && feedChannel('watch')) targets.add(feedChannel('watch'));
  const embed = formatFeedEvent(evt);
  for (const id of targets) {
    const channel = client.channels.cache.get(id);
    if (channel?.isTextBased()) {
      await channel.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

const feedTimers = new Map();
const feedPositions = new Map();
async function discoverLogs() {
  const roots = Array.from(new Set(['', 'dayzstandalone', 'dayzstandalone/logs', 'gameserver', 'gameserver/logs', process.env.NITRADO_LOG_DIR || ''].filter(Boolean)));
  const found = [];
  for (const root of roots) {
    try {
      const data = await fileList(root);
      const entries = data?.data?.entries || data?.data?.list || data?.data?.files || data?.data || [];
      const arr = Array.isArray(entries) ? entries : Object.values(entries || {});
      for (const item of arr) {
        const p = item.path || item.name || item.file;
        if (p && /\.(adm|clog|log|txt)$/i.test(p)) found.push(p);
      }
    } catch {}
  }
  return Array.from(new Set(found));
}
async function pollFeedFile(remotePath) {
  try {
    const sizeData = await fileSize(remotePath);
    const rawSize = sizeData?.data?.size ?? sizeData?.size ?? 0;
    const size = Number(rawSize) || 0;
    const positionKey = `${activeContext().guildId}:${remotePath}`;
    const previous = feedPositions.get(positionKey) ?? Math.max(0, size - 16000);
    const offset = Math.min(previous, size);
    const length = Math.min(24000, Math.max(0, size - offset));
    if (!length) return;
    const text = await fileSeek(remotePath, offset, length, 'raw');
    feedPositions.set(positionKey, size);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const evt = parseLogLine(line);
      if (evt.type === 'raw') continue;
      evt.id = crypto.createHash('sha1').update(`${remotePath}:${line}`).digest('hex');
      if ((stats.lastEvents || []).some(x => x.id === evt.id)) continue;
      if (evt.type === 'kill') {
        if (evt.attacker) upsertStat(evt.attacker, 'kills');
        if (evt.victim) upsertStat(evt.victim, 'deaths');
      } else if (evt.type === 'pvp' || evt.type === 'hit') {
        if (evt.attacker) upsertStat(evt.attacker, 'hits');
      } else if (evt.type === 'join' && evt.player) upsertStat(evt.player, 'joins');
      else if (evt.type === 'leave' && evt.player) upsertStat(evt.player, 'leaves');
      else if (evt.type === 'build' && evt.player) upsertStat(evt.player, 'builds');
      else if (evt.type === 'placement' && evt.player) upsertStat(evt.player, 'placements');
      recordEvent(evt);
      await publishFeed(evt);
    }
  } catch (err) {
    console.error(`Feed poll failed for ${remotePath}:`, err.message);
  }
}
async function startFeeds() {
  const guildId = activeContext().guildId;
  const ownerId = activeContext().ownerId;
  stopFeeds();
  config.feedsEnabled = true;
  saveJson(CONFIG_PATH, config);
  const timer = setInterval(() => {
    withGuildContext(guildId, ownerId, async () => {
      if (!config.feedsEnabled) return;
      for (const file of config.feedFiles || []) await pollFeedFile(file);
    }).catch(err => console.error(`Feed timer failed for ${guildId}:`, err.message));
  }, Math.max(5000, Number(config.feedIntervalMs) || 10000));
  feedTimers.set(guildId, timer);
  await Promise.all((config.feedFiles || []).map(pollFeedFile));
}
function stopFeeds() {
  const guildId = activeContext().guildId;
  const timer = feedTimers.get(guildId);
  if (timer) clearInterval(timer);
  feedTimers.delete(guildId);
  config.feedsEnabled = false;
  saveJson(CONFIG_PATH, config);
}

const pendingActions = new Map();
function confirmButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${id}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}
function queueAction(guildId, userId, action, extra = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  pendingActions.set(id, { guildId, userId, action, extra, expires: Date.now() + 30000 });
  return id;
}
async function executeConfirmed(action, extra) {
  if (action === 'restart') return serverAction('restart');
  if (action === 'start') return serverAction('start');
  if (action === 'stop') return serverAction('stop');
  if (action === 'file-delete') return fileDelete(extra.path);
  if (action === 'wipe-cache') { apiCache.clear(); return { ok: true }; }
  throw new Error(`Unknown confirmation action: ${action}`);
}

function strOpt(sub, name, description, required = true, max = 1000) {
  return sub.addStringOption(o => o.setName(name).setDescription(description).setRequired(required).setMaxLength(max));
}
function intOpt(sub, name, description, required = true, min = 0, max = 2147483647) {
  return sub.addIntegerOption(o => o.setName(name).setDescription(description).setRequired(required).setMinValue(min).setMaxValue(max));
}
function boolOpt(sub, name, description, required = true) {
  return sub.addBooleanOption(o => o.setName(name).setDescription(description).setRequired(required));
}
function channelOpt(sub, name = 'channel', description = 'Discord text channel', required = true) {
  return sub.addChannelOption(o => o.setName(name).setDescription(description).setRequired(required).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement));
}
function memberOpt(sub) {
  return sub.addUserOption(o => o.setName('member').setDescription('Discord member').setRequired(true));
}
function group(name, description, subs) {
  const b = new SlashCommandBuilder().setName(name).setDescription(description);
  for (const fn of subs) b.addSubcommand(fn);
  return b;
}

const commands = [];
commands.push(
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder().setName('status').setDescription('Show a quick Red Dawn server status'),
  new SlashCommandBuilder().setName('players').setDescription('Show players online'),
  new SlashCommandBuilder().setName('nitrado').setDescription('Test the Nitrado API connection').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('help').setDescription('Show Red Dawn command groups'),
  new SlashCommandBuilder().setName('restart').setDescription('Restart the Red Dawn Nitrado server'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show detailed Red Dawn server info'),
);

commands.push(group('setup', 'Secure per-server Red Dawn configuration', [
  s=>s.setName('connect').setDescription('Connect this Discord server to its Nitrado account'),
  s=>s.setName('import-env').setDescription('Import the legacy Render Nitrado credentials into this server'),
  s=>s.setName('disconnect').setDescription('Remove this server\'s Nitrado connection'),
  s=>s.setName('status').setDescription('Show this server\'s setup status'),
  s=>{const x=s.setName('admin-role').setDescription('Set the Red Dawn admin role');return x.addRoleOption(o=>o.setName('role').setDescription('Admin role').setRequired(true));},
  s=>s.setName('test').setDescription('Test this server\'s saved Nitrado connection'),
  s=>s.setName('security').setDescription('Show the security configuration without secrets'),
]));

commands.push(group('server', 'Powerful Red Dawn Nitrado server tools', [
  s=>s.setName('status').setDescription('Detailed live server status'),
  s=>s.setName('dashboard').setDescription('Show the live server dashboard'),
  s=>s.setName('info').setDescription('Show raw server information'),
  s=>s.setName('players').setDescription('List current players'),
  s=>s.setName('services').setDescription('List your Nitrado services'),
  s=>s.setName('service').setDescription('Show the configured Nitrado service'),
  s=>s.setName('notifications').setDescription('Show Nitrado server notifications'),
  s=>s.setName('ip').setDescription('Show server IP and port'),
  s=>s.setName('map').setDescription('Show current map'),
  s=>s.setName('slots').setDescription('Show player slots'),
  s=>s.setName('online').setDescription('Show current online count'),
  s=>s.setName('refresh').setDescription('Clear API cache and refresh data'),
  s=>s.setName('health').setDescription('Test server and API health'),
  s=>s.setName('latency').setDescription('Measure Nitrado API latency'),
  s=>s.setName('start').setDescription('Start the game server'),
  s=>s.setName('stop').setDescription('Stop the game server'),
  s=>s.setName('restart').setDescription('Restart the game server'),
  s=>{const x=s.setName('maintenance').setDescription('Toggle maintenance mode');return boolOpt(x,'enabled','Enable maintenance mode');},
  s=>{const x=s.setName('announce').setDescription('Send a server announcement');return strOpt(x,'message','Announcement text');},
  s=>{const x=s.setName('schedule-restart').setDescription('Schedule a one-time restart');return intOpt(x,'minutes','Minutes from now',true,1,10080);},
  s=>s.setName('cancel-restart').setDescription('Cancel the one-time restart'),
  s=>{const x=s.setName('auto-restart').setDescription('Schedule a daily restart in UTC');return intOpt(x,'hour','UTC hour',true,0,23);},
  s=>s.setName('cancel-auto').setDescription('Cancel the daily restart'),
  s=>s.setName('query').setDescription('Show live game query data'),
  s=>s.setName('uptime').setDescription('Show bot uptime'),
]));

commands.push(group('player', 'Player lists, staff tools and player intelligence', [
  s=>s.setName('list').setDescription('List online players'),
  s=>s.setName('count').setDescription('Show online player count'),
  s=>{const x=s.setName('find').setDescription('Find an online player');return strOpt(x,'identifier','Player name or identifier');},
  s=>{const x=s.setName('lookup').setDescription('Look up a player in tracked statistics');return strOpt(x,'identifier','Player name');},
  s=>{const x=s.setName('stats').setDescription('Show tracked player stats');return strOpt(x,'identifier','Player name');},
  s=>s.setName('recent').setDescription('Show recent player activity'),
  s=>s.setName('snapshot').setDescription('Save the current online player snapshot'),
  s=>s.setName('ban-list').setDescription('Show Nitrado ban list'),
  s=>{const x=s.setName('ban-add').setDescription('Add identifier to Nitrado ban list');return strOpt(x,'identifier','Identifier');},
  s=>{const x=s.setName('ban-remove').setDescription('Remove identifier from Nitrado ban list');return strOpt(x,'identifier','Identifier');},
  s=>s.setName('whitelist').setDescription('Show Nitrado whitelist'),
  s=>{const x=s.setName('whitelist-add').setDescription('Add identifier to whitelist');return strOpt(x,'identifier','Identifier');},
  s=>{const x=s.setName('whitelist-remove').setDescription('Remove identifier from whitelist');return strOpt(x,'identifier','Identifier');},
  s=>s.setName('priority').setDescription('Show Nitrado priority list'),
  s=>{const x=s.setName('priority-add').setDescription('Add identifier to priority list');return strOpt(x,'identifier','Identifier');},
  s=>{const x=s.setName('priority-remove').setDescription('Remove identifier from priority list');return strOpt(x,'identifier','Identifier');},
  s=>{const x=s.setName('watch-add').setDescription('Add a player to the watchlist');return strOpt(x,'identifier','Player name or identifier');},
  s=>{const x=s.setName('watch-remove').setDescription('Remove a player from watchlist');return strOpt(x,'identifier','Player name or identifier');},
  s=>s.setName('watch-list').setDescription('Show the watchlist'),
  s=>{const x=s.setName('note-set').setDescription('Save a private staff note');strOpt(x,'identifier','Player name or identifier');return strOpt(x,'note','Note text',true,1500);},
  s=>{const x=s.setName('note-get').setDescription('Read a staff note');return strOpt(x,'identifier','Player name or identifier');},
  s=>{const x=s.setName('note-remove').setDescription('Remove a staff note');return strOpt(x,'identifier','Player name or identifier');},
  s=>{const x=s.setName('report').setDescription('Create a player report');strOpt(x,'subject','Reported player');return strOpt(x,'details','Report details',true,1500);},
  s=>s.setName('reports').setDescription('List open player reports'),
  s=>{const x=s.setName('report-close').setDescription('Close a player report');return intOpt(x,'id','Report number',true,1,999999);},
]));

commands.push(group('settings', 'Nitrado settings management', [
  s=>s.setName('list').setDescription('List available settings'),
  s=>s.setName('sets').setDescription('List settings sets'),
  s=>s.setName('defaults').setDescription('Show default settings'),
  s=>{const x=s.setName('get').setDescription('Get a setting value');strOpt(x,'category','Setting category');return strOpt(x,'key','Setting key');},
  s=>{const x=s.setName('set').setDescription('Change a setting value');strOpt(x,'category','Setting category');strOpt(x,'key','Setting key');return strOpt(x,'value','New value');},
  s=>s.setName('server').setDescription('Show current active settings'),
]));

commands.push(group('file', 'Nitrado file browser and log tools', [
  s=>{const x=s.setName('list').setDescription('List a remote directory');return strOpt(x,'directory','Remote directory',false);},
  s=>{const x=s.setName('search').setDescription('Search remote files');return strOpt(x,'query','Search text');},
  s=>{const x=s.setName('tail').setDescription('Read the end of a file');strOpt(x,'path','Remote path');return intOpt(x,'bytes','Bytes',false,1,50000);},
  s=>{const x=s.setName('head').setDescription('Read the beginning of a file');strOpt(x,'path','Remote path');return intOpt(x,'bytes','Bytes',false,1,50000);},
  s=>{const x=s.setName('read').setDescription('Read a text file');strOpt(x,'path','Remote path');return intOpt(x,'bytes','Maximum bytes',false,1,50000);},
  s=>{const x=s.setName('size').setDescription('Get file size');return strOpt(x,'path','Remote path');},
  s=>{const x=s.setName('stat').setDescription('Get file metadata');return strOpt(x,'path','Remote path');},
  s=>{const x=s.setName('download').setDescription('Download a remote file to Discord');return strOpt(x,'path','Remote path');},
  s=>{const x=s.setName('upload').setDescription('Upload a Discord attachment to the server');strOpt(x,'directory','Remote directory');return x.addAttachmentOption(o=>o.setName('file').setDescription('File to upload').setRequired(true));},
  s=>{const x=s.setName('delete').setDescription('Delete a remote file');return strOpt(x,'path','Remote path');},
  s=>{const x=s.setName('move').setDescription('Move a remote file');strOpt(x,'source','Source path');return strOpt(x,'destination','Destination path');},
  s=>{const x=s.setName('copy').setDescription('Copy a remote file');strOpt(x,'source','Source path');return strOpt(x,'destination','Destination path');},
  s=>{const x=s.setName('mkdir').setDescription('Create a remote directory');return strOpt(x,'directory','Remote directory');},
  s=>s.setName('logs').setDescription('Discover likely DayZ log files'),
  s=>s.setName('bookmarks').setDescription('Show Nitrado file bookmarks'),
]));

commands.push(group('backup', 'Nitrado backup information', [
  s=>s.setName('list').setDescription('List available backups'),
  s=>s.setName('count').setDescription('Count available backups'),
  s=>s.setName('info').setDescription('Show backup response details'),
  s=>s.setName('reminder').setDescription('Show backup-management reminder'),
]));

commands.push(group('feed', 'Live DayZ log feeds', [
  s=>s.setName('status').setDescription('Show feed status'),
  s=>s.setName('discover').setDescription('Discover likely DayZ log files'),
  s=>s.setName('start').setDescription('Start live log feeds'),
  s=>s.setName('stop').setDescription('Stop live log feeds'),
  s=>{const x=s.setName('test').setDescription('Test log parsing');return strOpt(x,'type','Event type',false);},
  s=>{const x=s.setName('file-add').setDescription('Add a log file to live feeds');return strOpt(x,'path','Remote log path');},
  s=>{const x=s.setName('file-remove').setDescription('Remove a log file from feeds');return strOpt(x,'path','Remote log path');},
  s=>s.setName('file-list').setDescription('List feed files'),
  s=>{const x=s.setName('channel').setDescription('Set a feed channel');strOpt(x,'type','Feed type');return channelOpt(x);},
  s=>s.setName('channels').setDescription('Show feed channel mapping'),
  s=>s.setName('clear').setDescription('Clear feed channel mapping'),
  s=>{const x=s.setName('last').setDescription('Show recent parsed events');return intOpt(x,'count','Number of events',false,1,25);},
  s=>s.setName('kill').setDescription('Show recent kill events'),
  s=>s.setName('pvp').setDescription('Show recent PvP events'),
  s=>s.setName('hit').setDescription('Show recent hit events'),
  s=>s.setName('death').setDescription('Show recent death events'),
  s=>s.setName('build').setDescription('Show recent build events'),
  s=>s.setName('placement').setDescription('Show recent placement events'),
  s=>s.setName('join').setDescription('Show recent join events'),
  s=>s.setName('leave').setDescription('Show recent leave events'),
  s=>s.setName('watch').setDescription('Show recent watched-player events'),
]));

commands.push(group('stats', 'Red Dawn tracking and leaderboards', [
  s=>s.setName('leaderboard').setDescription('Show the top tracked players'),
  s=>s.setName('kills').setDescription('Show top kill leaders'),
  s=>s.setName('deaths').setDescription('Show top death counts'),
  s=>s.setName('kd').setDescription('Show best tracked K/D'),
  s=>s.setName('hits').setDescription('Show top hit counts'),
  s=>s.setName('activity').setDescription('Show most active tracked players'),
  s=>{const x=s.setName('player').setDescription('Show stats for a player');return strOpt(x,'identifier','Player name');},
  s=>s.setName('reset').setDescription('Reset local tracked stats'),
  s=>s.setName('export').setDescription('Export tracked stats as JSON'),
]));

commands.push(group('moderation', 'Discord moderation and staff controls', [
  s=>{const x=s.setName('clear').setDescription('Delete recent messages');return intOpt(x,'amount','Messages',true,1,100);},
  s=>{const x=s.setName('slowmode').setDescription('Set channel slowmode');return intOpt(x,'seconds','Seconds',true,0,21600);},
  s=>s.setName('lock').setDescription('Lock the current channel'),
  s=>s.setName('unlock').setDescription('Unlock the current channel'),
  s=>{const x=s.setName('timeout').setDescription('Timeout a member');memberOpt(x);return intOpt(x,'minutes','Minutes',true,1,40320);},
  s=>{const x=s.setName('warn').setDescription('Warn a member');memberOpt(x);return strOpt(x,'reason','Reason',true,1000);},
  s=>{const x=s.setName('warnings').setDescription('Show warnings for a member');return x.addUserOption(o=>o.setName('member').setDescription('Discord member').setRequired(true));},
  s=>{const x=s.setName('unwarn').setDescription('Clear warnings for a member');return x.addUserOption(o=>o.setName('member').setDescription('Discord member').setRequired(true));},
  s=>{const x=s.setName('kick').setDescription('Kick a member');memberOpt(x);return strOpt(x,'reason','Reason',false,500);},
  s=>{const x=s.setName('ban').setDescription('Ban a member');memberOpt(x);return strOpt(x,'reason','Reason',false,500);},
  s=>{const x=s.setName('unban').setDescription('Unban a user ID');return strOpt(x,'userid','Discord user ID');},
  s=>s.setName('audit').setDescription('Show recent Red Dawn staff actions'),
  s=>{const x=s.setName('set-admin-role').setDescription('Set Red Dawn admin role');return x.addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true));},
  s=>{const x=s.setName('set-mod-role').setDescription('Set Red Dawn moderator role');return x.addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true));},
]));

commands.push(group('community', 'Red Dawn community tools', [
  s=>{const x=s.setName('announce').setDescription('Post a formatted announcement');return strOpt(x,'message','Message',true,1800);},
  s=>{const x=s.setName('poll').setDescription('Create a simple poll');strOpt(x,'question','Poll question',true,300);return strOpt(x,'options','Options separated by |',true,800);},
  s=>{const x=s.setName('ticket').setDescription('Open a support ticket record');return strOpt(x,'subject','Ticket subject');},
  s=>{const x=s.setName('ticket-close').setDescription('Close your latest ticket');return intOpt(x,'id','Ticket ID',true,1,999999);},
  s=>{const x=s.setName('event').setDescription('Create a community event');strOpt(x,'name','Event name');return strOpt(x,'when','When');},
  s=>s.setName('events').setDescription('List community events'),
  s=>{const x=s.setName('event-end').setDescription('End a community event');return intOpt(x,'id','Event ID',true,1,999999);},
  s=>{const x=s.setName('suggest').setDescription('Submit a suggestion');return strOpt(x,'suggestion','Suggestion',true,1500);},
  s=>s.setName('rules').setDescription('Post the server rules'),
  s=>s.setName('links').setDescription('Show Red Dawn links'),
  s=>s.setName('verify').setDescription('Show verification instructions'),
]));

commands.push(group('bot', 'Red Dawn Bot controls and diagnostics', [
  s=>s.setName('help').setDescription('Show command categories'),
  s=>s.setName('ping').setDescription('Check bot latency'),
  s=>s.setName('uptime').setDescription('Show bot uptime'),
  s=>s.setName('about').setDescription('Show bot version and features'),
  s=>s.setName('health').setDescription('Show bot health'),
  s=>s.setName('latency').setDescription('Show Discord and API latency'),
  s=>s.setName('config').setDescription('Show safe bot configuration'),
  s=>s.setName('cache').setDescription('Show API cache status'),
  s=>s.setName('channels').setDescription('Show configured feed channels'),
  s=>s.setName('commands').setDescription('Show command/action counts'),
]));

const GROUPS = new Set(['setup','server','player','settings','file','backup','feed','stats','moderation','community','bot']);
function actionCount() {
  return commands.reduce((n, c) => n + c.toJSON().options.filter(o => o.type === 1 || o.type === 2).length || 1, 0);
}
function commandHelpText() {
  return [
    '**🌅 RED DAWN BOT**',
    '`/setup` — secure per-server Nitrado connection and permissions',
    '`/server` — Nitrado/server controls',
    '`/player` — players, lists, watchlist and staff tools',
    '`/settings` — Nitrado settings',
    '`/file` — file browser and logs',
    '`/backup` — backup information',
    '`/feed` — live DayZ feeds',
    '`/stats` — tracked PvP/player stats',
    '`/moderation` — Discord staff tools',
    '`/community` — announcements, events, tickets',
    '`/bot` — diagnostics and configuration',
    '',
    'Direct shortcuts: `/ping`, `/status`, `/players`, `/nitrado`, `/help`',
  ].join('\n');
}

async function replyServerStatus(i) {
  const data = await getServer(true);
  const gs = data?.data?.gameserver || {};
  const q = gs.query || {};
  const embed = new EmbedBuilder()
    .setTitle('🌅 Red Dawn Server')
    .addFields(
      { name: 'Status', value: safe(gs.status || 'Unknown', 80), inline: true },
      { name: 'Server', value: safe(q.server_name || gs.service_name || 'Unknown', 200), inline: true },
      { name: 'Players', value: `${q.player_current ?? 0}/${q.player_max ?? 0}`, inline: true },
      { name: 'Map', value: safe(q.map || 'Unknown', 100), inline: true },
      { name: 'Address', value: safe(`${q.ip || q.hostname || 'Unknown'}${q.port ? `:${q.port}` : ''}`, 100), inline: true },
      { name: 'Maintenance', value: config.maintenance ? '🛠️ ON' : '✅ OFF', inline: true },
    )
    .setTimestamp();
  return i.reply({ embeds: [embed] });
}
async function playersText() {
  const p = (await getPlayers(true)).data?.players || [];
  if (!p.length) return '👤 **No players are currently online.**';
  const names = p.slice(0, 100).map((x, n) => `${n + 1}. **${safe(x.name || x.username || 'Unknown', 100)}**`).join('\n');
  return `👥 **${p.length} online**\n\n${names}`;
}

async function handleGroup(i, root, sc) {
  if (root === 'setup') {
    if (['connect','import-env','disconnect','admin-role'].includes(sc)) {
      if (!(await requireOwner(i))) return;
    } else if (!(await requireAdmin(i))) {
      return;
    }
    if (sc === 'connect') {
      const modal = new ModalBuilder().setCustomId('setup_connect').setTitle('Connect Nitrado to this server');
      const serviceInput = new TextInputBuilder().setCustomId('service_id').setLabel('Nitrado Service ID').setPlaceholder('Example: 12345678').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30);
      const tokenInput = new TextInputBuilder().setCustomId('token').setLabel('Nitrado API / Long-life Token').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500);
      modal.addComponents(new ActionRowBuilder().addComponents(serviceInput), new ActionRowBuilder().addComponents(tokenInput));
      return i.showModal(modal);
    }
    if (sc === 'import-env') {
      const token = String(process.env.NITRADO_TOKEN || '').trim();
      const sid = String(process.env.NITRADO_SERVICE_ID || '').trim();
      if (!token || !sid) return i.reply(eph('❌ Legacy NITRADO_TOKEN/NITRADO_SERVICE_ID are not present in Render.'));
      const data = await testNitradoCredentials(token, sid);
      config.nitradoToken = token;
      config.nitradoServiceId = sid;
      config.setupCompletedAt = Date.now();
      audit(i.user.tag, 'setup-import-env', { serviceId: sid });
      return i.reply(eph(`✅ Imported the Nitrado connection for service \`${sid}\`. You can now remove the legacy NITRADO_TOKEN and NITRADO_SERVICE_ID from Render.\nServer: **${safe(data?.data?.gameserver?.query?.server_name || data?.data?.gameserver?.service_name || 'Connected')}**`));
    }
    if (sc === 'disconnect') {
      config.nitradoToken = '';
      config.nitradoServiceId = '';
      config.setupCompletedAt = null;
      config.feedsEnabled = false;
      stopFeeds();
      audit(i.user.tag, 'setup-disconnect');
      return i.reply(eph('✅ Nitrado credentials removed from this server\'s encrypted configuration.'));
    }
    if (sc === 'status') {
      return i.reply(eph(`🔐 **Red Dawn Security Status**\nNitrado: **${config.nitradoToken && config.nitradoServiceId ? 'CONNECTED' : 'NOT CONNECTED'}**\nService ID: ${config.nitradoServiceId ? `\`${config.nitradoServiceId}\`` : '—'}\nAdmin role: ${config.adminRoleId ? `<@&${config.adminRoleId}>` : 'Administrator / server owner'}\nDatabase-backed configuration: **ON**\nSecrets encrypted at rest: **ON**`));
    }
    if (sc === 'admin-role') {
      const role = i.options.getRole('role', true);
      config.adminRoleId = role.id;
      audit(i.user.tag, 'setup-admin-role', { role: role.id });
      return i.reply(eph(`✅ Red Dawn admin role set to <@&${role.id}>.`));
    }
    if (sc === 'test') {
      const started = Date.now();
      const data = await getServer(true);
      return i.reply(eph(`✅ Nitrado connection works.\nService: \`${serviceId()}\`\nServer: **${safe(data?.data?.gameserver?.query?.server_name || data?.data?.gameserver?.service_name || 'Connected')}**\nLatency: **${Date.now() - started} ms**`));
    }
    if (sc === 'security') {
      return i.reply(eph('🔒 **Red Dawn Security**\n• Each Discord server has its own Nitrado credentials.\n• Nitrado configuration is encrypted before it is stored in Postgres.\n• Only the server owner, Administrator, or configured Red Dawn admin role can manage Nitrado actions.\n• Bot tokens are never returned by commands.'));
    }
  }

  if (root === 'server') {
    if (['status','dashboard'].includes(sc)) return replyServerStatus(i);
    if (sc === 'info') return i.reply(eph(safe(JSON.stringify((await getServer(true))?.data?.gameserver || {}, null, 2), 1900)));
    if (sc === 'players') return i.reply(await playersText());
    if (sc === 'services') { const d=await getServices(); const services=d?.data?.services||[]; return i.reply(services.length?services.map(s=>`• **${safe(s.details?.name||'Unknown',100)}** — ID: \`${s.id}\``).join('\n'):'No services returned.'); }
    if (sc === 'service') { const d=await getServer(); const gs=d?.data?.gameserver||{}; return i.reply(`🖥️ **Service:** \`${serviceId()}\`\nName: **${safe(gs.service_name||gs.query?.server_name||'Unknown')}**`); }
    if (sc === 'notifications') return i.reply(eph(safe(JSON.stringify((await getNotifications())?.data || {}, null, 2), 1900)));
    const data = await getServer(true); const q=data?.data?.gameserver?.query||{};
    if (sc === 'ip') return i.reply(`🌐 **${safe(q.ip||q.hostname||'Unknown')}${q.port?`:${q.port}`:''}**`);
    if (sc === 'map') return i.reply(`🗺️ **${safe(q.map||'Unknown')}**`);
    if (sc === 'slots') return i.reply(`👥 **${q.player_max ?? 0}** slots`);
    if (sc === 'online') return i.reply(`🟢 **${q.player_current ?? 0}** players online`);
    if (sc === 'refresh') { apiCache.clear(); return i.reply('♻️ Nitrado cache cleared.'); }
    if (sc === 'health') { const t=Date.now(); await getServer(true); return i.reply(`✅ Nitrado server query OK — **${Date.now()-t} ms**`); }
    if (sc === 'latency') { const t=Date.now(); await getServer(true); return i.reply(`📡 Nitrado API latency: **${Date.now()-t} ms**`); }
    if (['start','stop','restart'].includes(sc)) {
      if (!(await requireAdmin(i))) return;
      const id=queueAction(i.guild.id,i.user.id, sc); return i.reply({ ...eph(`⚠️ Confirm **${sc}** on Nitrado server \`${serviceId()}\`?`), components:[confirmButtons(id)] });
    }
    if (sc === 'maintenance') {
      if (!(await requireAdmin(i))) return;
      config.maintenance=i.options.getBoolean('enabled',true); saveJson(CONFIG_PATH,config); audit(i.user.tag,'maintenance',{enabled:config.maintenance});
      return i.reply(`🛠️ Maintenance mode: **${config.maintenance?'ON':'OFF'}**`);
    }
    if (sc === 'announce') {
      if (!(await requireMod(i))) return;
      const message=i.options.getString('message',true); await i.channel.send({embeds:[new EmbedBuilder().setTitle('🌅 RED DAWN ANNOUNCEMENT').setDescription(safe(message,1800)).setTimestamp()]}); audit(i.user.tag,'announce'); return i.reply(eph('✅ Announcement posted.'));
    }
    if (sc === 'schedule-restart') { if(!(await requireAdmin(i)))return; const min=i.options.getInteger('minutes',true); const when=Date.now()+min*60000; config.scheduledRestartAt=when; saveJson(CONFIG_PATH,config); scheduleOneShot(); return i.reply(eph(`🔄 Restart scheduled for <t:${Math.floor(when/1000)}:F> (<t:${Math.floor(when/1000)}:R>).`)); }
    if (sc === 'cancel-restart') { if(!(await requireAdmin(i)))return; config.scheduledRestartAt=null; saveJson(CONFIG_PATH,config); clearScheduled('one'); return i.reply(eph('✅ One-time restart cancelled.')); }
    if (sc === 'auto-restart') { if(!(await requireAdmin(i)))return; const hour=i.options.getInteger('hour',true); config.recurringRestart={hourUtc:hour}; saveJson(CONFIG_PATH,config); scheduleDaily(); return i.reply(eph(`✅ Daily restart scheduled for **${hour}:00 UTC**.`)); }
    if (sc === 'cancel-auto') { if(!(await requireAdmin(i)))return; config.recurringRestart=null; saveJson(CONFIG_PATH,config); clearScheduled('daily'); return i.reply(eph('✅ Daily restart cancelled.')); }
    if (sc === 'query') return i.reply(eph(safe(JSON.stringify(q, null, 2), 1900)));
    if (sc === 'uptime') return i.reply(`⏱️ Bot uptime: **${msDuration(Date.now()-START_TIME)}**`);
  }

  if (root === 'player') {
    if (sc === 'list') return i.reply(await playersText());
    if (sc === 'count') { const p=(await getPlayers(true)).data?.players||[]; return i.reply(`👥 **${p.length}** online`); }
    if (['find','lookup'].includes(sc)) { const q=i.options.getString('identifier',true).toLowerCase(); const p=(await getPlayers(true)).data?.players||[]; const hits=p.filter(x=>String(x.name||x.username||'').toLowerCase().includes(q)); return i.reply(hits.length?hits.map(x=>`• **${safe(x.name||x.username)}**`).join('\n'):`No online match for **${safe(q)}**.`); }
    if (sc === 'stats') { const name=i.options.getString('identifier',true); const row=stats.players[name]||{kills:0,deaths:0,hits:0,joins:0,leaves:0,builds:0,placements:0}; const kd=row.deaths?((row.kills||0)/row.deaths).toFixed(2):(row.kills||0).toFixed(2); return i.reply(`📊 **${safe(name)}**\n☠️ Kills: **${row.kills||0}**\n💀 Deaths: **${row.deaths||0}**\n🎯 Hits: **${row.hits||0}**\n🟢 Joins: **${row.joins||0}**\n🔴 Leaves: **${row.leaves||0}**\n🔨 Builds: **${row.builds||0}**\n📦 Placements: **${row.placements||0}**\n📈 K/D: **${kd}**`); }
    if (sc === 'recent') { const p=stats.lastPlayerSnapshot||[]; return i.reply(p.length?`👥 **Last snapshot**\n${p.map((x,n)=>`${n+1}. ${safe(x,120)}`).join('\n')}`:'No player snapshot recorded yet.'); }
    if (sc === 'snapshot') { const p=(await getPlayers(true)).data?.players||[]; stats.lastPlayerSnapshot=p.map(x=>x.name||x.username||String(x)); saveJson(STATS_PATH,stats); return i.reply(`📸 Saved snapshot of **${p.length}** online players.`); }
    if (['ban-list','whitelist','priority'].includes(sc)) { const lists=await getCurrentLists(); const arr=lists[sc==='ban-list'?'bans':sc]||[]; return i.reply(eph(arr.length?`**${sc} (${arr.length})**\n${arr.slice(0,100).map(x=>`• \`${safe(x,120)}\``).join('\n')}`:`**${sc}** is empty.`)); }
    if (['ban-add','ban-remove','whitelist-add','whitelist-remove','priority-add','priority-remove'].includes(sc)) {
      if (!(await requireAdmin(i))) return;
      const map={bans:'ban',whitelist:'whitelist',priority:'priority'}; const listType=sc.startsWith('ban-')?'bans':sc.startsWith('whitelist-')?'whitelist':'priority'; const actionName=sc.endsWith('-add')?'add':'remove'; const id=i.options.getString('identifier',true); await modifyList(listType,actionName,id); audit(i.user.tag,`${listType}-${actionName}`,{identifier:id}); return i.reply(eph(`✅ ${actionName}ed **${safe(id)}** ${actionName==='add'?'to':'from'} ${map[listType]||listType}.`));
    }
    if (sc === 'watch-add') { if(!(await requireMod(i)))return; const id=i.options.getString('identifier',true); if(!config.watchlist.includes(id))config.watchlist.push(id);saveJson(CONFIG_PATH,config);audit(i.user.tag,'watch-add',{identifier:id});return i.reply(eph(`👀 Watching **${safe(id)}**.`)); }
    if (sc === 'watch-remove') { if(!(await requireMod(i)))return; const id=i.options.getString('identifier',true); config.watchlist=config.watchlist.filter(x=>x.toLowerCase()!==id.toLowerCase());saveJson(CONFIG_PATH,config);audit(i.user.tag,'watch-remove',{identifier:id});return i.reply(eph(`👀 Removed **${safe(id)}** from watchlist.`)); }
    if (sc === 'watch-list') return i.reply(config.watchlist.length?`👀 **Watchlist**\n${config.watchlist.map(x=>`• ${safe(x)}`).join('\n')}`:'👀 Watchlist is empty.');
    if (sc === 'note-set') { if(!(await requireMod(i)))return; const id=i.options.getString('identifier',true);const note=i.options.getString('note',true);config.notes[id]={note,by:i.user.tag,at:Date.now()};saveJson(CONFIG_PATH,config);audit(i.user.tag,'note-set',{identifier:id});return i.reply(eph(`📝 Note saved for **${safe(id)}**.`)); }
    if (sc === 'note-get') { if(!(await requireMod(i)))return; const id=i.options.getString('identifier',true); const n=config.notes[id]; return i.reply(eph(n?`📝 **${safe(id)}**\n${safe(n.note,1800)}\n\nBy ${safe(n.by)} • <t:${Math.floor(n.at/1000)}:R>`:'No note found.')); }
    if (sc === 'note-remove') { if(!(await requireMod(i)))return; const id=i.options.getString('identifier',true);delete config.notes[id];saveJson(CONFIG_PATH,config);return i.reply(eph('✅ Note removed.')); }
    if (sc === 'report') { const subject=i.options.getString('subject',true);const details=i.options.getString('details',true);const id=(config.reports.at(0)?.id||0)+1;config.reports.push({id,subject,details,by:i.user.tag,at:Date.now(),status:'open'});saveJson(CONFIG_PATH,config);return i.reply(`🚨 Report **#${id}** submitted for **${safe(subject)}**.`); }
    if (sc === 'reports') { const open=config.reports.filter(r=>r.status==='open');return i.reply(open.length?open.slice(-25).reverse().map(r=>`**#${r.id}** • ${safe(r.subject,100)} — ${safe(r.details,240)}\n<@${i.user.id}> / ${safe(r.by,80)}`).join('\n'):'✅ No open reports.'); }
    if (sc === 'report-close') { if(!(await requireMod(i)))return; const id=i.options.getInteger('id',true);const r=config.reports.find(x=>x.id===id);if(!r)return i.reply(eph('❌ Report not found.'));r.status='closed';r.closedBy=i.user.tag;r.closedAt=Date.now();saveJson(CONFIG_PATH,config);audit(i.user.tag,'report-close',{id});return i.reply(eph(`✅ Report **#${id}** closed.`)); }
  }

  if (root === 'settings') {
    if (sc === 'set' && !(await requireAdmin(i))) return;
    if (sc === 'list' || sc === 'sets') return i.reply(eph(safe(JSON.stringify(await getSettingsSets(),null,2),1900)));
    if (sc === 'defaults') return i.reply(eph(safe(JSON.stringify(await getSettingsDefaults(),null,2),1900)));
    if (sc === 'get') { const d=await getServer(true);const cat=i.options.getString('category',true), key=i.options.getString('key',true);const value=d?.data?.gameserver?.settings?.[cat]?.[key];return i.reply(eph(`⚙️ **${cat}.${key}**\n\`${safe(JSON.stringify(value ?? null),1600)}\``)); }
    if (sc === 'set') { const cat=i.options.getString('category',true),key=i.options.getString('key',true),value=i.options.getString('value',true);await updateSetting(cat,key,value);audit(i.user.tag,'setting-set',{cat,key});return i.reply(eph(`✅ Updated **${cat}.${key}**.`)); }
    if (sc === 'server') return i.reply(eph(safe(JSON.stringify((await getServer(true))?.data?.gameserver?.settings||{},null,2),1900)));
  }

  if (root === 'file') {
    const adminOps=['delete','move','copy','mkdir','download','upload']; if(adminOps.includes(sc) && !(await requireAdmin(i)))return;
    if (sc === 'list') { const d=i.options.getString('directory',false)||'';return i.reply(eph(safe(JSON.stringify(await fileList(d),null,2),1900))); }
    if (sc === 'search') { const q=i.options.getString('query',true);return i.reply(eph(safe(JSON.stringify(await fileList('',q),null,2),1900))); }
    if (['tail','head','read'].includes(sc)) { const p=validateRemotePath(i.options.getString('path',true));const bytes=i.options.getInteger('bytes',false)||16000;let c;if(sc==='head')c=await fileSeek(p,0,bytes,'raw');else if(sc==='tail')c=await fileSeek(p,-bytes,bytes,'raw');else c=await fileSeek(p,0,bytes,'raw');return i.reply({content:`\`${p}\`\n\n${safe(String(c),1900)}`}); }
    if (sc === 'size') { const p=validateRemotePath(i.options.getString('path',true));return i.reply(eph(safe(JSON.stringify(await fileSize(p),null,2),1900))); }
    if (sc === 'stat') { const p=validateRemotePath(i.options.getString('path',true));return i.reply(eph(safe(JSON.stringify(await fileStat(p),null,2),1900))); }
    if (sc === 'download') { const p=validateRemotePath(i.options.getString('path',true));const buf=await fileDownload(p);if(buf.length>8*1024*1024)throw new Error('File is larger than Discord upload limit for this bot. Use /file tail instead.');return i.reply({content:`📥 **${safe(p)}**`,files:[new AttachmentBuilder(buf,{name:path.basename(p)})]}); }
    if (sc === 'upload') { const dir=validateRemotePath(i.options.getString('directory',true));const attachment=i.options.getAttachment('file',true);const name=path.posix.basename(new URL(attachment.url).pathname)||'upload.bin';const r=await fetch(attachment.url,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('Could not download the Discord attachment.');const buf=Buffer.from(await r.arrayBuffer());if(buf.length>8*1024*1024)throw new Error('Attachment is larger than 8 MB.');await fileUpload(dir,name,buf);audit(i.user.tag,'file-upload',{directory:dir,name});return i.reply(eph(`✅ Uploaded **${name}** to **${dir}**.`)); }
    if (sc === 'delete') { const p=validateRemotePath(i.options.getString('path',true));const id=queueAction(i.user.id,'file-delete',{path:p});return i.reply({ ...eph(`⚠️ Confirm delete **${p}**?`),components:[confirmButtons(id)] }); }
    if (sc === 'move') { const a=validateRemotePath(i.options.getString('source',true)),b=validateRemotePath(i.options.getString('destination',true));await fileMove(a,b);audit(i.user.tag,'file-move',{source:a,destination:b});return i.reply(eph('✅ File moved.')); }
    if (sc === 'copy') { const a=validateRemotePath(i.options.getString('source',true)),b=validateRemotePath(i.options.getString('destination',true));await fileCopy(a,b);audit(i.user.tag,'file-copy',{source:a,destination:b});return i.reply(eph('✅ File copied.')); }
    if (sc === 'mkdir') { const d=validateRemotePath(i.options.getString('directory',true));await fileMkdir(d);audit(i.user.tag,'file-mkdir',{directory:d});return i.reply(eph('✅ Directory created.')); }
    if (sc === 'logs' || sc === 'bookmarks') { if(sc==='logs')return i.reply(eph((await discoverLogs()).slice(0,50).map(x=>`• \`${safe(x,160)}\``).join('\n')||'No obvious log files found.')); return i.reply(eph(safe(JSON.stringify(await nitradoRequest(`/services/${serviceId()}/gameservers/file_server/bookmarks`),null,2),1900))); }
  }

  if (root === 'backup') {
    const d=await getBackups(); const b=d?.data?.backups||d?.data||[]; if(sc==='list')return i.reply(eph(safe(JSON.stringify(b,null,2),1900)));if(sc==='count'){const a=Array.isArray(b)?b:Object.values(b||{});return i.reply(`💾 **${a.length}** backup records returned.`);}if(sc==='info')return i.reply(eph(safe(JSON.stringify(d,null,2),1900)));if(sc==='reminder')return i.reply('💾 Backup management is safest through the Nitrado panel. This bot currently exposes backup listing/info only.');
  }

  if (root === 'feed') {
    if (['start','stop'].includes(sc)) { if(!(await requireAdmin(i)))return; if(sc==='start'){ if(!config.feedFiles.length)return i.reply(eph('❌ Add a log file first with `/feed file-add`.'));await startFeeds();return i.reply(eph('📡 Live feeds started.')); } stopFeeds();return i.reply(eph('🛑 Live feeds stopped.')); }
    if (sc === 'status') return i.reply(`📡 Feeds: **${config.feedsEnabled?'RUNNING':'STOPPED'}**\nFiles: **${config.feedFiles.length}**\nInterval: **${Math.max(5000,config.feedIntervalMs)} ms**\nChannels: **${Object.keys(config.feedChannels).length}**`);
    if (sc === 'discover') return i.reply(eph((await discoverLogs()).slice(0,75).map(x=>`• \`${safe(x,160)}\``).join('\n')||'No obvious log files found.'));
    if (sc === 'test') { const samples={kill:'Player Alice killed Player Bob with weapon M4.',pvp:'Player Alice hit player Bob with a rifle.',hit:'Player Alice hit player Bob.',build:'Player Alice built a wall.',placement:'Player Alice placed an object.',join:'Player Alice connected.',leave:'Player Alice disconnected.'};const type=i.options.getString('type',false)||'kill';const evt=parseLogLine(samples[type]||samples.kill);evt.line=`TEST: ${samples[type]||samples.kill}`;return i.reply({embeds:[formatFeedEvent(evt)],flags:MessageFlags.Ephemeral}); }
    if (sc === 'file-add') { if(!(await requireAdmin(i)))return;const p=validateRemotePath(i.options.getString('path',true));if(!config.feedFiles.includes(p))config.feedFiles.push(p);saveJson(CONFIG_PATH,config);return i.reply(eph('✅ Added `' + p + '` to feeds.')); }
    if (sc === 'file-remove') { if(!(await requireAdmin(i)))return;const p=validateRemotePath(i.options.getString('path',true));config.feedFiles=config.feedFiles.filter(x=>x!==p);saveJson(CONFIG_PATH,config);return i.reply(eph('✅ Feed file removed.')); }
    if (sc === 'file-list') return i.reply(eph(config.feedFiles.length?config.feedFiles.map(x=>`• \`${safe(x,180)}\``).join('\n'):'No feed files configured.'));
    if (sc === 'channel') { if(!(await requireAdmin(i)))return;const type=i.options.getString('type',true).toLowerCase();const ch=i.options.getChannel('channel',true);config.feedChannels[type]=ch.id;saveJson(CONFIG_PATH,config);audit(i.user.tag,'feed-channel',{type,channel:ch.id});return i.reply(eph(`✅ **${type}** feed → <#${ch.id}>`)); }
    if (sc === 'channels') return i.reply(eph(Object.keys(config.feedChannels).length?Object.entries(config.feedChannels).map(([k,v])=>`• **${k}** → <#${v}>`).join('\n'):'No feed channels configured.'));
    if (sc === 'clear') {if(!(await requireAdmin(i)))return;config.feedChannels={};saveJson(CONFIG_PATH,config);return i.reply(eph('✅ Feed channels cleared.'));}
    const typeMap={last:null,kill:'kill',pvp:'pvp',hit:'hit',death:'kill',build:'build',placement:'placement',join:'join',leave:'leave',watch:'watch'};if(typeMap[sc]!==undefined){let arr=stats.lastEvents||[];if(sc==='watch')arr=arr.filter(isWatched);else if(typeMap[sc])arr=arr.filter(x=>x.type===typeMap[sc]);arr=arr.slice(0,15);return i.reply(eph(arr.length?arr.map(x=>`**${x.type.toUpperCase()}** • ${safe(x.line,220)}`).join('\n'):'No matching events recorded.'));}
  }

  if (root === 'stats') {
    const entries=Object.entries(stats.players||{}).map(([name,row])=>({name,row}));
    if(sc==='reset'){if(!(await requireAdmin(i)))return;stats=DEFAULT_STATS;saveJson(STATS_PATH,stats);return i.reply(eph('🧹 Local tracked statistics reset.'));}
    if(sc==='export'){if(!(await requireAdmin(i)))return;const buf=Buffer.from(JSON.stringify(stats,null,2));return i.reply({content:'📦 Tracked stats export',files:[new AttachmentBuilder(buf,{name:'red-dawn-stats.json'})],flags:MessageFlags.Ephemeral});}
    const sorted=(fn)=>entries.sort((a,b)=>fn(b.row)-fn(a.row)).slice(0,10);
    let list=[];
    if(sc==='leaderboard'||sc==='kills') list=sorted(r=>(r.kills||0));
    else if(sc==='deaths') list=sorted(r=>(r.deaths||0));
    else if(sc==='hits') list=sorted(r=>(r.hits||0));
    else if(sc==='activity') list=sorted(r=>(r.joins||0)+(r.leaves||0)+(r.hits||0));
    else if(sc==='kd') list=sorted(r=>(r.deaths?r.kills/r.deaths:r.kills||0));
    if(list.length)return i.reply(`🏆 **${sc.toUpperCase()}**\n${list.map((x,n)=>`${n+1}. **${safe(x.name,80)}** — K:${x.row.kills||0} D:${x.row.deaths||0} H:${x.row.hits||0} K/D:${x.row.deaths?((x.row.kills||0)/x.row.deaths).toFixed(2):((x.row.kills||0).toFixed(2))}`).join('\n')}`);
    if(sc==='player'){const n=i.options.getString('identifier',true);const r=stats.players[n]||{kills:0,deaths:0,hits:0,joins:0,leaves:0,builds:0,placements:0};return i.reply(`📊 **${safe(n)}**\n☠️ ${r.kills||0} kills • 💀 ${r.deaths||0} deaths • 🎯 ${r.hits||0} hits • 🟢 ${r.joins||0} joins • 🔴 ${r.leaves||0} leaves`);}
  }

  if (root === 'moderation') {
    if(!(await requireMod(i)))return;
    if(sc==='clear'){const n=i.options.getInteger('amount',true);if(!i.channel?.bulkDelete)return i.reply(eph('❌ This channel does not support bulk delete.'));const deleted=await i.channel.bulkDelete(n,true);audit(i.user.tag,'clear',{count:deleted.size});return i.reply(eph(`🧹 Deleted **${deleted.size}** messages.`));}
    if(sc==='slowmode'){const s=i.options.getInteger('seconds',true);await i.channel.setRateLimitPerUser(s);return i.reply(eph(`🐌 Slowmode set to **${s}s**.`));}
    if(sc==='lock'||sc==='unlock'){await i.channel.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:sc==='unlock'?null:false});audit(i.user.tag,sc);return i.reply(eph(sc==='lock'?'🔒 Channel locked.':'🔓 Channel unlocked.'));}
    if(sc==='timeout'){const m=i.options.getUser('member',true),mins=i.options.getInteger('minutes',true);const member=await i.guild.members.fetch(m.id);await member.timeout(mins*60000,`Red Dawn timeout by ${i.user.tag}`);return i.reply(eph(`⏳ Timed out **${m.tag}** for **${mins} minutes**.`));}
    if(sc==='warn'){const m=i.options.getUser('member',true),reason=i.options.getString('reason',true);config.warnings[m.id]=config.warnings[m.id]||[];config.warnings[m.id].push({reason,by:i.user.tag,at:Date.now()});saveJson(CONFIG_PATH,config);return i.reply(eph(`⚠️ Warned **${m.tag}**.`));}
    if(sc==='warnings'){const m=i.options.getUser('member',true);const arr=config.warnings[m.id]||[];return i.reply(eph(arr.length?arr.map((x,n)=>`${n+1}. ${safe(x.reason,300)} — ${safe(x.by,80)} <t:${Math.floor(x.at/1000)}:R>`).join('\n'):'No warnings.'));}
    if(sc==='unwarn'){const m=i.options.getUser('member',true);delete config.warnings[m.id];saveJson(CONFIG_PATH,config);return i.reply(eph('✅ Warnings cleared.'));}
    if(sc==='kick'){const u=i.options.getUser('member',true);const member=await i.guild.members.fetch(u.id);await member.kick(i.options.getString('reason',false)||`Red Dawn by ${i.user.tag}`);audit(i.user.tag,'kick',{user:u.id});return i.reply(eph(`👢 Kicked **${u.tag}**.`));}
    if(sc==='ban'){const u=i.options.getUser('member',true);await i.guild.members.ban(u.id,{reason:i.options.getString('reason',false)||`Red Dawn by ${i.user.tag}`});audit(i.user.tag,'ban',{user:u.id});return i.reply(eph(`🔨 Banned **${u.tag}**.`));}
    if(sc==='unban'){const id=i.options.getString('userid',true);await i.guild.members.unban(id,`Red Dawn by ${i.user.tag}`);return i.reply(eph(`✅ Unbanned **${id}**.`));}
    if(sc==='audit'){const a=config.audit||[];return i.reply(eph(a.length?a.slice(0,20).map(x=>`• **${safe(x.action,80)}** — ${safe(x.actor,80)} <t:${Math.floor(x.at/1000)}:R>`).join('\n'):'No audit entries.'));}
    if(sc==='set-admin-role'){const role=i.options.getRole('role',true);config.adminRoleId=role.id;saveJson(CONFIG_PATH,config);audit(i.user.tag,'set-admin-role',{role:role.id});return i.reply(eph(`✅ Admin role set to <@&${role.id}>.`));}
    if(sc==='set-mod-role'){const role=i.options.getRole('role',true);config.modRoleId=role.id;saveJson(CONFIG_PATH,config);audit(i.user.tag,'set-mod-role',{role:role.id});return i.reply(eph(`✅ Moderator role set to <@&${role.id}>.`));}
  }

  if(root==='community'){
    if(sc==='announce'){if(!(await requireMod(i)))return;const msg=i.options.getString('message',true);await i.channel.send({embeds:[new EmbedBuilder().setTitle('🌅 RED DAWN').setDescription(safe(msg,1800)).setTimestamp()]});return i.reply(eph('✅ Posted.'));}
    if(sc==='poll'){if(!(await requireMod(i)))return;const q=i.options.getString('question',true), opts=i.options.getString('options',true).split('|').map(x=>x.trim()).filter(Boolean).slice(0,10);if(!opts.length)return i.reply(eph('❌ No options provided.'));const letters='🇦🇧🇨🇩🇪🇫🇬🇭🇮🇯';const msg=await i.channel.send({content:`📊 **${safe(q,300)}**\n${opts.map((x,n)=>`${letters[n]||`${n+1}.`} ${safe(x,300)}`).join('\n')}`});for(let n=0;n<opts.length;n++)await msg.react(letters[n]).catch(()=>{});return i.reply(eph('✅ Poll posted.'));}
    if(sc==='ticket'){const subject=i.options.getString('subject',true);const id=(config.reports.at(0)?.id||0)+1;config.reports.push({id,subject:`TICKET: ${subject}`,details:'Community ticket',by:i.user.tag,at:Date.now(),status:'open',type:'ticket'});saveJson(CONFIG_PATH,config);return i.reply(`🎫 Ticket **#${id}** opened.`);}
    if(sc==='ticket-close'){const id=i.options.getInteger('id',true),r=config.reports.find(x=>x.id===id&&x.type==='ticket');if(!r)return i.reply(eph('❌ Ticket not found.'));r.status='closed';r.closedBy=i.user.tag;r.closedAt=Date.now();saveJson(CONFIG_PATH,config);return i.reply(eph(`✅ Ticket **#${id}** closed.`));}
    if(sc==='event'){if(!(await requireMod(i)))return;const name=i.options.getString('name',true),when=i.options.getString('when',true);const id=(config.events.at(0)?.id||0)+1;config.events.push({id,name,when,by:i.user.tag,ended:false});saveJson(CONFIG_PATH,config);return i.reply(`📅 Event **#${id} — ${safe(name)}** created for **${safe(when)}**.`);}
    if(sc==='events'){const e=config.events.filter(x=>!x.ended);return i.reply(e.length?e.map(x=>`📅 **#${x.id} ${safe(x.name,120)}** — ${safe(x.when,120)}`).join('\n'):'No active events.');}
    if(sc==='event-end'){if(!(await requireMod(i)))return;const id=i.options.getInteger('id',true),e=config.events.find(x=>x.id===id);if(!e)return i.reply(eph('❌ Event not found.'));e.ended=true;e.endedBy=i.user.tag;saveJson(CONFIG_PATH,config);return i.reply(eph(`✅ Event **#${id}** ended.`));}
    if(sc==='suggest'){const s=i.options.getString('suggestion',true);return i.reply(`💡 Suggestion received from **${safe(i.user.tag,80)}**:\n${safe(s,1500)}`);}
    if(sc==='rules'){return i.reply(process.env.RED_DAWN_RULES||'📜 **Red Dawn Rules**\n1. No cheating/exploits.\n2. Respect staff and players.\n3. No harassment.\n4. Follow Discord and Xbox rules.');}
    if(sc==='links'){return i.reply(process.env.RED_DAWN_LINKS||'🔗 Add your Discord invite / server links in `RED_DAWN_LINKS` on Render.');}
    if(sc==='verify'){return i.reply(process.env.RED_DAWN_VERIFY||'✅ Verification instructions go here. Set `RED_DAWN_VERIFY` in Render to customize this message.');}
  }

  if(root==='bot'){
    if(sc==='help')return i.reply(commandHelpText());
    if(sc==='ping')return i.reply(`🏓 Pong — **${client.ws.ping} ms**`);
    if(sc==='uptime')return i.reply(`⏱️ **${msDuration(Date.now()-START_TIME)}**`);
    if(sc==='about')return i.reply(`🌅 **Red Dawn Bot v${VERSION}**\nFast Discord + Nitrado tooling with grouped server, player, file, feed, stats, moderation and community commands.`);
    if(sc==='health')return i.reply(`✅ Bot ready: **${client.isReady()}**\nDiscord ping: **${client.ws.ping} ms**\nNitrado: **${config.nitradoToken && config.nitradoServiceId ? 'configured' : 'not connected'}**`);
    if(sc==='latency'){const t=Date.now();let api='error';try{await getServer(true);api=`${Date.now()-t} ms`;}catch(e){api=e.message;}return i.reply(`📡 Discord: **${client.ws.ping} ms**\nNitrado: **${safe(api,200)}**`);}
    if(sc==='config'){return i.reply(eph(`⚙️ **Safe config**\nMaintenance: **${config.maintenance?'ON':'OFF'}**\nFeeds: **${config.feedsEnabled?'ON':'OFF'}**\nFeed files: **${config.feedFiles.length}**\nAdmin role: ${config.adminRoleId?`<@&${config.adminRoleId}>`:'not set'}\nMod role: ${config.modRoleId?`<@&${config.modRoleId}>`:'not set'}`));}
    if(sc==='cache'){return i.reply(`🧠 API cache entries: **${apiCache.size}**`);}
    if(sc==='channels'){return i.reply(eph(Object.keys(config.feedChannels).length?Object.entries(config.feedChannels).map(([k,v])=>`• **${k}** → <#${v}>`).join('\n'):'No feed channels configured.'));}
    if(sc==='commands'){return i.reply(`🧩 **${commands.length} top-level commands**\n⚡ **${actionCount()} grouped actions**`);}
  }
}

async function handleConfirm(i) {
  const [verb,id]=i.customId.split(':');
  const item=pendingActions.get(id);
  if(!item) return i.update({content:'❌ This confirmation expired.',components:[]});
  if(item.guildId!==i.guild.id) return i.reply(eph('❌ This confirmation belongs to a different server.'));
  if(item.userId!==i.user.id) return i.reply(eph('❌ Only the person who requested this action can confirm it.'));
  pendingActions.delete(id);
  if(verb==='cancel') return i.update({content:'✅ Cancelled.',components:[]});
  if(Date.now()>item.expires)return i.update({content:'❌ This confirmation expired.',components:[]});
  await executeConfirmed(item.action,item.extra);
  audit(i.user.tag,item.action,item.extra);
  return i.update({content:`✅ **${item.action}** completed.`,components:[]});
}

const scheduled = new Map();
function clearScheduled(kind) {
  const guildId = activeContext().guildId;
  const key = `${guildId}:${kind}`;
  if (scheduled.has(key)) { clearTimeout(scheduled.get(key)); scheduled.delete(key); }
}
function scheduleOneShot() {
  const guildId = activeContext().guildId;
  const ownerId = activeContext().ownerId;
  clearScheduled('one');
  if (!config.scheduledRestartAt) return;
  const delay = Math.max(1000, config.scheduledRestartAt - Date.now());
  const key = `${guildId}:one`;
  scheduled.set(key, setTimeout(() => {
    withGuildContext(guildId, ownerId, async () => {
      try { await serverAction('restart'); audit('scheduler','restart',{type:'one-shot'}); }
      catch(e){ console.error(`Scheduled restart failed for ${guildId}:`, e.message); }
      config.scheduledRestartAt = null;
      scheduled.delete(key);
    }).catch(e => { console.error(e.message); scheduled.delete(key); });
  }, delay));
}
function scheduleDaily() {
  const guildId = activeContext().guildId;
  const ownerId = activeContext().ownerId;
  clearScheduled('daily');
  if (!config.recurringRestart) return;
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(Number(config.recurringRestart.hourUtc),0,0,0);
  if (next <= now) next.setUTCDate(next.getUTCDate()+1);
  const key = `${guildId}:daily`;
  scheduled.set(key, setTimeout(() => {
    withGuildContext(guildId, ownerId, async () => {
      try { await serverAction('restart'); audit('scheduler','restart',{type:'daily'}); }
      catch(e){ console.error(`Daily restart failed for ${guildId}:`, e.message); }
      scheduled.delete(key);
      scheduleDaily();
    }).catch(e => console.error(e.message));
  }, next-now));
}

client.once('clientReady', async()=>{
  console.log(`${client.user.tag} is online!`);
  client.user.setPresence({activities:[{name:'Red Dawn | /help',type:3}],status:'online'});
  const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
  try{
    const devGuildId=process.env.DISCORD_DEV_GUILD_ID;
    if(devGuildId){await rest.put(Routes.applicationGuildCommands(client.user.id,devGuildId),{body:commands.map(c=>c.toJSON())});console.log(`Registered commands to dev guild ${devGuildId}.`);}
    else{await rest.put(Routes.applicationCommands(client.user.id),{body:commands.map(c=>c.toJSON())});console.log('Registered commands globally for public installation.');}
    console.log(`Slash commands registered! ${commands.length} top-level / ${actionCount()} grouped actions.`);
  }catch(e){console.error('Command registration error:',e);}
  try {
    await ensureConnectedGuilds();
    for (const guild of client.guilds.cache.values()) {
      await withGuildContext(guild.id, guild.ownerId, async () => {
        if (config.feedsEnabled && config.feedFiles.length) await startFeeds();
        scheduleOneShot();
        scheduleDaily();
      });
    }
  } catch (e) { console.error('Tenant bootstrap error:', e.message); }
});

client.on('guildCreate', async guild => {
  try {
    await loadTenant(guild.id, guild.ownerId);
    console.log(`Joined guild ${guild.id}; encrypted tenant configuration initialized.`);
  } catch (e) {
    console.error(`Failed to initialize guild ${guild.id}:`, e.message);
  }
});

client.on('interactionCreate', async i=>{
  try{
    if(i.isButton()) {
      if (!i.guild) return;
      return withGuildContext(i.guild.id, i.guild.ownerId, () => handleConfirm(i));
    }
    if(i.isModalSubmit()) {
      if (i.customId !== 'setup_connect' || !i.guild) return;
      return withGuildContext(i.guild.id, i.guild.ownerId, async () => {
        if (!(await requireOwner(i))) return;
        const sid = i.fields.getTextInputValue('service_id').trim();
        const token = i.fields.getTextInputValue('token').trim();
        const data = await testNitradoCredentials(token, sid);
        config.nitradoToken = token;
        config.nitradoServiceId = sid;
        config.setupCompletedAt = Date.now();
        audit(i.user.tag, 'setup-connect', { serviceId: sid });
        return i.reply(eph(`✅ **Nitrado connected securely.**\nService: \`${sid}\`\nServer: **${safe(data?.data?.gameserver?.query?.server_name || data?.data?.gameserver?.service_name || 'Connected')}**\n\nThe credential is stored encrypted for this Discord server only.`));
      });
    }
    if(!i.isChatInputCommand()) return;
    if(!i.guild) return i.reply(eph('❌ This command must be used in a Discord server.'));
    return withGuildContext(i.guild.id, i.guild.ownerId, async () => {
      const root=i.commandName;
      if(root==='ping')return i.reply(`🏓 Pong — **${client.ws.ping} ms**`);
      if(root==='status')return replyServerStatus(i);
      if(root==='players')return i.reply(await playersText());
      if(root==='serverinfo')return replyServerStatus(i);
      if(root==='restart'){if(!(await requireAdmin(i)))return;const id=queueAction(i.guild.id,i.user.id,'restart');return i.reply({ ...eph(`⚠️ Confirm **restart** on Nitrado server \`${serviceId()}\`?`),components:[confirmButtons(id)] });}
      if(root==='nitrado'){if(!(await requireAdmin(i)))return;const t=Date.now();const d=await getServer(true);return i.reply(eph(`✅ Nitrado connected in **${Date.now()-t} ms**\nService: \`${serviceId()}\`\nServer: **${safe(d?.data?.gameserver?.query?.server_name||d?.data?.gameserver?.service_name||'Unknown')}**`));}
      if(root==='help')return i.reply(commandHelpText());
      if(GROUPS.has(root))return handleGroup(i,root,i.options.getSubcommand());
    });
  }catch(err){
    console.error(err);
    const msg=`❌ ${safe(err.message||'Unknown error',1600)}`;
    if(i.deferred||i.replied) return i.editReply({content:msg,components:[]}).catch(()=>{});
    return i.reply(eph(msg)).catch(()=>{});
  }
});

process.on('unhandledRejection',err=>console.error('Unhandled rejection:',err));
process.on('uncaughtException',err=>console.error('Uncaught exception:',err));
process.on('SIGTERM', async () => { try { await closeDatabase(); } finally { process.exit(0); } });

if(!process.env.DISCORD_TOKEN) console.error('DISCORD_TOKEN is missing.');
if(!process.env.DATABASE_URL) console.error('DATABASE_URL is missing.');
(async () => {
  try {
    await initDatabase();
    if (process.env.NITRADO_TOKEN || process.env.NITRADO_SERVICE_ID) console.warn('Legacy Nitrado environment variables detected. Use /setup import-env, then remove them from Render.');
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
})();
