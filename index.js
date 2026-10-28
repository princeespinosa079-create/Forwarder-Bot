const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const fs = require('fs');
const http = require('http'); // ← Added for Render port check

// ============================================
// ⚙️ RENDER ENVIRONMENT VARIABLES
// ============================================
const OWNER_ID     = process.env.OWNER_ID     || '1302080645987569694';
const BOT_TOKEN    = process.env.BOT_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const PORT         = process.env.PORT || 10000; // Render auto-sets this
const DATA_FILE    = '/tmp/forwarder_data.json';
const ALLOWED_EXT  = ['txt', 'lua', 'zip'];
const BATCH_SIZE   = 10;
const SEND_WORKERS = 2;

// ============================================
// 🚩 RENDER PORT HEALTH CHECK (FIXES YOUR ERROR)
// ============================================
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('✅ Forwarder Bot Online');
}).listen(PORT, () => {
  console.log(`🌐 Render health check running on port ${PORT}`);
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
// ⚡ COMMANDS
// ============================================
const commands = [
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('🔐 Login with your private token')
    .addStringOption(o => o.setName('token').setDescription('Private token').setRequired(true)),

  new SlashCommandBuilder()
    .setName('forward')
    .setDescription('⚡ UNLIMITED forward + auto skip duplicates')
    .addChannelOption(o => o.setName('source').setDescription('Source channel').setRequired(true))
    .addChannelOption(o => o.setName('destination').setDescription('Destination channel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('👑 OWNER ONLY')
    .addStringOption(o => o.setName('mode').setRequired(true)
      .addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'List',value:'list'}))
    .addUserOption(o => o.setName('user').setDescription('User (ID/mention)'))
].map(c => c.toJSON());

// ============================================
// 🚀 UNLIMITED FETCHERS
// ============================================
async function fetchAllMessages(channel) {
  const all = []; let lastId = null;
  while (true) {
    const batch = await channel.messages.fetch({ limit:100, before: lastId||undefined });
    if (!batch.size) break;
    all.push(...batch.values()); lastId = batch.last().id;
  }
  return all.reverse();
}

async function fetchDestSignatures(channel) {
  const sigs = new Set(); let lastId = null;
  while (true) {
    const batch = await channel.messages.fetch({ limit:100, before: lastId||undefined });
    if (!batch.size) break;
    for (const msg of batch.values()) {
      if (!msg.attachments.size) continue;
      for (const a of msg.attachments.values()) sigs.add(`${a.name.toLowerCase()}|${a.size}`);
    }
    lastId = batch.last().id;
  }
  return sigs;
}

// ============================================
// ⚡ PARALLEL SEND
// ============================================
async function sendFast(channel, batches) {
  let i = 0; const total = batches.length;
  async function worker() {
    while (i < total) {
      const n = i++;
      try { await channel.send({ files: batches[n] }); }
      catch { await new Promise(r=>setTimeout(r,1500)); try { await channel.send({ files: batches[n] }); } catch{} }
    }
  }
  await Promise.all(Array.from({length:SEND_WORKERS}, worker));
}

// ============================================
// 🔑 PERMS
// ============================================
const isOwner = id => id === OWNER_ID;
const isWhitelisted = id => isOwner(id) || whitelist.has(id);
const isLoggedIn = id => userTokens.has(id);

// ============================================
// ✅ READY
// ============================================
client.once('ready', async () => {
  loadData();
  console.log(`✅ Bot online: ${client.user.tag}`);
  const rest = new REST({version:'10'}).setToken(BOT_TOKEN);
  try { await rest.put(Routes.applicationCommands(CLIENT_ID), {body:commands}); console.log('⚡ Commands registered'); }
  catch(e){console.error('Command fail:',e.message)}
});

// ============================================
// 🎮 COMMAND HANDLER
// ============================================
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  const { commandName, user } = i;

  // 👑 WHITELIST
  if (commandName === 'whitelist') {
    if (!isOwner(user.id)) return i.reply({content:'🔒 OWNER ONLY', ephemeral:true});
    const mode = i.options.getString('mode'); const t = i.options.getUser('user');
    if (mode === 'list') return i.reply({embeds:[new EmbedBuilder().setTitle('📋 Whitelist').setDescription(whitelist.size?[...whitelist].map(id=>`<@${id}> \`${id}\``).join('\n'):'Empty').setColor('Blurple')], ephemeral:true});
    if (!t) return i.reply({content:'❌ Provide a user', ephemeral:true});
    if (mode==='add') { whitelist.add(t.id); saveData(); return i.reply({content:`✅ Added <@${t.id}>`, ephemeral:true}); }
    if (mode==='remove') { whitelist.delete(t.id); userTokens.delete(t.id); saveData(); return i.reply({content:`❌ Removed + logged out <@${t.id}>`, ephemeral:true}); }
  }

  // 🔐 LOGIN
  if (commandName === 'login') {
    if (!isWhitelisted(user.id)) return i.reply({content:'🚫 Not whitelisted', ephemeral:true});
    userTokens.set(user.id, i.options.getString('token').trim()); saveData();
    return i.reply({content:'🔐 Logged in (private)', ephemeral:true});
  }

  // ⚡ FORWARD — UNLIMITED + DUPE SKIP
  if (commandName === 'forward') {
    if (!isWhitelisted(user.id)) return i.reply({content:'🚫 Not whitelisted', ephemeral:true});
    if (!isLoggedIn(user.id)) return i.reply({content:'⚠️ Login first with /login', ephemeral:true});
    const src = i.options.getChannel('source'); const dst = i.options.getChannel('destination');
    if (!src||!dst) return i.reply({content:'❌ Invalid channels', ephemeral:true});
    if (src.id===dst.id) return i.reply({content:'❌ Same channel', ephemeral:true});

    await i.deferReply({ephemeral:true});
    const start = Date.now();
    try {
      // Parallel fetch source + destination signatures (FASTER)
      const [messages, existing] = await Promise.all([
        fetchAllMessages(src), fetchDestSignatures(dst)
      ]);

      const counts = {txt:0,lua:0,zip:0}; const files = []; let skipped = 0;
      for (const m of messages) {
        if (!m.attachments.size) continue;
        for (const a of m.attachments.values()) {
          const ext = a.name.split('.').pop()?.toLowerCase();
          if (!ALLOWED_EXT.includes(ext)) continue;
          // SKIP DUPLICATE (filename + size match)
          if (existing.has(`${a.name.toLowerCase()}|${a.size}`)) { skipped++; continue; }
          counts[ext]++; files.push({attachment:a.url, name:a.name});
        }
      }

      if (!files.length) return i.editReply(`📭 No new files (scanned ${messages.length} msgs | skipped ${skipped} duplicates)`);

      const batches = [];
      for (let x=0;x<files.length;x+=BATCH_SIZE) batches.push(files.slice(x,x+BATCH_SIZE));
      await sendFast(dst, batches);
      const sec = ((Date.now()-start)/1000).toFixed(1);

      // YOUR EXACT EMBED
      await dst.send({embeds:[new EmbedBuilder()
        .setTitle('✅ Forward done!')
        .setDescription(`I got this from <#${src.id}> and i forward it to <#${dst.id}> and yeah, i got **${counts.txt}** .txt, **${counts.lua}** .lua, and **${counts.zip}** .zip.`)
        .setColor('Green')
        .setFooter({text:'Forwarder Bot︱.gg/freesource'})
        .setTimestamp()
      ]});

      return i.editReply(`✅ DONE ⚡\n📤 ${files.length} new files | ⏭️ Skipped ${skipped} duplicates\n⏱️ ${sec}s | 📦 ${batches.length} batches`);
    } catch(e) {
      return i.editReply(`❌ Error: \`${e.message}\`\nCheck bot perms (Read History in source / Send+Attach in dest)`);
    }
  }
});

client.login(BOT_TOKEN).catch(e => { console.error('LOGIN FAIL:',e.message); process.exit(1); });
