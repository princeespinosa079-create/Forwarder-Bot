const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const fs = require('fs');
const http = require('http');

// ============================================
// ⚙️ RENDER ENV VARS
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
// 🌐 RENDER PORT FIX (STOPS PORT TIMEOUT ERROR)
// ============================================
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Forwarder Bot OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Port ${PORT} open (Render health check)`);
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
      console.log('✅ Loaded saved whitelist + logins');
    }
  } catch (e) { console.log('ℹ️ Fresh start'); }
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
// ⚡ SLASH COMMANDS (100% VALID)
// ============================================
const commands = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('🔐 Login with your private token')
    .addStringOption(o => o
      .setName('token')
      .setDescription('Your private token')
      .setRequired(true)),

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
    const batch = await channel.messages.fetch({ limit: 100, before: lastId || undefined });
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
    const batch = await channel.messages.fetch({ limit: 100, before: lastId || undefined });
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
      try { await channel.send({ files: batches[i] }); }
      catch {
        await new Promise(r => setTimeout(r, 1500));
        try { await channel.send({ files: batches[i] }); } catch {}
      }
    }
  }
  await Promise.all(Array.from({ length: SEND_WORKERS }, worker));
}

// ============================================
// 🔑 PERMISSIONS
// ============================================
const isOwner       = id => id === OWNER_ID;
const isWhitelisted = id => isOwner(id) || whitelist.has(id);
const isLoggedIn    = id => userTokens.has(id);

// ============================================
// ✅ READY → REGISTER COMMANDS
// ============================================
client.once('ready', async () => {
  loadData();
  console.log(`✅ ONLINE: ${client.user.tag}`);
  console.log(`👑 OWNER: ${OWNER_ID}`);
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('⚡ Commands registered (wait ~1min for Discord sync)');
  } catch (e) { console.error('❌ Command register fail:', e.message); }
});

// ============================================
// 🎮 FULL COMMAND HANDLER (100% COMPLETE)
// ============================================
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const { commandName, user } = i;

  // 👑 /WHITELIST
  if (commandName === 'whitelist') {
    if (!isOwner(user.id)) return i.reply({ content: '🔒 OWNER ONLY', ephemeral: true });
    const mode = i.options.getString('mode');
    const t = i.options.getUser('user');
    if (mode === 'list') {
      const list = whitelist.size ? [...whitelist].map(id => `• <@${id}> \`${id}\``).join('\n') : '*(empty)*';
      return i.reply({ embeds: [new EmbedBuilder().setTitle('📋 Whitelist').setDescription(list).setColor('Blurple').setFooter({text:`Total: ${whitelist.size}`})], ephemeral: true });
    }
    if (!t) return i.reply({ content: '❌ Provide a user for Add/Remove', ephemeral: true });
    if (mode === 'add') { whitelist.add(t.id); saveData(); return i.reply({ content:`✅ Added <@${t.id}>`, ephemeral:true }); }
    if (mode === 'remove') { whitelist.delete(t.id); userTokens.delete(t.id); saveData(); return i.reply({ content:`❌ Removed + logged out <@${t.id}>`, ephemeral:true }); }
  }

  // 🔐 /LOGIN
  if (commandName === 'login') {
    if (!isWhitelisted(user.id)) return i.reply({ content: '🚫 Not whitelisted', ephemeral: true });
    userTokens.set(user.id, i.options.getString('token').trim());
    saveData();
    return i.reply({ content: '🔐 Logged in (private)', ephemeral: true });
  }

  // ⚡ /FORWARD — UNLIMITED + DUPLICATE SKIP
  if (commandName === 'forward') {
    if (!isWhitelisted(user.id)) return i.reply({ content: '🚫 Not whitelisted', ephemeral: true });
    if (!isLoggedIn(user.id)) return i.reply({ content: '⚠️ Login first: `/login token:YOUR_TOKEN`', ephemeral: true });
    const src = i.options.getChannel('source');
    const dst = i.options.getChannel('destination');
    if (!src || !dst) return i.reply({ content: '❌ Invalid channels', ephemeral: true });
    if (src.id === dst.id) return i.reply({ content: '❌ Same channel', ephemeral: true });

    await i.deferReply({ ephemeral: true });
    const start = Date.now();
    try {
      const [allMsgs, existing] = await Promise.all([fetchAllMessages(src), getDestSignatures(dst)]);
      const counts = { txt:0, lua:0, zip:0 };
      const files = [];
      let skipped = 0;

      for (const msg of allMsgs) {
        if (!msg.attachments.size) continue;
        for (const a of msg.attachments.values()) {
          const ext = a.name.split('.').pop()?.toLowerCase();
          if (!ALLOWED_EXT.includes(ext)) continue;
          if (existing.has(`${a.name.toLowerCase()}|${a.size}`)) { skipped++; continue; }
          counts[ext]++;
          files.push({ attachment: a.url, name: a.name });
        }
      }

      if (!files.length) return i.editReply(`📭 No new files | Scanned ${allMsgs.length} msgs | Skipped ${skipped} duplicates`);

      const batches = [];
      for (let x=0;x<files.length;x+=BATCH_SIZE) batches.push(files.slice(x,x+BATCH_SIZE));
      await sendBatches(dst, batches);
      const sec = ((Date.now()-start)/1000).toFixed(1);

      await dst.send({ embeds: [new EmbedBuilder()
        .setTitle('✅ Forward done!')
        .setDescription(`I got this from <#${src.id}> and i forward it to <#${dst.id}> and yeah, i got **${counts.txt}** .txt, **${counts.lua}** .lua, and **${counts.zip}** .zip.`)
        .setColor('Green')
        .setFooter({ text: 'Forwarder Bot︱.gg/freesource' })
        .setTimestamp()]
      });

      return i.editReply(`✅ DONE ⚡\nNew: ${files.length} | Skipped: ${skipped} | Batches: ${batches.length} | Time: ${sec}s`);
    } catch (e) {
      return i.editReply(`❌ Error: \`${e.message}\`\nCheck bot perms (Read History in source / Send+Attach in dest)`);
    }
  }
});

// ============================================
// 🚀 START BOT — 100% COMPLETE (FIXES LINE 384 ERROR)
// ============================================
client.login(BOT_TOKEN).catch(e => {
  console.error('\n❌ LOGIN FAILED — CHECK BOT_TOKEN IN RENDER ENV VARS');
  console.error('Error details:', e.message);
  process.exit(1);
});
