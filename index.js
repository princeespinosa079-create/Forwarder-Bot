const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const fs = require('fs');
const http = require('http');

// ============================================
// ⚙️ CONFIG
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
// 🌐 PORT OPEN FIRST (RENDER SAFE)
// ============================================
console.log('\n🚀 BOT STARTING =========================================');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ [1] PORT ${PORT} OPEN`);
  startBot();
});

// ============================================
// 💾 PERSISTENCE
// ============================================
let userTokens = new Map();
let whitelist  = new Set();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      userTokens = new Map(d.userTokens || []);
      whitelist  = new Set(d.whitelist  || []);
      console.log(`✅ [4] DATA LOADED | WL:${whitelist.size} Tokens:${userTokens.size}`);
    }
  } catch (e) {
    console.log('⚠️  Failed to load data:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      userTokens: [...userTokens.entries()],
      whitelist: [...whitelist]
    }));
  } catch (e) {
    console.log('⚠️  Failed to save data:', e.message);
  }
}

// ============================================
// 🤖 START BOT
// ============================================
function startBot() {
  if (!BOT_TOKEN || !CLIENT_ID) {
    console.log('❌ FATAL: MISSING BOT_TOKEN OR CLIENT_ID IN RENDER ENV');
    return;
  }
  console.log(`✅ [2] ENV OK | Owner: ${OWNER_ID}`);

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

  client.on('error', e => console.log('❌ BOT ERROR:', e.message));
  client.on('warn',  w => console.log('⚠️  WARN:', w));
  process.on('unhandledRejection', e => console.log('❌ UNHANDLED:', e?.message || e));

  // ==========================================
  // ⚡ COMMAND DEFINITIONS
  // ==========================================
  const commands = [
    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('🏓 Test if bot responds'),
    new SlashCommandBuilder()
      .setName('login')
      .setDescription('🔐 Login with your private token')
      .addStringOption(o => o.setName('token').setDescription('Private token').setRequired(true)),
    new SlashCommandBuilder()
      .setName('forward')
      .setDescription('⚡ Forward .txt/.lua/.zip + skip duplicates')
      .addChannelOption(o => o.setName('source').setDescription('Source channel').setRequired(true))
      .addChannelOption(o => o.setName('destination').setDescription('Destination channel').setRequired(true)),
    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('👑 OWNER ONLY')
      .addStringOption(o => o.setName('mode').setRequired(true)
        .addChoices(
          { name: 'Add', value: 'add' },
          { name: 'Remove', value: 'remove' },
          { name: 'List', value: 'list' }
        ))
      .addUserOption(o => o.setName('user').setDescription('User (ID/mention)'))
  ].map(c => c.toJSON());

  // ==========================================
  // 🚀 FETCHERS
  // ==========================================
  async function fetchAllMessages(channel) {
    const all = [];
    let last = null;
    while (true) {
      const options = { limit: 100 };
      if (last) options.before = last;
      const batch = await channel.messages.fetch(options);
      if (!batch.size) break;
      all.push(...batch.values());
      last = batch.last().id;
      // Small delay to avoid rate limits on very large channels
      if (all.length % 500 === 0) await new Promise(r => setTimeout(r, 300));
    }
    return all.reverse();
  }

  async function getDestSigs(channel) {
    const s = new Set();
    let last = null;
    while (true) {
      const options = { limit: 100 };
      if (last) options.before = last;
      const batch = await channel.messages.fetch(options);
      if (!batch.size) break;
      for (const m of batch.values()) {
        if (m.attachments.size) {
          for (const a of m.attachments.values()) {
            s.add(`${a.name.toLowerCase()}|${a.size}`);
          }
        }
      }
      last = batch.last().id;
      if (s.size % 500 === 0) await new Promise(r => setTimeout(r, 300));
    }
    return s;
  }

  async function sendBatches(channel, batches) {
    let index = 0;
    const total = batches.length;

    async function worker() {
      while (index < total) {
        const current = index++;
        const files = batches[current];
        try {
          await channel.send({ files });
        } catch (err) {
          console.log(`⚠️  Send batch ${current} failed, retrying...`, err.message);
          await new Promise(r => setTimeout(r, 1500));
          try {
            await channel.send({ files });
          } catch (err2) {
            console.log(`❌ Send batch ${current} failed after retry:`, err2.message);
          }
        }
      }
    }

    await Promise.all(Array.from({ length: SEND_WORKERS }, () => worker()));
  }

  // ==========================================
  // 🔑 PERMS
  // ==========================================
  const isOwner = id => id === OWNER_ID;
  const isWL    = id => isOwner(id) || whitelist.has(id);
  const hasTk   = id => userTokens.has(id);

  // ==========================================
  // 🛡️ SAFE ERROR REPLY (never "did not respond")
  // ==========================================
  async function safeErr(i, e) {
    console.log('❌ COMMAND ERROR:', e?.message || e);
    try {
      if (i.deferred || i.replied) {
        return await i.editReply(`❌ Error: \`${e?.message || e}\``);
      }
      return await i.reply({ content: `❌ Error: \`${e?.message || e}\``, ephemeral: true });
    } catch (err) {
      console.log('❌ Failed to send error reply:', err.message);
    }
  }

  // ==========================================
  // ✅ READY → REGISTER COMMANDS (INSTANT!)
  // ==========================================
  client.once('ready', async () => {
    loadData();
    console.log(`\n✅✅✅ BOT ONLINE: ${client.user.tag} ✅✅✅`);
    console.log(`✅ Servers: ${client.guilds.cache.size}`);

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

    // 🟢 REGISTER IN EVERY SERVER (INSTANT)
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), { body: commands });
        console.log(`✅ [5] COMMANDS REGISTERED IN: ${guild.name} (${guild.id}) — INSTANT!`);
      } catch (e) {
        console.log(`❌ Failed guild ${guild.id}:`, e.message);
      }
    }

    // 🔵 ALSO REGISTER GLOBAL (takes 1-3h, fallback)
    try {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log(`✅ [6] GLOBAL COMMANDS QUEUED (appears in 1-3 hours)\n`);
    } catch (e) {
      console.log('⚠️  Global command registration failed:', e.message);
    }

    console.log('🎉 ALL DONE — BOT READY! Use /ping to test.\n');
  });

  // Auto-register when bot joins NEW server
  client.on('guildCreate', async (guild) => {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), { body: commands });
      console.log(`✅ NEW SERVER: Registered commands in ${guild.name}`);
    } catch (e) {
      console.log(`❌ Failed to register on new guild ${guild.id}:`, e.message);
    }
  });

  // ==========================================
  // 🎮 INTERACTION HANDLER — FIXED
  // Key fix: ALWAYS deferReply IMMEDIATELY for every slash command
  // before any logic. This prevents "The application did not respond."
  // ==========================================
  client.on('interactionCreate', async (i) => {
    // Only handle slash commands
    if (!i.isChatInputCommand()) return;

    // ✅ LOG EVERY INTERACTION
    console.log(`⚡ INTERACTION: /${i.commandName} by ${i.user.tag} (${i.user.id})`);

    // 🔑 CRITICAL FIX: Acknowledge the interaction WITHIN 3 SECONDS
    // by deferring first. Everything else happens after.
    try {
      await i.deferReply({ ephemeral: true });
    } catch (deferErr) {
      console.log('❌ Failed to defer interaction:', deferErr.message);
      // If we can't even defer, Discord already showed the error to the user.
      return;
    }

    const cmd = i.commandName;
    const user = i.user;

    try {
      // ========================================
      // 🏓 /PING — TEST COMMAND
      // ========================================
      if (cmd === 'ping') {
        const latency = Date.now() - i.createdTimestamp;
        return await i.editReply(
          `🏓 **PONG!** Bot is working perfectly.\n` +
          `Latency: \`${latency}ms\` | WebSocket: \`${client.ws.ping}ms\``
        );
      }

      // ========================================
      // 👑 /WHITELIST
      // ========================================
      if (cmd === 'whitelist') {
        if (!isOwner(user.id)) {
          return await i.editReply('🔒 **OWNER ONLY**');
        }

        const mode = i.options.getString('mode');
        const targetUser = i.options.getUser('user');

        if (mode === 'list') {
          const list = whitelist.size
            ? [...whitelist].map(id => `<@${id}> \`${id}\``).join('\n')
            : 'Empty';
          return await i.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle('📋 Whitelist')
                .setDescription(list)
                .setColor(0x5865F2)
            ]
          });
        }

        if (!targetUser) {
          return await i.editReply('❌ Provide a user');
        }

        if (mode === 'add') {
          whitelist.add(targetUser.id);
          saveData();
          return await i.editReply(`✅ Added <@${targetUser.id}>`);
        }

        if (mode === 'remove') {
          whitelist.delete(targetUser.id);
          userTokens.delete(targetUser.id);
          saveData();
          return await i.editReply(`❌ Removed + logged out <@${targetUser.id}>`);
        }

        return await i.editReply('❌ Unknown mode');
      }

      // ========================================
      // 🔐 /LOGIN
      // ========================================
      if (cmd === 'login') {
        if (!isWL(user.id)) {
          return await i.editReply('🚫 Not whitelisted');
        }

        const token = i.options.getString('token')?.trim();
        if (!token) {
          return await i.editReply('❌ Token is required');
        }

        userTokens.set(user.id, token);
        saveData();
        return await i.editReply('🔐 **Logged in!** (only you see this)');
      }

      // ========================================
      // ⚡ /FORWARD
      // ========================================
      if (cmd === 'forward') {
        if (!isWL(user.id)) {
          return await i.editReply('🚫 Not whitelisted');
        }
        if (!hasTk(user.id)) {
          return await i.editReply('⚠️ Login first: `/login token:YOUR_TOKEN`');
        }

        const src = i.options.getChannel('source');
        const dst = i.options.getChannel('destination');

        if (!src || !dst) {
          return await i.editReply('❌ Invalid channels');
        }
        if (src.id === dst.id) {
          return await i.editReply('❌ Same channel');
        }

        // Check bot permissions roughly
        if (!src.isTextBased?.() || !dst.isTextBased?.()) {
          return await i.editReply('❌ Both channels must be text channels');
        }

        const start = Date.now();

        // Update user that we started the heavy work
        await i.editReply('⏳ Scanning channels... this may take a while for large channels.');

        const [msgs, exist] = await Promise.all([
          fetchAllMessages(src),
          getDestSigs(dst)
        ]);

        const counts = { txt: 0, lua: 0, zip: 0 };
        const files = [];
        let skip = 0;

        for (const m of msgs) {
          if (!m.attachments.size) continue;
          for (const a of m.attachments.values()) {
            const ext = a.name.split('.').pop()?.toLowerCase();
            if (!ALLOWED_EXT.includes(ext)) continue;

            const sig = `${a.name.toLowerCase()}|${a.size}`;
            if (exist.has(sig)) {
              skip++;
              continue;
            }

            counts[ext]++;
            files.push({ attachment: a.url, name: a.name });
          }
        }

        if (!files.length) {
          return await i.editReply(
            `📭 No new files found\n` +
            `Scanned: ${msgs.length} messages | Skipped (duplicates): ${skip}`
          );
        }

        await i.editReply(
          `📤 Found ${files.length} new files. Uploading in batches of ${BATCH_SIZE}...`
        );

        // Build batches
        const batches = [];
        for (let x = 0; x < files.length; x += BATCH_SIZE) {
          batches.push(files.slice(x, x + BATCH_SIZE));
        }

        await sendBatches(dst, batches);

        const sec = ((Date.now() - start) / 1000).toFixed(1);

        // Public success embed in destination
        await dst.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Forward done!')
              .setDescription(
                `I got this from <#${src.id}> and forwarded it to <#${dst.id}>.\n` +
                `**${counts.txt}** .txt  •  **${counts.lua}** .lua  •  **${counts.zip}** .zip`
              )
              .setColor(0x57F287)
              .setFooter({ text: 'Forwarder Bot  •  .gg/freesource' })
              .setTimestamp()
          ]
        });

        return await i.editReply(
          `✅ **DONE** ⚡\n` +
          `New files: **${files.length}** | Skipped: **${skip}** | Time: **${sec}s**`
        );
      }

      // ❓ UNKNOWN COMMAND
      return await i.editReply(
        `❓ Unknown command: \`/${cmd}\`.\nTry restarting Discord (Ctrl+R) or wait a few minutes for command sync.`
      );

    } catch (e) {
      return await safeErr(i, e);
    }
  });

  // ==========================================
  // 🔑 LOGIN
  // ==========================================
  console.log('🔑 [3] Logging into Discord...');
  client.login(BOT_TOKEN).catch(e => {
    console.log('❌ LOGIN FAILED:', e.message);
    if (e.message.includes('401') || e.message.includes('token') || e.message.includes('TOKEN')) {
      console.log('👉 FIX: Reset bot token in Discord Developer Portal → paste the NEW token into Render BOT_TOKEN env var');
    }
  });
}
