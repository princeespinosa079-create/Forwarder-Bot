const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const fs = require('fs');

// ============================================
// ⚙️ RENDER ENVIRONMENT VARIABLES
// ============================================
const OWNER_ID       = process.env.OWNER_ID       || '1302080645987569694';
const BOT_TOKEN      = process.env.BOT_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const FORWARD_LIMIT  = parseInt(process.env.FORWARD_LIMIT) || 500;
const DATA_FILE      = '/tmp/forwarder_data.json'; // Render writable storage
const ALLOWED_EXT    = ['txt', 'lua', 'zip'];
const BATCH_SIZE     = 10;  // Discord MAX files per message = 10 (DO NOT CHANGE)
const SEND_WORKERS   = 2;   // Parallel send workers (2 = fastest SAFE speed)

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
  restRequestTimeout: 45000,
  retryLimit: 3
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
    .setDescription('⚡ FAST Forward .txt / .lua / .zip between channels')
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
// 🚀 FAST MESSAGE FETCHER (Paginated)
// ============================================
async function fetchAllMessages(channel, limit) {
  const all = [];
  let last = null;
  while (all.length < limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, limit - all.length),
      before: last || undefined
    });
    if (!batch.size) break;
    all.push(...batch.values());
    last = batch.last().id;
  }
  return all.reverse(); // Oldest → newest order
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
        await new Promise(r => setTimeout(r, 1200));
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
const isOwner      = id => id === OWNER_ID;
const isWhitelisted = id => isOwner(id) || whitelist.has(id);
const isLoggedIn   = id => userTokens.has(id);

// ============================================
// ✅ BOT READY → REGISTER COMMANDS
// ============================================
client.once('ready', async () => {
  loadData();
  console.log(`\n✅ ONLINE as ${client.user.tag}`);
  console.log(`👑 OWNER ID: ${OWNER_ID}`);
  console.log(`⚡ SPEED: ${SEND_WORKERS} workers | ${BATCH_SIZE} files/batch\n`);

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
  // 👑 /WHITELIST — OWNER ONLY
  // ==========================================
  if (commandName === 'whitelist') {
    if (!isOwner(user.id)) return i.reply({
      content: '🔒 **OWNER ONLY** — You are not allowed to use this.',
      ephemeral: true
    });

    const mode   = i.options.getString('mode');
    const target = i.options.getUser('user');

    // LIST
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

    // ADD / REMOVE require target
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
      userTokens.delete(target.id); // Force logout
      saveData();
      return i.reply({
        content: `❌ **REMOVED** <@${target.id}> + logged them out.`,
        ephemeral: true
      });
    }
  }

  // ==========================================
  // 🔐 /LOGIN — WHITELISTED ONLY
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
  // ⚡ /FORWARD — WHITELISTED + LOGGED IN
  // ==========================================
  if (commandName === 'forward') {
    // Permission checks
    if (!isWhitelisted(user.id)) return i.reply({
      content: '🚫 **NOT WHITELISTED** — Ask the owner for access.',
      ephemeral: true
    });
    if (!isLoggedIn(user.id)) return i.reply({
      content: '⚠️ **NOT LOGGED IN**\n> Run `/login token:YOUR_PRIVATE_TOKEN` first.',
      ephemeral: true
    });

    const src = i.options.getChannel('source');
    const dst = i.options.getChannel('destination');

    if (!src || !dst) return i.reply({
      content: '❌ Invalid channel(s). Make sure the bot can see both channels.',
      ephemeral: true
    });
    if (src.id === dst.id) return i.reply({
      content: '❌ Source and destination **cannot be the same channel**.',
      ephemeral: true
    });

    // ✅ Defer reply (gives us 15 MINUTES to work)
    await i.deferReply({ ephemeral: true });
    const startTime = Date.now();

    try {
      // ─── 1️⃣ FAST FETCH ALL MESSAGES ───
      const messages = await fetchAllMessages(src, FORWARD_LIMIT);
      if (!messages.length) return i.editReply(
        `📭 No messages found in <#${src.id}>`
      );

      // ─── 2️⃣ SINGLE-PASS FILTER + COUNT (SUPER FAST) ───
      const counts = { txt: 0, lua: 0, zip: 0 };
      const files  = [];

      for (const msg of messages) {
        if (!msg.attachments.size) continue; // ⚡ EARLY SKIP
        for (const att of msg.attachments.values()) {
          const ext = att.name.split('.').pop()?.toLowerCase();
          if (!ALLOWED_EXT.includes(ext)) continue;
          counts[ext]++;
          files.push({ attachment: att.url, name: att.name });
        }
      }

      if (!files.length) return i.editReply(
        `📭 Scanned **${messages.length}** messages in <#${src.id}>\n` +
        `> Found **0** matching files (only \`.txt\` / \`.lua\` / \`.zip\` are forwarded)`
      );

      // ─── 3️⃣ SPLIT INTO BATCHES OF 10 ───
      const batches = [];
      for (let x = 0; x < files.length; x += BATCH_SIZE) {
        batches.push(files.slice(x, x + BATCH_SIZE));
      }

      // ─── 4️⃣ ⚡ PARALLEL SEND (MAX SPEED) ───
      await sendBatchesFast(dst, batches);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // ─── 5️⃣ SEND YOUR EXACT EMBED TO DESTINATION ───
      const doneEmbed = new EmbedBuilder()
        .setTitle('✅ Forward done!')
        .setDescription(
          `I got this from <#${src.id}> and i forward it to <#${dst.id}> and yeah, ` +
          `i got **${counts.txt}** .txt, **${counts.lua}** .lua, and **${counts.zip}** .zip.`
        )
        .setColor('Green')
        .setFooter({ text: 'Forwarder Bot︱.gg/freesource' })
        .setTimestamp();

      await dst.send({ embeds: [doneEmbed] });

      // ─── 6️⃣ CONFIRM TO USER (PRIVATE) ───
      return i.editReply(
        `✅ **FORWARD COMPLETE!** ⚡\n` +
        `> **From:** <#${src.id}>\n` +
        `> **To:** <#${dst.id}>\n` +
        `> **Files:** \`${files.length}\` total ` +
        `(${counts.txt} txt / ${counts.lua} lua / ${counts.zip} zip)\n` +
        `> **Batches:** \`${batches.length}\` | **Speed:** ${SEND_WORKERS} workers\n` +
        `> **Time:** \`${elapsed}s\``
      );

    } catch (err) {
      console.error(err);
      return i.editReply(
        `❌ **ERROR:** \`${err.message}\`\n\n` +
        `**Common fixes:**\n` +
        `• Bot needs **Read Message History** in <#${src?.id}>\n` +
        `• Bot needs **Send Messages + Attach Files** in <#${dst?.id}>\n` +
        `• Channels are in the same server`
      );
    }
  }
});

// ============================================
// 🚀 START BOT
// ============================================
client.login(BOT_TOKEN).catch(e => {
  console.error('\n❌ LOGIN FAILED — Check BOT_TOKEN in Render Env Vars');
  console.error(e.message);
  process.exit(1);
});
