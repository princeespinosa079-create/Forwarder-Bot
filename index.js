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
  } catch(e){}
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({userTokens:[...userTokens.entries()],whitelist:[...whitelist]})); } catch(e){}
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
    new SlashCommandBuilder().setName('ping').setDescription('🏓 Test if bot responds'),
    new SlashCommandBuilder().setName('login').setDescription('🔐 Login with your private token')
      .addStringOption(o => o.setName('token').setDescription('Private token').setRequired(true)),
    new SlashCommandBuilder().setName('forward').setDescription('⚡ Forward .txt/.lua/.zip + skip duplicates')
      .addChannelOption(o => o.setName('source').setDescription('Source channel').setRequired(true))
      .addChannelOption(o => o.setName('destination').setDescription('Destination channel').setRequired(true)),
    new SlashCommandBuilder().setName('whitelist').setDescription('👑 OWNER ONLY')
      .addStringOption(o => o.setName('mode').setRequired(true)
        .addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'},{name:'List',value:'list'}))
      .addUserOption(o => o.setName('user').setDescription('User (ID/mention)'))
  ].map(c => c.toJSON());

  // ==========================================
  // 🚀 FETCHERS
  // ==========================================
  async function fetchAllMessages(channel) {
    const all = []; let last = null;
    while (true) {
      const b = await channel.messages.fetch({limit:100, before:last||undefined});
      if (!b.size) break;
      all.push(...b.values()); last = b.last().id;
    }
    return all.reverse();
  }
  async function getDestSigs(channel) {
    const s = new Set(); let last = null;
    while (true) {
      const b = await channel.messages.fetch({limit:100, before:last||undefined});
      if (!b.size) break;
      for (const m of b.values()) if (m.attachments.size)
        for (const a of m.attachments.values()) s.add(`${a.name.toLowerCase()}|${a.size}`);
      last = b.last().id;
    }
    return s;
  }
  async function sendBatches(channel, batches) {
    let i = 0; const T = batches.length;
    async function w(){
      while(i<T){const n=i++; try{await channel.send({files:batches[n]})}
        catch{await new Promise(r=>setTimeout(r,1500)); try{await channel.send({files:batches[n]})}catch{}}}
    }
    await Promise.all(Array.from({length:SEND_WORKERS},w));
  }

  // ==========================================
  // 🔑 PERMS
  // ==========================================
  const isOwner = id => id === OWNER_ID;
  const isWL    = id => isOwner(id) || whitelist.has(id);
  const hasTk   = id => userTokens.has(id);

  // ==========================================
  // ✅ READY → REGISTER COMMANDS (INSTANT!)
  // ==========================================
  client.once('ready', async () => {
    loadData();
    console.log(`\n✅✅✅ BOT ONLINE: ${client.user.tag} ✅✅✅`);
    console.log(`✅ Servers: ${client.guilds.cache.size}`);

    const rest = new REST({version:'10'}).setToken(BOT_TOKEN);

    // 🟢 REGISTER IN EVERY SERVER (INSTANT - 1 SECOND!)
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), {body: commands});
        console.log(`✅ [5] COMMANDS REGISTERED IN: ${guild.name} (${guild.id}) — INSTANT!`);
      } catch(e) { console.log(`❌ Failed guild ${guild.id}:`, e.message); }
    }

    // 🔵 ALSO REGISTER GLOBAL (takes 1-3h, fallback)
    try {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {body: commands});
      console.log(`✅ [6] GLOBAL COMMANDS QUEUED (appears in 1-3 hours)\n`);
    } catch(e){}

    console.log('🎉 ALL DONE — BOT READY! Use /ping to test.\n');
  });

  // Auto-register when bot joins NEW server
  client.on('guildCreate', async (guild) => {
    const rest = new REST({version:'10'}).setToken(BOT_TOKEN);
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), {body: commands});
      console.log(`✅ NEW SERVER: Registered commands in ${guild.name}`);
    } catch(e){}
  });

  // ==========================================
  // 🎮 INTERACTION HANDLER — 100% FIXED
  // ==========================================
  client.on('interactionCreate', async (i) => {
    // ✅ LOG EVERY INTERACTION (so you know it's received)
    console.log(`⚡ INTERACTION: /${i.commandName} by ${i.user.tag} (${i.user.id})`);

    if (!i.isChatInputCommand()) return;
    const cmd = i.commandName;
    const user = i.user;

    // ========================================
    // 🏓 /PING — TEST COMMAND
    // ========================================
    if (cmd === 'ping') {
      const before = Date.now();
      await i.deferReply({ephemeral:true});
      const ms = Date.now() - before;
      return i.editReply(`🏓 **PONG!** Bot is working perfectly.\nLatency: \`${ms}ms\` | WebSocket: \`${client.ws.ping}ms\``);
    }

    // ========================================
    // 👑 /WHITELIST
    // ========================================
    if (cmd === 'whitelist') {
      await i.deferReply({ephemeral:true}); // ✅ DEFER FIRST
      try {
        if (!isOwner(user.id)) return i.editReply('🔒 **OWNER ONLY**');
        const mode = i.options.getString('mode');
        const t = i.options.getUser('user');
        if (mode === 'list') {
          const list = whitelist.size ? [...whitelist].map(id=>`<@${id}> \`${id}\``).join('\n') : 'Empty';
          return i.editReply({embeds:[new EmbedBuilder().setTitle('📋 Whitelist').setDescription(list).setColor('Blurple')]});
        }
        if (!t) return i.editReply('❌ Provide a user');
        if (mode==='add') { whitelist.add(t.id); saveData(); return i.editReply(`✅ Added <@${t.id}>`); }
        if (mode==='remove') { whitelist.delete(t.id); userTokens.delete(t.id); saveData(); return i.editReply(`❌ Removed + logged out <@${t.id}>`); }
      } catch(e) { return safeErr(i, e); }
    }

    // ========================================
    // 🔐 /LOGIN
    // ========================================
    if (cmd === 'login') {
      await i.deferReply({ephemeral:true}); // ✅ DEFER FIRST
      try {
        if (!isWL(user.id)) return i.editReply('🚫 Not whitelisted');
        const tk = i.options.getString('token').trim();
        userTokens.set(user.id, tk); saveData();
        return i.editReply('🔐 **Logged in!** (only you see this)');
      } catch(e) { return safeErr(i, e); }
    }

    // ========================================
    // ⚡ /FORWARD
    // ========================================
    if (cmd === 'forward') {
      await i.deferReply({ephemeral:true}); // ✅ DEFER FIRST — BEFORE ANY CHECKS
      try {
        if (!isWL(user.id)) return i.editReply('🚫 Not whitelisted');
        if (!hasTk(user.id)) return i.editReply('⚠️ Login first: `/login token:YOUR_TOKEN`');
        const src = i.options.getChannel('source');
        const dst = i.options.getChannel('destination');
        if (!src||!dst) return i.editReply('❌ Invalid channels');
        if (src.id===dst.id) return i.editReply('❌ Same channel');

        const start = Date.now();
        const [msgs, exist] = await Promise.all([fetchAllMessages(src), getDestSigs(dst)]);
        const counts = {txt:0,lua:0,zip:0}; const files=[]; let skip=0;
        for (const m of msgs) {
          if (!m.attachments.size) continue;
          for (const a of m.attachments.values()) {
            const ex = a.name.split('.').pop()?.toLowerCase();
            if (!ALLOWED_EXT.includes(ex)) continue;
            if (exist.has(`${a.name.toLowerCase()}|${a.size}`)) { skip++; continue; }
            counts[ex]++; files.push({attachment:a.url, name:a.name});
          }
        }
        if (!files.length) return i.editReply(`📭 No new files | Scanned ${msgs.length} | Skipped ${skip}`);
        const batches = [];
        for (let x=0;x<files.length;x+=BATCH_SIZE) batches.push(files.slice(x,x+BATCH_SIZE));
        await sendBatches(dst, batches);
        const sec = ((Date.now()-start)/1000).toFixed(1);
        await dst.send({embeds:[new EmbedBuilder()
          .setTitle('✅ Forward done!')
          .setDescription(`I got this from <#${src.id}> and i forward it to <#${dst.id}> and yeah, i got **${counts.txt}** .txt, **${counts.lua}** .lua, and **${counts.zip}** .zip.`)
          .setColor('Green').setFooter({text:'Forwarder Bot︱.gg/freesource'}).setTimestamp()]});
        return i.editReply(`✅ DONE ⚡ | New:${files.length} Skip:${skip} | ${sec}s`);
      } catch(e) { return safeErr(i, e); }
    }

    // ❓ UNKNOWN COMMAND — NEVER SILENT
    await i.deferReply({ephemeral:true}).catch(()=>{});
    return i.editReply(`❓ Unknown command: \`/${cmd}\`. Try restarting Discord (Ctrl+R).`).catch(()=>{});
  });

  // ==========================================
  // 🛡️ SAFE ERROR REPLY (never "did not respond")
  // ==========================================
  async function safeErr(i, e) {
    console.log('❌ COMMAND ERROR:', e.message);
    try {
      if (i.deferred || i.replied) return i.editReply(`❌ Error: \`${e.message}\``);
      return i.reply({content:`❌ Error: \`${e.message}\``, ephemeral:true});
    } catch{}
  }

  // ==========================================
  // 🔑 LOGIN
  // ==========================================
  console.log('🔑 [3] Logging into Discord...');
  client.login(BOT_TOKEN).catch(e => {
    console.log('❌ LOGIN FAILED:', e.message);
    if (e.message.includes('401') || e.message.includes('token'))
      console.log('👉 FIX: Reset bot token in Discord Dev Portal → paste NEW token into Render BOT_TOKEN');
  });
}
