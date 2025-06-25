// ======= Required Modules =======
const TelegramBot = require('node-telegram-bot-api');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');

// ======= Bot Configuration =======
const TELEGRAM_BOT_TOKEN = '7324430025:AAG1EQjCQpoKYYntRiGKzsVga0M1muQEMtQ';
const CHANNEL_ID = '@gabimarutechchannel';
const ADMIN_IDS = [8095961856]; // Replace with real Telegram user IDs

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connectedUsers = {}; // Format: { phoneNumber: chatId }


// ======= Utility Functions =======
function saveConnectedUser(phoneNumber, chatId) {
  connectedUsers[phoneNumber] = chatId;
}

function deleteConnectedUser(phoneNumber) {
  delete connectedUsers[phoneNumber];
}

function listConnectedUsers() {
  return Object.entries(connectedUsers)
    .map(([phone, chat]) => `${phone} → ${chat}`)
    .join('\n') || 'No active connections';
}

async function checkChannelMembership(chatId) {
  const status = await bot.getChatMember(CHANNEL_ID, chatId).catch(() => null);
  return status && !['left', 'kicked'].includes(status.status);
}

async function sendTelegramMessage(chatId, message) {
  try {
    await bot.sendMessage(chatId, message);
  } catch (err) {
    console.error('Telegram message error:', err);
  }
}


// ======= WhatsApp Connection =======
async function startBotz(phoneNumber, telegramChatId = null) {
  const sessionPath = `./tmp/session/${phoneNumber}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const wabot = makeWASocket({
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    version,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    generateHighQualityLinkPreview: true,
  });

  if (!wabot.authState.creds.registered) {
    const code = await wabot.requestPairingCode(phoneNumber);
    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
    if (telegramChatId) {
      sendTelegramMessage(
        telegramChatId,
        `📲 Pairing code for *${phoneNumber}*: ${formatted}`
      );
    }
  }

  wabot.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open' && telegramChatId) {
      sendTelegramMessage(telegramChatId, `✅ Connected to WhatsApp as ${wabot.user.id}`);
    } else if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
      if (telegramChatId) sendTelegramMessage(telegramChatId, '⚠️ Reconnecting...');
      startBotz(phoneNumber, telegramChatId);
    }
  });

  wabot.ev.on('creds.update', saveCreds);

  wabot.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    const from = msg.key.remoteJid;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    (async () => {
      try {
        const pushName = msg.pushName || 'User';
        const isGroup = msg.key.remoteJid.endsWith('@g.us');
        const chatInfo = isGroup ? await wabot.groupMetadata(from) : null;
        const groupName = chatInfo?.subject || '';
        const statusMsg = isGroup ? `I'm chatting in ${groupName}` : `DM with ${pushName}`;
        await wabot.updateProfileStatus(statusMsg);
      } catch (err) {
        console.error('Failed to update bio:', err);
      }
    })();

    switch (text?.toLowerCase()) {
      case 'ping':
        await wabot.sendMessage(from, { text: '🏓 Pong from WhatsApp bot!' });
        break;
    }

    if (telegramChatId && text) {
      sendTelegramMessage(telegramChatId, `📥 *${from}*: ${text}`);
    }
  });

  // Group Join/Leave Notices
  wabot.ev.on('group-participants.update', async ({ id, participants, action }) => {
    for (const user of participants) {
      const note =
        action === 'add'
          ? `👋 Welcome ${user} to ${id}`
          : `👋 ${user} left ${id}`;
      if (telegramChatId) sendTelegramMessage(telegramChatId, note);
    }
  });
}


// ======= Telegram Commands =======

// /connect
bot.onText(/^\/connect (\d{7,15})$/, async (msg, match) => {
  const chatId = msg.chat.id;
 /* if (!(await checkChannelMembership(chatId)))
    return bot.sendMessage(chatId, `❌ Please join ${CHANNEL_ID} to use this bot.`); */

  const phone = match[1];
  if (connectedUsers[phone])
    return bot.sendMessage(chatId, `⚠️ This number is already connected.`);

  saveConnectedUser(phone, chatId);
  bot.sendMessage(chatId, `🔄 Connecting WhatsApp number: ${phone}`);
  await startBotz(phone, chatId);
});

// /deletepair
bot.onText(/^\/deletepair (\d{7,15})$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId))
    return bot.sendMessage(chatId, '❌ Admins only.');
/*  if (!(await checkChannelMembership(chatId)))
    return bot.sendMessage(chatId, `❌ Please join ${CHANNEL_ID} to use this bot.`); */

  const phone = match[1];
  if (!connectedUsers[phone])
    return bot.sendMessage(chatId, '❌ That number is not connected.');

  deleteConnectedUser(phone);
  bot.sendMessage(chatId, `✅ Disconnected number: ${phone}`);
});

// /listpair
bot.onText(/^\/listpair$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId))
    return bot.sendMessage(chatId, '❌ Admins only.');
/*  if (!(await checkChannelMembership(chatId)))
    return bot.sendMessage(chatId, `❌ Please join ${CHANNEL_ID} to use this bot.`); */

  bot.sendMessage(chatId, `📋 Connected Numbers:\n${listConnectedUsers()}`);
});

// /start
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
/*  if (!(await checkChannelMembership(chatId)))
    return bot.sendMessage(chatId, `❌ Please join ${CHANNEL_ID} to use this bot.`); */

  const photoUrl = 'https://files.catbox.moe/8boi3c.jpg';
  const caption = `🤖 *Aizen WhatsApp Bot*\n\nConnect and manage WhatsApp from Telegram with powerful features.\n\n🔹 /connect <number>\n🔹 /deletepair <number> (admin)\n🔹 /listpair (admin)\n🔹 *ping* (from WhatsApp)`;
  bot.sendPhoto(chatId, photoUrl, { caption, parse_mode: 'Markdown' });
});
