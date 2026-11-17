import fs from 'fs';
import os from 'os';
import axios from 'axios';
import path from 'path';
import stream from 'stream';
import bcrypt from 'bcrypt';
import { Telegraf } from 'telegraf';
import { ObjectId } from 'mongodb';
import { Api } from 'telegram/tl/index.js';
import type { TelegramClient } from 'telegram';

const SALT_ROUNDS = 10;

// Shared helpers/state that the bot borrows from the web app (server.ts).
export interface BotDeps {
  connectToMongo: () => Promise<any>;
  getUserIdByTg: (tgId: number | string, database: any) => Promise<any>;
  getDriveClient: (tokens: any) => Promise<any>;
  getOneDriveClient: (tokens: any, accountId?: string) => Promise<any>;
  getTgClient: () => Promise<TelegramClient>;
  resolvePeer: (telegram: TelegramClient, id: string) => Promise<any>;
  driveCache: { get: (k: string) => any; set: (k: string, v: any, ttl?: number) => any };
  invalidateDriveCache: (accountId: string) => void;
  deleteThumbFiles?: (fileId: string, accountId?: string) => void;
  nanoid: (length?: number) => string;
  nanoid12: () => string;
  oauth2Client: any;
  createOAuthState: (database: any, userId: string, provider: 'google' | 'microsoft') => Promise<string>;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_REDIRECT_URI: string;
}

/**
 * Build and launch the Telegram bot. Returns the Telegraf instance, or null if
 * no bot token is configured (in which case the web app runs without a bot).
 */
export function initBot(deps: BotDeps): Telegraf | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken === 'YOUR_BOT_TOKEN') {
    console.log('[Cloudyte] Telegram bot disabled (no TELEGRAM_BOT_TOKEN).');
    return null;
  }

  const {
    connectToMongo, getUserIdByTg, getDriveClient, getOneDriveClient,
    getTgClient, resolvePeer, driveCache, invalidateDriveCache, deleteThumbFiles,
    nanoid, nanoid12, oauth2Client, createOAuthState, MICROSOFT_CLIENT_ID, MICROSOFT_REDIRECT_URI,
  } = deps;

  const bot = new Telegraf(botToken);

  // ── Callback store (bot inline keyboards) ──────────────────────────────────
  const callbackStore: Record<string, any> = {};
  const botState: Record<string, { action: string; data: any }> = {};
function getCb(action: string, accId: string, id: string, pageToken?: string) {
  const hash = nanoid();
  callbackStore[hash] = { action, accId, id, pageToken, ts: Date.now() };
  return `cb:${hash}`;
}
setInterval(() => {
  const now = Date.now();
  Object.keys(callbackStore).forEach(k => { if (now - callbackStore[k].ts > 3600000) delete callbackStore[k]; });
}, 3600000);

  // ── Render helpers ─────────────────────────────────────────────────────────
function renderProgressBar(current: number, total: number) {
  const pct      = Math.min(100, (current / total) * 100);
  const progress = Math.floor(pct / 10);
  const bar      = '▓'.repeat(progress) + '░'.repeat(10 - progress);
  return `[\`${bar}\`] **${pct.toFixed(2)}%**`;
}

async function renderBrowser(ctx: any, accId: string, folderId: string, pageToken?: string, isEdit = false) {
  try {
    const database = await connectToMongo();
    const account  = await database.collection('accounts').findOne({ _id: new ObjectId(accId) });
    if (!account) return ctx.reply('❌ Account not found');

    let files: any[]       = [];
    let nextToken: string | null = null;
    let folderName         = 'Root';
    let parentId           = 'root';

    if (account.accountType === 'tgdrive') {
      const channelId = account.channelId;
      if (!channelId) return ctx.reply('❌ No channel configured for this TG Drive account.');

      const currentFolder = folderId === 'root' ? '' : folderId;
      const escapedFolder = currentFolder ? currentFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' : '';
      const [rawFiles, rawFolders] = await Promise.all([
        database.collection('tg_files')
          .find({ accountId: new ObjectId(accId), folder: currentFolder })
          .sort({ date: -1 }).limit(20).toArray(),
        database.collection('tg_folders')
          .find({ accountId: new ObjectId(accId), path: { $regex: `^${escapedFolder}[^/]+$` } })
          .toArray()
      ]);

      files = [
        ...rawFolders.map((f: any) => ({ id: f.path, name: f.name, isFolder: true, mimeType: 'folder' })),
        ...rawFiles.map((f: any) => ({ id: String(f._id), name: f.name, isFolder: false, mimeType: f.mimeType })),
      ];
      folderName = currentFolder || 'TG Drive Root';
      if (currentFolder.includes('/')) parentId = currentFolder.substring(0, currentFolder.lastIndexOf('/'));
      else if (currentFolder) parentId = 'root';
    } else if (account.accountType === 'onedrive') {
      const cacheKey = `od:${accId}:${folderId}:${pageToken || 'none'}`;
      const cached = driveCache.get(cacheKey) as any;
      if (cached) {
        files = cached.files;
        nextToken = cached.nextToken;
        folderName = cached.folderName;
        parentId = cached.parentId;
      } else {
        const c = await getOneDriveClient(account.tokens, accId);
        const itemPath = folderId === 'root' ? '/me/drive/root' : `/me/drive/items/${folderId}`;
        const [fm, r] = await Promise.all([
          c.api(itemPath).get(),
          c.api(`${itemPath}/children`).top(20).get()
        ]);
        folderName = fm.name === 'root' ? 'OneDrive Root' : fm.name;
        parentId = fm.parentReference?.id || 'root';
        files = r.value.map((f: any) => ({ id: f.id, name: f.name, isFolder: !!f.folder, mimeType: f.folder ? 'folder' : (f.file?.mimeType || '') }));
        if (r['@odata.nextLink']) {
          try { const u = new URL(r['@odata.nextLink']); nextToken = u.searchParams.get('$skiptoken') || u.searchParams.get('$skip'); } catch { nextToken = null; }
        }
        driveCache.set(cacheKey, { files, nextToken, folderName, parentId }, 30); // 30s for bot browsing
      }
    } else {
      const cacheKey = `gd:${accId}:${folderId}:${pageToken || 'none'}`;
      const cached = driveCache.get(cacheKey) as any;
      if (cached) {
        files = cached.files;
        nextToken = cached.nextToken;
        folderName = cached.folderName;
        parentId = cached.parentId;
      } else {
        const drive = await getDriveClient(account.tokens);
        const safeFolderId = String(folderId || 'root').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const q = `'${safeFolderId}' in parents and trashed = false`;
        const [metaRes, listRes] = await Promise.all([
          folderId === 'root' ? Promise.resolve({ data: { name: 'Google Drive Root', parents: [] } }) : drive.files.get({ fileId: folderId, fields: 'name,parents' }),
          drive.files.list({ pageSize: 12, pageToken, q, fields: 'files(id,name,mimeType),nextPageToken', orderBy: 'folder,name' })
        ]);
        folderName = metaRes.data.name || folderId;
        parentId = metaRes.data.parents?.[0] || 'root';
        files = (listRes.data.files || []).map((f: any) => ({ id: f.id, name: f.name, isFolder: f.mimeType === 'application/vnd.google-apps.folder', mimeType: f.mimeType }));
        nextToken = listRes.data.nextPageToken || null;
        driveCache.set(cacheKey, { files, nextToken, folderName, parentId }, 30);
      }
    }

    const buttons = files.map(f => ([{
      text: `${f.isFolder ? '📁' : '📄'} ${f.name}`,
      callback_data: getCb(f.isFolder ? 'browse' : 'info', accId, f.id!),
    }]));
    if (nextToken) buttons.push([{ text: 'Next Page ➡️', callback_data: getCb('browse', accId, folderId, nextToken) }]);

    const nav: any[] = [];
    if (folderId !== 'root') nav.push({ text: '⬅️ Back', callback_data: getCb('browse', accId, parentId) });
    nav.push({ text: '📁 New', callback_data: getCb('mkdir', accId, folderId) });
    nav.push({ text: '📤 Upload', callback_data: getCb('upload_prompt', accId, folderId) });
    if (account.accountType !== 'onedrive' && account.accountType !== 'tgdrive') {
      nav.push({ text: '📦 Batch', callback_data: getCb('batch_mode', accId, folderId) });
    }
    const userId = await getUserIdByTg(ctx.from!.id, database);
    const accountsCount = await database.collection('accounts').countDocuments({ userId });
    if (accountsCount > 1) nav.push({ text: '🔄 Switch', callback_data: getCb('files_list', 'null', 'null') });
    buttons.push(nav);

    const label = account.accountType === 'tgdrive' ? `📡 TG Drive: \`${account.channelId}\`` : `📧 *Account:* \`${account.email}\` (${account.accountType || 'google'})`;
    const text    = `${label}\n📍 *Location:* \`${folderName}\`\n\nSelect a file or folder:`;
    const options = { parse_mode: 'Markdown' as const, reply_markup: { inline_keyboard: buttons } };
    if (isEdit) await ctx.editMessageText(text, options).catch(() => {});
    else await ctx.reply(text, options);
  } catch (e: any) {
    console.error('RenderBrowser error:', e);
    ctx.reply('❌ Error loading files: ' + e.message);
  }
}

async function renderSettings(ctx: any, isEdit = false) {
  try {
    const database = await connectToMongo();
    const userId   = await getUserIdByTg(ctx.from!.id, database);
    if (!userId) return ctx.reply('❌ You are not logged in. Use /login.');
    
    const accounts = await database.collection('accounts').find({ userId }).toArray();
    const user     = await database.collection('users').findOne({ _id: userId });
    if (accounts.length === 0) {
      const text = 'No accounts linked. Use /addaccount to start.';
      return isEdit ? ctx.editMessageText(text) : ctx.reply(text);
    }
    const defaultAcc = accounts.find((a: any) => a.isDefault);
    const backupAcc  = accounts.find((a: any) => a._id.toString() === user?.backupAccId);
    let text = `⚙️ *Settings & Account Management*\n\n`;
    text += `👤 *User:* ${user?.username || 'Admin'}\n`;
    text += `🌟 *Default Account:* ${defaultAcc ? `\`${defaultAcc.email || defaultAcc.channelId}\`` : '_None set_'}\n`;
    text += `🛡️ *Backup Status:* ${user?.backupEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `📂 *Backup Account:* ${backupAcc ? `\`${backupAcc.email || backupAcc.channelId}\`` : 'Not configured'}\n\n`;
    const buttons: any[] = [[{ text: '🛡️ Backup Settings', callback_data: getCb('backup_settings', 'null', 'null') }]];
    if (user?.isAdmin) {
      buttons[0].push({ text: '🔧 Admin Panel', callback_data: getCb('admin_panel', 'null', 'null') });
    }
    accounts.forEach((acc: any) => {
      const label = acc.accountType === 'tgdrive' ? `📡 TG Drive (${acc.channelId})` : acc.email;
      buttons.push([{ text: `${acc.isDefault ? '[★] ' : ''}${label}`, callback_data: getCb('sett_acc', acc._id.toString(), 'info') }]);
    });
    const options = { parse_mode: 'Markdown' as const, reply_markup: { inline_keyboard: buttons } };
    if (isEdit) await ctx.editMessageText(text, options).catch(() => {});
    else await ctx.reply(text, options);
  } catch (e: any) {
    ctx.reply('❌ Error loading settings: ' + e.message);
  }
}

async function renderAdminPanel(ctx: any, isEdit = false) {
  try {
    const database = await connectToMongo();
    const userId = await getUserIdByTg(ctx.from!.id, database);
    const user = await database.collection('users').findOne({ _id: userId });
    if (!user?.isAdmin) return ctx.answerCbQuery('⛔ Access denied');

    const stats = {
      users: await database.collection('users').countDocuments(),
      accounts: await database.collection('accounts').countDocuments(),
      files: (await database.collection('tg_files').countDocuments())
    };

    const reg = await database.collection('settings').find({}).toArray();
    const config: any = {};
    reg.forEach(s => config[s.key] = s.value);

    let text = `🔧 *Cloudyte Admin Panel*\n\n`;
    text += `👥 *Total Users:* ${stats.users}\n`;
    text += `🔗 *Linked Accounts:* ${stats.accounts}\n`;
    text += `📄 *Indexed Files:* ${stats.files}\n\n`;
    
    text += `⚙️ *Registration Controls:*\n`;
    text += `• Global: ${config.registrationEnabled ? '✅' : '❌'}\n`;
    text += `• Web: ${config.webRegistrationEnabled ? '✅' : '❌'}\n`;
    text += `• Bot: ${config.botRegistrationEnabled ? '✅' : '❌'}\n`;

    const buttons = [
      [
        { text: `Global: ${config.registrationEnabled ? 'ON' : 'OFF'}`, callback_data: getCb('toggle_reg', 'registrationEnabled', String(!config.registrationEnabled)) },
      ],
      [
        { text: `Web: ${config.webRegistrationEnabled ? 'ON' : 'OFF'}`, callback_data: getCb('toggle_reg', 'webRegistrationEnabled', String(!config.webRegistrationEnabled)) },
        { text: `Bot: ${config.botRegistrationEnabled ? 'ON' : 'OFF'}`, callback_data: getCb('toggle_reg', 'botRegistrationEnabled', String(!config.botRegistrationEnabled)) }
      ],
      [{ text: '⬅️ Back to Settings', callback_data: getCb('settings_main', 'null', 'null') }]
    ];

    const options = { parse_mode: 'Markdown' as const, reply_markup: { inline_keyboard: buttons } };
    if (isEdit) await ctx.editMessageText(text, options).catch(() => {});
    else await ctx.reply(text, options);
  } catch (e: any) {
    ctx.reply('❌ Admin error: ' + e.message);
  }
}

  const botAuth = async (ctx: any, next: () => Promise<void>) => {
    const database = await connectToMongo();
    const user = await database.collection('users').findOne({ tgIds: String(ctx.from.id) });
    if (!user || user.isActive === false) {
      return ctx.reply('❌ *Authentication Required*\n\nYou must be logged in to use this command.\n\n🔐 Use `/login <user> <pass>`\n🚀 Use `/register <user> <pass>` (if allowed)', { parse_mode: 'Markdown' });
    }
    ctx.state.user = user;
    return next();
  };

  bot.telegram.setMyCommands([
    { command: 'start',      description: 'Start & Help' },
    { command: 'files',      description: 'File Manager' },
    { command: 'search',     description: 'Search Files' },
    { command: 'upload',     description: 'Secure Upload' },
    { command: 'storage',    description: 'Check Storage' },
    { command: 'settings',   description: 'Settings' },
    { command: 'addaccount', description: 'Add Storage Account' },
    { command: 'logout',     description: 'Logout (Unlink TG)' },
  ]).catch(console.error);

  bot.start(async (ctx) => {
    const database = await connectToMongo();
    const user = await database.collection('users').findOne({ tgIds: String(ctx.from.id) });
    
    if (user) {
      return ctx.reply(
        `Welcome back, *${user.username}*! ☁️\n\n` +
        `You are authenticated. What would you like to do?\n\n` +
        `🚀 *Quick Access:*\n` +
        `📂 /files - Browse drives\n` +
        `🔍 /search - Find files\n` +
        `📦 /storage - Storage usage\n` +
        `⚙️ /settings - App settings\n` +
        `🚪 /logout - Unlink this Telegram account`,
        { parse_mode: 'Markdown' }
      );
    }

    const globalReg = await database.collection('settings').findOne({ key: 'registrationEnabled' });
    const botReg    = await database.collection('settings').findOne({ key: 'botRegistrationEnabled' });
    const canReg = globalReg?.value !== false && botReg?.value !== false;

    let msg = `Welcome to *Cloudyte*! ☁️\n\n` +
              `The most advanced Telegram-based personal cloud storage interface.\n\n` +
              `🔐 *Status: Not authenticated.*\n\n` +
              `• Use \`/login <user> <pass>\` to link your account.\n`;
    
    if (canReg) {
      msg += `• Use \`/register <user> <pass>\` to create an account.\n`;
    } else {
      msg += `⚠️ _Registration via bot is currently disabled._\n`;
    }

    ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('settings', botAuth, async (ctx) => renderSettings(ctx));

  bot.command('register', async (ctx) => {
    const parts = (ctx.message as any).text.trim().split(/\s+/);
    await ctx.deleteMessage().catch(() => {});
    if (parts.length < 3) return ctx.reply('🚀 *Cloudyte Registration*\n\nUsage: `/register <username> <password>`', { parse_mode: 'Markdown' });
    const username = parts[1].trim();
    const password = parts[2];
    if (!username || username.length < 2 || username.length > 64 || !password || password.length < 4 || password.length > 256) {
      return ctx.reply('❌ Invalid username or password (min 4 chars for password).');
    }
    const database = await connectToMongo();
    
    const globalReg = await database.collection('settings').findOne({ key: 'registrationEnabled' });
    const botReg    = await database.collection('settings').findOne({ key: 'botRegistrationEnabled' });
    if (globalReg?.value === false || botReg?.value === false) {
      return ctx.reply('❌ Registration is currently disabled.');
    }

    if (await database.collection('users').findOne({ username })) return ctx.reply('❌ Username taken');
    
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    try {
      await database.collection('users').insertOne({
        _id: nanoid() as any,
        username,
        password: hashedPassword,
        tgIds: [String(ctx.from.id)],
        isAdmin: false,
        isActive: true,
        createdAt: new Date(),
        createdVia: 'bot'
      });
      ctx.reply(`✅ *Account Created!*\n\nYou are now logged in and linked as \`${username}\`.`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      if (err.code === 11000) return ctx.reply('❌ Username already taken');
      ctx.reply('❌ Registration failed: ' + err.message);
    }
  });

  bot.command('login', async (ctx) => {
    const parts    = (ctx.message as any).text.trim().split(/\s+/);
    const database = await connectToMongo();
    
    if (parts.length < 3) {
      const user = await database.collection('users').findOne({ tgIds: String(ctx.from.id) });
      if (user && user.isActive !== false) return ctx.reply(`🔓 Authenticated as *${user.username}*!\n\nDashboard: ${process.env.APP_URL}`, { parse_mode: 'Markdown' });
      return ctx.reply('🔐 *Cloudyte Login*\n\nUsage: `/login <username> <password>`', { parse_mode: 'Markdown' });
    }

    await ctx.deleteMessage().catch(() => {});
    const username = parts[1].trim();
    const password = parts[2];
    const user = await database.collection('users').findOne({ username });
    if (!user || user.isActive === false) return ctx.reply('❌ Invalid credentials or account disabled');
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return ctx.reply('❌ Invalid credentials');
    
    await database.collection('users').updateOne(
      { _id: user._id },
      { $addToSet: { tgIds: String(ctx.from.id) } }
    );
    
    ctx.reply(`🔓 *Welcome Back!*\n\nYou are authenticated and linked as \`${user.username}\`.\n\nDashboard: ${process.env.APP_URL}`, { parse_mode: 'Markdown' });
  });

  bot.command('logout', async (ctx) => {
    const database = await connectToMongo();
    const result   = await database.collection('users').updateOne(
      { tgIds: String(ctx.from.id) },
      { $pull: { tgIds: String(ctx.from.id) } }
    );
    if (result.modifiedCount > 0) ctx.reply('✅ Logged out. Telegram account unlinked.');
    else ctx.reply('ℹ️ You were not logged in.');
  });

  bot.command('addaccount', botAuth, (ctx) => {
    ctx.reply('➕ *Add Storage Account*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📁 Google Drive', callback_data: 'link_google' }, { text: '☁️ OneDrive', callback_data: 'link_onedrive' }],
          [{ text: '📡 Telegram Channel', callback_data: 'link_tgdrive' }],
        ]
      }
    });
  });

  bot.action('link_google', async (ctx) => {
    const database = await connectToMongo();
    const userId = await getUserIdByTg(ctx.from!.id, database);
    if (!userId) return ctx.answerCbQuery('❌ Login first').then(() => ctx.reply('Use /login or /register'));
    
    await ctx.answerCbQuery().catch(() => {});
    const state = await createOAuthState(database, String(userId), 'google');
    const url = oauth2Client.generateAuthUrl({ 
      access_type: 'offline', 
      scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'], 
      prompt: 'consent', 
      state
    });
    ctx.reply('Link your Google Drive:', { reply_markup: { inline_keyboard: [[{ text: '🔗 Link Google Drive', url }]] } });
  });

  bot.action('link_onedrive', async (ctx) => {
    const database = await connectToMongo();
    const userId = await getUserIdByTg(ctx.from!.id, database);
    if (!userId) return ctx.answerCbQuery('❌ Login first').then(() => ctx.reply('Use /login or /register'));

    await ctx.answerCbQuery().catch(() => {});
    const state = await createOAuthState(database, String(userId), 'microsoft');
    const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(MICROSOFT_REDIRECT_URI)}&response_mode=query&scope=${encodeURIComponent('files.readwrite.all User.Read offline_access')}&state=${encodeURIComponent(state)}&prompt=select_account`;
    ctx.reply('Link your OneDrive:', { reply_markup: { inline_keyboard: [[{ text: '🔗 Link OneDrive', url }]] } });
  });

  bot.action('link_tgdrive', async (ctx) => {
    const database = await connectToMongo();
    const userId = await getUserIdByTg(ctx.from!.id, database);
    if (!userId) return ctx.answerCbQuery('❌ Login first');
    await ctx.answerCbQuery().catch(() => {});
    botState[ctx.from!.id] = { action: 'register_tgdrive_channel', data: {} };
    ctx.reply(`📡 *Register TG Drive Channel*\n\nStep 1/2: Send the channel ID or username\n(e.g. \`-1001234567890\` or \`@mychannel\`)\n\n⚠️ Make sure the bot is an **admin** in the channel.`, { parse_mode: 'Markdown' });
  });

  bot.command('search', botAuth, async (ctx) => {
    const queryStr = (ctx.message as any).text.split(' ').slice(1).join(' ');
    if (!queryStr) return ctx.reply('Usage: /search <file name>');
    const database = await connectToMongo();
    const user = ctx.state.user;
    
    const accounts = await database.collection('accounts').find({ userId: user._id }).toArray();
    if (!accounts.length) return ctx.reply('❌ Link an account first: /addaccount');

    const defaultAcc = accounts.find((a: any) => a.isDefault) || accounts[0];
    try {
      let buttons: any[] = [];
      if (defaultAcc.accountType === 'tgdrive') {
        const regex = new RegExp(queryStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const files = await database.collection('tg_files').find({ accountId: defaultAcc._id, name: regex }).limit(8).toArray();
        buttons = files.map((f: any) => [{ text: `📄 ${f.name}`, callback_data: getCb('info', defaultAcc._id.toString(), String(f._id)) }]);
      } else if (defaultAcc.accountType === 'onedrive') {
        const c   = await getOneDriveClient(defaultAcc.tokens, defaultAcc._id.toString());
        const r   = await c.api(`/me/drive/root/search(q='${queryStr.replace(/[\r\n\0]/g, '').replace(/'/g, "''")}')`).top(8).get();
        buttons   = (r.value || []).map((f: any) => [{ text: `📄 ${f.name}`, callback_data: getCb('info', defaultAcc._id.toString(), f.id) }]);
      } else {
        const drive = await getDriveClient(defaultAcc.tokens);
        const safeQ = queryStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const r     = await drive.files.list({ q: `name contains '${safeQ}' and trashed = false`, fields: 'files(id,name)', pageSize: 8 });
        buttons     = (r.data.files || []).map(f => [{ text: `📄 ${f.name}`, callback_data: getCb('info', defaultAcc._id.toString(), f.id!) }]);
      }
      if (!buttons.length) return ctx.reply('🔍 No files found.');
      ctx.reply(`🔍 *Results for:* "${queryStr}"`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    } catch (e: any) { ctx.reply('Search failed: ' + e.message); }
  });

  bot.command('upload', botAuth, async (ctx) => {
    const database = await connectToMongo();
    const user = ctx.state.user;
    
    const accounts = await database.collection('accounts').find({ userId: user._id }).toArray();
    if (!accounts.length) return ctx.reply('No accounts linked. Use /addaccount.');
    const targetAcc = accounts.find((a: any) => a.isDefault) || (accounts.length === 1 ? accounts[0] : null);
    if (targetAcc) {
      botState[ctx.from.id] = { action: 'upload_file', data: { accId: targetAcc._id.toString(), folderId: 'root' } };
      const label = targetAcc.accountType === 'tgdrive' ? `TG Drive (${targetAcc.channelId})` : targetAcc.email;
      ctx.reply(`📤 *Upload to:* \`${label}\`\n\nSend the file now:`, { parse_mode: 'Markdown' });
    } else {
      const buttons = accounts.map((acc: any) => ([{ text: `📤 ${acc.accountType === 'tgdrive' ? '📡 ' + acc.channelId : acc.email}`, callback_data: getCb('upload_prompt', acc._id.toString(), 'root') }]));
      ctx.reply('📂 *Select account to upload to:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
  });

  bot.command('storage', botAuth, async (ctx) => {
    const database = await connectToMongo();
    const user = ctx.state.user;
    
    const accounts = await database.collection('accounts').find({ userId: user._id }).toArray();
    if (!accounts.length) return ctx.reply('No accounts linked.');
    let message = '📊 *Storage Summary*\n\n';
    for (const acc of accounts) {
      try {
        if (acc.accountType === 'tgdrive') {
          const [agg] = await database.collection('tg_files').aggregate([{ $match: { accountId: acc._id } }, { $group: { _id: null, total: { $sum: '$size' }, count: { $sum: 1 } } }]).toArray();
          const usedGB = ((agg?.total || 0) / (1024 ** 3)).toFixed(3);
          message += `📡 *TG Drive* (${acc.channelId})\n📦 ${usedGB} GB (${agg?.count || 0} files)\n\n`;
        } else if (acc.accountType === 'onedrive') {
          const c = await getOneDriveClient(acc.tokens, acc._id.toString()); const d = await c.api('/me/drive').get();
          message += `📁 *${acc.name || 'OneDrive'}* (OneDrive)\n☁️ ${(d.quota.used / (1024 ** 3)).toFixed(2)}GB / ${(d.quota.total / (1024 ** 3)).toFixed(2)}GB\n\n`;
        } else {
          const drive = await getDriveClient(acc.tokens); const about = await drive.about.get({ fields: 'storageQuota' });
          const { usage, limit } = about.data.storageQuota!;
          message += `📁 *${acc.name || acc.email}* (Google)\n☁️ ${(Number(usage) / (1024 ** 3)).toFixed(2)}GB / ${(Number(limit) / (1024 ** 3)).toFixed(2)}GB\n\n`;
        }
      } catch { message += `❌ *${acc.email || acc.channelId}*: Error\n\n`; }
    }
    ctx.replyWithMarkdown(message);
  });

  bot.command('files', botAuth, async (ctx) => {
    const database = await connectToMongo();
    const user = ctx.state.user;
    
    const accounts = await database.collection('accounts').find({ userId: user._id }).toArray();
    if (!accounts.length) return ctx.reply('No accounts linked. Use /addaccount.');
    const defaultAcc = accounts.find((a: any) => a.isDefault);
    if (defaultAcc) {
      const hash = nanoid();
      callbackStore[hash] = { action: 'browse', accId: defaultAcc._id.toString(), id: 'root', ts: Date.now() };
      return ctx.reply('📂 *Opening your default account:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📂 Open', callback_data: `cb:${hash}` }]] } });
    }
    const buttons = accounts.map((acc: any) => ([{ text: acc.accountType === 'tgdrive' ? `📡 TG Drive (${acc.channelId})` : `📧 ${acc.email}`, callback_data: getCb('browse', acc._id.toString(), 'root') }]));
    ctx.reply('📂 *Select account:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  // Text handler: handles TG Drive channel registration + rename + mkdir
  bot.on('text', async (ctx, next) => {
    const state = botState[ctx.from.id];
    if (!state) return next();
    const database  = await connectToMongo();
    const { action, data } = state;

    try {
      if (action === 'register_tgdrive_channel') {
        const channelId = ctx.message.text.trim();
        // Verify bot is admin first
        try {
          const admins  = await bot!.telegram.getChatAdministrators(channelId);
          const botInfo = await bot!.telegram.getMe();
          const isAdmin = admins.some((a: any) => a.user.id === botInfo.id);
          if (!isAdmin) throw new Error('Bot is not an admin in this channel');
        } catch (e: any) {
          delete botState[ctx.from.id];
          return ctx.reply(`❌ Cannot access channel: ${e.message}\n\nMake sure the bot is an admin in the channel.`);
        }
        // Channel OK — ask for drive name
        botState[ctx.from.id] = { action: 'register_tgdrive_name', data: { channelId } };
        return ctx.reply(`✅ Channel verified!\n\nStep 2/2: Send a *name* for this TG Drive\n(e.g. \`My Storage\`, \`Videos Channel\`)\n\nThis name will appear in your dashboard.`, { parse_mode: 'Markdown' });
      }

      if (action === 'register_tgdrive_name') {
        const driveName = ctx.message.text.trim() || 'TG Drive';
        const { channelId } = data;
        delete botState[ctx.from.id];
        const userId = await getUserIdByTg(ctx.from!.id, database);
        if (!userId) return ctx.reply('❌ Session lost. Use /login.');

        await database.collection('accounts').updateOne(
          { userId, channelId, accountType: 'tgdrive' },
          { $set: { userId, channelId, accountType: 'tgdrive', name: driveName, linkedAt: new Date().toISOString() } },
          { upsert: true }
        );
        const acc = await database.collection('accounts').findOne({ userId, channelId, accountType: 'tgdrive' });
        const newAccountId = acc!._id;
        // Re-link orphaned files
        const existingIds = (await database.collection('accounts').find({}, { projection: { _id: 1 } }).toArray()).map((a: any) => a._id);
        const fr = await database.collection('tg_files').updateMany({ accountId: { $nin: existingIds }, userId }, { $set: { accountId: newAccountId } });
        const dr = await database.collection('tg_folders').updateMany({ accountId: { $nin: existingIds }, userId }, { $set: { accountId: newAccountId } });
        const relinked = fr.modifiedCount + dr.modifiedCount;
        const extra = relinked > 0 ? `\n♻️ _${relinked} orphaned file(s) re-linked._` : '';
        ctx.reply(`✅ *TG Drive registered!*\n\n📛 Name: \`${driveName}\`\n📡 Channel: \`${channelId}\`${extra}\n\nUse /files to browse or /upload to add files.`, { parse_mode: 'Markdown' });
        return;
      }

      const userId = await getUserIdByTg(ctx.from!.id, database);
      if (!userId) {
        delete botState[ctx.from.id];
        return ctx.reply('❌ Session expired or account inactive. Use /login.');
      }

      const account = data.accId && ObjectId.isValid(data.accId)
        ? await database.collection('accounts').findOne({ _id: new ObjectId(data.accId) })
        : null;
      if (data.accId && (!account || String(account.userId) !== String(userId))) {
        delete botState[ctx.from.id];
        return ctx.reply('⛔ Access denied to this account.');
      }

      const isSafeBotFilename = (v: string) =>
        Boolean(v) && v.length <= 255 && !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..' && !v.includes('..') && !/[\x00-\x1f\x7f]/.test(v);

      if (action === 'rename_prompt' && account) {
        const newName = ctx.message.text.trim();
        if (!isSafeBotFilename(newName)) {
          delete botState[ctx.from.id];
          return ctx.reply('❌ Invalid filename.');
        }
        if (account.accountType === 'tgdrive') {
          if (!ObjectId.isValid(data.fileId)) {
            delete botState[ctx.from.id];
            return ctx.reply('❌ Invalid file ID.');
          }
          const meta = await database.collection('tg_files').findOne({ _id: new ObjectId(data.fileId), accountId: account._id });
          if (!meta) {
            delete botState[ctx.from.id];
            return ctx.reply('❌ File not found.');
          }
          if (meta.isEncrypted === true) {
            delete botState[ctx.from.id];
            return ctx.reply('🔒 Encrypted files cannot be renamed from the bot.');
          }
          await database.collection('tg_files').updateOne({ _id: meta._id }, { $set: { name: newName, updatedAt: new Date() } });
        } else if (account.accountType === 'onedrive') {
          const c = await getOneDriveClient(account.tokens, data.accId);
          await c.api(`/me/drive/items/${data.fileId}`).patch({ name: newName });
        } else {
          const drive = await getDriveClient(account.tokens);
          await drive.files.update({ fileId: data.fileId, requestBody: { name: newName } });
        }
        invalidateDriveCache(data.accId);
        ctx.reply(`✅ Renamed to: \`${newName}\``, { parse_mode: 'Markdown' });
      } else if (action === 'mkdir_prompt' && account) {
        const folderName = ctx.message.text.trim();
        if (!isSafeBotFilename(folderName)) {
          delete botState[ctx.from.id];
          return ctx.reply('❌ Invalid folder name.');
        }
        if (account.accountType === 'tgdrive') {
          const parentPath = (!data.folderId || data.folderId === 'root') ? '' : data.folderId;
          const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
          await database.collection('tg_folders').updateOne(
            { accountId: account._id, path: folderPath },
            { $set: { accountId: account._id, userId: String(userId), name: folderName, path: folderPath, createdAt: Math.floor(Date.now() / 1000) } },
            { upsert: true }
          );
        } else if (account.accountType === 'onedrive') {
          const c = await getOneDriveClient(account.tokens, data.accId);
          const parentPath = (!data.folderId || data.folderId === 'root') ? '/me/drive/root' : `/me/drive/items/${data.folderId}`;
          await c.api(`${parentPath}/children`).post({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
        } else {
          const drive = await getDriveClient(account.tokens);
          await drive.files.create({ requestBody: { name: folderName, parents: [data.folderId || 'root'], mimeType: 'application/vnd.google-apps.folder' } });
        }
        invalidateDriveCache(data.accId);
        delete botState[ctx.from.id];
        await renderBrowser(ctx, data.accId, data.folderId || 'root');
        return;
      }
      delete botState[ctx.from.id];
    } catch (e: any) {
      ctx.reply('❌ Action failed: ' + e.message);
      delete botState[ctx.from.id];
    }
  });

  // File upload handler (Telegram → Cloud)
  bot.on(['document', 'photo', 'video', 'audio', 'voice', 'video_note'], async (ctx) => {
    const database = await connectToMongo();
    const state    = botState[ctx.from.id];
    let accId: string | null = null;
    let folderId = '';

    const userId = await getUserIdByTg(ctx.from!.id, database);
    if (!userId) return ctx.reply('❌ Authentication required. Use /login first.');
    const userDoc = await database.collection('users').findOne({ _id: userId });

    if (state?.action === 'upload_file' || state?.action === 'batch_upload') {
      accId    = state.data.accId;
      folderId = state.data.folderId === 'root' ? '' : (state.data.folderId || '');
      if (state.action === 'upload_file') delete botState[ctx.from.id];
    }

    let account: any;
    if (accId && ObjectId.isValid(accId)) {
      account = await database.collection('accounts').findOne({ _id: new ObjectId(accId), userId });
    } else {
      const accounts = await database.collection('accounts').find({ userId }).toArray();
      account = accounts.find((a: any) => a.isDefault) || accounts[0];
      if (account) accId = account._id.toString();
    }
    if (!account) return ctx.reply('❌ No account found. Use /addaccount first.');

    const statusMsg = await ctx.reply('☁️ *Starting upload...*', { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id } as any);
    const msg       = ctx.message as any;
    const tgFile    = msg.document || msg.video || msg.audio || msg.voice || msg.video_note || (msg.photo && msg.photo[msg.photo.length - 1]);
    if (!tgFile) return;

    const rawFileName = msg.document?.file_name || msg.audio?.file_name || msg.video?.file_name || `telegram_file_${Date.now()}`;
    const fileName = path.basename(rawFileName);
    const mimeType = tgFile.mime_type || 'application/octet-stream';
    const fileSize = tgFile.file_size || 0;
    const sizeMB   = (fileSize / (1024 ** 2)).toFixed(2);

    try {
      // ── TG Drive: use copyMessage (zero bandwidth, instant, server-side) ──
      if (account.accountType === 'tgdrive') {
        await bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `📡 *Syncing to TG Drive...*\n\n📄 \`${fileName}\`\n💾 ${sizeMB} MB`, { parse_mode: 'Markdown' }).catch(() => {});
        const caption = folderId ? `F[${folderId}] | ${fileName}` : fileName;
        const copied  = await bot!.telegram.copyMessage(account.channelId, ctx.chat.id, ctx.message.message_id, { caption });
        const shareId = nanoid12();
        await database.collection('tg_files').insertOne({
          accountId: account._id,
          userId:    String(userId),
          messageId: copied.message_id,
          shareId,
          name:      fileName,
          size:      fileSize,
          mimeType,
          folder:    folderId || '',
          caption,
          isEncrypted: false,
          date:      Math.floor(Date.now() / 1000),
        });
        invalidateDriveCache(accId!);
        await bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `✅ *Saved to TG Drive!*\n\n📄 \`${fileName}\`\n📏 \`${sizeMB} MB\`\n📁 \`${folderId || 'Root'}\``, { parse_mode: 'Markdown' }).catch(() => {});
        return;
      }

      // ── Google Drive / OneDrive: download then re-upload ──────────────────
      const tmpPath = path.join(os.tmpdir(), `tgu_${Date.now()}_${nanoid(6)}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
      try {
        // ── DOWNLOAD PHASE with progress ──────────────────────────────────
        await bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
          `📥 *Downloading from Telegram...*\n\n📄 \`${fileName}\`\n💾 ${sizeMB} MB\n\n${renderProgressBar(0, 1)}\n_0.00 MB / ${sizeMB} MB_`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});

        if (fileSize <= 20 * 1024 * 1024) {
          const fileLink = await bot!.telegram.getFileLink(tgFile.file_id);
          const resp     = await axios({ method: 'get', url: fileLink.href, responseType: 'stream', timeout: 60_000 });
          const ws       = fs.createWriteStream(tmpPath);
          let dlBytes    = 0;
          let lastDlUpd  = 0;
          resp.data.on('data', (chunk: Buffer) => {
            dlBytes += chunk.length;
            const now = Date.now();
            if (now - lastDlUpd > 2000) {
              lastDlUpd = now;
              bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
                `📥 *Downloading from Telegram...*\n\n📄 \`${fileName}\`\n\n${renderProgressBar(dlBytes, fileSize || 1)}\n_${(dlBytes / (1024 ** 2)).toFixed(2)} MB / ${sizeMB} MB_`,
                { parse_mode: 'Markdown' }
              ).catch(() => {});
            }
          });
          await stream.promises.pipeline(resp.data, ws);
        } else {
          const tgc  = await getTgClient();
          const peer = await resolvePeer(tgc, String(ctx.chat.id));
          const msgs = await tgc.getMessages(peer, { ids: [ctx.message.message_id] });
          if (!msgs || !msgs[0]?.media) throw new Error('Could not retrieve file via MTProto');
          const ws      = fs.createWriteStream(tmpPath);
          let dlBytes   = 0, lastUpd = 0;
          try {
            for await (const chunk of tgc.iterDownload({ file: msgs[0].media as any, requestSize: 1024 * 1024 })) {
              if (!ws.write(chunk)) {
                await new Promise<void>((resolve, reject) => {
                  const onDrain = () => { cleanup(); resolve(); };
                  const onErr = (err: any) => { cleanup(); reject(err); };
                  const cleanup = () => { ws.off('drain', onDrain); ws.off('error', onErr); };
                  ws.once('drain', onDrain);
                  ws.once('error', onErr);
                });
              }
              dlBytes += chunk.length;
              if (Date.now() - lastUpd > 2000) {
                bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
                  `📥 *Downloading via MTProto...*\n\n📄 \`${fileName}\`\n\n${renderProgressBar(dlBytes, fileSize || 1)}\n_${(dlBytes / (1024 ** 2)).toFixed(2)} MB / ${sizeMB} MB_`,
                  { parse_mode: 'Markdown' }
                ).catch(() => {});
                lastUpd = Date.now();
              }
            }
            ws.end();
            await new Promise<void>((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
          } catch (dlErr) {
            ws.destroy();
            throw dlErr;
          }
        }

        // ── UPLOAD PHASE with progress ────────────────────────────────────
        const stat          = fs.statSync(tmpPath);
        const totalBytes    = stat.size;
        let   uploadedBytes = 0;
        let   lastUpd2      = 0;

        const trackUpload = (len: number) => {
          uploadedBytes += len;
          const now = Date.now();
          if (now - lastUpd2 > 2000) {
            bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
              `🚀 *Uploading to Cloud...*\n\n📄 \`${fileName}\`\n\n${renderProgressBar(uploadedBytes, totalBytes)}\n_${(uploadedBytes / (1024 ** 2)).toFixed(2)} MB / ${(totalBytes / (1024 ** 2)).toFixed(2)} MB_`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
            lastUpd2 = now;
          }
        };

        await bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
          `🚀 *Uploading to Cloud...*\n\n📄 \`${fileName}\`\n\n${renderProgressBar(0, 1)}\n_0.00 MB / ${(totalBytes / (1024 ** 2)).toFixed(2)} MB_`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});

      if (account.accountType === 'onedrive') {
          const c          = await getOneDriveClient(account.tokens, accId!);
          const parentPath = folderId ? `/me/drive/items/${folderId}` : '/me/drive/root';
          // Use chunked upload if file is large (> 4MB)
          if (totalBytes > 4 * 1024 * 1024) {
             const uploadSession = await c.api(`${parentPath}:/${encodeURIComponent(fileName)}:/createUploadSession`).post({
               item: { '@microsoft.graph.conflictBehavior': 'rename', name: fileName }
             });
             const uploadUrl  = uploadSession.uploadUrl;
             const chunkSize  = 320 * 1024 * 10;
             for (let start = 0; start < totalBytes; start += chunkSize) {
               const end         = Math.min(start + chunkSize, totalBytes);
               const chunkLen    = end - start;
               const chunkStream = fs.createReadStream(tmpPath, { start, end: end - 1 });
               await axios.put(uploadUrl, chunkStream, {
                 headers: {
                   'Content-Range': `bytes ${start}-${end - 1}/${totalBytes}`,
                   'Content-Length': chunkLen,
                 }
               });
               trackUpload(chunkLen);
             }
          } else {
             const streamUpload = fs.createReadStream(tmpPath);
             await c.api(`${parentPath}:/${encodeURIComponent(fileName)}:/content`).put(streamUpload);
          }
        } else {
          const drive = await getDriveClient(account.tokens);
          const readStream = fs.createReadStream(tmpPath);
          const tr    = new stream.Transform({
            transform(chunk, _enc, cb) { trackUpload(chunk.length); cb(null, chunk); }
          });
          await drive.files.create({
            requestBody: { name: fileName, parents: [folderId || 'root'] },
            media:       { mimeType, body: readStream.pipe(tr) }
          });
        }

      if (userDoc?.backupEnabled && userDoc?.backupAccId && ObjectId.isValid(userDoc.backupAccId)) {
        try {
          const backupAcc = await database.collection('accounts').findOne({ _id: new ObjectId(userDoc.backupAccId), userId });
          if (backupAcc) {
            await bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
              `🛡️ *Mirroring to Backup Drive...*\n\n📧 \`${backupAcc.email || backupAcc.channelId}\``,
              { parse_mode: 'Markdown' }
            ).catch(() => {});

            if (backupAcc.accountType === 'tgdrive') {
              const caption = folderId ? `F[${folderId}] | ${fileName}` : fileName;
              const copied  = await bot!.telegram.copyMessage(backupAcc.channelId, ctx.chat.id, ctx.message.message_id, { caption });
              const shareId = nanoid12();
              await database.collection('tg_files').insertOne({
                accountId: backupAcc._id, userId: String(userId), messageId: copied.message_id, shareId,
                name: fileName, size: fileSize, mimeType,
                folder: folderId || '', caption, isEncrypted: false, date: Math.floor(Date.now() / 1000),
              });
            } else if (backupAcc.accountType === 'onedrive') {
              const c2 = await getOneDriveClient(backupAcc.tokens, backupAcc._id.toString());
              if (totalBytes > 4 * 1024 * 1024) {
                const uploadSession = await c2.api('/me/drive/root:/' + encodeURIComponent(fileName) + ':/createUploadSession').post({
                  item: { '@microsoft.graph.conflictBehavior': 'rename', name: fileName }
                });
                const uploadUrl  = uploadSession.uploadUrl;
                const chunkSize  = 320 * 1024 * 10;
                for (let start = 0; start < totalBytes; start += chunkSize) {
                  const end         = Math.min(start + chunkSize, totalBytes);
                  const chunkLen    = end - start;
                  const chunkStream = fs.createReadStream(tmpPath, { start, end: end - 1 });
                  await axios.put(uploadUrl, chunkStream, {
                    headers: {
                      'Content-Range': `bytes ${start}-${end - 1}/${totalBytes}`,
                      'Content-Length': chunkLen,
                    }
                  });
                }
              } else {
                const streamUpload2 = fs.createReadStream(tmpPath);
                await c2.api(`/me/drive/root:/${encodeURIComponent(fileName)}:/content`).put(streamUpload2);
              }
            } else {
              const backupDrive = await getDriveClient(backupAcc.tokens);
              const readStream2 = fs.createReadStream(tmpPath);
              await backupDrive.files.create({ requestBody: { name: fileName }, media: { mimeType, body: readStream2 } });
            }
          }
        } catch (backupErr) {
          console.error('Backup mirroring failed:', backupErr);
        }
      }

        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        if (accId) invalidateDriveCache(accId);
        await bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
          `✅ *Saved to Cloud!*${userDoc?.backupEnabled ? ' *(+ Backup Mirror)*' : ''}\n\n📄 \`${fileName}\`\n📏 \`${sizeMB} MB\`\n📁 \`${folderId || 'Root'}\``,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      } catch (err: any) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        throw err;
      }
    } catch (err: any) {
      await bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `❌ *Upload failed:* ${err.message}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  });

  // Callback query handler
  bot.action(/^cb:(.*)$/, async (ctx: any) => {
    const hash   = ctx.match[1];
    const stored = callbackStore[hash];
    if (!stored) return ctx.answerCbQuery('Session expired. Please start over.');

    const { action, accId, id } = stored;
    const database = await connectToMongo();
    const userId   = await getUserIdByTg(ctx.from!.id, database);
    if (!userId) return ctx.answerCbQuery('❌ Login required. Use /login.');

    if (!['download', 'send_to_tg', 'mk_def', 'rm_def', 'rm_acc', 'toggle_backup', 'set_backup', 'toggle_reg'].includes(action)) {
      ctx.answerCbQuery().catch(() => {});
    }

    try {
      const isValidId = accId && accId !== 'null' && accId.length === 24 && /^[0-9a-fA-F]{24}$/.test(accId);
      const account   = isValidId ? await database.collection('accounts').findOne({ _id: new ObjectId(accId) }) : null;
      if (account && String(account.userId) !== String(userId)) {
        return ctx.answerCbQuery('⛔ Access denied');
      }

      if (action === 'browse') {
        if (!account) return ctx.answerCbQuery('❌ Account not found');
        if (botState[ctx.from.id]?.action === 'batch_upload') delete botState[ctx.from.id];
        await renderBrowser(ctx, accId, id, stored.pageToken, true);

      } else if (action === 'batch_mode') {
        if (!account) return ctx.answerCbQuery('❌ Account not found');
        botState[ctx.from.id] = { action: 'batch_upload', data: { accId, folderId: id } };
        ctx.reply(`📦 *Batch Upload*\n\nEvery file you send now uploads here. Click Done when finished.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Done', callback_data: getCb('browse', accId, id) }]] } });

      } else if (action === 'mkdir') {
        if (!account) return ctx.answerCbQuery('❌ Account not found');
        botState[ctx.from.id] = { action: 'mkdir_prompt', data: { accId, folderId: id } };
        ctx.reply(`📁 *New Folder*\n\nSend me the folder name:`, { parse_mode: 'Markdown' });

      } else if (action === 'upload_prompt') {
        if (!account) return ctx.answerCbQuery('❌ Account not found');
        botState[ctx.from.id] = { action: 'upload_file', data: { accId, folderId: id } };
        ctx.reply(`📤 *Upload File*\n\nSend the file to upload:`, { parse_mode: 'Markdown' });

      } else if (action === 'files_list') {
        const accounts = await database.collection('accounts').find({ userId }).toArray();
        const buttons  = accounts.map((acc: any) => ([{ text: acc.accountType === 'tgdrive' ? `📡 TG Drive (${acc.channelId})` : `📧 ${acc.email}`, callback_data: getCb('browse', acc._id.toString(), 'root') }]));
        ctx.editMessageText('📂 *Select account:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });

      } else if (action === 'info') {
        if (!account) throw new Error('Account not found');
        let name = 'Unknown', size = 'N/A', mimeType = 'file', shareId = '', isEncrypted = false;

        try {
          if (account.accountType === 'tgdrive') {
            if (!ObjectId.isValid(id)) throw new Error('Invalid file ID');
            const meta = await database.collection('tg_files').findOne({ _id: new ObjectId(id), accountId: account._id });
            if (!meta) throw new Error('File not found');
            isEncrypted = meta.isEncrypted === true;
            name = meta.name || 'Unknown';
            size = meta.size ? (Number(meta.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'N/A';
            mimeType = isEncrypted ? 'application/octet-stream' : (meta.mimeType || 'file');
            shareId = isEncrypted ? '' : (meta.shareId || '');
          } else {
            const meta = await database.collection('tg_files').findOne({ accountId: account._id, providerFileId: String(id) });
            isEncrypted = meta?.isEncrypted === true;
            if (account.accountType === 'onedrive') {
              const c = await getOneDriveClient(account.tokens, accId);
              const f = await c.api(`/me/drive/items/${id}`).get();
              name = f.name;
              size = f.size ? (Number(f.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'N/A';
              mimeType = isEncrypted ? 'application/octet-stream' : (f.file?.mimeType || 'file');
            } else {
              const drive = await getDriveClient(account.tokens);
              const f = await drive.files.get({ fileId: id, fields: 'name,size,mimeType' });
              name = f.data.name!;
              size = f.data.size ? (Number(f.data.size) / (1024 ** 2)).toFixed(2) + ' MB' : 'N/A';
              mimeType = isEncrypted ? 'application/octet-stream' : f.data.mimeType!;
            }
          }
        } catch (e: any) {
          console.error('Info fetch error:', e);
          return ctx.answerCbQuery('❌ Error: ' + e.message);
        }

        const shareLink = shareId ? `${process.env.APP_URL}/s/${shareId}` : null;
        const buttons: any[][] = [];
        if (!isEncrypted) {
          buttons.push([{ text: '📱 Send to Telegram', callback_data: getCb('send_to_tg', accId, id) }]);
          buttons.push([{ text: '✏️ Rename', callback_data: getCb('rename', accId, id) }]);
        }
        buttons.push([{ text: '🗑️ Delete', callback_data: getCb('delete', accId, id) }]);
        if (shareLink) buttons.unshift([{ text: '🔗 Share Link', url: shareLink }]);
        buttons.push([{ text: '⬅️ Back', callback_data: getCb('browse', accId, 'root') }]);

        const safeName = name.replace(/_/g, '\\_').replace(/\*/g, '\\*');
        const safeType = mimeType.replace(/_/g, '\\_').replace(/\*/g, '\\*');

        ctx.editMessageText(`📄 *File Details*${isEncrypted ? ' 🔒 _(E2EE)_' : ''}\n\n*Name:* ${safeName}\n*Size:* ${size}\n*Type:* ${safeType}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch((err: any) => {
          console.error('Edit info error:', err);
          ctx.reply(`📄 *File Details*\n\nName: ${name}\nSize: ${size}\nType: ${mimeType}`, { reply_markup: { inline_keyboard: buttons } });
        });

      } else if (action === 'send_to_tg') {
        if (!account) throw new Error('Account not found');
        const statusMsg = await ctx.reply('⏳ *Preparing...*', { parse_mode: 'Markdown' });
        const tmpPath   = path.join(os.tmpdir(), `send_${Date.now()}_${nanoid(6)}`);
        try {
          let fileName = 'file', downloadStream: any;
          if (account.accountType === 'tgdrive') {
            if (!ObjectId.isValid(id)) throw new Error('Invalid file ID');
            const meta = await database.collection('tg_files').findOne({ _id: new ObjectId(id), accountId: account._id });
            if (!meta) throw new Error('File not found');
            if (meta.isEncrypted === true) throw new Error('Encrypted files must be downloaded in the app');
            const telegram = await getTgClient();
            const peer     = await resolvePeer(telegram, account.channelId);
            const msgs     = await telegram.getMessages(peer, { ids: [meta.messageId] });
            if (!msgs?.[0]?.media) throw new Error('Message not found');
            fileName = meta.name;
            const ws = fs.createWriteStream(tmpPath);
            try {
              for await (const chunk of telegram.iterDownload({ file: msgs[0].media as any, requestSize: 512 * 1024 })) {
                if (!ws.write(chunk)) {
                  await new Promise<void>((resolve, reject) => {
                    const onDrain = () => { cleanup(); resolve(); };
                    const onErr = (e: any) => { cleanup(); reject(e); };
                    const cleanup = () => { ws.off('drain', onDrain); ws.off('error', onErr); };
                    ws.once('drain', onDrain);
                    ws.once('error', onErr);
                  });
                }
              }
              ws.end();
              await new Promise<void>((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
            } catch (e) {
              ws.destroy();
              throw e;
            }
          } else {
            const meta = await database.collection('tg_files').findOne({ accountId: account._id, providerFileId: String(id) });
            if (meta?.isEncrypted === true) throw new Error('Encrypted files must be downloaded in the app');
            if (account.accountType === 'onedrive') {
              const c    = await getOneDriveClient(account.tokens, accId);
              const item = await c.api(`/me/drive/items/${id}`).get();
              fileName = item.name;
              const dlUrl = item['@microsoft.graph.downloadUrl'];
              if (!dlUrl) throw new Error('Download link not available');
              const r     = await axios.get(dlUrl, { responseType: 'stream' }); downloadStream = r.data;
            } else {
              const drive = await getDriveClient(account.tokens);
              const f     = await drive.files.get({ fileId: id, fields: 'name,size' });
              fileName = f.data.name!;
              const r  = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' }); downloadStream = r.data;
            }
            const ws = fs.createWriteStream(tmpPath);
            await stream.promises.pipeline(downloadStream, ws);
          }
          const tgc = await getTgClient();
          await tgc.sendFile(String(ctx.chat.id), { file: tmpPath, caption: `✅ *${fileName}*`, forceDocument: true, attributes: [new Api.DocumentAttributeFilename({ fileName })] });
          bot!.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        } catch (err: any) {
          bot!.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `❌ *Failed:* ${err.message}`, { parse_mode: 'Markdown' }).catch(() => {});
        } finally {
          if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
        }

      } else if (action === 'rename') {
        if (!account) throw new Error('Account not found');
        botState[ctx.from.id] = { action: 'rename_prompt', data: { accId, fileId: id } };
        ctx.reply(`✏️ *Rename*\n\nSend the new name:`, { parse_mode: 'Markdown' });

      } else if (action === 'delete') {
        if (!account) throw new Error('Account not found');
        if (account.accountType === 'tgdrive') {
          if (!ObjectId.isValid(id)) throw new Error('Invalid file ID');
          const meta = await database.collection('tg_files').findOne({ _id: new ObjectId(id), accountId: account._id });
          if (meta) {
            const refCount = await database.collection('tg_files').countDocuments({ messageId: meta.messageId, accountId: account._id });
            if (refCount <= 1) {
              const telegram = await getTgClient();
              const peer     = await resolvePeer(telegram, account.channelId);
              try { await telegram.deleteMessages(peer, [meta.messageId], { revoke: true }); } catch { /* ignore */ }
            }
            await database.collection('tg_files').deleteOne({ _id: meta._id });
          }
        } else if (account.accountType === 'onedrive') {
          const c = await getOneDriveClient(account.tokens, accId); await c.api(`/me/drive/items/${id}`).delete();
          await database.collection('tg_files').deleteMany({ accountId: account._id, providerFileId: String(id) });
        } else {
          const drive = await getDriveClient(account.tokens); await drive.files.delete({ fileId: id });
          await database.collection('tg_files').deleteMany({ accountId: account._id, providerFileId: String(id) });
        }
        if (deleteThumbFiles) deleteThumbFiles(id, accId);
        invalidateDriveCache(accId);
        ctx.answerCbQuery('✅ Deleted');
        ctx.editMessageText('🗑️ *File deleted.*', { parse_mode: 'Markdown' });

      } else if (action === 'sett_acc') {
        if (!account) throw new Error('Account not found');
        const label = account.accountType === 'tgdrive' ? `TG Drive (${account.channelId})` : account.email;
        const buttons = [
          [{ text: account.isDefault ? '⭐ Remove Default' : '⭐ Set as Default', callback_data: getCb(account.isDefault ? 'rm_def' : 'mk_def', accId, 'null') }],
          [{ text: '🗑️ Delete Account', callback_data: getCb('rm_acc_confirm', accId, 'null') }],
          [{ text: '⬅️ Back', callback_data: getCb('settings_main', 'null', 'null') }],
        ];
        ctx.editMessageText(`⚙️ *${label}*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });

      } else if (action === 'mk_def') {
        await database.collection('accounts').updateMany({ userId }, { $set: { isDefault: false } });
        await database.collection('accounts').updateOne({ _id: new ObjectId(accId), userId }, { $set: { isDefault: true } });
        ctx.answerCbQuery('✅ Set as default');
        await renderSettings(ctx, true);

      } else if (action === 'rm_def') {
        await database.collection('accounts').updateOne({ _id: new ObjectId(accId), userId }, { $set: { isDefault: false } });
        ctx.answerCbQuery('✅ Default removed');
        await renderSettings(ctx, true);

      } else if (action === 'rm_acc_confirm') {
        if (!account) throw new Error('Account not found');
        const label = account.accountType === 'tgdrive' ? `TG Drive (${account.channelId})` : account.email;
        ctx.editMessageText(`⚠️ *Delete account* \`${label}\`?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Yes, Delete', callback_data: getCb('rm_acc', accId, 'null') }], [{ text: '❌ Cancel', callback_data: getCb('sett_acc', accId, 'null') }]] } });

      } else if (action === 'rm_acc') {
        await database.collection('accounts').deleteOne({ _id: new ObjectId(accId), userId });
        await database.collection('account_encryption_backups').deleteMany({ accountId: String(accId), userId: String(userId) });
        await database.collection('upload_sessions').deleteMany({ accountId: String(accId), userId: String(userId) });
        invalidateDriveCache(accId);
        ctx.answerCbQuery('✅ Account deleted');
        ctx.editMessageText('🗑️ *Account deleted.*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: getCb('settings_main', 'null', 'null') }]] } });

      } else if (action === 'settings_main') {
        await renderSettings(ctx, true);

      } else if (action === 'backup_settings') {
        const user     = await database.collection('users').findOne({ _id: userId });
        const accounts = await database.collection('accounts').find({ userId }).toArray();
        const backupAcc = accounts.find((a: any) => a._id.toString() === user?.backupAccId);
        const bLabel   = backupAcc ? (backupAcc.accountType === 'tgdrive' ? `TG Drive (${backupAcc.channelId})` : backupAcc.email) : 'None';
        let text = `🛡️ *Backup Settings*\n\nStatus: ${user?.backupEnabled ? '✅ Enabled' : '❌ Disabled'}\nTarget: ${bLabel}`;
        const buttons = [
          [{ text: user?.backupEnabled ? '❌ Disable' : '✅ Enable', callback_data: getCb('toggle_backup', 'null', 'null') }],
          [{ text: '🎯 Set Backup Account', callback_data: getCb('pick_backup', 'null', 'null') }],
          [{ text: '⬅️ Back', callback_data: getCb('settings_main', 'null', 'null') }]
        ];
        ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });

      } else if (action === 'toggle_backup') {
        const user = await database.collection('users').findOne({ _id: userId });
        await database.collection('users').updateOne({ _id: userId }, { $set: { backupEnabled: !user?.backupEnabled } });
        ctx.answerCbQuery('Updated'); await renderSettings(ctx, true);

      } else if (action === 'pick_backup') {
        const accounts = await database.collection('accounts').find({ userId }).toArray();
        const buttons  = accounts.map((acc: any) => ([{ text: acc.accountType === 'tgdrive' ? `📡 TG Drive (${acc.channelId})` : `📁 ${acc.email}`, callback_data: getCb('set_backup', acc._id.toString(), 'null') }]));
        buttons.push([{ text: '⬅️ Back', callback_data: getCb('backup_settings', 'null', 'null') }]);
        ctx.editMessageText('🎯 *Select backup account:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });

      } else if (action === 'set_backup') {
        const targetAcc = ObjectId.isValid(accId)
          ? await database.collection('accounts').findOne({ _id: new ObjectId(accId), userId })
          : null;
        if (!targetAcc) return ctx.answerCbQuery('❌ Invalid account');
        await database.collection('users').updateOne({ _id: userId }, { $set: { backupAccId: String(targetAcc._id) } });
        ctx.answerCbQuery('Backup account set'); await renderSettings(ctx, true);
        
      } else if (action === 'admin_panel') {
        await renderAdminPanel(ctx, true);

      } else if (action === 'toggle_reg') {
        const user = await database.collection('users').findOne({ _id: userId });
        if (!user?.isAdmin) return ctx.answerCbQuery('⛔ Access denied');
        const allowedKeys = new Set(['registrationEnabled', 'webRegistrationEnabled', 'botRegistrationEnabled']);
        if (!allowedKeys.has(accId)) return ctx.answerCbQuery('❌ Invalid setting key');
        
        const newValue = id === 'true';
        await database.collection('settings').updateOne(
          { key: accId },
          { $set: { key: accId, value: newValue, updatedAt: new Date() } },
          { upsert: true }
        );
        ctx.answerCbQuery('✅ Setting updated');
        await renderAdminPanel(ctx, true);
      }

    } catch (e: any) {
      ctx.answerCbQuery?.('Error: ' + e.message);
      console.error('Callback error:', e);
    }
  });

  bot.launch().catch(err => console.error('Bot launch failed:', err));

  return bot;
}
