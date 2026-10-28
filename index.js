const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const fs = require('fs');

// ============================================
// ⚙️ RENDER ENVIRONMENT VARIABLES (NO CONFIG.JSON)
// ============================================
const OWNER_ID     = process.env.OWNER_ID     || '1302080645987569694';
const BOT_TOKEN    = process.env.BOT_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const DATA_FILE    = '/tmp/forwarder_data.json'; // Render writable storage
const ALLOWED_EXT  = ['txt', 'lua', 'zip'];
const BATCH_SIZE   = 10;  // Discord hard limit = 10 files/message (DO NOT CHANGE)
const SEND_WORKERS = 2;   // Parallel send workers (2 = fastest SAFE speed)

// ============================================
// 💾 PERSISTENCE (Survives Render restarts)
// ============================================
let userTokens = new Map();
let whitelist  = new Set();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      userTokens = new Map(d.userTokens || []);
      whitelist  = new Set(d.whitelist  || []);
      console.log('[OK] Loaded whitelist + login data');
    }
  } catch (e) { console.log('[!] Fresh start — no saved data'); }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      userTokens: [...userTokens.entries()],
      whitelist:  [...whitelist]
    }));
  } catch (e) { console.log('[!] Save failed:', e.message); }
}

// ============================================
// 🤖 BOT CLIENT SETUP
// ============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel],
  restRequestTimeout: 120000, // 2min timeout for huge channel scans
  retryLimit: 5
});

// ============================================
// ⚡ SLASH COMMANDS DEFINITION
// ============================================
const commands = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('🔐 Login with your private token')
    .addStringOption(o => o
      .setName('token')
      .setDescription('Your private token (ONLY YOU SEE THIS)')
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('forward')
    .setDescription('⚡ UNLIMITED Forward .txt/.lua/.zip + auto skip duplicates')
    .addChannelOption(o => o
      .setName('source')
      .setDescription('Source channel (ID or mention)')
      .setRequired(true))
    .addChannelOption(o => o
      .setName('destination')
      .setDescription('Destination channel (ID or mention)')
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('👑 OWNER ONLY — Manage who can use the bot')
    .addStringOption(o => o
      .setName('mode')
      .setDescription('Choose action')
      .setRequired(true)
      .addChoices(
        { name: 'Add',    value: 'add'    },
        { name: 'Remove', value: 'remove' },
        { name: 'List',   value: 'list'   }
      ))
    .addUserOption(o => o
      .setName('user')
      .setDescription('User (mention or paste ID)')
      .setRequired(false))
].map(c => c.toJSON());

// ============================================
// 🚀 UNLIMITED MESSAGE FETCHER (NO LIMIT — GOES TO CHANNEL START)
// ============================================
async function fetchAllMessages(channel) {
  const all = [];
  let lastId = null;
  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      before: lastId || undefined
    });
    if (!batch.size) break; // No more messages = stop
    all.push(...batch.values());
    lastId = batch.last().id;
  }
  return all.reverse(); // Oldest → newest order
}

// ============================================
// 🆔 FETCH ALL EXISTING FILE SIGNATURES FROM DESTINATION (FOR DUPLICATE CHECK)
// Signature = "filename|filesize" (100% accurate duplicate detection)
// ============================================
async function fetchDestinationSignatures(channel) {
  const signatures = new Set(); // O(1) instant lookups
  let lastId = null;
  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      before: lastId || undefined
    });
    if (!batch.size) break;
    for (const msg of batch.values()) {
      if (!msg.attachments.size) continue;
      for (const att of msg.attachments.values()) {
        // Case-insensitive filename + exact size = perfect duplicate match
        signatures.add(`${att.name.toLowerCase()}|${att.size}`);
      }
    }
    lastId = batch.last().id;
  }
  return signatures;
}

// ============================================
// ⚡ PARALLEL BATCH SENDER (MAX SPEED)
// ============================================
async function sendBatchesFast(channel, batches) {
  let idx = 0;
  const total = batches.length;

  async function worker() {
    while (idx < total) {
      const i = idx++;
      try {
        await channel.send({ files: batches[i] });
      } catch (err) {
        // Retry ONCE on rate limit / network blip
        await new Promise(r => setTimeout(r, 1500));
        try { await channel.send({ files: batches[i] }); }
        catch (e) { console.log('[FAIL] Batch', i, ':', e.message); }
      }
    }
  }

  // Spawn N workers running IN PARALLEL
  await Promise.all(
    Array.from({ length: SEND_WORKERS }, worker)
  );
}

// ============================================
// 🔑 PERMISSION CHECKS
// ============================================
const isOwner       = id => id === OWNER_ID;
const isWhitelisted = id => isOwner(id) || whitelist.has(id);
const isLoggedIn    = id => userTokens.has(id);

// ============================================
// ✅ BOT READY → REGISTER COMMANDS
// ============================================
client.once('ready', async () => {
  loadData();
  console.log(`\n✅ ONLINE as ${client.user.tag}`);
  console.log(`👑 OWNER ID: ${OWNER_ID}`);
  console.log(`⚡ UNLIMITED MODE ACTIVE | ${SEND_WORKERS} workers | ${BATCH_SIZE} files/batch\n`);

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('⚡ Slash commands registered (global — ~1min to appear)');
  } catch (e) { console.error('❌ Command register FAIL:', e.message); }
});

// ============================================
// 🎮 COMMAND HANDLER
// ============================================
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const { commandName, user } = i;

  // ==========================================
  // 👑 /WHITELIST — OWNER ONLY (UNCHANGED)
  // ==========================================
  if (commandName === 'whitelist') {
    if (!isOwner(user.id)) return i.reply({
      content: '🔒 **OWNER ONLY** — You are not allowed to use this.',
      ephemeral: true
    });

    const mode   = i.options.getString('mode');
    const target = i.options.getUser('user');

    if (mode === 'list') {
      const list = whitelist.size
        ? [...whitelist].map(id => `• <@${id}> → \`${id}\``).join('\n')
        : '*(whitelist is empty)*';
      return i.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📋 Whitelisted Users')
          .setDescription(list)
          .setColor('Blurple')
          .setFooter({ text: `Total: ${whitelist.size} user(s)` })],
        ephemeral: true
      });
    }

    if (!target) return i.reply({
      content: '❌ You must provide a **user** (mention or ID) for Add / Remove.',
      ephemeral: true
    });

    if (mode === 'add') {
      whitelist.add(target.id);
      saveData();
      return i.reply({
        content: `✅ **ADDED** <@${target.id}> (\`${target.id}\`) to whitelist.`,
        ephemeral: true
      });
    }

    if (mode === 'remove') {
      whitelist.delete(target.id);
      userTokens.delete(target.id);
      saveData();
      return i.reply({
        content: `❌ **REMOVED** <@${target.id}> + logged them out.`,
        ephemeral: true
      });
    }
  }

  // ==========================================
  // 🔐 /LOGIN — WHITELISTED ONLY (UNCHANGED)
  // ==========================================
  if (commandName === 'login') {
    if (!isWhitelisted(user.id)) return i.reply({
      content: '🚫 **NOT WHITELISTED** — Ask the owner to add you first.',
      ephemeral: true
    });

    const token = i.options.getString('token');
    userTokens.set(user.id, token.trim());
    saveData();
    return i.reply({
      content: '🔐 **LOGGED IN SUCCESSFULLY!**\n> Your token is private — *only you can see this message.*',
      ephemeral: true
    });
  }

  // ==========================================
  // ⚡ /FORWARD — UNLIMITED + DUPLICATE SKIP
  // ==========================================
  if (commandName === 'forward') {
    // Permission checks
    if (!isWhitelisted(user.id)) return i.reply({
      content: '🚫 **NOT WHITELISTED** — Ask the owner for access.',
      ephemer
