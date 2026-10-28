const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const fs = require('fs');
const http = require('http');

// ============================================
// ⚙️ RENDER ENV VARS + HARDCODED FALLBACKS
// ============================================
const OWNER_ID     = process.env.OWNER_ID     || '1302080645987569694';
const BOT_TOKEN    = process.env.BOT_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const PORT         = process.env.PORT || 10000;
const DATA_FILE    = '/tmp/forwarder_data.json';
const ALLOWED_EXT  = ['txt', 'lua', 'zip'];
const BATCH_SIZE   = 10;
const SEND_WORKERS = 2;

// ============================================
// 🌐 RENDER PORT FIX (100% stops port timeout)
// ============================================
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Forwarder Bot OK');
}).listen(PORT, () => {
  console.log(`✅ Port ${PORT} open (Render health check)`);
});

// ============================================
// 💾 PERSISTENCE (whitelist + logins survive restarts)
// ============================================
let userTokens = new Map();
let whitelist  = new Set();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      userTokens = new Map(d.userTokens || []);
      whitelist  = new Set(d.whitelist  || []);
      console.log('✅ Loaded saved data');
    }
  } catch (e) { console.log('ℹ️ Fresh start (no saved data)'); }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      userTokens: [...userTokens.entries()],
      whitelist:  [...whitelist]
    }));
  } catch (e) { console.log('⚠️ Save failed:', e.message); }
}

// ============================================
// 🤖 BOT CLIENT
// ============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel],
  restRequestTimeout: 120000,
  retryLimit: 5
});

// ============================================
// ⚡ SLASH COMMANDS (100% valid — no undefined fields)
// ============================================
const commands = [
  // /login
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('🔐 Login with your private token')
    .addStringOption(o => o
      .setName('token')
      .setDescription('Your private token')
      .setRequired(true)),

  // /forward
  new SlashCommandBuilder()
    .setName('forward')
    .setDescription('⚡ UNLIMITED forward + skip duplicates')
    .addChannelOption(o => o
      .setName('source')
      .setDescription('Source channel')
      .setRequired(true))
    .addChannelOption(o => o
      .setName('destination')
      .setDescription('Destination channel')
      .setRequired(true)),

  // /whitelist
  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('👑 OWNER ONLY')
    .addStringOption(o => o
      .setName('mode')
      .setDescription('Action')
      .setRequired(true)
      .addChoices(
        { name: 'Add',    value: 'add'    },
        { name: 'Remove', value: 'remove' },
        { name: 'List',   value: 'list'   }
      ))
    .addUserOption(o => o
      .setName('user')
      .setDescription('User (ID or mention)')
      .setRequired(false))
].map(c => c.toJSON());

// ============================================
// 🚀 UNLIMITED FETCHERS (NO MESSAGE LIMIT)
// ============================================
async function fetchAllMessages(channel) {
  const all = [];
  let lastId = null;
  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      before: lastId || undefined
    });
    if (!batch.size) break;
    all.push(...batch.values());
    lastId = batch.last().id;
  }
  return all.reverse();
}

async function getDestSignatures(channel) {
  const sigs = new Set();
  let lastId = null;
  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      before: lastId || undefined
    });
    if (!batch.size) break;
    for (const msg of batch.values()) {
      if (!msg.attachments.size) continue;
      for (const a of msg.attachments.values()) {
        sigs.add(`${a.name.toLowerCase()}|${a.size}`);
      }
    }
    lastId = batch.last().id;
  }
  return sigs;
}

// ============================================
// ⚡ PARALLEL FAST SEND
// ============================================
async function sendBatches(channel, batches) {
  let idx = 0;
  const total = batches.length;

  async function worker() {
    while (idx < total) {
      const i = idx++;
      try {
        await channel.send({ files: batches[i] });
      } catch {
        await new Promise(r => setTimeout(r, 1500));
        try { await channel.send({ files: batches[i] }); } catch {}
      }
    }
  }

  await Promise.all(Array.from({ length: SEND_WORKERS }, worker));
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
  console.log(`✅ ONLINE: ${client.user.tag}`);
  console.log(`👑 OWNER: ${OWNER_ID}`);

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('⚡ Commands registered (wait ~1min for Discord to sync)');
  } catch (e) { console.error('❌ Command register fail:', e.message); }
});

// ============================================
// 🎮 FULL COMMAND HANDLER (100% COMPLETE — NO TRUNCATION)
// ============================================
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const { commandName, user } = i;

  // ─────────────────────────────────────────
  // 👑 /WHITELIST — OWNER ONLY
  // ─────────────────────────────────────────
  if (commandName === 'whitelist') {
    if (!isOwner(user.id)) {
      return i.reply({ content: '🔒 **OWNER ONLY**', ephemeral: true });
    }

    const mode   = i.options.getString('mode');
    const target = i.options.getUser('user');

    // LIST
    if (mode === 'list') {
      const list = whitelist.size
        ? [...whitelist].map(id => `• <@${id}> → \`${id}\``).join('\n')
        : '*(empty)*';
      return i.reply({
        embeds: [new EmbedBuilder()
          .setTitle('📋 Whitelisted Users')
          .setDescription(list)
          .setColor('Blurple')
          .setFooter({ text: `Total: ${whitelist.size}` })],
        ephemeral: true
      });
    }

    // ADD / REMOVE need target
    if (!target) {
      return i.reply({
        content: '❌ Provide a **user** for Add / Remove',
        ephemeral: true
      });
    }

    if (mode === 'add') {
      whitelist.add(target.id);
      saveData();
      return i.reply({
        content: `✅ Added <@${target.id}> (\`${target.id}\`)`,
        ephemeral: true
      });
    }

    if (mode === 'remove') {
      whitelist.delete(target.id);
      userTokens.delete(target.id);
      saveData();
      return i.reply({
        content: `❌ Removed + logged out <@${target.id}>`,
        ephemeral: true
      });
    }
  }

  // ─────────────────────────────────────────
  // 🔐 /LOGIN — WHITELISTED ONLY
  // ─────────────────────────────────────────
  if (commandName === 'login') {
    if (!isWhitelisted(user.id)) {
      return i.reply({ content: '🚫 Not whitelisted', ephemeral: true });
    }

    const token = i.options.getString('token');
    userTokens.set(user.id, token.trim());
    saveData();
    return i.reply({
      content: '🔐 **Logged in!** (only you see this)',
      ephemeral: true
    });
  }

  // ─────────────────────────────────────────
  // ⚡ /FORWARD — UNLIMITED + DUPLICATE SKIP
  // ─────────────────────────────────────────
  if (commandName === 'forward') {
    // Perms
    if (!isWhitelisted(user.id)) {
      return i.reply({ content: '🚫 Not whitelisted', ephemeral: true });
    }
    if (!isLoggedIn(user.id)) {
      return i.reply({ content: '⚠️ Login first: `/login token:YOUR_TOKEN`', ephemeral: true });
    }

    const src = i.options.getChannel('source');
    const dst = i.options.getChannel('destination');

    if (!src || !dst) return i.reply({ content: '❌ Invalid channels', ephemeral: true });
    if (src.id === dst.id) return i.reply({ content: '❌ Same channel', ephemeral: true });

    // Defer (15min runtime for huge channels)
    await i.deferReply({ ephemeral: true });
    const start = Date.now();

    try {
      // 1. PARALLEL FETCH (fastest possible)
      const [allMsgs, existingFiles] = await Promise.all([
        fetchAllMessages(src),
        getDestSignatures(dst)
      ]);

      // 2. Single-pass filter + count + duplicate skip
      const counts = { txt: 0, lua: 0, zip: 0 };
      const files  = [];
      let skipped  = 0;

      for (const msg of allMsgs) {
        if (!msg.attachments.size) continue;
        for (const a of msg.attachments.values()) {
          const ext = a.name.split('.').pop()?.toLowerCase();
          if (!ALLOWED_EXT.includes(ext)) continue;

          // SKIP IF ALREADY IN DESTINATION
          if (existingFiles.has(`${a.name.toLowerCase()}|${a.size}`)) {
            skipped++;
            continue;
          }

          counts[ext]++;
          files.push({ attachment: a.url, name: a.name });
        }
      }

      // No new files
      if (!files.length) {
        return i.editReply(
          `📭 No new files\n` +
          `> Scanned: ${allMsgs.length} messages\n` +
          `> Skipped duplicates: ${skipped}`
        );
      }

      // 3. Split into batches of 10
      const batches = [];
      for (let x = 0; x < files.length; x += BATCH_SIZE) {
        batches.push(files.slice(x, x + BATCH_SIZE));
      }

      // 4. FAST PARALLEL SEND
      await sendBatches(dst, batches);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      // 5. YOUR EXACT EMBED (100% matching your request)
      await dst.send({
        embeds: [new EmbedBuilder()
          .setTitle('✅ Forward done!')
          .setDescription(
            `I got this from <#${src.id}> and i forward it to <#${dst.id}> and yeah, ` +
            `i got **${counts.txt}** .txt, **${counts.lua}** .lua, and **${counts.zip}** .zip.`
          )
          .setColor('Green')
          .setFooter({ text: 'Forwarder Bot︱.gg/freesource' })
          .setTimestamp()]
      });

      // 6. Private confirmation to you
      return i.editReply(
        `✅ **DONE!** ⚡\n` +
        `> New files: ${files.length}\n` +
        `> Skipped duplicates: ${skipped}\n` +
        `> Batches: ${batches.length}\n` +
        `> Time: ${elapsed}s`
      );

    } catch (e) {
      console.error(e);
      return i.editReply(
        `❌ **Error:** \`${e.message}\`\n\n` +
        `**Fix:** Make sure bot has:\n` +
        `• Read Message History in <#${src?.id}>\n` +
        `• Send Messages + Attach Files in <#${dst?.id}>`
      );
    }
  }
});

// ============================================
// 🚀 START BOT
// ============================================
client.login(BOT_TOKEN).catch(e => {
  console.error('\n❌ LOGIN FAILED — CHECK BOT_TOKEN IN RENDER ENV VARS');
  console.error(e
