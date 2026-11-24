require('dotenv').config();
const { Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');

// ── CRASH PREVENTION ──────────────────────────────────────────────────────────
process.on('uncaughtException', err => console.error('⚠️ CRASH CAUGHT:', err.message));
process.on('unhandledRejection', err => console.error('⚠️ UNHANDLED:', err?.message || err));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User]
});

// ── AUTO RECONNECT (discord.js handles reconnects automatically) ──────────────
client.on('shardDisconnect', () => {
    console.log('🔴 Disconnected — discord.js will auto-reconnect...');
});

const DB_FILE = './database.json';
let db = {};
let pendingBattles = {};       // { targetId: { challengerId, challengerName, defenderName } }
let pendingPokemonTrades = {}; // { targetId: { fromId, fromName, pokemon, price } }
let activeBattles = {};        // { battleId: { p1, p2, p1Id, p2Id, turn, log, wildMode, wildPokemon } }
let wildPokemonState = {};     // { chatId: { pokemon, spawnTime } }
let messageCounters = {};      // { chatId: count }
let pendingResets = {};        // { ownerId: { type: 'money'|'inv'|'pokemon'|'cards', expiresAt } }

// ── MESSAGE DEDUPLICATION ──────────────────────────────────────────────────────
// FIX (double-reply glitch): on gateway disconnect/reconnect (see shardDisconnect
// below), Discord can redeliver a messageCreate event for the same message as a
// brand-new Message object. Each listener would then process that single message
// twice, doubling every reply (.catch, .feed, etc).
// wrapMessage()'s `__wrapped` flag doesn't help here since it lives on the object,
// and a redelivered event comes in as a *different* object with the same msg.id.
// Fix: each listener keeps its own seen-IDs cache (keyed by listener name) and
// skips an ID it has already handled. Per-listener caches are required — there
// are 3 independent listeners below that are each SUPPOSED to see every message
// once, so a single shared cache would make listener #2/#3 wrongly skip messages
// listener #1 already saw.
const processedMessageIdsByListener = {};
const PROCESSED_ID_CACHE_LIMIT = 2000; // keep memory bounded on long-running bots
function alreadyProcessed(listenerName, id) {
    if (!id) return false;
    const seen = processedMessageIdsByListener[listenerName] || (processedMessageIdsByListener[listenerName] = new Set());
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > PROCESSED_ID_CACHE_LIMIT) {
        // drop the oldest entry (Sets preserve insertion order)
        seen.delete(seen.values().next().value);
    }
    return false;
}

// ── OWNER / MOD IDs ──────────────────────────────────────────────────────────
// OWNER_NUMBERS — shown in .owners command, highest authority
const OWNER_NUMBERS = [
    '870273490568216648',   // Owner (tum)
    '1523263401395097671',  // Dost (owner/mod)
    '1528377826485473351',  // Luna (AI bot/owner)
];

// MOD_NUMBERS — full bot controls, shown in .mods/.help, NOT shown in .owners
// Add new mods here; OWNER_NUMBERS are auto-included
const MOD_NUMBERS = [
    ...OWNER_NUMBERS,
    '1364272517526716597',  // Mod 3
    '1094136540441083985',  // Mod 4
];

// FBI_NUMBERS — special agents with access to ban users + all suspicious-activity
// alerts (large transfers, redeem codes, pokemon sales, etc.), tagged via .fbi
const FBI_NUMBERS = [
    '1514600279759392789',  // Agent 1
    '1498417518010695701',  // Agent 2
    '1466462850624262144',  // Agent 3
];

// ── Helper: split a tax amount equally among all owners, crediting their wallets ──
// Any leftover from integer division (rounding remainder) goes to the first owner(s)
// so the full tax amount is always accounted for (nothing lost to rounding).
function distributeTaxToOwners(taxAmt) {
    if (!taxAmt || taxAmt <= 0 || OWNER_NUMBERS.length === 0) return;
    const share = Math.floor(taxAmt / OWNER_NUMBERS.length);
    let remainder = taxAmt - (share * OWNER_NUMBERS.length);
    for (const ownerId of OWNER_NUMBERS) {
        initUser(ownerId);
        let portion = share;
        if (remainder > 0) { portion += 1; remainder -= 1; }
        db[ownerId].wallet += portion;
    }
    saveDB();
}

// ── Helper: DM all mods + owners + FBI agents with a suspicious-activity alert ──
async function notifyStaff(messageText) {
    const recipients = [...new Set([...MOD_NUMBERS, ...FBI_NUMBERS])];
    for (const staffId of recipients) {
        try {
            const staffUser = await client.users.fetch(staffId).catch(() => null);
            if (staffUser) await staffUser.send(messageText).catch(() => {});
        } catch (_) {}
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 💳 AMERICAN EXPRESS CARD SYSTEM
// ══════════════════════════════════════════════════════════════════════════
const AMEX_CARDS = {
    green: {
        emoji: '🟢', name: 'Green', tier: 1,
        eligibility: 20_000_000,         // net worth required
        availCost:   1_000_000,          // one-time avail fee (registration)
        maintenance: 3_000_000,          // per week
        transferLimit:    50_000_000,    // per single transfer
        dailyTransferCap: 25_000_000,    // daily send cap
        cdReduction:      0.20,          // 20% CD reduction
        dailyBonus:       0.25,          // +25% on .daily
        robProtection:    0,             // 0 = none
        shop:             null,
        badge:            '🟢 Green Member',
    },
    gold: {
        emoji: '🥇', name: 'Gold', tier: 2,
        eligibility: 40_000_000,
        availCost:   3_000_000,
        maintenance: 5_000_000,
        transferLimit:    100_000_000,
        dailyTransferCap: 50_000_000,
        cdReduction:      0.30,
        dailyBonus:       0.50,
        robProtection:    0.25,          // 25% damage reduction
        shop:             '.goldshop',
        badge:            '🥇 Gold Member',
    },
    platinum: {
        emoji: '💎', name: 'Platinum', tier: 3,
        eligibility: 60_000_000,
        availCost:   5_000_000,
        maintenance: 7_000_000,
        transferLimit:    500_000_000,
        dailyTransferCap: 200_000_000,
        cdReduction:      0.50,
        dailyBonus:       1.00,
        robProtection:    0.50,
        shop:             '.platshop',
        badge:            '💎 Platinum Member',
    },
    black: {
        emoji: '🖤', name: 'Black', tier: 4,
        eligibility: 100_000_000,
        availCost:   10_000_000,
        maintenance: 10_000_000,
        transferLimit:    Infinity,
        dailyTransferCap: Infinity,
        cdReduction:      0.70,
        dailyBonus:       2.00,
        robProtection:    1.00,          // full immunity
        shop:             '.blackshop',
        badge:            '🖤 Black Member',
    },
};

// Helper: get user's net worth (wallet + bank)
function getNetWorth(userId) {
    const u = db[userId];
    if (!u) return 0;
    return (u.wallet || 0) + (u.bank || 0);
}

// Helper: get user's active amex card data (or null)
function getAmexCard(userId) {
    const u = db[userId];
    if (!u || !u.amexCard) return null;
    return u.amexCard; // { tier, active, availedAt, lastMaintenance, graceStart, invitesSent:{} }
}

// Helper: apply CD reduction for card holders
function getEffectiveCd(userId, baseCd) {
    const card = getAmexCard(userId);
    if (!card || !card.active) return baseCd;
    const tier = AMEX_CARDS[card.tier];
    if (!tier) return baseCd;
    return Math.floor(baseCd * (1 - tier.cdReduction));
}

// ── Check and send Amex invites when net worth crosses thresholds ──────────
async function checkAmexInvite(userId) {
    try {
        const nw = getNetWorth(userId);
        const u  = db[userId];
        if (!u) return;
        if (!u.amexInvitesSent) u.amexInvitesSent = {};

        for (const [tierKey, card] of Object.entries(AMEX_CARDS)) {
            // Already sent this invite
            if (u.amexInvitesSent[tierKey]) continue;
            // Already has this tier or higher
            if (u.amexCard && AMEX_CARDS[u.amexCard.tier]?.tier >= card.tier) continue;
            // Net worth not reached yet
            if (nw < card.eligibility) continue;

            // Send the invite DM
            u.amexInvitesSent[tierKey] = true;
            saveDB();

            const discordUser = await client.users.fetch(userId).catch(() => null);
            if (!discordUser) continue;

            await discordUser.send(
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `${card.emoji} *AMERICAN EXPRESS — EXCLUSIVE INVITATION* ${card.emoji}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Congratulations! Your net worth has qualified you for the\n` +
                `*Amex ${card.name} Card* — one of Tyrant's most exclusive memberships.\n\n` +
                `💳 *Card:* Amex ${card.emoji} ${card.name}\n` +
                `💰 *One-time fee:* $${formatNum(card.availCost)}\n` +
                `📅 *Weekly maintenance:* $${formatNum(card.maintenance)}/week\n\n` +
                `✨ *Benefits:*\n` +
                `📤 Transfer limit: ${card.transferLimit === Infinity ? 'Unlimited' : '$' + formatNum(card.transferLimit)}\n` +
                `📊 Daily transfer cap: ${card.dailyTransferCap === Infinity ? 'None' : '$' + formatNum(card.dailyTransferCap)}\n` +
                `⏱️ Gambling CD: -${card.cdReduction * 100}%\n` +
                `🎁 Daily bonus: +${card.dailyBonus * 100}%\n` +
                `🛡️ Rob protection: ${card.robProtection === 0 ? 'None' : card.robProtection === 1 ? 'Full immunity' : (card.robProtection * 100) + '% damage reduction'}\n` +
                (card.shop ? `🏪 Exclusive shop: ${card.shop}\n` : '') +
                `🏅 Badge: ${card.badge}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `To avail, type *.avail ${tierKey}* in the server.\n` +
                `_This invitation is optional — availing is your choice._`
            ).catch(() => {});
        }
    } catch (e) { console.error('Amex invite error:', e.message); }
}

// whatsapp-web.js's `msg`/`chatObj`, so the ported game logic below
// needs minimal changes.
// ══════════════════════════════════════════════════════════════════════════
// Shim for whatsapp-web.js MessageMedia: returns {__media: true, url}
const MessageMedia = {
    fromUrl: async (url) => ({ __media: true, url }),
    fromFilePath: (path) => ({ __media: true, path })
};

function wrapMessage(message) {
    // FIX: this same message object is shared across multiple messageCreate
    // listeners. Wrapping it twice would re-derive senderId from an already
    // string-ified message.author (giving 'unknown') and double-wrap message.reply.
    // Make this function idempotent so calling it more than once is always safe.
    if (message.__wrapped) return message;
    message.__wrapped = true;

    const senderId = message.author?.id || 'unknown';  // FIX: safe guard against missing author

    message.author2 = senderId; // for code using msg.author || msg.from
    message.author = senderId;  // FIX: override Discord User object with plain string ID
    message.from = senderId;
    message.body = message.content;

    // msg.reply(text, {mentions:[...]}) -> Discord reply (mentions handled via <@id>)
    const originalReply = message.reply.bind(message);
    message.reply = (content, opts = {}) => {
        if (typeof content === 'string') {
            return originalReply({ content, allowedMentions: { parse: ['users'] } }).catch(() => {});
        }
        return originalReply(content).catch(() => {});
    };

    message.fromMe = false; // Discord bot messages are filtered out separately

    // mentionedIds: array of mentioned user IDs (WhatsApp style)
    message.mentionedIds = message.mentions?.users ? [...message.mentions.users.keys()] : [];  // FIX: safe guard

    // hasQuotedMsg / getQuotedMessage: based on Discord message replies
    message.hasQuotedMsg = !!message.reference;
    message.getQuotedMessage = async () => {
        if (!message.reference) return { author: null };
        try {
            const ref = await message.channel.messages.fetch(message.reference.messageId);
            return { author: ref.author.id };
        } catch (_) {
            return { author: null };
        }
    };

    message.getContact = async () => ({ id: { _serialized: senderId } });

    // msg.getChat() -> returns an object with id._serialized, isGroup, sendMessage
    message.getChat = async () => {
        let participants = [];
        if (message.guild) {
            try {
                const members = await message.guild.members.fetch();
                // FIX: members is a Discord Collection, must use .values() before .map()
                participants = [...members.values()].map(m => ({
                    id: { _serialized: m.id },
                    isAdmin: m.permissions.has('Administrator') || m.permissions.has('ModerateMembers'),
                    isSuperAdmin: m.permissions.has('Administrator')
                }));
            } catch (_) {}
        }
        return {
            id: { _serialized: message.channel.id },
            isGroup: !!message.guild,
            participants,
            removeParticipants: async (ids) => {
                if (!message.guild) return;
                for (const id of ids) {
                    const member = await message.guild.members.fetch(id.split('@')[0] || id).catch(() => null);
                    if (member) await member.kick().catch(() => {});
                }
            },
            sendMessage: (content, opts = {}) => {
            // Image/media + caption (MessageMedia shim object)
            if (content && content.__media) {
                const payload = { content: opts.caption || '', allowedMentions: { parse: ['users'] } };
                if (content.url) payload.files = [new AttachmentBuilder(content.url, { name: 'image.png' })];
                else if (content.path) payload.files = [new AttachmentBuilder(content.path)];
                return message.channel.send(payload).catch(() => {});
            }
            if (typeof content === 'string') {
                return message.channel.send({ content, allowedMentions: { parse: ['users'] } }).catch(() => {});
            }
                return message.channel.send(content).catch(() => {});
            }
        };
    };

    return message;
}

// Convert "@123456789" (WhatsApp style) mentions to Discord "<@123456789>"
function toDiscordMention(id) {
    return `<@${id}>`;
}

// ── Safe long-message sender ────────────────────────────────────────────────
// Plain `msg.reply(text)` is capped at Discord's hard 2000-char content limit
// and the wrapped reply() above silently swallows any overflow error
// (.catch(() => {})), so long menus (.pstore, etc.) would just
// vanish with zero feedback. This sends an embed instead (4096-char
// description limit — 2x the headroom) and, if content is STILL too long
// (e.g. the card catalog keeps growing), auto-splits into multiple
// page embeds at safe \n\n boundaries so no entry is ever cut in half.
// Uses msg.channel.send directly (not the wrapped msg.reply) so a real
// send failure gets logged instead of disappearing silently.
const EMBED_DESC_LIMIT = 4096;
async function sendLongEmbed(msg, { title, description, color = 0x5865F2, footer } = {}) {
    const blocks = description.split('\n\n');
    const chunks = [];
    let current = '';
    for (const block of blocks) {
        if ((current + block + '\n\n').length > EMBED_DESC_LIMIT) {
            if (current) chunks.push(current.trim());
            current = block + '\n\n';
        } else {
            current += block + '\n\n';
        }
    }
    if (current.trim()) chunks.push(current.trim());
    if (chunks.length === 0) chunks.push(description);

    for (let i = 0; i < chunks.length; i++) {
        const embed = new EmbedBuilder().setColor(color).setDescription(chunks[i]);
        if (i === 0 && title) embed.setTitle(title);
        const pageLabel = chunks.length > 1 ? `Page ${i + 1}/${chunks.length}` : null;
        const footerText = [pageLabel, footer].filter(Boolean).join(' • ');
        if (footerText) embed.setFooter({ text: footerText });

        const payload = { embeds: [embed] };
        if (i === 0) payload.reply = { messageReference: msg.id, failIfNotExists: false };

        try {
            await msg.channel.send(payload);
        } catch (e) {
            console.error('sendLongEmbed failed:', e.message);
        }
    }
}

// Discord-based "is mod/admin" check
async function checkIsMod(msg) {
    try {
        // msg.author is a string ID after wrapMessage; before wrapMessage it's a User object
        const authorId = typeof msg.author === 'string' ? msg.author : (msg.author?.id || '');
        if (!authorId) return false;

        // 1. Hardcoded owner IDs always pass
        if (MOD_NUMBERS.includes(authorId)) return true;

        // 2. DMs — treat as allowed
        if (!msg.guild) return true;

        // 3. Check Discord server permissions directly from the original message's guild
        //    msg.guild is still intact — wrapMessage doesn't remove it
        const member = await msg.guild.members.fetch(authorId).catch(() => null);
        if (!member) return false;

        return member.permissions.has('Administrator') ||
               member.permissions.has('ModerateMembers') ||
               member.permissions.has('ManageGuild') ||
               member.permissions.has('KickMembers');
    } catch (e) {
        console.error('checkIsMod error:', e.message);
        // Fallback: only hardcoded owners
        const authorId = typeof msg.author === 'string' ? msg.author : (msg.author?.id || '');
        return MOD_NUMBERS.includes(authorId);
    }
}



// ── EVOLUTION STONE SHOP ───────────────────────────────────────────────────────
const STONE_SHOP = {
    evolutionstone: { name: 'Evolution Stone', price: 75000, emoji: '🌟💎', desc: 'Evolves an eligible Pokémon into its next form! Use with `.evolve <pokemon>`' },
};

const RARE_CANDY_SHOP = {
    rarecandy: { name: 'Rare Candy', price: 25000, emoji: '🍬', desc: 'Instantly levels up a Pokémon by one level. Use `.rare <pokemon>`.' },
};

// ── POKÉBALL SHOP ─────────────────────────────────────────────────────────────
const POKEBALL_SHOP = {
    pokeball:    { name: 'Pokéball',       price: 500,    catchBonus: 0,   emoji: '🔴', desc: 'Standard catch tool' },
    greatball:   { name: 'Great Ball',     price: 2000,   catchBonus: 15,  emoji: '🔵', desc: '+15% catch rate' },
    ultraball:   { name: 'Ultra Ball',     price: 5000,   catchBonus: 30,  emoji: '⚫', desc: '+30% catch rate' },
    masterball:  { name: 'Master Ball',    price: 100000, catchBonus: 100, emoji: '🟣', desc: '100% guaranteed catch!' },
    heavyball:   { name: 'Heavy Ball',     price: 8000,   catchBonus: 20,  emoji: '⚙️', desc: 'Best vs large Pokémon' },
    lureball:    { name: 'Lure Ball',      price: 3000,   catchBonus: 25,  emoji: '🎣', desc: 'Extra effective on fish Pokémon' },
};

// ── FOOD SHOP ─────────────────────────────────────────────────────────────────
// Categories: berry (cheap classic Pokémon berries), meal (everyday food),
// protein (pure ATK specialists), special (rare all-rounder), legendary (permanent stat item),
// drink (soda/energy — instant ATK buff usable ONLY in the next PvP battle), alcohol (risky funny items)
const FOOD_SHOP = {
    // ── 🍓 BERRIES — progressively stronger HP + permanent ATK benefits ──
    heriberry:    { name: 'Heri Berry',     price: 100,  heal: 12, atkBoost: 1, energy: 12, emoji: '🩷🫐', desc: '+12 HP & +1 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    cheriberry:   { name: 'Cheri Berry',    price: 150,  heal: 15, atkBoost: 1, energy: 15, emoji: '🔴🫐', desc: '+15 HP & +1 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    oranberry:    { name: 'Oran Berry',     price: 200,  heal: 25, atkBoost: 2, energy: 25, emoji: '🔵🫐', desc: '+25 HP & +2 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    chestoberry:  { name: 'Chesto Berry',   price: 300,  heal: 30, atkBoost: 2, energy: 30, emoji: '🟣🫐', desc: '+30 HP & +2 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    pechaberry:   { name: 'Pecha Berry',    price: 400,  heal: 35, atkBoost: 3, energy: 35, emoji: '🌸🫐', desc: '+35 HP & +3 permanent ATK; cures Toxic', isAlcohol: false, isToxic: false, category: 'berry', curesToxic: true },
    rawstberry:   { name: 'Rawst Berry',    price: 500,  heal: 40, atkBoost: 4, energy: 40, emoji: '🔥🫐', desc: '+40 HP & +4 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    aspearberry:  { name: 'Aspear Berry',   price: 650,  heal: 45, atkBoost: 5, energy: 45, emoji: '❄️🫐', desc: '+45 HP & +5 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    leppaberry:   { name: 'Leppa Berry',    price: 800,  heal: 50, atkBoost: 6, energy: 50, emoji: '❤️🫐', desc: '+50 HP & +6 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    persimberry:  { name: 'Persim Berry',   price: 1000, heal: 55, atkBoost: 7, energy: 55, emoji: '🟠🫐', desc: '+55 HP & +7 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    sitrusberry:  { name: 'Sitrus Berry',   price: 1400, heal: 65, atkBoost: 8, energy: 65, emoji: '🟢🫐', desc: '+65 HP & +8 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    figyberry:    { name: 'Figy Berry',     price: 1800, heal: 75, atkBoost: 10, energy: 75, emoji: '🟤🫐', desc: '+75 HP & +10 permanent ATK', isAlcohol: false, isToxic: false, category: 'berry' },
    lumberry:     { name: 'Lum Berry',      price: 2500, heal: 90, atkBoost: 12, energy: 90, emoji: '🟣🫐', desc: '+90 HP & +12 permanent ATK; cures Toxic', isAlcohol: false, isToxic: false, category: 'berry', curesToxic: true },

    // ── 🍽️ MEALS — everyday food, balanced heal + permanent ATK ──
    chicken:    { name: 'Roasted Chicken',   price: 400,      heal: 25,  atkBoost: 2,  energy: 25,   emoji: '🍗',   desc: 'Restores +25 HP & +2 ATK', isAlcohol: false, isToxic: false, category: 'meal' },
    moomoomilk: { name: 'Moomoo Milk',       price: 550,      heal: 55,  atkBoost: 3,  energy: 55,   emoji: '🥛',   desc: 'Farm-fresh milk — restores +55 HP & +3 ATK', isAlcohol: false, isToxic: false, category: 'meal' },
    milkshake:  { name: 'Thick Milkshake',   price: 700,      heal: 45,  atkBoost: 3,  energy: 45,   emoji: '🥤🍦', desc: 'Restores +45 HP & +3 ATK', isAlcohol: false, isToxic: false, category: 'meal' },
    pizza:      { name: 'Mega Pizza',        price: 1200,     heal: 80,  atkBoost: 5,  energy: 80,   emoji: '🍕',   desc: 'Restores +80 HP & +5 ATK — cheesy goodness', isAlcohol: false, isToxic: false, category: 'meal' },
    sushi:      { name: 'Premium Sushi',     price: 3000,     heal: 90,  atkBoost: 6,  energy: 90,   emoji: '🍣',   desc: 'Restores +90 HP + +6 ATK + +10 XP boost', isAlcohol: false, isToxic: false, category: 'meal', xpBonus: 10 },

    // ── 💪 PROTEIN — built for pure damage, light on healing ──
    protein:       { name: 'Protein Bar',     price: 2500, heal: 100, atkBoost: 8,  energy: 100, emoji: '🍫',  desc: 'Fully restores HP & +8 ATK', isAlcohol: false, isToxic: false, category: 'protein' },
    proteinpowder: { name: 'Protein Powder',  price: 6000, heal: 35,  atkBoost: 18, energy: 35,  emoji: '💪🥤', desc: 'Pure muscle fuel — the BIGGEST permanent ATK gain of any food! Light healing only.', isAlcohol: false, isToxic: false, category: 'protein' },

    // ── 🧪 SPECIAL — rare all-rounder, beats every normal food in HP+ATK ──
    mystery:    { name: 'Mystery Drink',     price: 8000,     heal: 100, atkBoost: 12, energy: 100,  emoji: '🧪',   desc: 'Mysterious concoction — full heal, +12 ATK & +20 XP! More HP & ATK than any normal food.', isAlcohol: false, isToxic: false, category: 'special', xpBonus: 20 },

    // ── 👑 LEGENDARY — absurdly expensive, permanent stat upgrade ──

    // ── 🥤 DRINKS — instant ATK buff for your NEXT PvP battle ONLY (no use vs wild Pokémon) ──
    sprite:     { name: 'Sprite',            price: 80,   heal: 15, atkBoost: 0, energy: 15, emoji: '🟢🥤', desc: 'Crisp citrus fizz — instant +6 ATK buff for your next PvP battle only', isAlcohol: false, isToxic: false, category: 'drink', atkBuff: 6 },
    fanta:      { name: 'Fanta',             price: 95,   heal: 18, atkBoost: 0, energy: 18, emoji: '🟠🥤', desc: 'Sweet orange soda — instant +7 ATK buff for your next PvP battle only', isAlcohol: false, isToxic: false, category: 'drink', atkBuff: 7 },
    coke:       { name: 'Coca-Cola',         price: 115,  heal: 20, atkBoost: 0, energy: 20, emoji: '🔴🥤', desc: 'Classic cola rush — instant +9 ATK buff for your next PvP battle only', isAlcohol: false, isToxic: false, category: 'drink', atkBuff: 9 },
    energy:     { name: 'Energy Drink',      price: 800,  heal: 30, atkBoost: 0, energy: 30, emoji: '⚡',   desc: 'Caffeine surge — instant +14 ATK buff for your next PvP battle only', isAlcohol: false, isToxic: false, category: 'drink', atkBuff: 14 },
    redbull:    { name: 'Red Bull',          price: 1800, heal: 40, atkBoost: 0, energy: 40, emoji: '🐂⚡', desc: 'Gives your Pokémon wings! The strongest drink — instant +22 ATK buff for your next PvP battle only', isAlcohol: false, isToxic: false, category: 'drink', atkBuff: 22 },

    // ── 🍻 ALCOHOL & FUNNY — risky: great for 3 uses, TOXIC after that ──
};

// Groups food shop entries by category into a nicely formatted, headered menu string.
function buildFoodShopMenu() {
    const CATEGORY_LABELS = {
        berry:     '🍓 *BERRIES* _(cheap & classic)_',
        meal:      '🍽️ *MEALS*',
        protein:   '💪 *PROTEIN* _(pure damage specialists)_',
        special:   '🧪 *SPECIAL* _(best all-rounder — beats every normal food)_',
        drink:     '🥤 *DRINKS* _(instant ATK buff — next PvP battle only, no effect vs wild Pokémon)_',
    };
    const ORDER = ['berry', 'protein', 'special', 'drink'];
    let menu = '';
    for (const cat of ORDER) {
        const keys = Object.keys(FOOD_SHOP).filter(k => (FOOD_SHOP[k].category || 'meal') === cat);
        if (keys.length === 0) continue;
        menu += `${CATEGORY_LABELS[cat]}\n`;
        for (const key of keys) {
            const f = FOOD_SHOP[key];
            menu += `${f.emoji} *${f.name}* — $${formatNum(f.price)} (\`.buy ${key}\`)\n📝 ${f.desc}\n\n`;
        }
    }
    return menu.trim();
}

// ── POKÉMON MOVES ─────────────────────────────────────────────────────────────
const POKEMON_MOVES = {
    pikachu:    [
        { name: 'Thunderbolt',   damage: [45, 65], emoji: '⚡', special: false },
        { name: 'Thunder',       damage: [60, 90], emoji: '🌩️', special: true  },
        { name: 'Quick Attack',  damage: [20, 35], emoji: '💨', special: false },
        { name: 'Volt Tackle',   damage: [80, 110],emoji: '⚡💥',special: true  },
    ],
    bulbasaur:  [
        { name: 'Vine Whip',     damage: [35, 50], emoji: '🌿', special: false },
        { name: 'Solar Beam',    damage: [65, 90], emoji: '☀️', special: true  },
        { name: 'Razor Leaf',    damage: [40, 60], emoji: '🍃', special: false },
        { name: 'Poison Powder', damage: [25, 40], emoji: '☠️', special: false },
    ],
    charmander: [
        { name: 'Ember',         damage: [35, 55], emoji: '🔥', special: false },
        { name: 'Fire Spin',     damage: [55, 80], emoji: '🌀🔥',special: true  },
        { name: 'Scratch',       damage: [20, 35], emoji: '✋', special: false },
        { name: 'Flamethrower',  damage: [60, 85], emoji: '🔥💨',special: true  },
    ],
    squirtle:   [
        { name: 'Water Gun',     damage: [35, 50], emoji: '💧', special: false },
        { name: 'Aqua Tail',     damage: [65, 90], emoji: '🌊💙',special: true  },
        { name: 'Withdraw',      damage: [20, 30], emoji: '🐢', special: false },
        { name: 'Bubble Beam',   damage: [45, 65], emoji: '🫧', special: false },
    ],
    charizard:  [
        { name: 'Wing Attack',   damage: [65, 88], emoji: '🦅🔥',special: false },
        { name: 'Fire Blast',    damage: [90, 130],emoji: '💥🔥',special: true  },
        { name: 'Dragon Claw',   damage: [75, 100],emoji: '🐉', special: false },
        { name: 'Inferno',       damage: [100,140],emoji: '☄️', special: true  },
    ],
    blastoise:  [
        { name: 'Hydro Pump',    damage: [75, 100],emoji: '🌊', special: true  },
        { name: 'Water Cannon',  damage: [85, 115],emoji: '💦🔵',special: true  },
        { name: 'Skull Bash',    damage: [60, 80], emoji: '💀', special: false },
        { name: 'Ice Beam',      damage: [65, 90], emoji: '🧊', special: false },
    ],
    venusaur:   [
        { name: 'Petal Blizzard',damage: [80, 110],emoji: '🌸💨',special: true  },
        { name: 'Petal Dance',   damage: [70, 95], emoji: '🌺', special: false },
        { name: 'Frenzy Plant',  damage: [90, 125],emoji: '🌱💥',special: true  },
        { name: 'Sludge Bomb',   damage: [65, 85], emoji: '☠️💚',special: false },
    ],
    greninja:   [
        { name: 'Water Shuriken',damage: [80, 110],emoji: '🥷💧',special: true  },
        { name: 'Night Slash',   damage: [70, 95], emoji: '🌑✂️',special: false },
        { name: 'Mat Block',     damage: [55, 75], emoji: '🥷🛡️',special: false },
        { name: 'Hydro Vortex',  damage: [100,135],emoji: '🌀🌊',special: true  },
    ],
    gengar:     [
        { name: 'Shadow Ball',   damage: [80, 110],emoji: '👻🌑',special: true  },
        { name: 'Dream Eater',   damage: [90, 120],emoji: '💤😈',special: true  },
        { name: 'Lick',          damage: [55, 75], emoji: '👅👻',special: false },
        { name: 'Curse',         damage: [70, 95], emoji: '🪄👻',special: false },
    ],
    gyarados:   [
        { name: 'Hyper Beam',    damage: [100,140],emoji: '💥🔱',special: true  },
        { name: 'Dragon Rage',   damage: [80, 110],emoji: '🐉💢',special: false },
        { name: 'Aqua Tail',     damage: [75, 100],emoji: '🌊🐟',special: false },
        { name: 'Crunch',        damage: [70, 95], emoji: '🦷💥',special: false },
    ],
    garchomp:   [
        { name: 'Dragon Rush',   damage: [90, 125],emoji: '🦈🌪️',special: false },
        { name: 'Earth Power',   damage: [95, 130],emoji: '🌍💥',special: true  },
        { name: 'Sand Tomb',     damage: [65, 85], emoji: '🏜️🌀',special: false },
        { name: 'Outrage',       damage: [110,150],emoji: '💢🐉',special: true  },
    ],
    lucario:    [
        { name: 'Aura Sphere',   damage: [95, 130],emoji: '✨🔵',special: true  },
        { name: 'Close Combat',  damage: [100,135],emoji: '👊💥',special: false },
        { name: 'Bone Rush',     damage: [75, 100],emoji: '🦴⚡',special: false },
        { name: 'Steel Cannon',  damage: [85, 115],emoji: '🔩💡',special: true  },
    ],
    mew:        [
        { name: 'Mew Beam',      damage: [90, 120],emoji: '🌀✨',special: true  },
        { name: 'Ancient Power', damage: [80, 110],emoji: '🪨💫',special: false },
        { name: 'Metronome',     damage: [70, 130],emoji: '🎵🔀',special: true  },
        { name: 'Transform',     damage: [75, 110],emoji: '🌟🔄',special: true  },
    ],
    darkrai:    [
        { name: 'Dark Void',     damage: [100,140],emoji: '🌑🕳️',special: true  },
        { name: 'Phantom Force', damage: [85, 115],emoji: '👻💜',special: false },
        { name: 'Nightmare',     damage: [90, 125],emoji: '💤😱',special: true  },
        { name: 'Feint Attack',  damage: [70, 95], emoji: '🌚⚔️',special: false },
    ],
    mewtwo:     [
        { name: 'Psystrike',     damage: [110,150],emoji: '🌌💜',special: true  },
        { name: 'Psyblast',      damage: [100,135],emoji: '🌀💥',special: true  },
        { name: 'Barrier Break', damage: [90, 120],emoji: '🧱💔',special: false },
        { name: 'Genesis Nova',  damage: [120,160],emoji: '🌌⚡',special: true  },
    ],
    rayquaza:   [
        { name: 'Dragon Ascent', damage: [120,165],emoji: '🟢🐉',special: true  },
        { name: 'Sky Attack',    damage: [105,145],emoji: '☁️💥',special: true  },
        { name: 'Outrage',       damage: [105,140],emoji: '💢🌪️',special: false },
        { name: 'Air Lock Slam', damage: [100,135],emoji: '🌪️⚡',special: false },
    ],
    lugia:      [
        { name: 'Aeroblast',     damage: [115,155],emoji: '🦅💨',special: true  },
        { name: 'Gust of Doom',  damage: [90, 120],emoji: '🌬️🌊',special: false },
        { name: 'Extrasensory',  damage: [95, 130],emoji: '🌀🔵',special: true  },
        { name: 'Sky Drop',      damage: [80, 110],emoji: '🌤️⬇️',special: false },
    ],
    arceus:     [
        { name: 'Judgement',     damage: [130,175],emoji: '👑⚡',special: true  },
        { name: 'Hyper Voice',   damage: [110,150],emoji: '📣💫',special: false },
        { name: 'Earth Power',   damage: [115,155],emoji: '🌍⚡',special: true  },
        { name: 'Seraph Strike', damage: [100,140],emoji: '🌌🌟',special: false },
    ],
    // New Pokémon moves
    rattata:    [
        { name: 'Bite',          damage: [20, 35], emoji: '🦷',  special: false },
        { name: 'Hyper Fang',    damage: [35, 50], emoji: '😬',  special: false },
        { name: 'Quick Attack',  damage: [15, 28], emoji: '💨',  special: false },
        { name: 'Super Fang',    damage: [30, 45], emoji: '⚡🦷', special: true  },
    ],
    pidgey:     [
        { name: 'Gust',          damage: [18, 30], emoji: '🌬️', special: false },
        { name: 'Wing Attack',   damage: [25, 40], emoji: '🦅',  special: false },
        { name: 'Whirlwind',     damage: [20, 35], emoji: '🌀',  special: false },
        { name: 'Aerial Ace',    damage: [30, 45], emoji: '✈️✨', special: true  },
    ],
    meowth:     [
        { name: 'Scratch',       damage: [18, 30], emoji: '✋',  special: false },
        { name: 'Pay Day',       damage: [25, 40], emoji: '🪙💥', special: false },
        { name: 'Fury Swipes',   damage: [20, 38], emoji: '💅💥', special: false },
        { name: 'Night Slash',   damage: [32, 50], emoji: '🌑✂️', special: true  },
    ],
    psyduck:    [
        { name: 'Water Sport',   damage: [22, 36], emoji: '💧',  special: false },
        { name: 'Confusion',     damage: [30, 46], emoji: '🌀🦆', special: true  },
        { name: 'Disable',       damage: [18, 30], emoji: '😵',  special: false },
        { name: 'Psychic Wave',  damage: [42, 60], emoji: '🌊🌀', special: true  },
    ],
    growlithe:  [
        { name: 'Bite',          damage: [28, 42], emoji: '🦷🔥', special: false },
        { name: 'Flame Wheel',   damage: [38, 55], emoji: '🔥🌀', special: false },
        { name: 'Agility',       damage: [22, 36], emoji: '💨🐕', special: false },
        { name: 'Flare Blitz',   damage: [55, 78], emoji: '🔥💥', special: true  },
    ],
    abra:       [
        { name: 'Teleport',      damage: [15, 25], emoji: '🔮✨', special: false },
        { name: 'Psybeam',       damage: [28, 42], emoji: '🌈🌀', special: true  },
        { name: 'Hidden Power',  damage: [22, 36], emoji: '⭐',   special: false },
        { name: 'Future Sight',  damage: [45, 65], emoji: '👁️🌀', special: true  },
    ],
    machop:     [
        { name: 'Karate Chop',   damage: [32, 48], emoji: '🥋✋', special: false },
        { name: 'Low Kick',      damage: [26, 40], emoji: '🦵',   special: false },
        { name: 'Submission',    damage: [40, 58], emoji: '🤼',   special: false },
        { name: 'Seismic Toss',  damage: [50, 72], emoji: '🌍🤜', special: true  },
    ],
    haunter:    [
        { name: 'Lick',          damage: [25, 38], emoji: '👅💜', special: false },
        { name: 'Spite',         damage: [20, 32], emoji: '😤👻', special: false },
        { name: 'Sucker Punch',  damage: [35, 52], emoji: '👊🌑', special: false },
        { name: 'Shadow Punch',  damage: [48, 68], emoji: '🌑👊', special: true  },
    ],
    scyther:    [
        { name: 'Slash',         damage: [45, 65], emoji: '⚔️',  special: false },
        { name: 'Wing Attack',   damage: [38, 55], emoji: '🦅⚔️', special: false },
        { name: 'X-Scissor',     damage: [55, 78], emoji: '✂️✂️', special: false },
        { name: 'Fury Cutter',   damage: [65, 92], emoji: '🔪💥', special: true  },
    ],
    eevee:      [
        { name: 'Tackle',        damage: [24, 38], emoji: '💪🦊', special: false },
        { name: 'Swift',         damage: [32, 48], emoji: '⭐🌟', special: false },
        { name: 'Bite',          damage: [28, 44], emoji: '🦷🦊', special: false },
        { name: 'Last Resort',   damage: [50, 72], emoji: '🦊💥', special: true  },
    ],
    snorlax:    [
        { name: 'Body Slam',     damage: [65, 90], emoji: '😴💥', special: false },
        { name: 'Rest',          damage: [40, 60], emoji: '💤❤️', special: false },
        { name: 'Hyper Beam',    damage: [85, 118],emoji: '😴💥🔥',special: true  },
        { name: 'Heavy Slam',    damage: [75, 105],emoji: '⚙️💥', special: true  },
    ],
    dragonite:  [
        { name: 'Dragon Rush',   damage: [70, 98], emoji: '🐲💨', special: false },
        { name: 'Thunder Punch', damage: [62, 88], emoji: '⚡👊', special: false },
        { name: 'Fire Punch',    damage: [65, 92], emoji: '🔥👊', special: false },
        { name: 'Draco Meteor',  damage: [95, 132],emoji: '🌠🐲', special: true  },
    ],
    alakazam:   [
        { name: 'Psybeam',       damage: [42, 62], emoji: '🌈💜', special: false },
        { name: 'Kinesis',       damage: [35, 55], emoji: '🥄💫', special: false },
        { name: 'Telekinesis',   damage: [55, 78], emoji: '🌀🥄', special: false },
        { name: 'Psycho Cut',    damage: [68, 95], emoji: '🔮✂️', special: true  },
    ],
    articuno:   [
        { name: 'Ice Shard',     damage: [50, 72], emoji: '❄️🧊', special: false },
        { name: 'Freeze Dry',    damage: [65, 90], emoji: '🧊💨', special: false },
        { name: 'Blizzard',      damage: [80, 115],emoji: '❄️🌪️', special: true  },
        { name: 'Sheer Cold',    damage: [90, 128],emoji: '🌨️💀', special: true  },
    ],
    zapdos:     [
        { name: 'Thunder Shock', damage: [50, 72], emoji: '⚡🐦', special: false },
        { name: 'Drill Peck',    damage: [62, 88], emoji: '🔩🐦', special: false },
        { name: 'Discharge',     damage: [75, 105],emoji: '⚡💥', special: true  },
        { name: 'Zap Cannon',    damage: [92, 128],emoji: '⚡🔫', special: true  },
    ],
    moltres:    [
        { name: 'Fire Spin',     damage: [52, 75], emoji: '🔥🌀', special: false },
        { name: 'Sky Attack',    damage: [65, 92], emoji: '🦅🔥', special: false },
        { name: 'Flame Burst',   damage: [78, 108],emoji: '💥🔥', special: true  },
        { name: 'Inferno Wing',  damage: [95, 132],emoji: '☄️🦅', special: true  },
    ],
    // Extra new Pokémon
    totodile:   [
        { name: 'Water Gun',     damage: [30, 46], emoji: '💧🐊', special: false },
        { name: 'Bite',          damage: [28, 44], emoji: '🦷🐊', special: false },
        { name: 'Aqua Jet',      damage: [40, 58], emoji: '💦⚡', special: false },
        { name: 'Crunch',        damage: [55, 78], emoji: '🐊💥', special: true  },
    ],
    cyndaquil:  [
        { name: 'Ember',         damage: [28, 44], emoji: '🔥🦔', special: false },
        { name: 'Smokescreen',   damage: [22, 36], emoji: '💨🌫️', special: false },
        { name: 'Flame Charge',  damage: [42, 62], emoji: '🔥💨', special: false },
        { name: 'Eruption',      damage: [65, 92], emoji: '🌋🔥', special: true  },
    ],
    chikorita:  [
        { name: 'Razor Leaf',    damage: [28, 44], emoji: '🍃✂️', special: false },
        { name: 'Sweet Scent',   damage: [20, 32], emoji: '🌸🌿', special: false },
        { name: 'Magical Leaf',  damage: [40, 58], emoji: '🍀✨', special: false },
        { name: 'Leaf Storm',    damage: [62, 88], emoji: '🌪️🍃', special: true  },
    ],
    umbreon:    [
        { name: 'Dark Pulse',    damage: [55, 78], emoji: '🌑💜', special: false },
        { name: 'Moonblast',     damage: [68, 95], emoji: '🌙✨', special: true  },
        { name: 'Mean Look',     damage: [42, 60], emoji: '👁️🌑', special: false },
        { name: 'Foul Play',     damage: [75, 105],emoji: '😈🌑', special: true  },
    ],
    espeon:     [
        { name: 'Psybeam',       damage: [52, 75], emoji: '🌈💜', special: false },
        { name: 'Morning Sun',   damage: [45, 65], emoji: '☀️🌸', special: false },
        { name: 'Psyshock',      damage: [68, 95], emoji: '🌀💥', special: true  },
        { name: 'Future Sight',  damage: [82, 115],emoji: '👁️💜', special: true  },
    ],
    ampharos:   [
        { name: 'Thundershock',  damage: [48, 68], emoji: '⚡🐑', special: false },
        { name: 'Thunder Punch', damage: [60, 85], emoji: '⚡👊', special: false },
        { name: 'Signal Beam',   damage: [72, 100],emoji: '📡⚡', special: true  },
        { name: 'Zap Canon',     damage: [88, 122],emoji: '⚡💥', special: true  },
    ],
    tyranitar:  [
        { name: 'Rock Slide',    damage: [65, 90], emoji: '🪨💥', special: false },
        { name: 'Crunch',        damage: [72, 100],emoji: '🦷💢', special: false },
        { name: 'Dark Pulse',    damage: [78, 108],emoji: '🌑🦖', special: true  },
        { name: 'Stone Edge',    damage: [95, 132],emoji: '💎🪨', special: true  },
    ],
    blaziken:   [
        { name: 'Blaze Kick',    damage: [68, 95], emoji: '🔥🦵', special: false },
        { name: 'Sky Uppercut',  damage: [62, 88], emoji: '👊☁️', special: false },
        { name: 'High Jump Kick',damage: [80, 112],emoji: '🦵💥', special: false },
        { name: 'Blast Burn',    damage: [98, 138],emoji: '🔥💥', special: true  },
    ],
    swampert:   [
        { name: 'Mud Shot',      damage: [50, 72], emoji: '🌊🤎', special: false },
        { name: 'Hammer Arm',    damage: [65, 92], emoji: '💪🌊', special: false },
        { name: 'Muddy Water',   damage: [75, 105],emoji: '🌊💦', special: true  },
        { name: 'Hydro Cannon',  damage: [95, 132],emoji: '💧💥', special: true  },
    ],
    sceptile:   [
        { name: 'Leaf Blade',    damage: [62, 88], emoji: '🍃⚔️', special: false },
        { name: 'Detect',        damage: [40, 58], emoji: '👁️🌿', special: false },
        { name: 'Dragon Claw',   damage: [70, 98], emoji: '🐉🌿', special: false },
        { name: 'Frenzy Plant',  damage: [95, 132],emoji: '🌱💥', special: true  },
    ],
    metagross:  [
        { name: 'Meteor Mash',   damage: [78, 108],emoji: '🪐💥', special: false },
        { name: 'Zen Headbutt',  damage: [68, 95], emoji: '🔩🌀', special: false },
        { name: 'Bullet Punch',  damage: [60, 85], emoji: '🔩👊', special: false },
        { name: 'Psychic Fang',  damage: [92, 128],emoji: '🌀🦷', special: true  },
    ],
    
   latios:     [
        { name: 'Luster Purge',  damage: [82, 115],emoji: '💙✨', special: true  },
        { name: 'Dragon Pulse',  damage: [72, 100],emoji: '🐉💙', special: false },
        { name: 'Psychic Boost', damage: [78, 108],emoji: '🌀💙', special: true  },
        { name: 'Mist Ball',     damage: [88, 122],emoji: '🌫️💙', special: true  },
    ],
    latias:     [
        { name: 'Mist Ball',     damage: [80, 112],emoji: '🌫️❤️', special: true  },
        { name: 'Charm',         damage: [55, 78], emoji: '💕🐉', special: false },
        { name: 'Draco Meteor',  damage: [88, 122],emoji: '🌠❤️', special: true  },
        { name: 'Dragon Breath', damage: [68, 95], emoji: '🐉❤️', special: false },
    ],
    giratina:   [
        { name: 'Shadow Force',  damage: [102,142],emoji: '👻🌑', special: true  },
        { name: 'Aura Sphere',   damage: [85, 118],emoji: '✨🔮', special: true  },
        { name: 'Dragon Pulse',  damage: [78, 108],emoji: '🐉🌑', special: false },
        { name: 'Ancient Power', damage: [72, 100],emoji: '🪨⚫', special: false },
    ],
    dialga:     [
        { name: 'Roar of Time',  damage: [108,150],emoji: '⏱️🐉', special: true  },
        { name: 'Metal Burst',   damage: [88, 122],emoji: '🔩💥', special: true  },
        { name: 'Dragon Claw',   damage: [78, 108],emoji: '🐉⏰', special: false },
        { name: 'Flash Cannon',  damage: [82, 115],emoji: '💡🔷', special: true  },
    ],
    palkia:     [
        { name: 'Spacial Rend',  damage: [108,148],emoji: '🌌🔱', special: true  },
        { name: 'Hydro Pump',    damage: [88, 120],emoji: '🌊🔱', special: true  },
        { name: 'Dragon Pulse',  damage: [80, 112],emoji: '🐉🌌', special: false },
        { name: 'Aqua Ring',     damage: [72, 100],emoji: '💧🔱', special: false },
    ],
    reshiram:   [
        { name: 'Blue Flare',    damage: [112,155],emoji: '🔥💙', special: true  },
        { name: 'Fusion Flare',  damage: [98, 138],emoji: '🔥⚪', special: true  },
        { name: 'Dragon Breath', damage: [80, 112],emoji: '🐉🔥', special: false },
        { name: 'Hyper Voice',   damage: [75, 105],emoji: '📣🔥', special: false },
    ],
    zekrom:     [
        { name: 'Bolt Strike',   damage: [112,155],emoji: '⚡🔱', special: true  },
        { name: 'Fusion Bolt',   damage: [98, 138],emoji: '⚡⚫', special: true  },
        { name: 'Dragon Claw',   damage: [80, 112],emoji: '🐉⚡', special: false },
        { name: 'Outrage',       damage: [88, 122],emoji: '💢⚡', special: false },
    ],
    kyurem:     [
        { name: 'Ice Burn',      damage: [108,148],emoji: '🔥🧊', special: true  },
        { name: 'Freeze Shock',  damage: [102,142],emoji: '❄️⚡', special: true  },
        { name: 'Dragon Pulse',  damage: [82, 115],emoji: '🐉❄️', special: false },
        { name: 'Glaciate',      damage: [88, 122],emoji: '🧊💨', special: true  },
    ],
    xerneas:    [
        { name: 'Geomancy',      damage: [95, 132],emoji: '🌺🌟', special: true  },
        { name: 'Moonblast',     damage: [88, 122],emoji: '🌙✨', special: true  },
        { name: 'Fairy Wind',    damage: [72, 100],emoji: '🌸💨', special: false },
        { name: 'Close Combat',  damage: [80, 112],emoji: '🦌💥', special: false },
    ],
    yveltal:    [
        { name: 'Oblivion Wing', damage: [108,148],emoji: '🌑🦅', special: true  },
        { name: 'Dark Pulse',    damage: [85, 118],emoji: '🌑💜', special: false },
        { name: 'Sky Attack',    damage: [80, 112],emoji: '☁️⚫', special: false },
        { name: 'Death Wing',    damage: [98, 138],emoji: '💀🦅', special: true  },
    ],
    zygarde:    [
        { name: 'Land\'s Wrath', damage: [102,142],emoji: '🌍🐍', special: true  },
        { name: 'Thousand Arrows',damage: [92,128],emoji: '🏹🌿', special: true  },
        { name: 'Dragon Pulse',  damage: [78, 108],emoji: '🐉🌿', special: false },
        { name: 'Core Enforcer', damage: [98, 138],emoji: '🌟🐍', special: true  },
    ],
    solgaleo:   [
        { name: 'Sunsteel Strike',damage: [112,155],emoji: '☀️🦁', special: true  },
        { name: 'Zen Headbutt',  damage: [85, 118],emoji: '🌀🦁', special: false },
        { name: 'Solar Blade',   damage: [98, 138],emoji: '☀️⚔️', special: true  },
        { name: 'Full Metal Body',damage: [80, 112],emoji: '🔩🦁', special: false },
    ],
    lunala:     [
        { name: 'Moongeist Beam',damage: [112,155],emoji: '🌙🦇', special: true  },
        { name: 'Shadow Ray',    damage: [98, 138],emoji: '👻🌙', special: true  },
        { name: 'Moonblast',     damage: [85, 118],emoji: '🌙✨', special: false },
        { name: 'Phantom Force', damage: [80, 112],emoji: '👻💜', special: false },
    ],
    necrozma:   [
        { name: 'Prismatic Laser',damage: [118,162],emoji: '🌈🔱', special: true  },
        { name: 'Photon Geyser', damage: [105,145],emoji: '💡💥', special: true  },
        { name: 'Power Gem',     damage: [88, 122],emoji: '💎⚡', special: false },
        { name: 'Searing Light', damage: [95, 132],emoji: '☀️🔱', special: true  },
    ],
    zacian:     [
        { name: 'Behemoth Blade',damage: [118,162],emoji: '⚔️🌸', special: true  },
        { name: 'Play Rough',    damage: [88, 122],emoji: '🐾💕', special: false },
        { name: 'Sacred Sword',  damage: [98, 138],emoji: '⚔️✨', special: true  },
        { name: 'Iron Head',     damage: [82, 115],emoji: '🔩👑', special: false },
    ],
    zamazenta:  [
        { name: 'Behemoth Bash', damage: [118,162],emoji: '🛡️💙', special: true  },
        { name: 'Close Combat',  damage: [88, 122],emoji: '👊🛡️', special: false },
        { name: 'Sacred Sword',  damage: [95, 132],emoji: '⚔️🔵', special: true  },
        { name: 'Body Press',    damage: [82, 115],emoji: '💪🔵', special: false },
    ],
};

// Default moves for wild/unconfigured Pokémon
const DEFAULT_MOVES = [
    { name: 'Tackle',    damage: [15, 30], emoji: '💪', special: false },
    { name: 'Scratch',   damage: [20, 35], emoji: '✋', special: false },
    { name: 'Growl',     damage: [10, 20], emoji: '😾', special: false },
    { name: 'Quick Hit', damage: [25, 40], emoji: '💨', special: false },
];

function xpRequiredForLevel(level) {
    const lv = Math.max(1, Number(level) || 1);
    return Math.floor(100 * Math.pow(1.25, lv - 1));
}
function addPokemonXp(pokemon, amount) {
    if (!pokemon) return { gained: 0, levels: 0, oldLevel: 1, newLevel: 1 };
    const gained = Math.max(0, Math.floor(Number(amount) || 0));
    const oldLevel = Math.max(1, Number(pokemon.level) || 1);
    pokemon.level = oldLevel; pokemon.xp = Math.max(0, Number(pokemon.xp) || 0);
    pokemon.maxXp = xpRequiredForLevel(pokemon.level);
    pokemon.xp += gained; let levels = 0;
    while (pokemon.xp >= pokemon.maxXp) {
        pokemon.xp -= pokemon.maxXp; pokemon.level += 1; levels += 1;
        const hpGain = Math.max(3, Math.floor((pokemon.maxHp || 50) * 0.06));
        const atkGain = Math.max(2, Math.floor((pokemon.atk || 50) * 0.05));
        pokemon.maxHp = (pokemon.maxHp || 50) + hpGain; pokemon.hp = Math.min(pokemon.maxHp, (pokemon.hp || 0) + hpGain); pokemon.atk = (pokemon.atk || 50) + atkGain;
        pokemon.maxXp = xpRequiredForLevel(pokemon.level);
    }
    return { gained, levels, oldLevel, newLevel: pokemon.level };
}
function xpForWildPokemon(wild) { return ({ Weak:20, Common:35, Rare:60, Epic:90, Legendary:140, Mythical:180 })[wild?.rarity] || 30; }
function getPokemonXpLine(pokemon) { const lv=Math.max(1,Number(pokemon?.level)||1), xp=Math.max(0,Number(pokemon?.xp)||0); return `Lv.${lv} • XP ${xp}/${xpRequiredForLevel(lv)}`; }

function getMovesForPokemon(pokeName) {
    return POKEMON_MOVES[pokeName.toLowerCase()] || DEFAULT_MOVES;
}

// FIX: battle damage used to be rolled purely from the move's fixed range and
// completely ignored the attacker's ATK stat — so ATK gained from food, level-ups,
// or drink buffs had zero effect on actual damage dealt. This scales the rolled
// damage by the attacker's ATK relative to the 50-point baseline every Pokémon
// starts at, clamped so a single stat can't trivialize or nullify a fight.
function rollMoveDamage(move, attackerAtk) {
    const base = Math.floor(Math.random() * (move.damage[1] - move.damage[0] + 1)) + move.damage[0];
    const atkMultiplier = Math.max(0.6, Math.min(2.2, (Number(attackerAtk) || 50) / 50));
    return Math.max(1, Math.round(base * atkMultiplier));
}

// ── WILD POKÉMON POOL ─────────────────────────────────────────────────────────
const WILD_POKEMON_POOL = [
    // ── WEAK (easy first catches for new players) ──────────────────────────────
    { name: 'Rattata',     hp: 30,  atk: 35,  emoji: '🐭',   dexId: 19,  rarity: 'Weak', category: 'Normal'   },
    { name: 'Pidgey',      hp: 40,  atk: 40,  emoji: '🐦',   dexId: 16,  rarity: 'Weak', category: 'Normal'   },
    { name: 'Meowth',      hp: 40,  atk: 42,  emoji: '🐱',   dexId: 52,  rarity: 'Weak', category: 'Normal'   },
    { name: 'Caterpie',    hp: 28,  atk: 25,  emoji: '🐛',   dexId: 10,  rarity: 'Weak', category: 'Normal'   },
    { name: 'Weedle',      hp: 28,  atk: 28,  emoji: '🐝',   dexId: 13,  rarity: 'Weak', category: 'Poison'   },
    { name: 'Magikarp',    hp: 20,  atk: 10,  emoji: '🐟',   dexId: 129, rarity: 'Weak', category: 'Water'    },
    { name: 'Zubat',       hp: 35,  atk: 38,  emoji: '🦇',   dexId: 41,  rarity: 'Weak', category: 'Poison'   },
    { name: 'Spearow',     hp: 38,  atk: 40,  emoji: '🦅',   dexId: 21,  rarity: 'Weak', category: 'Normal'   },
    { name: 'Ekans',       hp: 35,  atk: 38,  emoji: '🐍',   dexId: 23,  rarity: 'Weak', category: 'Poison'   },
    { name: 'Sandshrew',   hp: 42,  atk: 40,  emoji: '🐾',   dexId: 27,  rarity: 'Weak', category: 'Ground'   },
    { name: 'Jigglypuff',  hp: 55,  atk: 30,  emoji: '🌸',   dexId: 39,  rarity: 'Weak', category: 'Normal'   },
    { name: 'Oddish',      hp: 38,  atk: 32,  emoji: '🌿',   dexId: 43,  rarity: 'Weak', category: 'Grass'    },
    { name: 'Paras',       hp: 35,  atk: 35,  emoji: '🍄🦀', dexId: 46,  rarity: 'Weak', category: 'Bug'      },
    { name: 'Venonat',     hp: 38,  atk: 35,  emoji: '🪲',   dexId: 48,  rarity: 'Weak', category: 'Bug'      },
    { name: 'Diglett',     hp: 25,  atk: 42,  emoji: '⛏️',   dexId: 50,  rarity: 'Weak', category: 'Ground'   },
    { name: 'Poliwag',     hp: 40,  atk: 35,  emoji: '🌀🐟', dexId: 60,  rarity: 'Weak', category: 'Water'    },
    { name: 'Bellsprout',  hp: 35,  atk: 40,  emoji: '🪴',   dexId: 69,  rarity: 'Weak', category: 'Grass'    },
    { name: 'Slowpoke',    hp: 60,  atk: 25,  emoji: '🌸🐷', dexId: 79,  rarity: 'Weak', category: 'Water'    },
    { name: 'Seel',        hp: 45,  atk: 32,  emoji: '🦭',   dexId: 86,  rarity: 'Weak', category: 'Water'    },
    { name: 'Shellder',    hp: 30,  atk: 40,  emoji: '🐚',   dexId: 90,  rarity: 'Weak', category: 'Water'    },
    { name: 'Krabby',      hp: 30,  atk: 45,  emoji: '🦀',   dexId: 98,  rarity: 'Weak', category: 'Water'    },
    { name: 'Voltorb',     hp: 40,  atk: 42,  emoji: '💣',   dexId: 100, rarity: 'Weak', category: 'Electric' },
    { name: 'Exeggcute',   hp: 35,  atk: 30,  emoji: '🥚',   dexId: 102, rarity: 'Weak', category: 'Grass'    },
    { name: 'Cubone',      hp: 50,  atk: 35,  emoji: '💀',   dexId: 104, rarity: 'Weak', category: 'Ground'   },
    { name: 'Hoothoot',    hp: 45,  atk: 32,  emoji: '🦉',   dexId: 163, rarity: 'Weak', category: 'Normal'   },
    { name: 'Ledyba',      hp: 40,  atk: 28,  emoji: '🐞',   dexId: 165, rarity: 'Weak', category: 'Bug'      },
    { name: 'Spinarak',    hp: 38,  atk: 30,  emoji: '🕷️',   dexId: 167, rarity: 'Weak', category: 'Bug'      },
    { name: 'Sentret',     hp: 42,  atk: 38,  emoji: '🦡',   dexId: 161, rarity: 'Weak', category: 'Normal'   },
    { name: 'Wooper',      hp: 50,  atk: 28,  emoji: '💧🦎', dexId: 194, rarity: 'Weak', category: 'Water'    },
    { name: 'Swinub',      hp: 50,  atk: 38,  emoji: '🐷❄️', dexId: 220, rarity: 'Weak', category: 'Ice'      },
    { name: 'Wurmple',     hp: 35,  atk: 28,  emoji: '🐛',   dexId: 265, rarity: 'Weak', category: 'Bug'      },
    { name: 'Zigzagoon',   hp: 40,  atk: 35,  emoji: '🦝',   dexId: 263, rarity: 'Weak', category: 'Normal'   },
    { name: 'Bidoof',      hp: 55,  atk: 30,  emoji: '🦫',   dexId: 399, rarity: 'Weak', category: 'Normal'   },
    { name: 'Starly',      hp: 40,  atk: 42,  emoji: '⭐🐦', dexId: 396, rarity: 'Weak', category: 'Normal'   },
    { name: 'Shinx',       hp: 42,  atk: 45,  emoji: '⚡🦁', dexId: 403, rarity: 'Weak', category: 'Electric' },
    { name: 'Buizel',      hp: 45,  atk: 42,  emoji: '🌊🦦', dexId: 418, rarity: 'Weak', category: 'Water'    },

    // ── COMMON ────────────────────────────────────────────────────────────────
    { name: 'Psyduck',     hp: 50,  atk: 52,  emoji: '🦆',   dexId: 54,  rarity: 'Common', category: 'Water'    },
    { name: 'Growlithe',   hp: 55,  atk: 70,  emoji: '🐕',   dexId: 58,  rarity: 'Common', category: 'Fire'     },
    { name: 'Abra',        hp: 25,  atk: 55,  emoji: '🔮',   dexId: 63,  rarity: 'Common', category: 'Psychic'  },
    { name: 'Machop',      hp: 70,  atk: 80,  emoji: '💪',   dexId: 66,  rarity: 'Common', category: 'Fighting' },
    { name: 'Totodile',    hp: 50,  atk: 65,  emoji: '🐊',   dexId: 158, rarity: 'Common', category: 'Water'    },
    { name: 'Cyndaquil',   hp: 45,  atk: 60,  emoji: '🔥🦔', dexId: 155, rarity: 'Common', category: 'Fire'     },
    { name: 'Chikorita',   hp: 45,  atk: 49,  emoji: '🌿',   dexId: 152, rarity: 'Common', category: 'Grass'    },
    { name: 'Sudowoodo',   hp: 70,  atk: 65,  emoji: '🪨🌳', dexId: 185, rarity: 'Common', category: 'Rock'     },
    { name: 'Marill',      hp: 70,  atk: 20,  emoji: '🐭💧', dexId: 183, rarity: 'Common', category: 'Water'    },
    { name: 'Aipom',       hp: 55,  atk: 70,  emoji: '🐒',   dexId: 190, rarity: 'Common', category: 'Normal'   },
    { name: 'Misdreavus',  hp: 60,  atk: 85,  emoji: '👻💜', dexId: 200, rarity: 'Common', category: 'Ghost'    },
    { name: 'Snubbull',    hp: 60,  atk: 80,  emoji: '🐶💕', dexId: 209, rarity: 'Common', category: 'Normal'   },
    { name: 'Treecko',     hp: 40,  atk: 55,  emoji: '🌿🦎', dexId: 252, rarity: 'Common', category: 'Grass'    },
    { name: 'Torchic',     hp: 40,  atk: 60,  emoji: '🐤🔥', dexId: 255, rarity: 'Common', category: 'Fire'     },
    { name: 'Mudkip',      hp: 50,  atk: 55,  emoji: '💧🐸', dexId: 258, rarity: 'Common', category: 'Water'    },
    { name: 'Poochyena',   hp: 45,  atk: 55,  emoji: '🐺',   dexId: 261, rarity: 'Common', category: 'Dark'     },
    { name: 'Lotad',       hp: 40,  atk: 40,  emoji: '🍃💧', dexId: 270, rarity: 'Common', category: 'Water'    },
    { name: 'Makuhita',    hp: 72,  atk: 60,  emoji: '🥊',   dexId: 296, rarity: 'Common', category: 'Fighting' },
    { name: 'Meditite',    hp: 45,  atk: 55,  emoji: '🧘',   dexId: 307, rarity: 'Common', category: 'Fighting' },
    { name: 'Electrike',   hp: 45,  atk: 58,  emoji: '⚡🐶', dexId: 309, rarity: 'Common', category: 'Electric' },
    { name: 'Roselia',     hp: 50,  atk: 60,  emoji: '🌹',   dexId: 315, rarity: 'Common', category: 'Grass'    },
    { name: 'Spoink',      hp: 60,  atk: 50,  emoji: '🐷🌀', dexId: 325, rarity: 'Common', category: 'Psychic'  },
    { name: 'Trapinch',    hp: 45,  atk: 70,  emoji: '🏜️🦷', dexId: 328, rarity: 'Common', category: 'Ground'   },
    { name: 'Turtwig',     hp: 55,  atk: 55,  emoji: '🐢🌿', dexId: 387, rarity: 'Common', category: 'Grass'    },
    { name: 'Piplup',      hp: 45,  atk: 53,  emoji: '🐧💧', dexId: 393, rarity: 'Common', category: 'Water'    },
    { name: 'Chimchar',    hp: 44,  atk: 58,  emoji: '🐒🔥', dexId: 390, rarity: 'Common', category: 'Fire'     },
    { name: 'Riolu',       hp: 40,  atk: 70,  emoji: '🥋',   dexId: 447, rarity: 'Common', category: 'Fighting' },
    { name: 'Gible',       hp: 58,  atk: 70,  emoji: '🐲🏜️', dexId: 443, rarity: 'Common', category: 'Dragon'   },
    { name: 'Snivy',       hp: 45,  atk: 55,  emoji: '🐍🌿', dexId: 495, rarity: 'Common', category: 'Grass'    },
    { name: 'Tepig',       hp: 55,  atk: 62,  emoji: '🐷🔥', dexId: 498, rarity: 'Common', category: 'Fire'     },
    { name: 'Oshawott',    hp: 55,  atk: 55,  emoji: '🌊🦦', dexId: 501, rarity: 'Common', category: 'Water'    },
    { name: 'Chespin',     hp: 56,  atk: 61,  emoji: '🌰🐾', dexId: 650, rarity: 'Common', category: 'Grass'    },
    { name: 'Fennekin',    hp: 40,  atk: 62,  emoji: '🦊🔥', dexId: 653, rarity: 'Common', category: 'Fire'     },
    { name: 'Froakie',     hp: 41,  atk: 62,  emoji: '🐸💧', dexId: 656, rarity: 'Common', category: 'Water'    },

    // ── RARE ──────────────────────────────────────────────────────────────────
    { name: 'Haunter',     hp: 45,  atk: 85,  emoji: '👻',   dexId: 93,  rarity: 'Rare', category: 'Ghost'    },
    { name: 'Scyther',     hp: 70,  atk: 110, emoji: '🦗',   dexId: 123, rarity: 'Rare', category: 'Bug'      },
    { name: 'Eevee',       hp: 55,  atk: 55,  emoji: '🦊',   dexId: 133, rarity: 'Rare', category: 'Normal'   },
    { name: 'Umbreon',     hp: 95,  atk: 65,  emoji: '🌑🦊', dexId: 197, rarity: 'Rare', category: 'Dark'     },
    { name: 'Espeon',      hp: 65,  atk: 90,  emoji: '🌸🦊', dexId: 196, rarity: 'Rare', category: 'Psychic'  },
    { name: 'Ampharos',    hp: 90,  atk: 85,  emoji: '⚡🐑', dexId: 181, rarity: 'Rare', category: 'Electric' },
    { name: 'Heracross',   hp: 80,  atk: 125, emoji: '🦏🐛', dexId: 214, rarity: 'Rare', category: 'Fighting' },
    { name: 'Sneasel',     hp: 55,  atk: 95,  emoji: '🌑❄️', dexId: 215, rarity: 'Rare', category: 'Dark'     },
    { name: 'Porygon2',    hp: 85,  atk: 80,  emoji: '💻🌀', dexId: 233, rarity: 'Rare', category: 'Normal'   },
    { name: 'Larvitar',    hp: 50,  atk: 64,  emoji: '🪨🦖', dexId: 246, rarity: 'Rare', category: 'Rock'     },
    { name: 'Lucario',     hp: 70,  atk: 115, emoji: '🥋⚡', dexId: 448, rarity: 'Rare', category: 'Fighting' },
    { name: 'Garchomp',    hp: 108, atk: 130, emoji: '🐲🏜️', dexId: 445, rarity: 'Rare', category: 'Dragon'   },
    { name: 'Togekiss',    hp: 85,  atk: 80,  emoji: '🕊️✨', dexId: 468, rarity: 'Rare', category: 'Fairy'    },
    { name: 'Gallade',     hp: 68,  atk: 125, emoji: '⚔️🧘', dexId: 475, rarity: 'Rare', category: 'Psychic'  },
    { name: 'Roserade',    hp: 60,  atk: 125, emoji: '🌹🌙', dexId: 407, rarity: 'Rare', category: 'Grass'    },
    { name: 'Breloom',     hp: 60,  atk: 130, emoji: '🍄🥊', dexId: 286, rarity: 'Rare', category: 'Fighting' },
    { name: 'Banette',     hp: 64,  atk: 115, emoji: '🪡👻', dexId: 354, rarity: 'Rare', category: 'Ghost'    },
    { name: 'Absol',       hp: 65,  atk: 130, emoji: '🌙🗡️', dexId: 359, rarity: 'Rare', category: 'Dark'     },
    { name: 'Flygon',      hp: 80,  atk: 100, emoji: '🐲🏜️', dexId: 330, rarity: 'Rare', category: 'Dragon'   },
    { name: 'Gengar',      hp: 60,  atk: 130, emoji: '👻😈', dexId: 94,  rarity: 'Rare', category: 'Ghost'    },
    { name: 'Zoroark',     hp: 60,  atk: 105, emoji: '🦊🌑', dexId: 571, rarity: 'Rare', category: 'Dark'     },
    { name: 'Bisharp',     hp: 65,  atk: 125, emoji: '⚔️🔪', dexId: 625, rarity: 'Rare', category: 'Dark'     },
    { name: 'Haxorus',     hp: 76,  atk: 147, emoji: '🐉⚔️', dexId: 612, rarity: 'Rare', category: 'Dragon'   },
    { name: 'Hydreigon',   hp: 92,  atk: 125, emoji: '🐉🌑', dexId: 635, rarity: 'Rare', category: 'Dragon'   },
    { name: 'Noivern',     hp: 85,  atk: 70,  emoji: '🦇🐉', dexId: 715, rarity: 'Rare', category: 'Dragon'   },
    { name: 'Goodra',      hp: 90,  atk: 100, emoji: '🌧️🐉', dexId: 706, rarity: 'Rare', category: 'Dragon'   },

    // ── EPIC ──────────────────────────────────────────────────────────────────
    { name: 'Snorlax',     hp: 160, atk: 110, emoji: '😴',   dexId: 143, rarity: 'Epic', category: 'Normal'  },
    { name: 'Dragonite',   hp: 91,  atk: 134, emoji: '🐲',   dexId: 149, rarity: 'Epic', category: 'Dragon'  },
    { name: 'Alakazam',    hp: 55,  atk: 50,  emoji: '🥄',   dexId: 65,  rarity: 'Epic', category: 'Psychic' },
    { name: 'Tyranitar',   hp: 100, atk: 134, emoji: '🦖',   dexId: 248, rarity: 'Epic', category: 'Dark'    },
    { name: 'Blaziken',    hp: 80,  atk: 120, emoji: '🔥🐓', dexId: 257, rarity: 'Epic', category: 'Fire'    },
    { name: 'Swampert',    hp: 100, atk: 110, emoji: '🌊🐊', dexId: 260, rarity: 'Epic', category: 'Water'   },
    { name: 'Sceptile',    hp: 70,  atk: 105, emoji: '🌿🦎', dexId: 254, rarity: 'Epic', category: 'Grass'   },
    { name: 'Metagross',   hp: 80,  atk: 135, emoji: '🔩🌀', dexId: 376, rarity: 'Epic', category: 'Steel'   },
    { name: 'Salamence',   hp: 95,  atk: 135, emoji: '🐉🔵', dexId: 373, rarity: 'Epic', category: 'Dragon'  },
    { name: 'Milotic',     hp: 95,  atk: 60,  emoji: '🌊🐍', dexId: 350, rarity: 'Epic', category: 'Water'   },
    { name: 'Infernape',   hp: 76,  atk: 104, emoji: '🔥🐒', dexId: 392, rarity: 'Epic', category: 'Fire'    },
    { name: 'Empoleon',    hp: 84,  atk: 86,  emoji: '🐧⚔️', dexId: 395, rarity: 'Epic', category: 'Water'   },
    { name: 'Torterra',    hp: 95,  atk: 109, emoji: '🐢🌳', dexId: 389, rarity: 'Epic', category: 'Grass'   },
    { name: 'Electivire',  hp: 75,  atk: 123, emoji: '⚡💪', dexId: 466, rarity: 'Epic', category: 'Electric'},
    { name: 'Magmortar',   hp: 75,  atk: 125, emoji: '🔥🦾', dexId: 467, rarity: 'Epic', category: 'Fire'    },
    { name: 'Rhyperior',   hp: 115, atk: 140, emoji: '🪨🦏', dexId: 464, rarity: 'Epic', category: 'Rock'    },
    { name: 'Serperior',   hp: 75,  atk: 75,  emoji: '🐍👑', dexId: 497, rarity: 'Epic', category: 'Grass'   },
    { name: 'Emboar',      hp: 110, atk: 123, emoji: '🐷🔥', dexId: 500, rarity: 'Epic', category: 'Fire'    },
    { name: 'Samurott',    hp: 95,  atk: 100, emoji: '🌊⚔️', dexId: 503, rarity: 'Epic', category: 'Water'   },
    { name: 'Volcarona',   hp: 85,  atk: 135, emoji: '🔥🦋', dexId: 637, rarity: 'Epic', category: 'Fire'    },
    { name: 'Greninja',    hp: 72,  atk: 95,  emoji: '🐸🌊', dexId: 658, rarity: 'Epic', category: 'Water'   },
    { name: 'Chesnaught',  hp: 88,  atk: 107, emoji: '🌰🛡️', dexId: 652, rarity: 'Epic', category: 'Grass'   },
    { name: 'Delphox',     hp: 75,  atk: 114, emoji: '🦊🔥', dexId: 655, rarity: 'Epic', category: 'Fire'    },

    // ── LEGENDARY ─────────────────────────────────────────────────────────────
    { name: 'Articuno',    hp: 90,  atk: 85,  emoji: '🧊',   dexId: 144, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zapdos',      hp: 90,  atk: 90,  emoji: '⚡',   dexId: 145, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Moltres',     hp: 90,  atk: 100, emoji: '🔥',   dexId: 146, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Latios',      hp: 80,  atk: 130, emoji: '💙🐉', dexId: 381, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Latias',      hp: 80,  atk: 110, emoji: '❤️🐉', dexId: 380, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Groudon',     hp: 100, atk: 150, emoji: '🌋🔴', dexId: 383, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Kyogre',      hp: 100, atk: 150, emoji: '🌊🔵', dexId: 382, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Giratina',    hp: 150, atk: 100, emoji: '👻🐉', dexId: 487, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Dialga',      hp: 100, atk: 120, emoji: '⏱️🐉', dexId: 483, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Palkia',      hp: 90,  atk: 120, emoji: '🌌🐉', dexId: 484, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Reshiram',    hp: 100, atk: 150, emoji: '🔥⚪', dexId: 643, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zekrom',      hp: 100, atk: 150, emoji: '⚡⚫', dexId: 644, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Kyurem',      hp: 125, atk: 130, emoji: '❄️🐉', dexId: 646, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Xerneas',     hp: 126, atk: 131, emoji: '🌺🦌', dexId: 716, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Yveltal',     hp: 126, atk: 131, emoji: '🌑🦅', dexId: 717, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zygarde',     hp: 216, atk: 100, emoji: '🌿🐍', dexId: 718, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Solgaleo',    hp: 137, atk: 137, emoji: '☀️🦁', dexId: 791, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Lunala',      hp: 137, atk: 137, emoji: '🌙🦇', dexId: 792, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zacian',      hp: 92,  atk: 170, emoji: '⚔️🐺', dexId: 888, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Zamazenta',   hp: 92,  atk: 130, emoji: '🛡️🐺', dexId: 889, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Mewtwo',      hp: 106, atk: 154, emoji: '🧬🐱', dexId: 150, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Lugia',       hp: 106, atk: 90,  emoji: '🌊🦅', dexId: 249, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Eternatus',   hp: 140, atk: 145, emoji: '☠️🐉', dexId: 890, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Ho-Oh',       hp: 106, atk: 130, emoji: '🌈🦅', dexId: 250, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Rayquaza',    hp: 105, atk: 150, emoji: '🌌🐉', dexId: 384, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Heatran',     hp: 91,  atk: 130, emoji: '🔥🏔️', dexId: 485, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Regigigas',   hp: 110, atk: 160, emoji: '🗿💪', dexId: 486, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Cobalion',    hp: 91,  atk: 90,  emoji: '⚔️💎', dexId: 638, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Terrakion',   hp: 91,  atk: 129, emoji: '🪨⚔️', dexId: 639, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Virizion',    hp: 91,  atk: 90,  emoji: '🌿⚔️', dexId: 640, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Tornadus',    hp: 79,  atk: 115, emoji: '🌪️',   dexId: 641, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Thundurus',   hp: 79,  atk: 115, emoji: '⚡🌩️', dexId: 642, rarity: 'Legendary', category: 'Legendary' },
    { name: 'Landorus',    hp: 89,  atk: 145, emoji: '🏔️💨', dexId: 645, rarity: 'Legendary', category: 'Legendary' },

    // ── MYTHICAL ─────────────────────────────────────────────────────────────
    { name: 'Mew',         hp: 100, atk: 100, emoji: '🌟🐱', dexId: 151, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Celebi',      hp: 100, atk: 100, emoji: '🌿✨', dexId: 251, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Jirachi',     hp: 100, atk: 100, emoji: '⭐🔱', dexId: 385, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Deoxys',      hp: 50,  atk: 180, emoji: '👾🌌', dexId: 386, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Darkrai',     hp: 70,  atk: 135, emoji: '🌑😈', dexId: 491, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Shaymin',     hp: 100, atk: 100, emoji: '🌸🦔', dexId: 492, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Victini',     hp: 100, atk: 100, emoji: '🔥✌️', dexId: 494, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Genesect',    hp: 71,  atk: 120, emoji: '🔩🦟', dexId: 649, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Necrozma',    hp: 97,  atk: 107, emoji: '🌈🔱', dexId: 800, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Arceus',      hp: 120, atk: 120, emoji: '🌟🐴', dexId: 493, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Hoopa',       hp: 80,  atk: 110, emoji: '🌀👺', dexId: 720, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Marshadow',   hp: 90,  atk: 125, emoji: '👊🌑', dexId: 802, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Zeraora',     hp: 88,  atk: 112, emoji: '⚡🐯', dexId: 807, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Meltan',      hp: 46,  atk: 65,  emoji: '🔩🥣', dexId: 808, rarity: 'Mythical', category: 'Mythical' },
    { name: 'Melmetal',    hp: 135, atk: 143, emoji: '🔩💀', dexId: 809, rarity: 'Mythical', category: 'Mythical' },
];

// ── BASE-FORM STARTERS (catchable in the wild, feed into evolution chains) ─────
WILD_POKEMON_POOL.push(
    { name: 'Pikachu',    hp: 55,  atk: 65,  emoji: '⚡🐭', dexId: 25,  rarity: 'Common', category: 'Electric' },
    { name: 'Charmander', hp: 50,  atk: 62,  emoji: '🔥🦎', dexId: 4,   rarity: 'Common', category: 'Fire' },
);

// ── EVOLVED FORMS ────────────────────────────────────────────────────────────
// Obtainable in the wild directly (one rarity tier above their base form) OR by
// using an Evolution Stone on a matching base-form Pokémon with `.evolve <name>`.
WILD_POKEMON_POOL.push(
    { name: 'Raichu',     hp: 80,  atk: 100, emoji: '⚡🐹',dexId: 26,  rarity: 'Rare',   category: 'Electric' },
    { name: 'Charmeleon', hp: 70,  atk: 88,  emoji: '🔥🦎',dexId: 5,   rarity: 'Rare',   category: 'Fire'     },
    { name: 'Charizard',  hp: 95,  atk: 130, emoji: '🔥🐉',dexId: 6,   rarity: 'Epic',   category: 'Fire'     },
    { name: 'Raticate',   hp: 55,  atk: 82,  emoji: '🐀',   dexId: 20,  rarity: 'Common', category: 'Normal'  },
    { name: 'Pidgeotto',  hp: 63,  atk: 68,  emoji: '🐦',   dexId: 17,  rarity: 'Common', category: 'Normal'  },
    { name: 'Pidgeot',    hp: 83,  atk: 100, emoji: '🐦',   dexId: 18,  rarity: 'Rare',   category: 'Normal'  },
    { name: 'Persian',    hp: 65,  atk: 78,  emoji: '🐱',   dexId: 53,  rarity: 'Common', category: 'Normal'  },
    { name: 'Golbat',     hp: 75,  atk: 80,  emoji: '🦇',   dexId: 42,  rarity: 'Common', category: 'Poison'  },
    { name: 'Crobat',     hp: 85,  atk: 105, emoji: '🦇',   dexId: 169, rarity: 'Rare',   category: 'Poison'  },
    { name: 'Arcanine',   hp: 90,  atk: 115, emoji: '🐕‍🦺', dexId: 59,  rarity: 'Rare',   category: 'Fire'     },
    { name: 'Machoke',    hp: 90,  atk: 105, emoji: '💪',   dexId: 67,  rarity: 'Common', category: 'Fighting'},
    { name: 'Machamp',    hp: 105, atk: 135, emoji: '💪',   dexId: 68,  rarity: 'Rare',   category: 'Fighting'},
    { name: 'Kadabra',    hp: 40,  atk: 35,  emoji: '🔮',   dexId: 64,  rarity: 'Common', category: 'Psychic' },
    { name: 'Croconaw',   hp: 70,  atk: 85,  emoji: '🐊',   dexId: 159, rarity: 'Common', category: 'Water'   },
    { name: 'Feraligatr', hp: 95,  atk: 118, emoji: '🐊',   dexId: 160, rarity: 'Rare',   category: 'Water'   },
    { name: 'Quilava',    hp: 65,  atk: 82,  emoji: '🔥🦔', dexId: 156, rarity: 'Common', category: 'Fire'    },
    { name: 'Typhlosion', hp: 90,  atk: 118, emoji: '🔥🦔', dexId: 157, rarity: 'Rare',   category: 'Fire'    },
    { name: 'Bayleef',    hp: 65,  atk: 68,  emoji: '🌿',   dexId: 153, rarity: 'Common', category: 'Grass'   },
    { name: 'Meganium',   hp: 90,  atk: 82,  emoji: '🌿🌸', dexId: 154, rarity: 'Rare',   category: 'Grass'   },
    { name: 'Golduck',    hp: 75,  atk: 82,  emoji: '🦆',   dexId: 55,  rarity: 'Common', category: 'Water'   },
    { name: 'Granbull',   hp: 85,  atk: 105, emoji: '🐶💕', dexId: 210, rarity: 'Common', category: 'Normal'  },
    { name: 'Mismagius',  hp: 70,  atk: 105, emoji: '👻💜', dexId: 429, rarity: 'Rare',   category: 'Ghost'   },
    { name: 'Ambipom',    hp: 70,  atk: 95,  emoji: '🐒',   dexId: 424, rarity: 'Common', category: 'Normal'  },
    { name: 'Weavile',    hp: 70,  atk: 130, emoji: '🌑❄️', dexId: 461, rarity: 'Rare',   category: 'Dark'    },
    { name: 'Pupitar',    hp: 70,  atk: 84,  emoji: '🪨🦖', dexId: 247, rarity: 'Common', category: 'Rock'    },
    { name: 'Scizor',     hp: 70,  atk: 130, emoji: '🦗🔩', dexId: 212, rarity: 'Rare',   category: 'Steel'   },
    { name: 'Porygon-Z',  hp: 85,  atk: 135, emoji: '💻🌀', dexId: 474, rarity: 'Rare',   category: 'Normal'  },
);

// ── EXTRA POKÉMON ─────────────────────────────────────────────────────────────
// Additional catchable Pokémon. They use DEFAULT_MOVES until custom moves are configured.
WILD_POKEMON_POOL.push(
    { name: 'Elekid',      hp: 45,  atk: 62,  emoji: '⚡👶', dexId: 239, rarity: 'Common', category: 'Electric' },
    { name: 'Magby',       hp: 45,  atk: 64,  emoji: '🔥👶', dexId: 240, rarity: 'Common', category: 'Fire' },
    { name: 'Swablu',      hp: 55,  atk: 45,  emoji: '☁️🐦', dexId: 333, rarity: 'Common', category: 'Flying' },
    { name: 'Mawile',      hp: 70,  atk: 78,  emoji: '🧚‍♀️🦷', dexId: 303, rarity: 'Rare', category: 'Steel' },
    { name: 'Rotom',       hp: 65,  atk: 95,  emoji: '⚡👻', dexId: 479, rarity: 'Rare', category: 'Electric' },
    { name: 'Litwick',     hp: 50,  atk: 70,  emoji: '🕯️👻', dexId: 607, rarity: 'Common', category: 'Ghost' },
    { name: 'Mimikyu',     hp: 75,  atk: 105, emoji: '👻🎭', dexId: 778, rarity: 'Epic', category: 'Ghost' },
    { name: 'Axew',        hp: 55,  atk: 88,  emoji: '🦎🪓', dexId: 610, rarity: 'Rare', category: 'Dragon' },
    { name: 'Rookidee',    hp: 45,  atk: 58,  emoji: '🐦⚫', dexId: 821, rarity: 'Common', category: 'Flying' },
    { name: 'Yamper',      hp: 55,  atk: 72,  emoji: '⚡🐕', dexId: 835, rarity: 'Common', category: 'Electric' },
    { name: 'Snom',        hp: 42,  atk: 38,  emoji: '❄️🐛', dexId: 872, rarity: 'Weak', category: 'Ice' },
    { name: 'Dreepy',      hp: 48,  atk: 82,  emoji: '👻🐉', dexId: 885, rarity: 'Rare', category: 'Dragon' },
    { name: 'Fuecoco',     hp: 62,  atk: 68,  emoji: '🔥🐊', dexId: 909, rarity: 'Common', category: 'Fire' },
    { name: 'Sprigatito',  hp: 50,  atk: 66,  emoji: '🌿🐱', dexId: 906, rarity: 'Common', category: 'Grass' },
    { name: 'Quaxly',      hp: 52,  atk: 64,  emoji: '💧🦆', dexId: 912, rarity: 'Common', category: 'Water' },
    { name: 'Tinkatink',   hp: 55,  atk: 72,  emoji: '🔨🧚', dexId: 957, rarity: 'Rare', category: 'Fairy' },
    { name: 'Frigibax',    hp: 65,  atk: 86,  emoji: '🧊🐉', dexId: 996, rarity: 'Rare', category: 'Dragon' },
    { name: 'Pawmi',       hp: 48,  atk: 70,  emoji: '⚡🐭', dexId: 921, rarity: 'Weak', category: 'Electric' }
);

// ── EVOLUTION CHAINS ─────────────────────────────────────────────────────────
// Used by `.evolve <pokemon>` with an Evolution Stone. Base name (lowercase) -> next form.
// Stats for the evolved form are pulled live from WILD_POKEMON_POOL above.
const EVOLUTION_MAP = {
    pikachu:    'Raichu',
    charmander: 'Charmeleon',
    charmeleon: 'Charizard',
    rattata:    'Raticate',
    pidgey:     'Pidgeotto',
    pidgeotto:  'Pidgeot',
    meowth:     'Persian',
    zubat:      'Golbat',
    golbat:     'Crobat',
    growlithe:  'Arcanine',
    machop:     'Machoke',
    machoke:    'Machamp',
    abra:       'Kadabra',
    kadabra:    'Alakazam',
    totodile:   'Croconaw',
    croconaw:   'Feraligatr',
    cyndaquil:  'Quilava',
    quilava:    'Typhlosion',
    chikorita:  'Bayleef',
    bayleef:    'Meganium',
    psyduck:    'Golduck',
    snubbull:   'Granbull',
    misdreavus: 'Mismagius',
    aipom:      'Ambipom',
    sneasel:    'Weavile',
    larvitar:   'Pupitar',
    pupitar:    'Tyranitar',
    scyther:    'Scizor',
    porygon2:   'Porygon-Z',
};

// ── FISH SELL PRICES ──────────────────────────────────────────────────────────
const FISH_SELL_PRICES = {
    fish:       { key: 'fish',      price: 200,  name: 'Standard Minnow Fish', emoji: '🐟' },
    salmon:     { key: 'salmon',    price: 800,  name: 'Premium Salmon',       emoji: '🐟' },
    goldenfish: { key: 'goldenFish',price: 5000, name: 'Legendary Golden Fish', emoji: '✨🐟' },
    golden:     { key: 'goldenFish',price: 5000, name: 'Legendary Golden Fish', emoji: '✨🐟' },
};

// ── AMAZON BAGS ───────────────────────────────────────────────────────────────
const AMAZON_BAGS = {
    tote:              { name: 'Canvas Tote Bag 🛍️',        price: 5000,     emoji: '🛍️', desc: 'Basic everyday carry. Simple but honest.' },
    skybag:            { name: 'Skybag Traveller 🎒',        price: 25000,    emoji: '🎒', desc: 'Great for trips and daily use.' },
    safari:            { name: 'Safari Duffle Bag 🟤',       price: 50000,    emoji: '🟤', desc: 'Rugged and spacious. Adventure-ready.' },
    aristocrat:        { name: 'Aristocrat Suitcase 🧳',     price: 55000,    emoji: '🧳', desc: 'Premium hard-shell luggage.' },
    americantourister: { name: 'American Tourister ✈️',      price: 75000,    emoji: '✈️', desc: 'Top-tier travel companion. Sleek design.' },
    gucci:             { name: 'Gucci Bag 💼',               price: 100000,   emoji: '💼', desc: 'Luxury fashion statement. Flex on everyone.' },
    hermes:            { name: 'Hermès Birkin 👜',           price: 200000,   emoji: '👜', desc: 'Ultra-rare. The pinnacle of flex culture.' },
};

// ── BANK SYSTEM ──────────────────────────────────────────────────────────────
const BANK_DEFAULT_CAPACITY = 500_000;
const CREDIT_BUILD_MIN_LOAN = 25_000;
const CREDIT_BUILD_MIN_HOLD_MS = 12 * 60 * 60 * 1000;
const CREDIT_BUILD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CREDIT_BUILD_MAX_POSITIVE = 60;


const CAPACITY_PACKAGES = [
    { id: 1,  label: '+500K',  increase: 500_000,      cost: 150_000     },
    { id: 2,  label: '+1M',    increase: 1_000_000,    cost: 450_000     },
    { id: 3,  label: '+5M',    increase: 5_000_000,    cost: 1_500_000   },
    { id: 4,  label: '+10M',   increase: 10_000_000,   cost: 3_000_000   },
    { id: 5,  label: '+50M',   increase: 50_000_000,   cost: 20_000_000  },
    { id: 6,  label: '+100M',  increase: 100_000_000,  cost: 50_000_000  },
    { id: 7,  label: '+500M',  increase: 500_000_000,  cost: 300_000_000 },
    { id: 8,  label: '+1B',    increase: 1_000_000_000,    cost: 700_000_000   },
    { id: 9,  label: '+10B',   increase: 10_000_000_000,   cost: 6_000_000_000 },
    { id: 10, label: '+50B',   increase: 50_000_000_000,   cost: 30_000_000_000 },
];

// ── VIP PASS — for trillionaires ──────────────────────────────────────────────
const VIP_MONTHLY_FEE      = 10_000_000;  // $10M monthly fee
const VIP_DURATION_MS      = 30 * 24 * 60 * 60 * 1000; // 30 days
const VIP_REMINDER_3D_MS   = 3  * 24 * 60 * 60 * 1000; // send reminder at 3 days left
const VIP_REMINDER_1D_MS   = 1  * 24 * 60 * 60 * 1000; // send urgent reminder at 1 day left

const BANK_LOAN_TIERS = [
    {
        label: 'Micro', min: 1_000, max: 50_000, days: 2, interest: 0.05,
        ratings: [
            { maxDays: 2,        label: '⭐ Excellent', creditDelta: +20 },
            { maxDays: 4,        label: '✅ Good',      creditDelta: +10 },
            { maxDays: 6,        label: '🆗 Average',   creditDelta:   0 },
            { maxDays: 8,        label: '⚠️ Late',      creditDelta: -10 },
            { maxDays: Infinity, label: '❌ Defaulted', creditDelta: -30 },
        ],
    },
    {
        label: 'Small', min: 50_001, max: 500_000, days: 4, interest: 0.08,
        ratings: [
            { maxDays: 3,        label: '⭐ Excellent', creditDelta: +25 },
            { maxDays: 5,        label: '✅ Good',      creditDelta: +12 },
            { maxDays: 7,        label: '🆗 Average',   creditDelta:   0 },
            { maxDays: 10,       label: '⚠️ Late',      creditDelta: -15 },
            { maxDays: Infinity, label: '❌ Defaulted', creditDelta: -40 },
        ],
    },
    {
        label: 'Medium', min: 500_001, max: 2_000_000, days: 7, interest: 0.12,
        ratings: [
            { maxDays: 5,        label: '⭐ Excellent', creditDelta: +30 },
            { maxDays: 7,        label: '✅ Good',      creditDelta: +15 },
            { maxDays: 10,       label: '🆗 Average',   creditDelta:   0 },
            { maxDays: 14,       label: '⚠️ Late',      creditDelta: -20 },
            { maxDays: Infinity, label: '❌ Defaulted', creditDelta: -50 },
        ],
    },
    {
        label: 'Large', min: 2_000_001, max: 10_000_000, days: 14, interest: 0.18,
        ratings: [
            { maxDays: 10,       label: '⭐ Excellent', creditDelta: +40 },
            { maxDays: 14,       label: '✅ Good',      creditDelta: +20 },
            { maxDays: 18,       label: '🆗 Average',   creditDelta:   0 },
            { maxDays: 21,       label: '⚠️ Late',      creditDelta: -30 },
            { maxDays: Infinity, label: '❌ Defaulted', creditDelta: -70 },
        ],
    },
    {
        label: 'Elite', min: 10_000_001, max: Infinity, days: 30, interest: 0.25,
        minCredit: 700,
        ratings: [
            { maxDays: 20,       label: '⭐ Excellent', creditDelta: +60 },
            { maxDays: 30,       label: '✅ Good',      creditDelta: +30 },
            { maxDays: 40,       label: '🆗 Average',   creditDelta:   0 },
            { maxDays: 50,       label: '⚠️ Late',      creditDelta: -50 },
            { maxDays: Infinity, label: '❌ Defaulted', creditDelta: -100 },
        ],
    },
];

function getCreditBand(score) {
    if (score >= 800) return { label: '💎 Platinum', maxLoan: Infinity };
    if (score >= 700) return { label: '🥇 Gold',     maxLoan: Infinity };
    if (score >= 550) return { label: '🥈 Silver',   maxLoan: 10_000_000 };
    if (score >= 400) return { label: '🥉 Bronze',   maxLoan: 2_000_000 };
    if (score >= 250) return { label: '📉 Low',      maxLoan: 500_000 };
    return               { label: '🚫 Poor',      maxLoan: 50_000 };
}

function getLoanTier(amount) {
    return BANK_LOAN_TIERS.find(t => amount >= t.min && amount <= t.max) || null;
}

// ── BALANCE-BASED LOAN CAP ────────────────────────────────────────────────────
// Loans are no longer sanctioned purely off credit score / a free first-loan
// bypass. Instead, the max loan a user can take is also capped as a multiple
// of their RECENT AVERAGE balance (wallet+bank), not just their instantaneous
// balance — so stuffing cash into the bank right before requesting a loan
// (then withdrawing it) doesn't game the cap.
const BALANCE_LOAN_MULTIPLIER = 4;      // max loan = up to 4x recent avg balance
const BALANCE_HISTORY_WINDOW_DAYS = 7;  // "recent" = last 7 daily snapshots
const BALANCE_HISTORY_MAX_ENTRIES = 14; // keep a bit of buffer beyond the window

// Record a daily net-worth snapshot for every user (called by a scheduled job).
function recordBalanceSnapshots() {
    const now = Date.now();
    for (const [userId, u] of Object.entries(db)) {
        if (userId.startsWith('_') || !u || typeof u !== 'object' || !u.registered) continue;
        if (!Array.isArray(u.balanceHistory)) u.balanceHistory = [];
        const netWorth = (u.wallet || 0) + (u.bank || 0);
        u.balanceHistory.push({ ts: now, netWorth });
        if (u.balanceHistory.length > BALANCE_HISTORY_MAX_ENTRIES) {
            u.balanceHistory.splice(0, u.balanceHistory.length - BALANCE_HISTORY_MAX_ENTRIES);
        }
    }
    saveDB();
}

// Recent average balance for a single user — average of snapshots taken within
// the last BALANCE_HISTORY_WINDOW_DAYS. Falls back to current net worth if the
// user has no snapshot history yet (e.g. brand new account).
function getRecentAvgBalance(u) {
    const currentNetWorth = (u.wallet || 0) + (u.bank || 0);
    if (!Array.isArray(u.balanceHistory) || u.balanceHistory.length === 0) return currentNetWorth;
    const cutoff = Date.now() - BALANCE_HISTORY_WINDOW_DAYS * 86_400_000;
    const recent = u.balanceHistory.filter(e => e.ts >= cutoff);
    if (recent.length === 0) return currentNetWorth;
    const sum = recent.reduce((acc, e) => acc + (e.netWorth || 0), 0);
    return sum / recent.length;
}

// The actual max loan for a user: the tighter of their credit-band cap and
// their balance-based cap.
function getMaxLoanForUser(u) {
    const band = getCreditBand(u.creditScore);
    const recentAvg = getRecentAvgBalance(u);
    const balanceCap = Math.floor(recentAvg * BALANCE_LOAN_MULTIPLIER);
    return { band, recentAvg, balanceCap, maxLoan: Math.min(band.maxLoan, balanceCap) };
}

// ── LOTTERY ──────────────────────────────────────────────────────────────────
// Players buy a $70K ticket via `.buy lottery`. Once 5 distinct players
// have entered, the draw fires automatically: top 3 entrants (picked at random
// from the 5) win cash prizes from their tier's range, the other 2 get nothing.
// Results are announced in whichever GC a mod has designated via `.lll`
// (falls back to the GC the 5th ticket was bought in if none is set).
const LOTTERY_TICKET_PRICE = 70000;
const LOTTERY_POOL_SIZE    = 5;
const LOTTERY_PRIZES = [
    { place: 1, label: '🥇 1st Place', min: 300000, max: 500000 },
    { place: 2, label: '🥈 2nd Place', min: 160000, max: 200000 },
    { place: 3, label: '🥉 3rd Place', min: 70000,  max: 150000 },
];


// ── COOLDOWNS (seconds) ───────────────────────────────────────────────────────
const CD_DIG = 45, CD_FISH = 45, CD_CASINO = 300, CD_SLOTS = 60,
      CD_DB = 60, CD_ROULETTE = 60, CD_COINFLIP = 60, CD_CHEAT = 600, CD_ROB = 60;

// ── DYNAMIC GAMBLING ODDS ─────────────────────────────────────────────────────
// Each game has a live house-win chance that drifts in the background instead of
// using one fixed percentage forever. Values are persisted so a restart doesn't
// reset the current market.
const GAMBLING_RATE_RANGES = {
    casino:      [38, 38],
    slots:       [30, 30],
    slotsDouble: [0, 0],
    slotsTriple: [30, 30],
    roulette:    [25, 25],
    coinflip:    [25, 25],
    double:      [33, 33],
};
function clampRate(v, range) { return Math.max(range[0], Math.min(range[1], Number(v))); }
function ensureDynamicGamblingRates() {
    if (!db._config.gamblingRates) db._config.gamblingRates = {};
    for (const [key, range] of Object.entries(GAMBLING_RATE_RANGES)) {
        if (!Number.isFinite(Number(db._config.gamblingRates[key]))) {
            db._config.gamblingRates[key] = Number((range[0] + Math.random() * (range[1] - range[0])).toFixed(2));
        }
    }
    return db._config.gamblingRates;
}
function getDynamicGamblingRate(game) {
    const rates = ensureDynamicGamblingRates();
    const range = GAMBLING_RATE_RANGES[game];
    return clampRate(rates[game], range);
}
function driftGamblingRates() {
    const rates = ensureDynamicGamblingRates();
    for (const [key, range] of Object.entries(GAMBLING_RATE_RANGES)) {
        // Mostly small downward movement, with frequent small recoveries.
        const delta = Math.random() < 0.62 ? -(0.05 + Math.random() * 0.20) : (0.01 + Math.random() * 0.10);
        rates[key] = Number(clampRate(rates[key] + delta, range).toFixed(2));
    }
    saveDB();
}
const AVAILABLE_BAGS = ['Skybag', 'Safari Bag', 'Aristocrat Bag', 'Gucci Bag 💼', 'American Tourister'];

const ROAST_MESSAGES = [
    "Look at this script kiddie trying to run dev cheats in a group! Go execute `.dig` and work hard for once. 🤡",
    "Bro really thought he could hack his way into wealth while everyone was watching. Absolute clown energy! 🧠❌",
    "Nice try, master hacker! Next time try executing your masterplans in my DMs, not in public. How embarrassing! 😂"
];

// ── CATCH GIF URL ─────────────────────────────────────────────────────────────
const POKEBALL_GIF_URL = 'https://media.tenor.com/5n7JF3bVDfYAAAAC/pokeball-throw.gif';

// Official PokeAPI artwork for any Pokémon, by dexId — free, no uploads needed.
function pokemonArtUrl(dexId) {
    return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dexId || 1}.png`;
}
async function getPokemonArtMedia(dexId) {
    return MessageMedia.fromUrl(pokemonArtUrl(dexId));
}

// Prefer a local pokeball-wobble GIF from assets/ (drop in assets/pokeball_wobble.gif),
// falling back to the Tenor URL above if it's not there.
async function getPokeballWobbleMedia() {
    const localPath = path.join(__dirname, 'assets', 'pokeball_wobble.gif');
    if (fs.existsSync(localPath)) return MessageMedia.fromFilePath(localPath);
    return MessageMedia.fromUrl(POKEBALL_GIF_URL);
}

// ── ASSET IMAGE PATHS ────────────────────────────────────────────────────────
const path = require('path');
const ASSETS = {
    coin:        path.join(__dirname, 'assets', 'coin.png'),
    treasureBox: path.join(__dirname, 'assets', 'treasure_box.png'),
    fishBlue:    path.join(__dirname, 'assets', 'fish_blue.png'),
    fishSalmon:  path.join(__dirname, 'assets', 'fish_salmon.png'),
    fishGold:    path.join(__dirname, 'assets', 'fish_gold.png'),
    deposit:     path.join(__dirname, 'assets', 'deposit.png'),
    withdraw:    path.join(__dirname, 'assets', 'withdraw.png'),
    zombie:      path.join(__dirname, 'assets', 'zombie.png'),
    shark:       path.join(__dirname, 'assets', 'shark.png'),
};

// ── DB HELPERS ────────────────────────────────────────────────────────────────
// ── SAFE DB LOAD with backup ─────────────────────────────────────────────────
const DB_BACKUP = DB_FILE + '.bak';
if (fs.existsSync(DB_FILE)) {
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        if (!raw || raw.trim() === '') throw new Error('Empty file');
        db = JSON.parse(raw);
        // Save a good backup every time we load successfully
        fs.writeFileSync(DB_BACKUP, raw);
        console.log(`✅ Database loaded (${Object.keys(db).length} entries)`);
    } catch (e) {
        console.error(`⚠️ database.json corrupted: ${e.message} — trying backup...`);
        if (fs.existsSync(DB_BACKUP)) {
            try {
                db = JSON.parse(fs.readFileSync(DB_BACKUP, 'utf8'));
                console.log('✅ Restored from backup!');
            } catch (e2) {
                console.error('❌ Backup also corrupted. Starting fresh.');
                db = {};
            }
        } else {
            console.error('❌ No backup found. Starting fresh.');
            db = {};
        }
    }
} else {
    console.log('ℹ️ No database found — starting fresh.');
}
if (!db._config) db._config = { botActive: true };
if (!db._config.amexInvitesSent) db._config.amexInvitesSent = {};
// Per-GC active state: { [chatId]: true/false }
if (!db._config.gcActive)  db._config.gcActive  = {};
// Lobby GCs set: { [chatId]: true }
if (!db._config.lobbyGCs)  db._config.lobbyGCs  = {};
// Dedicated Pokémon GC: only spawn wild Pokémon & allow .catch/.throwball here
if (db._config.pokemonChannelId === undefined) db._config.pokemonChannelId = null;
// Redeem codes: { [code]: { amount, creatorId, createdAt, claimed: false, claimedBy, claimedAt } }
if (!db._redeemCodes) db._redeemCodes = {};
// Banned users set: { [userId]: { bannedBy, at } }
if (!db._config.bannedUsers) db._config.bannedUsers = {};
// Dynamically added mods / FBI agents (persisted across restarts) — hydrate into the runtime arrays
if (!db._config.extraMods) db._config.extraMods = [];
if (!db._config.extraFbiAgents) db._config.extraFbiAgents = [];
for (const id of db._config.extraMods) if (!MOD_NUMBERS.includes(id)) MOD_NUMBERS.push(id);
for (const id of db._config.extraFbiAgents) if (!FBI_NUMBERS.includes(id)) FBI_NUMBERS.push(id);
// Lottery state: pooled entries (max 5) + the GC designated for result announcements
if (!db._config.lottery) db._config.lottery = { entries: [], announceChannelId: null, lastResult: null };
if (db._config.lottery.entries === undefined)          db._config.lottery.entries = [];
if (db._config.lottery.announceChannelId === undefined) db._config.lottery.announceChannelId = null;
if (db._config.lottery.lastResult === undefined)        db._config.lottery.lastResult = null;

// Start the live gambling-rate market after the database has been loaded.
ensureDynamicGamblingRates();
setInterval(driftGamblingRates, 30_000);

// ── AFK storage: { userId: { since: timestamp, reason: string } } ────────
if (!db._config.afk) db._config.afk = {};

// ── ONE-TIME MIGRATION: old default starting wallet was $550,000 — reset ──
// every existing user's wallet to $0 to match the new $0 starting balance.
// Guarded by a flag file so this never re-runs (and re-zeroes earnings) on
// a later restart.
const WALLET_RESET_FLAG = './wallet_reset_v1.flag';
if (!fs.existsSync(WALLET_RESET_FLAG)) {
    const isValidDiscordId = id => /^\d{17,19}$/.test(id);
    let resetCount = 0;
    for (const id of Object.keys(db)) {
        if (id !== '_config' && isValidDiscordId(id) && db[id] && db[id].wallet !== undefined) {
            db[id].wallet = 0;
            resetCount++;
        }
    }
    try {
        fs.writeFileSync(WALLET_RESET_FLAG, new Date().toISOString());
        console.log(`💰 One-time migration: reset ${resetCount} existing user wallet(s) to $0.`);
        saveDB();
    } catch (e) {
        console.error('⚠️ Could not write wallet reset flag:', e.message);
    }
}

// Helper: is bot active in this specific chat?
function isBotActiveInChat(chatId) {
    // Defensive: old databases may not have all config fields.
    if (!db._config) db._config = {};
    if (!db._config.gcActive) db._config.gcActive = {};
    // Essential onboarding commands must remain available.
    // Other commands still obey the normal botActive / per-GC switch.
    if (db._config.gcActive[chatId] !== undefined) return !!db._config.gcActive[chatId];
    return db._config.botActive !== false;
}

// Helper: is this chat a lobby GC?
function isLobbyGC(chatId) {
    return !!db._config.lobbyGCs[chatId];
}


    

// Commands blocked in lobby GCs (gambling + pokemon catching/play)
const LOBBY_BLOCKED_COMMANDS = new Set([
    '.casino', '.slots', '.roulette', '.db', '.double', '.cf', '.coinflip',
    '.rob', '.catch', '.throwball', '.play'
]);


// ── NUMBER FORMATTER ─────────────────────────────────────────────────────────
// Always uses en-US locale so commas appear consistently (1,000 / 1,000,000)
// regardless of the server's system locale or Node.js ICU build.
function formatNum(n) {
    const num = Number(n);
    if (!isFinite(num)) return String(n);
    return num.toLocaleString('en-US');
}

// ── VIP-AWARE BANK CAPACITY ────────────────────────────────────────────────────
// VIP Pass gives UNLIMITED bank space while active — we never mutate u.maxCapacity
// for this, so the instant VIP lapses/isn't recharged, capacity is exactly what it
// was before (no bonus to subtract, nothing to "revert").
function isVipActive(u) {
    return !!(u && u.vip && u.vip.active && u.vip.expiresAt > Date.now());
}
function getBankCapacity(u) {
    return isVipActive(u) ? Infinity : (u.maxCapacity || 500_000);
}
function formatCapacity(u) {
    return isVipActive(u) ? '💎 Unlimited (VIP)' : `$${formatNum(u.maxCapacity || 500_000)}`;
}
// Charges nothing itself — caller must already have deducted VIP_MONTHLY_FEE.
// Activates a fresh VIP Pass, or extends an already-active one by 30 more days.
// Never touches u.maxCapacity — unlimited space comes purely from isVipActive().
function activateOrRenewVip(u) {
    const now = Date.now();
    const wasActive = isVipActive(u);
    if (wasActive) {
        u.vip.expiresAt += VIP_DURATION_MS;
        u.vip.reminder3dSent = false;
        u.vip.reminder1dSent = false;
    } else {
        u.vip = {
            active: true,
            expiresAt: now + VIP_DURATION_MS,
            reminder3dSent: false,
            reminder1dSent: false,
        };
    }
    return wasActive;
}

// ── AMOUNT SHORTHAND PARSER ───────────────────────────────────────────────────
// Parses "50k" → 50000, "2.5m" → 2500000, "1b" → 1000000000, "all" → handled externally
// Returns NaN if unparseable.
// No single gambling wager may exceed 5% of the player's total wealth.
const MAX_GAMBLE_WEALTH_PERCENT = 0.05;
function getMaxGambleBet(userId) {
    return Math.max(0, Math.floor(getNetWorth(userId) * MAX_GAMBLE_WEALTH_PERCENT));
}
function validateGambleBet(userId, bet) {
    const u = db[userId];
    const maxBet = getMaxGambleBet(userId);
    if (!Number.isFinite(bet) || bet <= 0 || bet > (u?.wallet || 0)) return { ok:false, maxBet, reason:'wallet' };
    if (bet > maxBet) return { ok:false, maxBet, reason:'wealth' };
    return { ok:true, maxBet };
}

function parseAmount(str, walletForAll) {
    if (!str) return NaN;
    const s = str.toString().toLowerCase().trim();
    if (s === 'all' && walletForAll !== undefined) return walletForAll;
    const match = s.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
    if (!match) return NaN;
    const num = parseFloat(match[1]);
    const mult = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : match[2] === 'b' ? 1_000_000_000 : 1;
    return Math.floor(num * mult);
}

// ── PROFILE / ACTIVITY / XP SYSTEM ────────────────────────────────────────────
// Discord bots cannot see literal keystrokes, so typing rate is measured from
// messages sent: messages/minute, words/minute and chars/minute over 5 minutes.
const PROFILE_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
// FIX: XP earning made tougher/slower — longer cooldown, smaller gains per tick,
// lower daily cap, and steeper per-level growth. Plain chat no longer grants XP at all
// (see messageCreate handler) — only commands/games do now.
const PROFILE_XP_COOLDOWN_MS = 60 * 1000;
const PROFILE_XP_DAILY_CAP = 300;
const PROFILE_XP_COMMAND = 2;
const PROFILE_XP_GAME_BONUS = 4;
const PROFILE_LEVEL_BASE = 100;
const PROFILE_LEVEL_GROWTH = 1.28;
const PROFILE_LEVEL_REWARDS = {
    2:  { cash: 25000, text: '💰 $25K' },
    3:  { cash: 50000, text: '💰 $50K' },
    5:  { cash: 100000, text: '💰 $100K + 2× 🔴 Pokéball' },
    10: { cash: 250000, text: '💰 $250K + 2× 🔵 Great Ball' },
    15: { cash: 500000, text: '💰 $500K + 2× ⚫ Ultra Ball' },
    20: { cash: 1000000, text: '💰 $1M + 1× 🟣 Master Ball' },
};
function profileXpRequired(level) {
    return Math.floor(PROFILE_LEVEL_BASE * Math.pow(PROFILE_LEVEL_GROWTH, Math.max(0, (Number(level) || 1) - 1)));
}
function profileLevelForXp(totalXp) {
    let level = 1, remaining = Math.max(0, Number(totalXp) || 0), need = profileXpRequired(level);
    while (remaining >= need && level < 100) { remaining -= need; level++; need = profileXpRequired(level); }
    return { level, currentXp: remaining, needed: need };
}
function grantProfileLevelReward(u, level) {
    const reward = PROFILE_LEVEL_REWARDS[level];
    if (!reward) return null;
    u.wallet = (u.wallet || 0) + (reward.cash || 0);
    if (level === 5) u.inventory.pokeball = (u.inventory.pokeball || 0) + 2;
    if (level === 10) u.inventory.greatball = (u.inventory.greatball || 0) + 2;
    if (level === 15) u.inventory.ultraball = (u.inventory.ultraball || 0) + 2;
    if (level === 20) u.inventory.masterball = (u.inventory.masterball || 0) + 1;
    return reward.text;
}
function trimProfileActivity(u, now = Date.now()) {
    if (!Array.isArray(u.activityLog)) u.activityLog = [];
    const cutoff = now - PROFILE_ACTIVITY_WINDOW_MS;
    u.activityLog = u.activityLog.filter(e => e.ts >= cutoff);
}
function getProfileTypingStats(u) {
    trimProfileActivity(u);
    const entries = u.activityLog || [];
    const messages = entries.length;
    const words = entries.reduce((n, e) => n + (e.words || 0), 0);
    const chars = entries.reduce((n, e) => n + (e.chars || 0), 0);
    const mins = Math.max(1 / 60, Math.min(5, (Date.now() - (entries[0]?.ts || Date.now())) / 60000));
    return { messagesPerMinute: messages / mins, wordsPerMinute: words / mins, charsPerMinute: chars / mins, windowMessages: messages };
}
function awardProfileXp(userId, amount, reason = 'interaction') {
    initUser(userId);
    const u = db[userId];
    if (!u.registered) return null;
    const now = Date.now();
    if (!u.profileXpDay || u.profileXpDay !== new Date(now).toDateString()) { u.profileXpDay = new Date(now).toDateString(); u.profileXpToday = 0; }
    if ((u.profileXpToday || 0) >= PROFILE_XP_DAILY_CAP) return null;
    if (now - (u.lastProfileXpAt || 0) < PROFILE_XP_COOLDOWN_MS) return null;
    const gained = Math.min(Math.max(1, Math.floor(amount)), PROFILE_XP_DAILY_CAP - (u.profileXpToday || 0));
    const before = profileLevelForXp(u.profileXp || 0);
    u.profileXp = (u.profileXp || 0) + gained;
    u.profileXpToday = (u.profileXpToday || 0) + gained;
    u.lastProfileXpAt = now;
    u.profileXpLifetime = (u.profileXpLifetime || 0) + gained;
    const after = profileLevelForXp(u.profileXp);
    u.profileLevel = after.level;
    const rewards = [];
    if (after.level > before.level) {
        for (let lv = before.level + 1; lv <= after.level; lv++) {
            const reward = grantProfileLevelReward(u, lv);
            if (reward) rewards.push({ level: lv, reward });
        }
    }
    saveDB();
    return { gained, reason, level: after.level, currentXp: after.currentXp, needed: after.needed, levelledUp: after.level > before.level, rewards };
}
function trackUserActivity(userId, content) {
    initUser(userId);
    const u = db[userId];
    if (!u.registered) return null;
    const now = Date.now(), text = String(content || '').trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const chars = text.length;
    trimProfileActivity(u, now);
    u.activityLog.push({ ts: now, words, chars });
    u.totalMessages = (u.totalMessages || 0) + 1;
    u.totalWords = (u.totalWords || 0) + words;
    u.totalChars = (u.totalChars || 0) + chars;
    u.lastActiveAt = now;
    const stats = getProfileTypingStats(u);
    u.typingRate = { messagesPerMinute: Number(stats.messagesPerMinute.toFixed(2)), wordsPerMinute: Number(stats.wordsPerMinute.toFixed(2)), charsPerMinute: Number(stats.charsPerMinute.toFixed(2)), measuredAt: now };
    return stats;
}
function profileXpNotice(result) {
    if (!result) return null;
    const rewardText = result.rewards.length ? '\n🎁 *Level gift:* ' + result.rewards.map(r => 'Lv.' + r.level + ' — ' + r.reward).join(', ') : '';
    return '✨ *PROFILE XP +' + result.gained + '*\n📈 Level **' + result.level + '** • XP **' + result.currentXp + '/' + result.needed + '**' + (result.levelledUp ? '\n🎉 *LEVEL UP!* You reached profile Level ' + result.level + '!' : '') + rewardText;
}

function saveDB() {
    try {
        const data = JSON.stringify(db, null, 2);
        const tmp = DB_FILE + '.tmp';
        fs.writeFileSync(tmp, data);   // write to temp first
        fs.renameSync(tmp, DB_FILE);   // atomic swap — prevents corruption on crash
    } catch (err) { console.error('DB save error:', err); }
}

function initUser(userId) {
    // FIX: skip invalid/non-Discord IDs (old WhatsApp keys, placeholders, etc.)
    if (!userId || !/^\d{17,19}$/.test(userId)) return;
    if (!db[userId]) db[userId] = {};
    const u = db[userId];
    if (u.wallet === undefined)       u.wallet = 0;
    if (u.profileXp === undefined) u.profileXp = 0;
    if (u.profileXpLifetime === undefined) u.profileXpLifetime = 0;
    if (u.profileLevel === undefined) u.profileLevel = 1;
    if (u.profileXpToday === undefined) u.profileXpToday = 0;
    if (u.profileXpDay === undefined) u.profileXpDay = new Date().toDateString();
    if (u.lastProfileXpAt === undefined) u.lastProfileXpAt = 0;
    if (u.activityLog === undefined) u.activityLog = [];
    if (u.totalMessages === undefined) u.totalMessages = 0;
    if (u.totalWords === undefined) u.totalWords = 0;
    if (u.totalChars === undefined) u.totalChars = 0;
    if (u.typingRate === undefined) u.typingRate = { messagesPerMinute: 0, wordsPerMinute: 0, charsPerMinute: 0, measuredAt: 0 };
    if (u.firstLoanGuideShown === undefined) u.firstLoanGuideShown = false;
    if (u.firstUpgradeGuideShown === undefined) u.firstUpgradeGuideShown = false;
    if (u.creditBuildRepays === undefined) u.creditBuildRepays = 0;
    if (u.creditBuildWindowStart === undefined) u.creditBuildWindowStart = 0;
    if (u.creditBuildPositiveGain === undefined) u.creditBuildPositiveGain = 0;
    if (u.defaultedLoanCount === undefined) u.defaultedLoanCount = 0;
    if (u.loanDefaultBanUntil === undefined) u.loanDefaultBanUntil = null;
    if (u.registered === undefined)   u.registered = false;
    if (u.registeredAt === undefined) u.registeredAt = Date.now(); // track account age for transfer lock
    if (u.bank === undefined)         u.bank = 0;
    if (u.maxCapacity === undefined)  u.maxCapacity = 500_000;
    if (u.creditScore === undefined)  u.creditScore = 500;
    if (u.bankLoanCount === undefined) u.bankLoanCount = 0; // bank loans (no card needed)
    if (u.lastTransfer === undefined)          u.lastTransfer = 0;
    if (u.dailyTransferSent === undefined)     u.dailyTransferSent = 0;
    if (u.dailyTransferCount === undefined)    u.dailyTransferCount = 0;
    if (u.transferDay === undefined)           u.transferDay = '';
    if (u.dailyTransferReceived === undefined) u.dailyTransferReceived = 0;
    if (u.transferReceiveDay === undefined)    u.transferReceiveDay = '';
    if (u.lastDig === undefined)      u.lastDig = 0;
    if (u.lastFish === undefined)     u.lastFish = 0;
    if (u.lastCasino === undefined)   u.lastCasino = 0;
    if (u.lastSlots === undefined)    u.lastSlots = 0;
    if (u.lastDb === undefined)       u.lastDb = 0;
    if (u.lastRoulette === undefined) u.lastRoulette = 0;
    if (u.lastCoinflip === undefined) u.lastCoinflip = 0;
    if (u.lastCheat === undefined)    u.lastCheat = 0;
    if (u.lastDaily === undefined)    u.lastDaily = 0;
    if (u.dailyStreak === undefined)  u.dailyStreak = 0;
    if (u.lastRob === undefined)      u.lastRob = 0;
    if (u.dailyDbCount === undefined) u.dailyDbCount = 0;
    if (u.lastLimitReset === undefined) u.lastLimitReset = Date.now();
    if (u.inventory === undefined)    u.inventory = {};
    const inv = u.inventory;
    if (inv.shovel === undefined)       inv.shovel = 1;
    if (inv.fishingRod === undefined)   inv.fishingRod = 1;
    if (inv.pokeball === undefined)     inv.pokeball = 5;
    if (inv.greatball === undefined)    inv.greatball = 0;
    if (inv.ultraball === undefined)    inv.ultraball = 0;
    if (inv.masterball === undefined)   inv.masterball = 0;
    if (inv.heavyball === undefined)    inv.heavyball = 0;
    if (inv.lureball === undefined)     inv.lureball = 0;
    if (inv.assignedBag === undefined)  inv.assignedBag = AVAILABLE_BAGS[Math.floor(Math.random() * AVAILABLE_BAGS.length)];
    if (inv.fish === undefined)         inv.fish = 0;
    if (inv.salmon === undefined)       inv.salmon = 0;
    if (inv.goldenFish === undefined)   inv.goldenFish = 0;
    // Food items
    for (let key of Object.keys(FOOD_SHOP)) {
        if (inv[key] === undefined) inv[key] = 0;
    }
    // Evolution stones
    for (let key of Object.keys(STONE_SHOP)) {
        if (inv[key] === undefined) inv[key] = 0;
    }
    for (let key of Object.keys(RARE_CANDY_SHOP)) {
        if (inv[key] === undefined) inv[key] = 0;
    }
    if (u.amexCard === undefined)         u.amexCard = null;
    if (u.amexInvitesSent === undefined)  u.amexInvitesSent = {};
    if (u.pokemon === undefined) u.pokemon = [];
    for (const p of u.pokemon) { p.level=p.level||1; p.xp=p.xp||0; p.maxXp=p.maxXp||xpRequiredForLevel(p.level); }
    // Active battle team — names of up to 6 Pokémon from u.pokemon. Everything else lives in the PC (box).
    if (u.team === undefined) u.team = u.pokemon.slice(0, 6).map(p => p.name);
    // mrbeast daily usage per pokemon: { pokemonName: { count, lastReset } }
    // Permanent ATK boost from food (cumulative, saved to DB)
    if (u.permAtkBoost === undefined) u.permAtkBoost = {};
    if (u.permHpBoost === undefined) u.permHpBoost = {};
    // Toxicity tracker per pokemon: { pokemonName: { alcoholCount, cigarCount, toxicUntil } }
    // ATK buffs from food (temporary, per battle): stored but reset after use
    if (u.atkBuff === undefined) u.atkBuff = 0;
    // Bank loan system (credit-score based — 4-day gambling ban if not repaid)
    if (u.bankLoan === undefined)           u.bankLoan           = null;
    if (u.loanBanUntil === undefined)       u.loanBanUntil       = null; // timestamp: bank loan gambling ban until
    if (u.bankLoanOverdueAt === undefined)  u.bankLoanOverdueAt  = null; // timestamp: when bank loan first went overdue
    // Daily net-worth snapshots used to cap loans against RECENT balance,
    // not just instantaneous balance (see BALANCE-BASED LOAN CAP above)
    if (u.balanceHistory === undefined)     u.balanceHistory     = [];
    // Track when user first joined
    if (u.joinedAt === undefined) u.joinedAt = Date.now();
    // VIP Pass — for trillionaires. Grants UNLIMITED bank space while active.
    // { active, expiresAt, reminder3dSent, reminder1dSent }
    if (u.vip === undefined) u.vip = null;
    for (const oldFood of ['mrbeast','rum','whiskey','cigar','cigarette','beer']) { if (u.inventory && Object.prototype.hasOwnProperty.call(u.inventory, oldFood)) delete u.inventory[oldFood]; }
}

// ── Helper: zero out a user's inventory (used by ".reset inv") ─────────────
// Keeps the same key set initUser() expects (so nothing downstream breaks
// on a missing field) but drives every count down to 0. assignedBag is kept
// as-is since it's a cosmetic assignment, not a resource to "reset".
function zeroUserInventory(userData) {
    const keptBag = userData.inventory?.assignedBag || AVAILABLE_BAGS[Math.floor(Math.random() * AVAILABLE_BAGS.length)];
    userData.inventory = {
        shovel: 0,
        fishingRod: 0,
        pokeball: 0,
        greatball: 0,
        ultraball: 0,
        masterball: 0,
        heavyball: 0,
        lureball: 0,
        assignedBag: keptBag,
        fish: 0,
        salmon: 0,
        goldenFish: 0,
        rarecandy: 0,
    };
    for (const key of Object.keys(FOOD_SHOP)) {
        userData.inventory[key] = 0;
    }
}

// A user must explicitly run `.reg` before the bot will respond to any of
// their other commands. Just being auto-created via initUser() (which can
// happen incidentally, e.g. an admin command referencing them) does NOT
// count as registered.
function isRegistered(userId) {
    return !!(db[userId] && db[userId].registered === true);
}

// ── LOTTERY DRAW ───────────────────────────────────────────────────────────────
// Fires once db._config.lottery.entries reaches LOTTERY_POOL_SIZE. Shuffles the
// pool, pays out the top 3 a random amount within their prize band, credits
// wallets, resets the pool, and announces the result in the configured GC
// (falling back to the GC that triggered the draw if no `.lll` GC is set yet).
async function runLotteryDraw(fallbackChannel) {
    const lottery = db._config.lottery;
    const pool = [...lottery.entries];
    // Shuffle (Fisher-Yates)
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const winners = [];
    for (let i = 0; i < LOTTERY_PRIZES.length; i++) {
        const prize = LOTTERY_PRIZES[i];
        const userId = pool[i];
        const amount = Math.floor(Math.random() * (prize.max - prize.min + 1)) + prize.min;
        initUser(userId);
        db[userId].wallet += amount;
        winners.push({ userId, amount, label: prize.label, place: prize.place });
    }
    const losers = pool.slice(LOTTERY_PRIZES.length); // remaining 2 entrants — no reward

    // Reset the pool for the next round
    lottery.entries = [];
    lottery.lastResult = { winners, losers, drawnAt: Date.now() };
    saveDB();

    // Build the announcement
    let out = `🎰 *LOTTERY DRAW COMPLETE!* 🎰\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
    out += `🎟️ 5 tickets sold — here are the results:\n\n`;
    winners.forEach(w => {
        out += `${w.label}: <@${w.userId}> — *+$${formatNum(w.amount)}* 💰\n`;
    });
    if (losers.length) {
        out += `\n💀 *No prize:* ${losers.map(id => `<@${id}>`).join(', ')}\n`;
    }
    out += `\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_New round is open — buy a ticket with \`.buy lottery\`!_`;

    const mentions = pool;
    const targetChannelId = lottery.announceChannelId;
    let sent = false;
    if (targetChannelId) {
        try {
            const channel = await client.channels.fetch(targetChannelId);
            if (channel) {
                await channel.send({ content: out, allowedMentions: { parse: ['users'] } });
                sent = true;
            }
        } catch (e) {
            console.error('Lottery announce-channel send failed:', e.message);
        }
    }
    if (!sent && fallbackChannel) {
        try {
            await fallbackChannel.send({ content: out, allowedMentions: { parse: ['users'] } });
        } catch (e) {
            console.error('Lottery fallback-channel send failed:', e.message);
        }
    }
}

function checkDailyReset(userId) {
    const now = Date.now();
    if (now - db[userId].lastLimitReset > 86400000) {
        db[userId].dailyDbCount = 0;
        db[userId].lastLimitReset = now;
        saveDB();
    }
}

function makeProgressBar(current, max) {
    const total = 8;
    const filled = Math.max(0, Math.min(total, Math.round((current / max) * total)));
    return '🟩'.repeat(filled) + '⬜'.repeat(total - filled);
}

// Track last 5 spawned Pokémon per chat to avoid repeats
const recentSpawns = {};

function pickWildPokemon(chatId) {
    const roll = Math.random() * 100;
    let pool;
    // Legendary/Mythical dropped way down (0.5%-1% combined range) — everything else absorbs the difference.
    if (roll <= 33)        pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Weak');
    else if (roll <= 63)   pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Common');
    else if (roll <= 84)   pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Rare');
    else if (roll <= 98.5) pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Epic');
    else if (roll <= 99.5) pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Legendary'); // 1%
    else                   pool = WILD_POKEMON_POOL.filter(p => p.rarity === 'Mythical');  // 0.5%

    // Anti-repeat: filter out recently spawned Pokémon in this chat
    if (chatId) {
        if (!recentSpawns[chatId]) recentSpawns[chatId] = [];
        const recent = recentSpawns[chatId];
        const filtered = pool.filter(p => !recent.includes(p.name));
        if (filtered.length > 0) pool = filtered;
        // Track this spawn
        const pick = { ...pool[Math.floor(Math.random() * pool.length)] };
        recent.push(pick.name);
        if (recent.length > 5) recent.shift();
        return pick;
    }
    return { ...pool[Math.floor(Math.random() * pool.length)] };
}

// { chatId: lastSpawnTime }
const lastSpawnTime = {};

function checkWildSpawn(chatId) {
    if (wildPokemonState[chatId]) return false; // already a wild pokemon active
    const now = Date.now();
    const last = lastSpawnTime[chatId] || 0;
    // Roughly 2 Pokémon per hour: random 25–35 minute cooldown.
    const cdMs = (Math.floor(Math.random() * 11) + 25) * 60 * 1000;
    if (now - last >= cdMs) {
        lastSpawnTime[chatId] = now;
        return true;
    }
    return false;
}

function generateBattleId() {
    return 'BT' + Date.now().toString(36).toUpperCase();
}

function isToxic(userId, pokeName) {
    const tox = db[userId]?.toxicity?.[pokeName.toLowerCase()];
    if (!tox) return false;
    return tox.toxicUntil && Date.now() < tox.toxicUntil;
}

function getToxicInfo(userId, pokeName) {
    return db[userId]?.toxicity?.[pokeName.toLowerCase()] || { alcoholCount: 0, cigarCount: 0, toxicUntil: 0 };
}

// ── CLIENT EVENTS ─────────────────────────────────────────────────────────────
client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('👉 Scan QR:'); });
client.on('ready', () => console.log('🚀 BOT ONLINE — ALL SYSTEMS GO'));

// ── MAIN MESSAGE HANDLER ──────────────────────────────────────────────────────
client.on('messageCreate', async msg => {
    // Lightweight diagnostic: confirms the gateway event is reaching the handler.
    // Set DEBUG_MESSAGES=false in .env to silence it (default: false).
    if (process.env.DEBUG_MESSAGES === 'true') console.log('📩 messageCreate:', msg.id, msg.author?.id, JSON.stringify(msg.content || ''));
    // FIX: deduplicate BEFORE any async work so gateway-redelivered events are
    // rejected immediately, even before the partial fetch.
    if (alreadyProcessed('main', msg.id)) return;
    // FIX: partial messages/authors (Partials.Message is enabled) can arrive
    // with msg.author missing .id until explicitly fetched — resolve that first.
    try {
        if (msg.partial) msg = await msg.fetch();
        if (!msg.author) return;
        if (typeof msg.author !== "string" && !msg.author.id) return;
    } catch (e) {
        console.error('Partial fetch failed:', e.message);
        return;
    }
    if (!msg.__wrapped && msg.author.bot && msg.author.id !== '1528377826485473351') return;  // Allow Luna through
    msg = wrapMessage(msg);
    try {
        let body = msg.body ? msg.body.trim() : '';
        body = body.replace(/^\.\s+/, '.');
        const senderId = msg.author || msg.from;
        if (!body) return;

        // Profile tracking is deliberately isolated from command execution.
        // A malformed legacy profile must NEVER prevent the bot from replying.
        try {
            initUser(senderId);
            if (isRegistered(senderId)) {
                // Typing-rate stats are tracked for every message (used on the .p profile card),
                // but this is NOT XP — XP is granted separately below, commands/games only.
                trackUserActivity(senderId, body);

                // FIX: XP used to be awarded on EVERY message, including plain chat/words.
                // Now XP is only granted when the message is an actual command (starts with '.').
                // Plain conversation never grants XP anymore.
                if (body.startsWith('.')) {
                    const quickCommand = body.split(' ')[0].toLowerCase();
                    const quickGameCommands = new Set(['.casino','.slots','.roulette','.db','.double','.cf','.coinflip','.gamble','.dig','.fish','.rob','.catch','.throwball','.battle','.daily','.feed','.evolve','.use','.buy']);
                    const xpAmount = quickGameCommands.has(quickCommand) ? PROFILE_XP_GAME_BONUS : PROFILE_XP_COMMAND;
                    const autoXp = awardProfileXp(senderId, xpAmount);
                    // FIX: only announce on an actual level-up — a reply for every single
                    // command's XP tick was spammy/irritating. XP still gained silently otherwise.
                    if (autoXp && autoXp.levelledUp) {
                        await msg.reply(profileXpNotice(autoXp)).catch(() => {});
                    }
                }
            }
        } catch (profileErr) {
            console.error('⚠️ Profile tracking skipped (command execution continues):', profileErr.message);
        }

        const chatObj = await msg.getChat();
        const isGroupChat = chatObj.isGroup;

        // ── DM COMMAND WHITELIST ──────────────────────────────────────────────
        // Only specific commands are allowed in DMs — everything else is blocked.
        if (!isGroupChat && body.startsWith('.')) {
            const DM_ALLOWED = new Set([
                '.redeem', '.claim', '.reg', '.menu', '.help',
                '.bal', '.p', '.profile',
                '.deposit', '.dep', '.withdraw', '.wd',
                '.loan', '.upgrades', '.u1', '.u2', '.u3', '.u4', '.u5', '.u6', '.u7', '.u8', '.u9', '.u10',
                // Amex card system — all allowed in DM
                '.americanexpress', '.amex',
                '.avail', '.mycard', '.paymaint', '.cardinfo',
            ]);
            const dmCmd = body.split(' ')[0].toLowerCase();
            if (!DM_ALLOWED.has(dmCmd)) {
                return msg.reply(
                    `🔒 This command is not available in DMs.\n\n` +
                    `**Commands available in DM:**\n` +
                    `• \`.bal\` / \`.p\` — Check your balance\n` +
                    `• \`.redeem [amount]\` — Create a redeem code (mods/owners only)\n` +
                    `• \`.claim [code]\` — Claim a redeem code\n` +
                    `• \`.loan\` — Loan system\n` +
                    `• \`.americanexpress\` — Amex card guide\n` +
                    `• \`.avail [card]\` — Get an Amex card\n` +
                    `• \`.mycard\` — View your card & status\n` +
                    `• \`.paymaint\` — Pay card maintenance\n` +
                    `• \`.cardinfo [card]\` — View card details\n\n` +
                    `_Head to the server for all other commands!_`
                );
            }
        }

        let isMod = await checkIsMod(msg);

        // ── Handle active battle move replies ────────────────────────────────
        // Players reply with a move name like "Thunderbolt" or "1" (move index)
        const lowerBody = body.toLowerCase().trim();

        // Check if this user is in an active battle and replying with a move
        for (const [battleId, battle] of Object.entries(activeBattles)) {
            const isP1Turn = battle.turn === 'p1' && senderId === battle.p1Id;
            const isP2Turn = battle.turn === 'p2' && senderId === battle.p2Id;
            if (!isP1Turn && !isP2Turn) continue;

            const myPoke   = isP1Turn ? battle.p1 : battle.p2;
            const oppPoke  = isP1Turn ? battle.p2 : battle.p1;
            const myId     = senderId;
            const oppId    = isP1Turn ? battle.p2Id : battle.p1Id;
            const myName   = myId.split('@')[0];
            const oppName  = oppId.split('@')[0];

            const moves = getMovesForPokemon(myPoke.name);
            let chosenMove = null;

            // match by number (1-4) or name
            const numMatch = parseInt(lowerBody);
            if (!isNaN(numMatch) && numMatch >= 1 && numMatch <= moves.length) {
                chosenMove = moves[numMatch - 1];
            } else {
                chosenMove = moves.find(m => m.name.toLowerCase() === lowerBody);
            }
            if (!chosenMove) break; // not a valid move, ignore

            // Calculate damage — now scales with the attacker's current ATK stat
            // (see rollMoveDamage) instead of ignoring it entirely.
            const dmg = rollMoveDamage(chosenMove, myPoke.atk);
            oppPoke.hp = Math.max(0, oppPoke.hp - dmg);

            let moveMsg = `⚔️ *${myPoke.emoji} ${myPoke.name}* used *${chosenMove.emoji} ${chosenMove.name}*!\n` +
                          `💥 Dealt *${dmg} damage* to ${oppPoke.emoji} ${oppPoke.name}!\n` +
                          `❤️ ${oppPoke.name} HP: ${makeProgressBar(oppPoke.hp, oppPoke.maxHp)} (${oppPoke.hp}/${oppPoke.maxHp})\n`;

            if (oppPoke.hp <= 0) {
                // Battle over
                delete activeBattles[battleId];

                if (battle.wildMode) {
                    // Wild Pokémon defeated — chance to catch
                    const wild = battle.wildPokemon;
                    moveMsg += `\n🏆 *${myPoke.name} wins!* Wild ${wild.emoji} ${wild.name} is weakened!\n\n`;
                    moveMsg += `🎯 Use *.throwball [balltype]* to try catching it!\n` +
                               `_(e.g. \`.throwball pokeball\` or \`.throwball ultraball\`)_\n` +
                               `⚠️ Wild Pokémon flees in 30 seconds if not caught!`;
                    wildPokemonState[chatObj.id._serialized] = {
                        pokemon: { ...wild, hp: 1 },
                        spawnTime: Date.now(),
                        weakened: true,
                        battleWinner: myId
                    };
                    // Auto-flee after 30s
                    setTimeout(() => {
                        const cid = chatObj.id._serialized;
                        if (wildPokemonState[cid]?.weakened) {
                            delete wildPokemonState[cid];
                            chatObj.sendMessage(`💨 The weakened ${wild.emoji} ${wild.name} recovered and fled into the wild!`).catch(() => {});
                        }
                    }, 30000);
                } else {
                    // PvP battle over
                    const winnerId  = myId;
                    const loserId   = oppId;
                    initUser(winnerId); initUser(loserId);

                    // Sync HP back to DB. PvP victories no longer grant cash or XP.
                    const updatePokeHp = (uid, poke) => {
                        const party = db[uid].pokemon || [];
                        const found = party.find(p => p.name.toLowerCase() === poke.name.toLowerCase());
                        if (found) found.hp = poke.hp;
                    };
                    updatePokeHp(myId, myPoke);
                    updatePokeHp(oppId, oppPoke);
                    saveDB();
                    moveMsg += `
🏆 *${myPoke.emoji} ${myPoke.name}* won the battle!
` +
                               `🎖️ *Victory recorded — no cash/XP reward is awarded.*

` +
                               `💡 Heal your Pokémon with \`.feed\` before the next battle.`;
                }
                return chatObj.sendMessage(moveMsg, { mentions: [myId, oppId] }).catch(() => {});
            }

            // Switch turn
            battle.turn = isP1Turn ? 'p2' : 'p1';

            if (battle.wildMode && battle.turn === 'p2') {
                // It's the wild Pokémon's turn. There's no real second player
                // (p2Id is the placeholder 'wild'), so the bot plays this move
                // itself instead of waiting forever for input nobody can send.
                const wildMoves = getMovesForPokemon(battle.p2.name);
                const wildMove = wildMoves[Math.floor(Math.random() * wildMoves.length)];
                const wDmg = rollMoveDamage(wildMove, battle.p2.atk);
                battle.p1.hp = Math.max(0, battle.p1.hp - wDmg);

                moveMsg += `\n🟢 *${battle.p2.emoji} ${battle.p2.name}* used *${wildMove.emoji} ${wildMove.name}*!\n` +
                           `💥 Dealt *${wDmg} damage* to ${battle.p1.emoji} ${battle.p1.name}!\n` +
                           `❤️ ${battle.p1.name} HP: ${makeProgressBar(battle.p1.hp, battle.p1.maxHp)} (${battle.p1.hp}/${battle.p1.maxHp})\n`;

                if (battle.p1.hp <= 0) {
                    // Player's Pokémon fainted — battle over, wild Pokémon gets away
                    delete activeBattles[battleId];
                    initUser(myId);
                    const party = db[myId].pokemon || [];
                    const found = party.find(p => p.name.toLowerCase() === battle.p1.name.toLowerCase());
                    if (found) found.hp = battle.p1.hp;
                    saveDB();
                    moveMsg += `\n💀 *${battle.p1.name} fainted!* The wild ${battle.p2.emoji} ${battle.p2.name} got away!\n` +
                               `💡 Heal your Pokémon with \`.feed\` before battling again.`;
                    return chatObj.sendMessage(moveMsg, { mentions: [myId] }).catch(() => {});
                }

                // Back to the player's turn
                battle.turn = 'p1';
            }

            const nextId    = battle.turn === 'p1' ? battle.p1Id : battle.p2Id;
            const nextPoke  = battle.turn === 'p1' ? battle.p1 : battle.p2;
            const nextMoves = getMovesForPokemon(nextPoke.name);
            moveMsg += `\n⏳ <@${nextId}>'s turn! *${nextPoke.emoji} ${nextPoke.name}*'s moves:\n`;
            nextMoves.forEach((m, i) => { moveMsg += `${i+1}. ${m.emoji} *${m.name}* (${m.damage[0]}-${m.damage[1]} dmg)${m.special ? ' ✨' : ''}\n`; });
            moveMsg += `\nReply with move number or name!`;
            return chatObj.sendMessage(moveMsg, { mentions: [nextId] }).catch(() => {});
        }

        // ── AFK: welcome back on ANY message (before dot-command gate) ────────
        const _chatIdForAfk = chatObj.id._serialized;
        if (db._config.afk && db._config.afk[senderId] && !body.toLowerCase().startsWith('.afk')) {
            const afkData = db._config.afk[senderId];
            const elapsed = Date.now() - afkData.since;
            const totalSec = Math.floor(elapsed / 1000);
            const hrs  = Math.floor(totalSec / 3600);
            const mins = Math.floor((totalSec % 3600) / 60);
            const secs = totalSec % 60;
            let duration = '';
            if (hrs > 0)       duration = `${hrs}h ${mins}m`;
            else if (mins > 0) duration = `${mins}m ${secs}s`;
            else               duration = `${secs}s`;
            delete db._config.afk[senderId];
            saveDB();
            await chatObj.sendMessage(
                `👋 Welcome back <@${senderId}>!\n` +
                `⏱️ You were AFK for *${duration}*` +
                (afkData.reason ? `\n💬 AFK reason was: _${afkData.reason}_` : ''),
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // Only process dot-commands from here
        if (!body.startsWith('.')) return;
        const chatId = chatObj.id._serialized;
        const _botActiveHere = isBotActiveInChat(chatId);
        const onboardingCommand = ['.reg', '.menu', '.help'].includes(body.split(/\s+/)[0].toLowerCase());
        if (!_botActiveHere && !onboardingCommand && body !== '.bot on' && body !== '.bot off' && body !== '.lobby' && body !== '.unlobby' && body !== '.kick' && !body.startsWith('.pp') && body !== '.mods' && body !== '.owners' && body !== '.ppp' && body !== '.modhelp') return;

        // ── BAN GATE — silently block banned users from all bot features ──────
        if (db._config.bannedUsers[senderId] && !MOD_NUMBERS.includes(senderId) && !FBI_NUMBERS.includes(senderId)) return;

        const args = body.split(' ').filter(a => a !== '');
        const command = args[0].toLowerCase();

        // ── .reg — create an account. Required before any other command works ──
        if (command === '.reg') {
            if (isRegistered(senderId)) {
                return msg.reply('✅ You\'re already registered! Type `.menu` to see what you can do.').catch(() => {});
            }
            initUser(senderId);
            db[senderId].registered = true;
            db[senderId].wallet = 100_000;
            db[senderId].registeredAt = Date.now();
            saveDB();
            return msg.reply(
                `🎉 *WELCOME!* 🎉\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `✅ Your account has been created!\n` +
                `👛 Starting wallet: *$0*\n` +
                `🎁 *Bonus:* +$100,000 welcome gift awarded!\n\n` +
                `💡 Type \`.menu\` to see all available commands and start earning!`
            ).catch(() => {});
        }
        
 

        // ── .afk — mark yourself as Away From Keyboard ───────────────────────
        if (command === '.afk') {
            const reason = args.slice(1).join(' ') || null;
            if (db._config.afk[senderId]) {
                // Already AFK — remove it
                delete db._config.afk[senderId];
                saveDB();
                return msg.reply('✅ AFK removed! You\'re back.').catch(() => {});
            }
            db._config.afk[senderId] = { since: Date.now(), reason };
            saveDB();
            return msg.reply(
                `💤 *You're now AFK!*\n` +
                (reason ? `📝 Reason: _${reason}_\n` : '') +
                `_The bot will welcome you back when you return._`
            ).catch(() => {});
        }

        // ── REGISTRATION GATE — guide first-time users ─────────────────────────
        if (!isRegistered(senderId)) {
            return msg.reply(
                '👋 *WELCOME TO TRYANT!* 🏦🎮\n\n' +
                'You have not registered yet, so your account is not active.\n' +
                '📝 Type **.reg** to create your free Tryant account.\n\n' +
                'After registering you can use:\n' +
                '💰 Economy & games • 🏦 Bank & loans • 🎰 Gambling • 🐾 Pokémon\n' +
                '🌟 Profile XP & levels • 🎁 Level gifts\n\n' +
                '🐾 *Pokémon tip:* after registering, use **.catch** when a weak Pokémon appears to start your journey!'
            ).catch(() => {});
        }

        // Loan-default restriction: allow profile/balance and repayment/status while debt is outstanding.
        if (db[senderId].loanDefaultBanUntil && Date.now() < db[senderId].loanDefaultBanUntil) {
            const allowed = ['.loan', '.p', '.profile', '.bal'].includes(command);
            if (!allowed) return msg.reply('🚫 Your account is under a temporary loan-default restriction.\n💸 Repay your debt with **.loan repay** to restore normal access.').catch(() => {});
        }

        // ── LOBBY GC: block forbidden commands ───────────────────────────────
        if (isGroupChat && isLobbyGC(chatId) && LOBBY_BLOCKED_COMMANDS.has(command)) {
            return msg.reply('🏛️ *Lobby GC Mode* — This command is not available here.\n_Gambling & Pokemon catching are disabled in lobby groups._').catch(() => {});
        }

        // ── POKÉMON GC: block gambling commands (Pokémon-only zone) ─────────
        const POKEMON_GC_GAMBLING_BLOCK = new Set([
            '.casino', '.slots', '.roulette', '.db', '.double', '.cf', '.coinflip', '.rob'
        ]);
        if (isGroupChat && db._config.pokemonChannelId && chatId === db._config.pokemonChannelId && POKEMON_GC_GAMBLING_BLOCK.has(command)) {
            return msg.reply('🐾 *Pokémon GC Mode* — Gambling is not allowed here!\n_This channel is for Pokémon battles and catching only._').catch(() => {});
        }

        // ── WILD SPAWN CHECK — skip in lobby GCs, skip if not pokemon GC ────────────────────────────
        if (isGroupChat && command !== '.catch' && command !== '.throwball' && !isLobbyGC(chatId)) {
            // If a dedicated Pokémon GC is set, only spawn wild Pokémon there
            const _pokemonChanId = db._config.pokemonChannelId;
            const _canSpawnHere = !_pokemonChanId || chatId === _pokemonChanId;
            const _dedicatedAutoSpawn = !!(_pokemonChanId && chatId === _pokemonChanId);
            if (_canSpawnHere && !_dedicatedAutoSpawn && checkWildSpawn(chatObj.id._serialized)) {
                const wild = pickWildPokemon(chatObj.id._serialized);
                const cid = chatObj.id._serialized;
                wildPokemonState[cid] = { pokemon: { ...wild, currentHp: wild.hp }, spawnTime: Date.now(), weakened: false };

                const spawnCard = `🌿 *A WILD POKÉMON APPEARED IN THE TALL GRASS!* 🌿\n` +
                                  `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                                  `${wild.emoji} *${wild.name}* [${wild.rarity}] appeared!\n` +
                                  `❤️ HP: ${wild.hp} | ⚔️ ATK: ${wild.atk}\n\n` +
                                  `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                                  `🥊 Type *.catch* to battle it!\n` +
                                  `_(Flees in 3 minutes if nobody challenges!)_`;
                try {
                    const media = await getPokemonArtMedia(wild.dexId);
                    await chatObj.sendMessage(media, { caption: spawnCard });
                } catch (_) {
                    await chatObj.sendMessage(spawnCard);
                }
                setTimeout(() => {
                    if (wildPokemonState[cid] && !wildPokemonState[cid].weakened) {
                        delete wildPokemonState[cid];
                        chatObj.sendMessage(`💨 *Wild ${wild.emoji} ${wild.name} fled into the bushes!* Nobody was brave enough.`).catch(() => {});
                    }
                }, 3 * 60 * 1000);
            }
        }

        // ── .mods / .help ─────────────────────────────────────────────────────
        if (command === '.mods' || command === '.help') {
            const requester = senderId.split('@')[0];
            let adminIds = [];
            if (isGroupChat && chatObj.participants) {
                adminIds = chatObj.participants
                    .filter(p => p.isAdmin || p.isSuperAdmin)
                    .map(p => p.id._serialized);
            }
            for (const m of MOD_NUMBERS) {
                if (!adminIds.includes(m)) adminIds.push(m);
            }
            const adminTags = adminIds.map(id => `• <@${id}>`).join('\n');
            const modMsg = `📢 *MOD ALERT — HELP NEEDED!* 📢\n` +
                           `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                           `⚠️ @${requester} from this group needs assistance!\n\n` +
                           `👮 Tagging Admins/Moderators:\n${adminTags}\n\n` +
                           `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                           `_Please attend to the group as soon as possible!_`;
            return chatObj.sendMessage(modMsg, { mentions: [senderId, ...adminIds] }).catch(() => {});
        }


        // ── .debugme — full raw debug ─────────────────────────────────────────
        if (command === '.debugme') {
            try {
                const parts = chatObj.participants || [];
                const adminList = parts.filter(p => p.isAdmin || p.isSuperAdmin).map(p => p.id?._serialized);
                // Re-check isMod fresh with detailed logging
                const rawAuthorId = typeof msg.author === 'string' ? msg.author : (msg.author?.id || 'UNDEFINED');
                const inModList = MOD_NUMBERS.includes(rawAuthorId);
                let memberPerms = 'N/A';
                if (msg.guild) {
                    const m = await msg.guild.members.fetch(rawAuthorId).catch(() => null);
                    if (m) memberPerms = [...m.permissions.toArray()].join(', ');
                    else memberPerms = 'Member not found in guild';
                }
                return msg.reply(
                    '🔍 *DEBUG INFO*\n' +
                    '━━━━━━━━━━━━━━━━━━━━\n' +
                    '🆔 Your ID: `' + rawAuthorId + '`\n' +
                    '📋 MOD_NUMBERS: `' + MOD_NUMBERS.join(', ') + '`\n' +
                    '✅ In MOD list: ' + inModList + '\n' +
                    '👮 isMod result: ' + isMod + '\n' +
                    '🏠 Has guild: ' + !!msg.guild + '\n' +
                    '👥 Participants fetched: ' + parts.length + '\n' +
                    '🛡️ Admins in server: ' + (adminList.join(', ') || 'none') + '\n' +
                    '🔑 Your permissions: ' + memberPerms
                ).catch(() => {});
            } catch(e) {
                return msg.reply('debug error: ' + e.message).catch(() => {});
            }
        }
        // ── .owners ───────────────────────────────────────────────────────────
        if (command === '.owners') {
            // No isMod check — anyone can see who the owners are
            // Only shows OWNER_NUMBERS (not regular mods)
            const ownerTags = OWNER_NUMBERS.map(m => `• <@${m}>`).join('\n');
            const ownerMsg = `👑 *GROUP OWNERS* 👑\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                             `${ownerTags}\n\n` +
                             `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
            return chatObj.sendMessage(ownerMsg, { mentions: OWNER_NUMBERS }).catch(() => {});
        }

        // ── .gamble ───────────────────────────────────────────────────────────
        if (command === '.gamble') {
            const r = ensureDynamicGamblingRates();
            return msg.reply(
                `🎰 *CASINO DISTRICT — GAMBLING GUIDE* 🎰
` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬

` +
                `🎰 *.casino [bet]* — **38% WR · 2.4× payout** · CD: 5 min

` +
                `🎰 *.slots [bet]* — **30% WR · 2.5× payout** · CD: 1 min

` +
                `🎡 *.roulette [red/black/green] [bet]* — **25% WR · 1.9× payout** · CD: 1 min

` +
                `⚖️ *.db [bet]* — **33% WR · 1.9× payout** · CD: 1 min · Max 15/day

` +
                `🪙 *.cf [heads/tails] [bet]* — **25% WR · 1.9× payout** · CD: 1 min

` +
                `🛡️ *WAGER CAP* — Every individual wager is limited to **5% of your total wealth**.

` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
` +
                `💡 _All games are luck-based. Gamble responsibly!_`
            );
        }

        // ── .pokemon — detailed Pokémon game guide ──────────────────────────────
        if (command === '.pokemon') {
            return msg.reply(
                `🐾 *POKÉMON GAME — FULL GUIDE* 🐾\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🌿 *CATCHING*\n` +
                `Wild Pokémon spawn roughly **2× per hour** at random 25–35 minute intervals (flees after 3 min).\n` +
                `🥊 *.catch* — Battle the wild Pokémon to weaken it. (groups only)\n` +
                `🎯 *.throwball [type]* — Throw a ball at a weakened wild Pokémon to catch it. Higher-tier balls = better odds. (flees 30s after being weakened)\n\n` +
                `⚔️ *BATTLING*\n` +
                `🥊 *.battle [@user]* — Challenge another player to a PvP battle. Win for the victory — **no cash/XP reward is given**.\n` +
                `✅ *.accept* / ❌ *.reject* — Accept or decline an incoming battle challenge.\n` +
                `💥 During a battle, reply with a move *number* or *name* on your turn.\n\n` +
                `🩺 *TEAM CARE*\n` +
                `❤️ *.health* — Check your active Pokémon's HP & status.\n` +
                `🍗 *.feed [pokemon] [food]* — Heal & buff your Pokémon with food.\n` +
                `🔄 *.use [pokemon]* — Switch which Pokémon is active for battles.\n` +
                `🎒 *.inv* — View your full inventory & Pokémon roster.\n\n` +
                `🛒 *GEAR & TRADING*\n` +
                `🏪 *.pstore* — Buy Pokéballs, food & Pokémon items.\n` +
                `💵 *.buy [item]* — Purchase a specific item directly.\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💡 _Tip: stronger/rarer Pokémon hit harder in battle — check \`.health\` before challenging anyone!_`
            );
        }

        // ── .ll — Check lottery status ──────────────────────────────────────────
        if (command === '.ll') {
            const lottery = db._config.lottery;
            const entries = lottery.entries;

            // Resolve display names for entrants (no pings)
            const entrantNames = [];
            for (const id of entries) {
                let uName = id;
                try {
                    const du = await client.users.fetch(id).catch(() => null);
                    if (du) uName = du.displayName || du.username || id;
                    if (msg.guild) {
                        const mem = await msg.guild.members.fetch(id).catch(() => null);
                        if (mem) uName = mem.nickname || mem.displayName || uName;
                    }
                } catch (_) {}
                entrantNames.push(uName);
            }

            let out = `🎰 *LOTTERY STATUS* 🎰\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            out += `👥 *Entrants:* ${entries.length}/${LOTTERY_POOL_SIZE}\n`;
            if (entrantNames.length > 0) {
                out += entrantNames.map((name, i) => `   ${i + 1}. ${name}`).join('\n') + '\n';
            }
            out += `\n🎟️ *Ticket price:* $${formatNum(LOTTERY_TICKET_PRICE)}\n`;
            out += entries.includes(senderId)
                ? `✅ You're entered this round!\n`
                : `❌ You haven't entered — buy a ticket with \`.buy lottery\`\n`;
            out += `\n🏆 *PRIZES*\n`;
            LOTTERY_PRIZES.forEach(p => {
                out += `   ${p.label}: $${p.min}-$${p.max}\n`;
            });
            out += `   💀 Rest: nothing\n\n`;
            const announceChan = lottery.announceChannelId
                ? `<#${lottery.announceChannelId}>`
                : '_not set yet — results will post in whichever GC fills the pool_';
            out += `📢 *Results announced in:* ${announceChan}\n\n`;
            if (lottery.lastResult) {
                const r = lottery.lastResult;
                // Resolve winner names (no pings in .ll status)
                out += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n📜 *Last round's winners:*\n`;
                for (const w of r.winners) {
                    let wName = w.userId;
                    try {
                        const du = await client.users.fetch(w.userId).catch(() => null);
                        if (du) wName = du.displayName || du.username || w.userId;
                        if (msg.guild) {
                            const mem = await msg.guild.members.fetch(w.userId).catch(() => null);
                            if (mem) wName = mem.nickname || mem.displayName || wName;
                        }
                    } catch (_) {}
                    out += `   ${w.label}: ${wName} (+$${formatNum(w.amount)})\n`;
                }
            }
            return chatObj.sendMessage(out, { allowedMentions: { parse: [] } }).catch(() => {});
        }

        // ── .lll — MOD ONLY: designate this GC as the lottery announcement GC ──
        if (command === '.lll') {
            if (!isMod) return msg.reply('❌ Only mods/owners can set the lottery announcement GC.');
            if (!isGroupChat) return msg.reply('❌ `.lll` must be run inside the group chat you want results announced in.');
            db._config.lottery.announceChannelId = chatId;
            saveDB();
            return chatObj.sendMessage(
                `🎰 *LOTTERY ANNOUNCEMENT GC SET!* 🎰\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `📢 This group chat is now the official *lottery results* announcement channel.\n` +
                `🎟️ Users can still buy tickets (\`.buy lottery\`) from any GC — results will always be posted here once 5 entrants join.\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Set by <@${senderId}>_`,
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // ── DEV CHEATS ────────────────────────────────────────────────────────


        if (command === '.bot') {
            if (!isMod) return msg.reply('❌ Only group admins can use this command.');
            const action = args[1] ? args[1].toLowerCase() : '';
            if (action === 'off') {
                if (isGroupChat) { db._config.gcActive[chatId] = false; }
                else { db._config.botActive = false; }
                saveDB();
                return msg.reply('🔴 Bot deactivated in *this* group.');
            } else if (action === 'on') {
                if (isGroupChat) { db._config.gcActive[chatId] = true; }
                else { db._config.botActive = true; }
                saveDB();
                return msg.reply('🟢 Bot active in *this* group.');
            } else return msg.reply('❌ Usage:  or ');
        }

        // ── .lobby — mark/unmark this GC as a lobby ──────────────────────────
        if (command === '.lobby') {
            if (!isMod) return msg.reply('❌ Only group admins can use this command.');
            if (!isGroupChat) return msg.reply('❌ This command only works in groups.');
            db._config.lobbyGCs[chatId] = true; saveDB();
            return msg.reply(
                '🏛️ *LOBBY GC MODE ACTIVATED* 🏛️\n' +
                '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n' +
                '✅ This group is now a *Lobby GC*.\n\n' +
                '📋 *Allowed:* .menu .bal .transfer .wealthy .health .inv .food .buy .amazon .battle .mods .help .owners .bot\n\n' +
                '❌ *Disabled:* All gambling, Pokemon catching & wild spawns\n\n' +
                '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n' +
                '_Type .unlobby to remove lobby mode_'
            );
        }
        if (command === '.unlobby') {
            if (!isMod) return msg.reply('❌ Only group admins can use this command.');
            if (!isGroupChat) return msg.reply('❌ This command only works in groups.');
            delete db._config.lobbyGCs[chatId]; saveDB();
            return msg.reply('✅ Lobby GC mode removed. All features restored.');
        }

        // ── .ppp — MOD ONLY: set this GC as the dedicated Pokémon channel ────
        if (command === '.ppp') {
            if (!isMod) return msg.reply('❌ Only mods can set the Pokémon channel.');
            if (!isGroupChat) return msg.reply('❌ `.ppp` must be run inside the group you want as the Pokémon GC.');
            db._config.pokemonChannelId = chatId;
            saveDB();
            return chatObj.sendMessage(
                `🐾 *POKÉMON GC SET!* 🐾\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `✅ This group is now the dedicated *Pokémon GC*!\n\n` +
                `🌿 Wild Pokémon will **only** spawn here.\n` +
                `🥊 *.catch* and *.throwball* will **only** work here.\n` +
                `⚔️ Pokémon battles (*.battle*) are restricted to this GC.\n` +
                `🚫 *Gambling commands are disabled here* — this is a Pokémon-only zone!\n` +
                `⏱️ Wild Pokémon auto-spawn roughly 2× per hour at random 25–35 minute intervals.\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_Set by <@${senderId}> — use \`.ppp\` in a different GC to change it._`,
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // ── .modhelp — Show all mod-only commands ────────────────────────────
        if (command === '.modhelp') {
            return msg.reply(
                `🛡️ *MOD COMMANDS* 🛡️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `⚙️ *GC CONTROLS*\n` +
                `🟢 *.bot on* / 🔴 *.bot off* — Enable or disable the bot in this GC.\n\n` +
                `🏛️ *.lobby* — Mark this GC as a Lobby GC (disables gambling & Pokémon catching).\n` +
                `🔓 *.unlobby* — Remove lobby mode from this GC.\n\n` +
                `🐾 *.ppp* — Set this GC as the dedicated Pokémon GC. Wild spawns, *.catch*, and *.throwball* only work here.\n\n` +
                `🎰 *.lll* — Set this GC as the lottery results announcement channel.\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 *USER MANAGEMENT*\n` +
                `🔍 *.pp @user* — View full database profile of any user (financials, gambling history, assets).\n\n` +
                `🚪 *.kick @user* — Kick a member from the group.\n\n` +
                `🔨 *.ban @user* — Ban a user from using the bot (reply to their msg or tag them). _Mods + FBI agents._\n\n` +
                `✅ *.unban @user* — Remove a bot ban (reply to their msg or tag them). _Mods + FBI agents._\n\n` +
                `🕵️ *.fbi* — Tag the FBI agents in this group.\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👑 *OWNER ONLY*\n` +
                `➕ *.regmod [user id]* — Promote a user to moderator.\n` +
                `➖ *.removemod [user id]* — Demote a moderator.\n\n` +
                `🕵️ *OWNER + FBI*\n` +
                `➕ *.regagent [user id]* — Recruit a new FBI agent.\n` +
                `➖ *.removeagent [user id]* — Remove an FBI agent.\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_All mod commands require mod/admin permissions._`
            );
        }

        if (!_botActiveHere) return;

        // ── .bal — WALLET / BANK / MONEY ONLY ───────────────────────────────────
        if (command === '.bal') {
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || senderId);
            initUser(target); const u = db[target];
            const netW = (u.wallet || 0) + (u.bank || 0);
            const capacity = getBankCapacity(u);
            const bankPct = isVipActive(u) ? 0 : Math.min(100, Number((((u.bank || 0) / Math.max(1, capacity)) * 100).toFixed(1)));
            let displayName = target, avatarUrl = null;
            try {
                const du = await client.users.fetch(target).catch(() => null);
                if (du) { displayName = du.globalName || du.displayName || du.username || target; avatarUrl = du.displayAvatarURL({ size: 256, extension: 'png' }); }
                if (msg.guild) { const member = await msg.guild.members.fetch(target).catch(() => null); if (member) { displayName = member.nickname || member.displayName || displayName; avatarUrl = member.displayAvatarURL({ size: 256, extension: 'png' }) || avatarUrl; } }
            } catch (_) {}
            const balEmbed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setAuthor({ name: displayName + "'s Balance", iconURL: avatarUrl || undefined })
                .setThumbnail(avatarUrl)
                .addFields(
                    { name: '💰 Wallet', value: '`$' + formatNum(u.wallet || 0) + '`', inline: true },
                    { name: '🏦 Bank', value: '`$' + formatNum(u.bank || 0) + '`', inline: true },
                    { name: '📊 Net Worth', value: '`$' + formatNum(netW) + '`', inline: true },
                    { name: '🏦 Bank Capacity', value: bankPct + '% used', inline: true },
                    { name: '🏅 Civil Score', value: '`' + (u.creditScore || 500) + '/1000` ' + getCreditBand(u.creditScore || 500).label, inline: true },
                )
                .setFooter({ text: '.p for your profile & XP • .bank for deposits/withdrawals' });
            return msg.channel.send({ embeds: [balEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .p / .profile — PROFILE LEVEL, XP & ACTIVITY ONLY ───────────────────
        if (command === '.p' || command === '.profile') {
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || senderId);
            initUser(target); const u = db[target];
            const prof = profileLevelForXp(u.profileXp || 0); u.profileLevel = prof.level;
            const stats = getProfileTypingStats(u);
            let displayName = target, avatarUrl = null;
            try {
                const du = await client.users.fetch(target).catch(() => null);
                if (du) { displayName = du.globalName || du.displayName || du.username || target; avatarUrl = du.displayAvatarURL({ size: 256, extension: 'png' }); }
                if (msg.guild) { const member = await msg.guild.members.fetch(target).catch(() => null); if (member) { displayName = member.nickname || member.displayName || displayName; avatarUrl = member.displayAvatarURL({ size: 256, extension: 'png' }) || avatarUrl; } }
            } catch (_) {}
            const pokemon = u.pokemon || [];
            const nextGift = Object.keys(PROFILE_LEVEL_REWARDS).map(Number).find(l => l > prof.level);
            const profileEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setAuthor({ name: displayName + "'s Tryant Profile", iconURL: avatarUrl || undefined })
                .setThumbnail(avatarUrl)
                .setDescription('🌟 **Profile Level ' + prof.level + '**\n✨ XP: **' + prof.currentXp + '/' + prof.needed + '**\n' + (nextGift ? '🎁 Next gift: **Lv.' + nextGift + '**' : '🎁 All currently configured level gifts unlocked!'))
                .addFields(
                    { name: '🐾 Pokémon', value: '`' + pokemon.length + '` owned', inline: true },
                    { name: '💬 Activity', value: '`' + (u.totalMessages || 0) + '` messages\n`' + (u.totalWords || 0) + '` words', inline: true },
                    { name: '⌨️ Typing Rate', value: '`' + stats.messagesPerMinute.toFixed(1) + ' msg/min`\n`' + stats.wordsPerMinute.toFixed(1) + ' words/min`', inline: true },
                    { name: '📅 Streak', value: '`' + (u.dailyStreak || 0) + ' days`', inline: true },
                )
                .setFooter({ text: '.bal for wallet/bank • .xp [pokemon] for Pokémon XP • Profile XP comes from commands & games only' });
            return msg.channel.send({ embeds: [profileEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .dig ──────────────────────────────────────────────────────────────
        if (command === '.dig') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastDig) / 1000 < CD_DIG) {
                let left = Math.ceil(CD_DIG - (now - db[senderId].lastDig) / 1000);
                return msg.reply(`⏳ Your hands are tired! Wait *${left}s*.`);
            }
            db[senderId].lastDig = now;
            // 5% treasure box | 15% bad luck | 42% nothing | 38% coins
            const chance = Math.random() * 100;

            if (chance <= 5) {
                // 🎁 TREASURE BOX — 1,000,000 gold coins
                const treasureWin = 1000000;
                db[senderId].wallet += treasureWin; saveDB();
                const treasureEmbed = new EmbedBuilder()
                    .setColor(0xF1C40F)
                    .setTitle('🎁 TREASURE BOX FOUND!')
                    .setDescription(
                        `🏆 **INCREDIBLE!** You unearthed a **TRYANT Treasure Box**!\n\n` +
                        `💰 **Gold Coins** › \`+$${formatNum(treasureWin)}\`\n` +
                        `👛 **Wallet** › \`$${formatNum(db[senderId].wallet)}\``
                    )
                    .setThumbnail('attachment://treasure_box.png')
                    .setFooter({ text: 'Rare find! Only 2% chance!' });
                try {
                    return await msg.channel.send({
                        embeds: [treasureEmbed],
                        files: [new AttachmentBuilder(ASSETS.treasureBox, { name: 'treasure_box.png' })],
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    });
                } catch (_) {
                    return msg.channel.send({ embeds: [treasureEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
                }

            } else if (chance <= 20) {
                let loss = Math.min(Math.floor(Math.random() * 900) + 400, db[senderId].wallet);
                db[senderId].wallet -= loss; saveDB();
                const digLossEmbed = new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle('⛏️ Dig')
                    .setDescription(`🧟 A zombie jumped out!\n**Lost** › \`-$${formatNum(loss)}\`\n**Wallet** › \`$${formatNum(db[senderId].wallet)}\``)
                    .setThumbnail('attachment://zombie.png');
                try {
                    return await msg.channel.send({
                        embeds: [digLossEmbed],
                        files: [new AttachmentBuilder(ASSETS.zombie, { name: 'zombie.png' })],
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    });
                } catch (_) {
                    return msg.channel.send({ embeds: [digLossEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
                }

            } else if (chance <= 62) {
                saveDB();
                const digNothingEmbed = new EmbedBuilder().setColor(0x95A5A6).setTitle('⛏️ Dig').setDescription(`🪱 You dug for an hour and found only worms.\n**Result** › Nothing`);
                return msg.channel.send({ embeds: [digNothingEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});

            } else {
                // 💰 Coins find (1,000 – 10,000)
                let coins = Math.floor(Math.random() * 9001) + 1000;
                db[senderId].wallet += coins; saveDB();
                const coinsEmbed = new EmbedBuilder()
                    .setColor(0xF1C40F)
                    .setTitle('💰 You caught coins!')
                    .setDescription(
                        `You dug and found **${formatNum(coins)} coins**!\n\n` +
                        `💰 **Gained** › \`+$${formatNum(coins)}\`\n` +
                        `👛 **Wallet** › \`$${formatNum(db[senderId].wallet)}\``
                    )
                    .setThumbnail('attachment://coin.png')
                    .setFooter({ text: 'Keep digging for more!' });
                try {
                    return await msg.channel.send({
                        embeds: [coinsEmbed],
                        files: [new AttachmentBuilder(ASSETS.coin, { name: 'coin.png' })],
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    });
                } catch (_) {
                    return msg.channel.send({ embeds: [coinsEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
                }
            }
        }

        // ── .fish ─────────────────────────────────────────────────────────────
        if (command === '.fish') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastFish) / 1000 < CD_FISH) {
                let left = Math.ceil(CD_FISH - (now - db[senderId].lastFish) / 1000);
                return msg.reply(`⏳ Wait *${left}s* for fish to gather back.`);
            }
            db[senderId].lastFish = now;
            // 10% shark | 12% golden | 28% salmon | 35% minnow | 15% nothing
            const roll = Math.random() * 100;

            const sendFishEmbed = async (embed, assetKey, fileName) => {
                try {
                    return await msg.channel.send({
                        embeds: [embed],
                        files: [new AttachmentBuilder(ASSETS[assetKey], { name: fileName })],
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    });
                } catch (_) {
                    return msg.channel.send({ embeds: [embed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
                }
            };

            if (roll <= 10) {
                let loss = Math.min(Math.floor(Math.random() * 1200) + 600, db[senderId].wallet);
                db[senderId].wallet -= loss; saveDB();
                const fishSharkEmbed = new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle('🎣 Fishing')
                    .setDescription(`🦈 **SHARK ATTACK!**\n**Lost** › \`-$${formatNum(loss)}\`\n**Wallet** › \`$${formatNum(db[senderId].wallet)}\``)
                    .setThumbnail('attachment://shark.png');
                try {
                    return await msg.channel.send({
                        embeds: [fishSharkEmbed],
                        files: [new AttachmentBuilder(ASSETS.shark, { name: 'shark.png' })],
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    });
                } catch (_) {
                    return msg.channel.send({ embeds: [fishSharkEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
                }

            } else if (roll <= 22) {
                db[senderId].inventory.goldenFish = (db[senderId].inventory.goldenFish || 0) + 1; saveDB();
                const fishGoldEmbed = new EmbedBuilder()
                    .setColor(0xF1C40F)
                    .setTitle('🎣 Fishing')
                    .setDescription(`✨ **LEGENDARY CATCH!**\nYou reeled in a **Golden Fish**!\n*Check \`.inv\` to see it*`)
                    .setThumbnail('attachment://fish_gold.png');
                return sendFishEmbed(fishGoldEmbed, 'fishGold', 'fish_gold.png');

            } else if (roll <= 50) {
                db[senderId].inventory.salmon = (db[senderId].inventory.salmon || 0) + 1; saveDB();
                const fishSalmonEmbed = new EmbedBuilder()
                    .setColor(0xE67E22)
                    .setTitle('🎣 Fishing')
                    .setDescription(`🐟 **Nice catch!** Premium Salmon hooked!\n*Sell with \`.sell salmon\`*`)
                    .setThumbnail('attachment://fish_salmon.png');
                return sendFishEmbed(fishSalmonEmbed, 'fishSalmon', 'fish_salmon.png');

            } else if (roll <= 85) {
                db[senderId].inventory.fish = (db[senderId].inventory.fish || 0) + 1; saveDB();
                const fishMinnowEmbed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setTitle('🎣 Fishing')
                    .setDescription(`🐟 Caught a small **Minnow Fish**.\n*Sell with \`.sell fish\`*`)
                    .setThumbnail('attachment://fish_blue.png');
                return sendFishEmbed(fishMinnowEmbed, 'fishBlue', 'fish_blue.png');

            } else {
                saveDB();
                const fishNothingEmbed = new EmbedBuilder().setColor(0x95A5A6).setTitle('🎣 Fishing').setDescription(`🌊 Sat on the dock for 45 minutes. Nothing bit.`);
                return msg.channel.send({ embeds: [fishNothingEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }
        }

        // ── .casino ───────────────────────────────────────────────────────────
        if (command === '.casino') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastCasino) / 1000 < getEffectiveCd(senderId, CD_CASINO)) {
                let left = Math.ceil(getEffectiveCd(senderId, CD_CASINO) - (now - db[senderId].lastCasino) / 1000);
                return msg.reply(`🎰 Casino threw you out. Wait *${Math.floor(left/60)}m ${left%60}s*.`);
            }
            let bet = parseAmount(args[1]);
            const gambleCheck = validateGambleBet(senderId, bet);
            if (!gambleCheck.ok) return msg.reply(gambleCheck.reason === 'wealth'
                ? `❌ Max wager is 5% of your total wealth: $${formatNum(gambleCheck.maxBet)}.`
                : '❌ Enter a real bet you own.');
            db[senderId].lastCasino = now;
            const syms = ['🎲','🎰','💎','🃏','💰'];
            let r1 = syms[Math.floor(Math.random()*syms.length)];
            let r2 = syms[Math.floor(Math.random()*syms.length)];
            let r3 = syms[Math.floor(Math.random()*syms.length)];
            const casinoWinChance = getDynamicGamblingRate('casino');
            const won_c = Math.random() * 100 < casinoWinChance;
            const payout = Math.floor(bet * 2.4);
            if (won_c) {
                db[senderId].wallet = db[senderId].wallet - bet + payout;
                checkAmexInvite(senderId).catch(() => {});
            } else {
                db[senderId].wallet -= bet;
            }
            saveDB();
            const casinoEmbed = new EmbedBuilder()
                .setColor(won_c ? 0x2ECC71 : 0xE74C3C)
                .setTitle('🎰 Casino')
                .setDescription(
                    `## [ ${r1} | ${r2} | ${r3} ]

` +
                    `**Bet** › \`$${formatNum(bet)}\`
` +
                    `**Win Rate** › \`${casinoWinChance.toFixed(0)}%\`
` +
                    `**Result** › ${won_c ? `🎉 You won \`$${formatNum(payout)}\` (2.4×)!` : `💀 You lost \`$${formatNum(bet)}\``}
` +
                    `**Wallet** › \`$${formatNum(db[senderId].wallet)}\``
                )
                .setFooter({ text: won_c ? '🔥 Lucky spin!' : '😤 Better luck next time' });
            return msg.channel.send({ embeds: [casinoEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .slots ────────────────────────────────────────────────────────────
        if (command === '.slots') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastSlots) / 1000 < getEffectiveCd(senderId, CD_SLOTS)) {
                let left = Math.ceil(getEffectiveCd(senderId, CD_SLOTS) - (now - db[senderId].lastSlots) / 1000);
                return msg.reply(`⏳ Lever stuck! Wait *${left}s*.`);
            }
            let bet = parseAmount(args[1]);
            const gambleCheck = validateGambleBet(senderId, bet);
            if (!gambleCheck.ok) return msg.reply(gambleCheck.reason === 'wealth'
                ? `❌ Max wager is 5% of your total wealth: $${formatNum(gambleCheck.maxBet)}.`
                : '❌ Usage: `.slots [bet]`');
            db[senderId].lastSlots = now;
            const items = ['🍎','💎','🍓','🍒','🔔'];
            const slotsWinChance = getDynamicGamblingRate('slots');
            const won = Math.random() * 100 < slotsWinChance;
            let r1, r2, r3;
            if (won) {
                r1 = r2 = r3 = items[Math.floor(Math.random()*items.length)];
            } else {
                r1 = items[Math.floor(Math.random()*items.length)];
                r2 = items[Math.floor(Math.random()*items.length)];
                r3 = items[Math.floor(Math.random()*items.length)];
                while (r1 === r2 && r2 === r3) r3 = items[Math.floor(Math.random()*items.length)];
            }
            const payout = Math.floor(bet * 2.5);
            if (won) db[senderId].wallet = db[senderId].wallet - bet + payout;
            else db[senderId].wallet -= bet;
            saveDB();
            const slotsEmbed = new EmbedBuilder()
                .setColor(won ? 0xF1C40F : 0xE74C3C)
                .setTitle('🎰 Slot Machine')
                .setDescription(
                    `## [ ${r1}  |  ${r2}  |  ${r3} ]

` +
                    `**Bet** › \`$${formatNum(bet)}\`
` +
                    `**Win Rate** › \`${slotsWinChance.toFixed(0)}%\`
` +
                    `**Result** › ${won ? `🎉 **JACKPOT!** +$${formatNum(payout)} (2.5×)` : `❌ **No Match** — **-$${formatNum(bet)}**`}
` +
                    `**Wallet** › \`$${formatNum(db[senderId].wallet)}\``
                )
                .setFooter({ text: won ? '🏆 2.5× payout!' : '😬 Spin again?' });
            return msg.channel.send({ embeds: [slotsEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .roulette ─────────────────────────────────────────────────────────
        if (command === '.roulette') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastRoulette) / 1000 < getEffectiveCd(senderId, CD_ROULETTE)) {
                let left = Math.ceil(getEffectiveCd(senderId, CD_ROULETTE) - (now - db[senderId].lastRoulette) / 1000);
                return msg.reply(`⏳ Wheel spinning. Wait *${left}s*.`);
            }
            const space = args[1] ? args[1].toLowerCase() : '';
            const bet = parseAmount(args[2]);
            const gambleCheck = validateGambleBet(senderId, bet);
            if (!['red','black','green'].includes(space) || !gambleCheck.ok)
                return msg.reply(gambleCheck.reason === 'wealth'
                    ? `❌ Max wager is 5% of your total wealth: $${formatNum(gambleCheck.maxBet)}.`
                    : '❌ Format: `.roulette [red/black/green] [bet]`');
            db[senderId].lastRoulette = now;

            const rouletteWinChance = getDynamicGamblingRate('roulette');
            const won_r = Math.random() * 100 < rouletteWinChance;
            const colorPool = space === 'red' ? ['red','black'] : space === 'black' ? ['black','red'] : ['green','red','black'];
            const landedColor = won_r ? space : colorPool.find(c => c !== space) || 'red';
            const rollNum = landedColor === 'green'
                ? 0
                : (landedColor === 'red'
                    ? [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36][Math.floor(Math.random()*18)]
                    : [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35][Math.floor(Math.random()*18)]);
            const payout = Math.floor(bet * 1.9);
            if (won_r) db[senderId].wallet = db[senderId].wallet - bet + payout;
            else db[senderId].wallet -= bet;
            saveDB();

            const colorEmoji = landedColor === 'red' ? '🔴' : landedColor === 'black' ? '⚫' : '🟢';
            const betEmoji = space === 'red' ? '🔴' : space === 'black' ? '⚫' : '🟢';
            const rouletteEmbed = new EmbedBuilder()
                .setColor(landedColor === 'red' ? 0xE74C3C : landedColor === 'green' ? 0x2ECC71 : 0x2C2F33)
                .setTitle('🎡 Roulette')
                .setDescription(
                    `**Ball landed on** › ${colorEmoji} **${rollNum}** (${landedColor})
` +
                    `**Your bet** › ${betEmoji} ${space} · \`$${formatNum(bet)}\`
` +
                    `**Win Rate** › \`${rouletteWinChance.toFixed(0)}%\` · **Payout** › 1.9×

` +
                    `**Result** › ${won_r ? `🎉 You won \`$${formatNum(payout)}\`!` : `💀 You lost \`$${formatNum(bet)}\``}
` +
                    `**Wallet** › \`$${formatNum(db[senderId].wallet)}\``
                )
                .setFooter({ text: '🎯 1.9× payout' });
            return msg.channel.send({ embeds: [rouletteEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .db / .double ─────────────────────────────────────────────────────
        if (command === '.db' || command === '.double') {
            initUser(senderId); checkDailyReset(senderId);
            if (db[senderId].dailyDbCount >= 15) return msg.reply('⚖️ Daily cap reached! Max 15/day.');
            const now = Date.now();
            if ((now - db[senderId].lastDb) / 1000 < getEffectiveCd(senderId, CD_DB)) {
                let left = Math.ceil(getEffectiveCd(senderId, CD_DB) - (now - db[senderId].lastDb) / 1000);
                return msg.reply(`⏳ Wait *${left}s*.`);
            }
            const bet = parseAmount(args[1]);
            const gambleCheck = validateGambleBet(senderId, bet);
            if (!gambleCheck.ok) return msg.reply(gambleCheck.reason === 'wealth'
                ? `❌ Max wager is 5% of your total wealth: $${formatNum(gambleCheck.maxBet)}.`
                : '❌ Invalid bet.');
            db[senderId].lastDb = now; db[senderId].dailyDbCount += 1;

            const dbWinChance = getDynamicGamblingRate('double');
            const won = Math.random() * 100 < dbWinChance;
            const payout = Math.floor(bet * 1.9);
            if (won) db[senderId].wallet = db[senderId].wallet - bet + payout;
            else db[senderId].wallet -= bet;
            saveDB();

            const dbEmbed = new EmbedBuilder()
                .setColor(won ? 0x2ECC71 : 0xE74C3C)
                .setTitle('📈 Double or Nothing')
                .setDescription(
                    `**Result** › ${won ? `🟢 **WON!** +$${formatNum(payout)} (1.9×)` : `🔴 **CRASHED!** -$${formatNum(bet)}`}
` +
                    `**Win Rate** › \`${dbWinChance.toFixed(0)}%\`
` +
                    `**Wallet** › \`$${formatNum(db[senderId].wallet)}\`
` +
                    `**Uses today** › ${db[senderId].dailyDbCount}/15`
                )
                .setFooter({ text: won ? '🔥 1.9× payout!' : '😬 Better luck next time' });
            return msg.channel.send({ embeds: [dbEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .cf / .coinflip ───────────────────────────────────────────────────
        if (command === '.cf' || command === '.coinflip') {
            initUser(senderId); const now = Date.now();
            if ((now - db[senderId].lastCoinflip) / 1000 < getEffectiveCd(senderId, CD_COINFLIP)) {
                let left = Math.ceil(getEffectiveCd(senderId, CD_COINFLIP) - (now - db[senderId].lastCoinflip) / 1000);
                return msg.reply(`⏳ Wait *${left}s*.`);
            }
            const userChoice = args[1] ? args[1].toLowerCase() : '';
            const bet = parseAmount(args[2]);
            const gambleCheck = validateGambleBet(senderId, bet);
            if (!['h','t','heads','tails'].includes(userChoice) || !gambleCheck.ok)
                return msg.reply(gambleCheck.reason === 'wealth'
                    ? `❌ Max wager is 5% of your total wealth: $${formatNum(gambleCheck.maxBet)}.`
                    : '❌ Syntax: `.cf [heads/tails] [bet]`');
            db[senderId].lastCoinflip = now;
            const choiceMap = { h:'heads', t:'tails', heads:'heads', tails:'tails' };
            const pick = choiceMap[userChoice];
            const cfWinChance = getDynamicGamblingRate('coinflip');
            const won = Math.random() * 100 < cfWinChance;
            const spin = won ? pick : (pick === 'heads' ? 'tails' : 'heads');
            const spinEmoji = spin === 'heads' ? '🪙' : '📀';
            const payout = Math.floor(bet * 1.9);
            if (won) db[senderId].wallet = db[senderId].wallet - bet + payout;
            else db[senderId].wallet -= bet;
            saveDB();

            const cfEmbed = new EmbedBuilder()
                .setColor(won ? 0x2ECC71 : 0xE74C3C)
                .setTitle('🪙 Coin Flip')
                .setDescription(
                    `**Coin** › ${spinEmoji} **${spin.charAt(0).toUpperCase()+spin.slice(1)}**
` +
                    `**Your pick** › ${pick}
` +
                    `**Bet** › \`$${formatNum(bet)}\`
` +
                    `**Win Rate** › \`${cfWinChance.toFixed(0)}%\` · **Payout** › 1.9×

` +
                    `**Result** › ${won ? `🎉 You won \`$${formatNum(payout)}\`!` : `💀 You lost \`$${formatNum(bet)}\``}
` +
                    `**Wallet** › \`$${formatNum(db[senderId].wallet)}\``
                )
                .setFooter({ text: won ? '🔥 1.9× payout!' : '😤 Flip it again' });
            return msg.channel.send({ embeds: [cfEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .deposit / .withdraw ──────────────────────────────────────────────
        if (command === '.deposit' || command === '.dep') {
            initUser(senderId);
            if (db[senderId].wallet <= 0) return msg.reply('❌ Nothing to deposit.');
            const bankSpace = getBankCapacity(db[senderId]) - db[senderId].bank;
            if (bankSpace <= 0) return msg.reply(`❌ Your bank is full! Capacity: *${formatCapacity(db[senderId])}*\nBuy more space with \`.bank buy <1-10>\` or go unlimited with \`.vip buy\`.`);
            let s = args[1]; let amt = (!s || s.toLowerCase() === 'all') ? db[senderId].wallet : parseAmount(s, db[senderId].wallet);
            if (isNaN(amt) || amt <= 0 || amt > db[senderId].wallet) return msg.reply('❌ Invalid amount.');
            if (amt > bankSpace) {
                amt = bankSpace;
                await msg.reply(`⚠️ Bank almost full — only depositing *$${formatNum(amt)}* (remaining space). Buy more capacity with \`.bank buy <1-10>\`.`).catch(() => {});
            }
            db[senderId].wallet -= amt; db[senderId].bank += amt; saveDB();
            const depEmbed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setTitle('🏦 Deposit Successful')
                .addFields(
                    { name: '✅ Deposited', value: `\`+${formatNum(amt)}\``, inline: true },
                    { name: '💰 Wallet', value: `\`${formatNum(db[senderId].wallet)}\``, inline: true },
                    { name: '🏦 Bank', value: `\`${formatNum(db[senderId].bank)}\``, inline: true },
                )
                .setThumbnail('attachment://deposit.png')
                .setFooter({ text: 'Use .wd to withdraw funds' });
            try {
                return await msg.channel.send({ embeds: [depEmbed], files: [new AttachmentBuilder(ASSETS.deposit, { name: 'deposit.png' })], reply: { messageReference: msg.id, failIfNotExists: false } });
            } catch (_) {
                return msg.channel.send({ embeds: [depEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }
        }

        if (command === '.withdraw' || command === '.wd') {
            initUser(senderId); let s = args[1];
            if (!s) return msg.reply('❌ Enter amount to withdraw.');
            let amt = parseAmount(s, db[senderId].bank);
            if (isNaN(amt) || amt <= 0 || amt > db[senderId].bank) return msg.reply("❌ You don't have that in bank.");
            db[senderId].bank -= amt; db[senderId].wallet += amt; saveDB();
            const wdEmbed = new EmbedBuilder()
                .setColor(0xE67E22)
                .setTitle('🏧 Withdrawal Successful')
                .addFields(
                    { name: '✅ Withdrawn', value: `\`+${formatNum(amt)}\``, inline: true },
                    { name: '💰 Wallet', value: `\`${formatNum(db[senderId].wallet)}\``, inline: true },
                    { name: '🏦 Bank', value: `\`${formatNum(db[senderId].bank)}\``, inline: true },
                )
                .setThumbnail('attachment://withdraw.png')
                .setFooter({ text: 'Use .dep to deposit funds back • Spend wisely!' });
            try {
                return await msg.channel.send({ embeds: [wdEmbed], files: [new AttachmentBuilder(ASSETS.withdraw, { name: 'withdraw.png' })], reply: { messageReference: msg.id, failIfNotExists: false } });
            } catch (_) {
                return msg.channel.send({ embeds: [wdEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }
        }

        // ── .upgrades / .u1-.u10 — bank capacity upgrades ─────────────────────
        if (command === '.upgrades' || /^\.u(?:10|[1-9])$/.test(command)) {
            initUser(senderId);
            const u = db[senderId];
            const directId = command === '.upgrades' ? null : parseInt(command.slice(2), 10);
            if (directId === null) {
                const lines = CAPACITY_PACKAGES.map(p =>
                    `\`${p.id}\` *${p.label}* — costs *$${formatNum(p.cost)}* → new total: *$${formatNum(u.maxCapacity + p.increase)}* → buy with \.u${p.id}`
                ).join('\n');
                const vipLine = isVipActive(u)
                    ? `💎 VIP active — bank space is UNLIMITED until <t:${Math.floor(u.vip.expiresAt / 1000)}:R>`
                    : `💎 VIP — \.vip buy for unlimited bank space`;
                return msg.channel.send({ embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('🏦 Bank Capacity Upgrades').setDescription(`Current capacity: **${formatCapacity(u)}**\n\n${lines}\n\n${vipLine}`).setFooter({ text: 'Type .u1 through .u10 to buy an upgrade' })], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }
            const pkg = CAPACITY_PACKAGES.find(p => p.id === directId);
            if (!pkg) return msg.reply('❌ Invalid upgrade. Use `.upgrades`.');
            const totalFunds = (u.wallet || 0) + (u.bank || 0);
            if (totalFunds < pkg.cost) return msg.reply(`❌ Need *$${formatNum(pkg.cost)}* but you only have *$${formatNum(totalFunds)}*.`);
            if (!u.firstUpgradeGuideShown) {
                u.firstUpgradeGuideShown = true;
                saveDB();
                await msg.reply('🏦 *BANK CAPACITY GUIDE*\n\nYour bank has a storage limit. Upgrades increase how much you can safely keep in the bank.\n💡 Buy capacity as your wealth grows; do not spend money on an upgrade you do not need yet.').catch(() => {});
            }
            let rem = pkg.cost;
            if (u.wallet >= rem) u.wallet -= rem;
            else { rem -= u.wallet; u.wallet = 0; u.bank = Math.max(0, u.bank - rem); }
            u.maxCapacity += pkg.increase;
            saveDB();
            return msg.reply(`🏦 *UPGRADE ${pkg.id} PURCHASED!*\n📦 ${pkg.label}\n💰 Paid: $${formatNum(pkg.cost)}\n📈 New capacity: $${formatNum(u.maxCapacity)}\n\n_Next upgrade: \.u${Math.min(10, pkg.id + 1)}_`);
        }

        // ── .bank ────────────────────────────────────────────────────────────
        if (command === '.bank' || command === '.loan') {
            initUser(senderId);
            const u   = db[senderId];
            if (u.creditScore === undefined) u.creditScore = 500;
            if (u.bankLoanCount === undefined) u.bankLoanCount = 0;
            if (u.bankLoan      === undefined) u.bankLoan      = null;
            if (!u.maxCapacity || u.maxCapacity < BANK_DEFAULT_CAPACITY) u.maxCapacity = BANK_DEFAULT_CAPACITY;

            const bankSub = command === '.loan' ? ((args[1] || '').toLowerCase()) : ((args[1] || '').toLowerCase());
            const loanAmountArg = command === '.loan' ? (args[1] || '') : (args[2] || '');

            // ── .bank  (overview) ─────────────────────────────────────────────
            if (command === '.loan' && (!bankSub || bankSub === 'help')) {
                return msg.reply(`💸 *BANK LOAN SYSTEM*\n\nUse \.loan <amount> to request a bank loan.\n• \.loan <amount> — Request a loan\n• \.loan repay — Repay your active loan\n• \.loan status — View your active loan\n\nLoans are credit-score based; no card collateral is required.`);
            }

            if (command === '.bank' && (!bankSub || bankSub === 'info')) {
                const band     = getCreditBand(u.creditScore);
                const vipOn    = isVipActive(u);
                const bankPct  = vipOn ? 0 : Math.min(100, Number((((Number(u.bank) || 0) / Math.max(1, Number(u.maxCapacity) || BANK_DEFAULT_CAPACITY)) * 100).toFixed(1)));
                const loanLine = u.bankLoan
                    ? `⚠️ Active bank loan: *$${formatNum(u.bankLoan.totalRepay)}* due <t:${Math.floor(u.bankLoan.dueDate / 1000)}:R>`
                    : `✅ No active bank loan`;
                const bankEmbed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setTitle('🏦 Bank Overview')
                    .addFields(
                        { name: '💰 Balance',    value: vipOn
                            ? `\`$${formatNum(u.bank)}\` / 💎 *Unlimited (VIP active — expires <t:${Math.floor(u.vip.expiresAt / 1000)}:R>)*`
                            : `\`$${formatNum(u.bank)}\` / \`$${formatNum(u.maxCapacity)}\` (${bankPct}% used)` },
                        { name: '📊 Credit Score', value: `\`${u.creditScore} / 1000\` ${band.label}`, inline: true },
                        { name: '🏦 Bank Loan',    value: loanLine, inline: true },
                    )
                    .setFooter({ text: '.upgrades • .u1-.u10 • .loan <amt> • .loan repay • .loan status • .bank credit • .vip' });
                return msg.channel.send({ embeds: [bankEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }

            // ── .bank upgrade — show packages ────────────────────────────────
            if (bankSub === 'upgrade') {
                const lines = CAPACITY_PACKAGES.map(p =>
                    `\`${p.id}\` *${p.label}* — costs *$${formatNum(p.cost)}* → new total: *$${formatNum(u.maxCapacity + p.increase)}*`
                ).join('\n');
                const vipActive = isVipActive(u);
                const vipLine = vipActive
                    ? `\`VIP\` 💎 *VIP Pass* — active! Bank space is *UNLIMITED* right now. Recharge: \`.vip buy\` ($${formatNum(VIP_MONTHLY_FEE)}/mo) before <t:${Math.floor(u.vip.expiresAt / 1000)}:R>`
                    : `\`VIP\` 💎 *VIP Pass — for trillionaires* — costs *$${formatNum(VIP_MONTHLY_FEE)}/month* → *UNLIMITED* bank space while active\n     ⚠️ _Recurring — miss a recharge and your bank capacity goes back to exactly what it was before (\`$${formatNum(u.maxCapacity)}\` right now)._`;
                const upgradeEmbed = new EmbedBuilder()
                    .setColor(0x9B59B6)
                    .setTitle('🏦 Bank Capacity Upgrades')
                    .setDescription(`Current capacity: **${formatCapacity(u)}**\n\n${lines}\n\n${vipLine}`)
                    .setFooter({ text: 'Use .bank buy <1-10> to purchase • .vip buy for the VIP Pass' });
                return msg.channel.send({ embeds: [upgradeEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }

            // ── .bank buy <1-10> — purchase capacity upgrade ──────────────────
            if (bankSub === 'buy') {
                // ── .bank buy vip — shortcut into the VIP Pass flow ────────────
                if ((args[2] || '').toLowerCase() === 'vip') {
                    if (u.wallet < VIP_MONTHLY_FEE) {
                        return msg.reply(
                            `❌ *VIP Pass costs $${formatNum(VIP_MONTHLY_FEE)}/month.*\n` +
                            `👛 You only have *$${formatNum(u.wallet)}*.\n\n` +
                            `_This pass is built for trillionaires — keep stacking!_`
                        );
                    }
                    u.wallet -= VIP_MONTHLY_FEE;
                    const wasActive = activateOrRenewVip(u);
                    saveDB();
                    return msg.channel.send({
                        embeds: [new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle(wasActive ? '💎 VIP PASS RENEWED! 💎' : '💎 VIP PASS ACTIVATED! 💎')
                            .setDescription(
                                `🏦 *Bank Capacity:* 💎 *UNLIMITED*\n` +
                                `⏳ *Expires:* <t:${Math.floor(u.vip.expiresAt / 1000)}:F> (<t:${Math.floor(u.vip.expiresAt / 1000)}:R>)\n` +
                                `💵 *Fee Paid:* $${formatNum(VIP_MONTHLY_FEE)}\n\n` +
                                `_Recharge with \`.bank buy vip\` or \`.vip buy\` before it expires, or your bank goes back to \`$${formatNum(u.maxCapacity)}\`!_`
                            )],
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    }).catch(() => {});
                }

                if (!u.firstUpgradeGuideShown) {
                    u.firstUpgradeGuideShown = true;
                    saveDB();
                    await msg.reply('🏦 *BANK CAPACITY GUIDE*\n\nYour bank has a storage limit. Upgrades increase the amount you can safely keep in the bank.\n💡 Buy capacity as your wealth grows; do not spend money on an upgrade you do not need yet.').catch(() => {});
                }

                const pkg = CAPACITY_PACKAGES.find(p => p.id === parseInt(args[2]));
                if (!pkg) return msg.reply('❌ Invalid package. Use `.upgrades` to see options (1–10, or `vip`).');
                const totalFunds = u.wallet + u.bank;
                if (totalFunds < pkg.cost) {
                    return msg.reply(
                        `❌ Need *$${formatNum(pkg.cost)}* but you only have *$${formatNum(totalFunds)}* (wallet + bank combined).`
                    );
                }
                // Deduct: wallet first, then bank
                let rem = pkg.cost;
                if (u.wallet >= rem) { u.wallet -= rem; }
                else { rem -= u.wallet; u.wallet = 0; u.bank -= rem; }
                u.maxCapacity += pkg.increase;
                saveDB();
                const buyEmbed = new EmbedBuilder()
                    .setColor(0x2ECC71)
                    .setTitle('🏦 Capacity Upgraded!')
                    .addFields(
                        { name: '📦 Package',      value: `*${pkg.label}*`,                    inline: true },
                        { name: '💰 Cost Paid',    value: `\`$${formatNum(pkg.cost)}\``,       inline: true },
                        { name: '📈 New Capacity', value: `\`$${formatNum(u.maxCapacity)}\``,  inline: true },
                    );
                return msg.channel.send({ embeds: [buyEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }

            // ── .bank loan <amount> — request a bank loan (no card needed) ──────
            if (command === '.loan' || bankSub === 'loan') {
                if (u.bankLoan) {
                    return msg.reply(`⚠️ You already have an active bank loan of *$${formatNum(u.bankLoan.amount)}*!\nRepay it first with \`.bank repay\`.`);
                }
                const loanAmt = parseAmount(loanAmountArg);
                if (isNaN(loanAmt) || loanAmt < 1000) {
                    return msg.reply('❌ Minimum loan is *$1,000*. Example: `.bank loan 50k`');
                }
                if (!u.firstLoanGuideShown) {
                    u.firstLoanGuideShown = true;
                    saveDB();
                    await msg.reply('💸 *BANK LOAN & CIVIL SCORE GUIDE*\n\nBorrow only what you can repay. Paying responsibly improves your civil score and unlocks larger credit.\n⚠️ Missing the due date lowers your score and can restrict gambling; serious/defaulted debt can place an economy restriction until the debt is settled.\n💡 Tiny loans repaid immediately are not a reliable way to farm civil score.').catch(() => {});
                }

                const tier = getLoanTier(loanAmt);
                if (!tier) return msg.reply('❌ Loan amount out of supported range.');

                // Elite tier credit check — applies from day one, no first-loan bypass
                if (tier.minCredit && u.creditScore < tier.minCredit) {
                    const band = getCreditBand(u.creditScore);
                    return msg.reply(
                        `❌ *Elite loans* require *700+* credit score.\nYour score: *${u.creditScore}* ${band.label}\n_Repay existing loans on time to raise your score!_`
                    );
                }

                // Combined cap: the tighter of your credit-band cap and your
                // RECENT AVERAGE balance × ${BALANCE_LOAN_MULTIPLIER} — no more
                // free-pass "first loan" for huge amounts on a $0 account.
                const { band, recentAvg, balanceCap, maxLoan } = getMaxLoanForUser(u);
                if (loanAmt > maxLoan) {
                    const limitingFactor = balanceCap < band.maxLoan ? 'balance' : 'credit';
                    if (limitingFactor === 'balance') {
                        return msg.reply(
                            `❌ Based on your recent average balance (*$${formatNum(Math.round(recentAvg))}*), you can borrow up to *$${formatNum(balanceCap)}* (${BALANCE_LOAN_MULTIPLIER}x your balance).\n` +
                            `Build up your wallet/bank balance to unlock bigger loans!`
                        );
                    }
                    return msg.reply(
                        `❌ Your credit band (${band.label}) only allows loans up to *$${formatNum(band.maxLoan)}*.\nYour score: *${u.creditScore}* — keep repaying on time to unlock higher limits!`
                    );
                }

                const interest   = Math.ceil(loanAmt * tier.interest);
                const totalRepay = loanAmt + interest;
                const dueDate    = Date.now() + tier.days * 86_400_000;

                // Credit money — fill bank first, remainder to wallet
                const bankSpace = getBankCapacity(u) - u.bank;
                if (bankSpace >= loanAmt) { u.bank += loanAmt; }
                else { u.bank += bankSpace; u.wallet += (loanAmt - bankSpace); }

                u.bankLoan = { amount: loanAmt, interest, totalRepay, tier: tier.label, takenAt: Date.now(), dueDate, creditEligible: loanAmt >= CREDIT_BUILD_MIN_LOAN };
                u.bankLoanCount++;
                saveDB();

                const loanEmbed = new EmbedBuilder()
                    .setColor(0xF1C40F)
                    .setTitle('🏦 Bank Loan Sanctioned!')
                    .addFields(
                        { name: '💵 Amount',       value: `\`$${formatNum(loanAmt)}\``,   inline: true },
                        { name: '📦 Tier',         value: `*${tier.label}*`,               inline: true },
                        { name: `💸 Interest (${Math.round(tier.interest*100)}%)`, value: `\`$${formatNum(interest)}\``, inline: true },
                        { name: '🔄 Total to Repay', value: `\`$${formatNum(totalRepay)}\``, inline: true },
                        { name: '📅 Due In',        value: `*${tier.days} days* (<t:${Math.floor(dueDate/1000)}:R>)`, inline: true },
                    )
                    .setFooter({ text: 'Use .bank repay before the due date to protect your credit score! ⚠️ No card is seized — but your credit score will be penalised for late repayment.' });
                return msg.channel.send({ embeds: [loanEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }

            // ── .bank repay — repay active bank loan ─────────────────────────
            if ((command === '.loan' && bankSub === 'repay') || (command === '.bank' && bankSub === 'repay')) {
                if (!u.bankLoan) return msg.reply('✅ You have no active bank loan to repay! Use `.bank loan <amount>` to get one.');

                const { amount, interest, totalRepay, takenAt, dueDate } = u.bankLoan;
                const totalFunds = u.wallet + u.bank;
                if (totalFunds < totalRepay) {
                    return msg.reply(
                        `❌ You need *$${formatNum(totalRepay)}* to repay but only have *$${formatNum(totalFunds)}* (wallet + bank).`
                    );
                }

                // Deduct: wallet first, then bank
                let rem2 = totalRepay;
                if (u.wallet >= rem2) { u.wallet -= rem2; }
                else { rem2 -= u.wallet; u.wallet = 0; u.bank -= rem2; }

                // Calculate rating with anti-credit-farming rules.
                const elapsedMs = Date.now() - takenAt;
                const daysTaken = elapsedMs / 86_400_000;
                const lTier     = getLoanTier(amount);
                let rating, creditDelta;
                for (const r of lTier.ratings) {
                    if (daysTaken <= r.maxDays) { rating = r.label; creditDelta = r.creditDelta; break; }
                }
                if (creditDelta > 0) {
                    if (amount < CREDIT_BUILD_MIN_LOAN || elapsedMs < CREDIT_BUILD_MIN_HOLD_MS) creditDelta = 0;
                    if (!u.creditBuildWindowStart || Date.now() - u.creditBuildWindowStart > CREDIT_BUILD_WINDOW_MS) {
                        u.creditBuildWindowStart = Date.now(); u.creditBuildPositiveGain = 0; u.creditBuildRepays = 0;
                    }
                    const remainingPositive = Math.max(0, CREDIT_BUILD_MAX_POSITIVE - (u.creditBuildPositiveGain || 0));
                    creditDelta = Math.min(creditDelta, remainingPositive);
                    if (creditDelta > 0) {
                        u.creditBuildPositiveGain = (u.creditBuildPositiveGain || 0) + creditDelta;
                        u.creditBuildRepays = (u.creditBuildRepays || 0) + 1;
                    }
                }
                u.creditScore = Math.max(0, Math.min(1000, u.creditScore + creditDelta));
                u.bankLoan    = null;
                u.bankLoanOverdueAt = null;
                u.loanDefaultBanUntil = null;
                u.loanBanUntil = null;
                saveDB();

                const sign    = creditDelta >= 0 ? '+' : '';
                const newBand = getCreditBand(u.creditScore);
                const repayEmbed = new EmbedBuilder()
                    .setColor(0x2ECC71)
                    .setTitle('✅ Bank Loan Repaid!')
                    .addFields(
                        { name: '💰 Repaid',          value: `\`$${formatNum(totalRepay)}\``,                    inline: true },
                        { name: '⏱️ Time Taken',       value: `*${daysTaken.toFixed(1)} days*`,                  inline: true },
                        { name: '📊 Repayment Rating', value: `*${rating}*`,                                     inline: true },
                        { name: '📈 Credit Change',    value: `\`${sign}${creditDelta}\``,                       inline: true },
                        { name: '🏅 New Score',        value: `\`${u.creditScore} / 1000\` ${newBand.label}`,   inline: true },
                    );
                return msg.channel.send({ embeds: [repayEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }

            // ── .bank credit — view credit score ─────────────────────────────
            if (bankSub === 'credit') {
                const band    = getCreditBand(u.creditScore);
                const maxLoan = band.maxLoan === Infinity ? 'Unlimited' : `$${formatNum(band.maxLoan)}`;
                const creditEmbed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setTitle('📊 Credit Score')
                    .addFields(
                        { name: '🏅 Score',                value: `\`${u.creditScore} / 1000\`  ${band.label}`, inline: true },
                        { name: '💳 Max Bank Loan',        value: `\`${maxLoan}\``,                             inline: true },
                        { name: '🔢 Bank Loans Taken',     value: `\`${u.bankLoanCount}\``,                     inline: true },
                    )
                    .setDescription(
                        `**Score Bands:**\n` +
                        `💎 Platinum (800+) — Unlimited\n🥇 Gold (700+) — Unlimited\n🥈 Silver (550+) — $10M\n` +
                        `🥉 Bronze (400+) — $2M\n📉 Low (250+) — $500K\n🚫 Poor (<250) — $50K`
                    )
                    .setFooter({ text: 'Repay bank loans on time to improve your score!' });
                return msg.channel.send({ embeds: [creditEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }

            // ── .bank loans / .bank myloan — view active bank loan ────────────
            if ((command === '.loan' && bankSub === 'status') || (command === '.bank' && (bankSub === 'loans' || bankSub === 'myloan'))) {
                if (!u.bankLoan) return msg.reply('✅ No active bank loan. Use `.loan <amount>` to request one.');
                const { amount, interest, totalRepay, tier: tLabel, takenAt, dueDate } = u.bankLoan;
                const lTier2   = getLoanTier(amount);
                const loanViewEmbed = new EmbedBuilder()
                    .setColor(0xE67E22)
                    .setTitle('🏦 Active Bank Loan')
                    .addFields(
                        { name: '💵 Principal',    value: `\`$${formatNum(amount)}\``,                    inline: true },
                        { name: '📦 Tier',         value: `*${tLabel}*`,                                  inline: true },
                        { name: `💸 Interest (${lTier2 ? Math.round(lTier2.interest*100) : '?'}%)`, value: `\`$${formatNum(interest)}\``, inline: true },
                        { name: '🔄 Total Due',    value: `\`$${formatNum(totalRepay)}\``,                inline: true },
                        { name: '📅 Taken',        value: `<t:${Math.floor(takenAt/1000)}:R>`,            inline: true },
                        { name: '⏰ Due',           value: `<t:${Math.floor(dueDate/1000)}:R>`,           inline: true },
                    )
                    .setFooter({ text: 'Use .loan repay to settle your bank loan' });
                return msg.channel.send({ embeds: [loanViewEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
            }

            // ── unknown subcommand — show help ────────────────────────────────
            return msg.reply(
                `🏦 *Bank Commands:*\n` +
                `\`.bank\` — Overview & balance\n` +
                `\`.upgrades\` — View capacity packages\n` +
                `\`.u1\`–\`.u10\` — Buy a capacity upgrade\n` +
                `\`.loan <amount>\` — Request a bank loan\n` +
                `\`.loan repay\` — Repay your active bank loan\n` +
                `\`.loan status\` — View active bank loan details\n` +
                `\`.bank credit\` — View credit score`
            );
        }

        // ── .vip — VIP Pass for trillionaires ────────────────────────────────────
        if (command === '.vip' || command === '.vippass') {
            initUser(senderId);
            const u = db[senderId];
            const vipSub = (args[1] || '').toLowerCase();

            // ── .vip buy — purchase or renew ───────────────────────────────────
            if (vipSub === 'buy' || vipSub === 'renew') {
                if (u.wallet < VIP_MONTHLY_FEE) {
                    return msg.reply(
                        `❌ *VIP Pass costs $${formatNum(VIP_MONTHLY_FEE)}/month.*\n` +
                        `👛 You only have *$${formatNum(u.wallet)}*.\n\n` +
                        `_This pass is built for trillionaires — keep stacking!_`
                    );
                }
                u.wallet -= VIP_MONTHLY_FEE;
                const wasActive = activateOrRenewVip(u);
                saveDB();

                if (wasActive) {
                    return msg.channel.send({
                        embeds: [new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('💎 VIP PASS RENEWED! 💎')
                            .setDescription(
                                `Your VIP Pass has been extended!\n\n` +
                                `⏳ *New expiry:* <t:${Math.floor(u.vip.expiresAt / 1000)}:F> (<t:${Math.floor(u.vip.expiresAt / 1000)}:R>)\n` +
                                `🏦 *Bank Capacity:* 💎 *UNLIMITED*\n` +
                                `💵 *Fee Paid:* $${formatNum(VIP_MONTHLY_FEE)}`
                            )],
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    }).catch(() => {});
                } else {
                    return msg.channel.send({
                        embeds: [new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('💎 VIP PASS ACTIVATED! 💎')
                            .setDescription(
                                `Welcome to the VIP club, <@${senderId}>! 🥂\n\n` +
                                `🏦 *Bank Capacity:* 💎 *UNLIMITED* — deposit as much as you want, no cap.\n` +
                                `⏳ *Expires:* <t:${Math.floor(u.vip.expiresAt / 1000)}:F> (<t:${Math.floor(u.vip.expiresAt / 1000)}:R>)\n` +
                                `💵 *Fee Paid:* $${formatNum(VIP_MONTHLY_FEE)}\n\n` +
                                `_Recharge before it expires with \`.vip buy\` or your bank goes back to \`$${formatNum(u.maxCapacity)}\`!_`
                            )],
                        allowedMentions: { users: [senderId] },
                        reply: { messageReference: msg.id, failIfNotExists: false }
                    }).catch(() => {});
                }
            }

            // ── .vip (no args) — status ─────────────────────────────────────────
            if (!isVipActive(u)) {
                return msg.channel.send({
                    embeds: [new EmbedBuilder()
                        .setColor(0x95A5A6)
                        .setTitle('💎 VIP Pass — For Trillionaires')
                        .setDescription(
                            `You don't have an active VIP Pass.\n\n` +
                            `💵 *Cost:* $${formatNum(VIP_MONTHLY_FEE)} / month\n` +
                            `🏦 *Benefit:* 💎 *UNLIMITED* bank space while active — no capacity limit at all.\n` +
                            `⚠️ If you don't recharge before it expires, your bank capacity goes right back to what it was before (currently \`$${formatNum(u.maxCapacity)}\`).\n\n` +
                            `Buy it with \`.vip buy\`.`
                        )],
                    reply: { messageReference: msg.id, failIfNotExists: false }
                }).catch(() => {});
            }
            return msg.channel.send({
                embeds: [new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle('💎 VIP Pass — Active')
                    .setDescription(
                        `🏦 *Bank Capacity:* 💎 *UNLIMITED*\n` +
                        `⏳ *Expires:* <t:${Math.floor(u.vip.expiresAt / 1000)}:F> (<t:${Math.floor(u.vip.expiresAt / 1000)}:R>)\n\n` +
                        `Recharge anytime with \`.vip buy\` to extend before it runs out — otherwise your capacity reverts to \`$${formatNum(u.maxCapacity)}\`!`
                    )],
                reply: { messageReference: msg.id, failIfNotExists: false }
            }).catch(() => {});
        }

        // ── .xp ────────────────────────────────────────────────────────────────
        if (command === '.xp') {
            initUser(senderId); const party=db[senderId].pokemon||[];
            if (!party.length) return msg.reply('❌ No Pokémon! Catch one first.');
            const name=args.slice(1).join(' ').toLowerCase(); const p=name ? party.find(x=>x.name.toLowerCase()===name) : party[0];
            if (!p) return msg.reply(`❌ You don't have a Pokémon named *${name}*!`);
            return msg.reply(`🌟 *${p.emoji} ${p.name} — EXPERIENCE*\n📈 Level: **${p.level||1}**\n✨ XP: **${p.xp||0}/${xpRequiredForLevel(p.level||1)}**\n❤️ HP: ${p.hp}/${p.maxHp}\n⚔️ ATK: ${p.atk}\n\n_Win battles or use XP foods to level up. Each level increases HP and ATK._`);
        }

        // ── .health ───────────────────────────────────────────────────────────
        if (command === '.health') {
            initUser(senderId);
            let party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon! Catch one with *.catch* in a group.');
            let p = party[0];
            if (!p.maxHp) { let lk = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === p.name.toLowerCase()) || { hp: 50, atk: 50 }; p.maxHp = lk.hp; p.hp = lk.hp; saveDB(); }
            let toxic = isToxic(senderId, p.name);
            let healthCard = `🩺 *PARTNER DIAGNOSTICS* 🩺\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                             `🔰 *Active:* *${p.emoji} ${p.name}*\n` +
                             `🌟 *Level:* Rank ${p.level || 1}\n` +
                             `${p.gender ? `⚤ *Gender:* ${p.gender}\n` : ''}` +
                             `🏷️ *Category:* ${p.category || p.tier || 'Unknown'}\n` +
                             `⚔️ *Attack:* ${p.atk} ATK\n` +
                             `❤️ *HP:* ${p.hp} / ${p.maxHp}\n` +
                             `📊 [ ${makeProgressBar(p.hp, p.maxHp)} ]\n` +
                             `${toxic ? '☠️ *STATUS: TOXIC!* (temp debuff active)\n' : ''}` +
                             `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
            try {
                let media = await getPokemonArtMedia(p.dexId);
                return chatObj.sendMessage(media, { caption: healthCard });
            } catch (_) { return msg.reply(healthCard); }
        }

        // ── .use ──────────────────────────────────────────────────────────────
        if (command === '.use') {
            initUser(senderId);
            let party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon in roster! Catch one first.');
            let name = args.slice(1).join(' ').trim().toLowerCase();
            if (!name) return msg.reply('❌ Syntax: `.use [pokemon_name]`');
            let idx = party.findIndex(p => p.name.toLowerCase() === name);
            if (idx === -1) return msg.reply(`❌ You don't own *${name}*. Check \`.inv\`.`);
            if (idx === 0) return msg.reply(`⚡ *${party[0].name}* is already your active partner!`);
            let chosen = party.splice(idx, 1)[0];
            party.unshift(chosen); saveDB();
            return chatObj.sendMessage(
                `🔄 *SQUAD UPDATED!*\n🟢 *Deployed:* ${chosen.emoji} *${chosen.name}* [Lv.${chosen.level||1}]\n❤️ HP: ${makeProgressBar(chosen.hp, chosen.maxHp||50)} (${chosen.hp}/${chosen.maxHp||50})`,
                { mentions: [senderId] }
            ).catch(() => {});
        }


        // ── .ptrade — offer a Pokémon to another player ───────────────────────
        // Usage: .ptrade @user <pokemon name> [price]
        // Price is optional (0 = free gift)
        if (command === '.ptrade') {
            initUser(senderId);
            const party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ You have no Pokémon to trade!');

            const targetId = msg.mentionedIds[0];
            if (!targetId) return msg.reply('❌ Tag the player you want to trade with.\n💡 Usage: `.ptrade @user <Pokémon name> [price]`');
            if (targetId === senderId) return msg.reply('❌ You cannot trade with yourself.');

            // Last arg is price if it's a number, rest is Pokémon name
            const tradeArgs = args.slice(1).filter(a => !a.startsWith('<@'));
            let price = 0;
            let pokeName = '';
            if (tradeArgs.length > 0 && !isNaN(tradeArgs[tradeArgs.length - 1].replace(/[^0-9]/g, ''))) {
                price = parseInt(tradeArgs[tradeArgs.length - 1].replace(/[^0-9]/g, ''), 10);
                pokeName = tradeArgs.slice(0, -1).join(' ').toLowerCase().trim();
            } else {
                pokeName = tradeArgs.join(' ').toLowerCase().trim();
            }
            if (!pokeName) return msg.reply('❌ Specify the Pokémon name.\n💡 Usage: `.ptrade @user <Pokémon name> [price]`');

            const pokeIdx = party.findIndex(p => p.name.toLowerCase() === pokeName);
            if (pokeIdx === -1) return msg.reply(`❌ You don't own *${pokeName}*. Check \`.inv\`.`);
            if (pokeIdx === 0 && party.length === 1) return msg.reply('❌ You can\'t trade your only Pokémon — you\'d have nothing left!');

            const pokemon = party[pokeIdx];
            initUser(targetId);

            // Cancel any prior pending offer to that player
            pendingPokemonTrades[targetId] = {
                fromId:   senderId,
                fromName: msg.author?.username || senderId,
                pokemon,
                pokeIdx,
                price
            };

            // Auto-expire after 2 minutes
            setTimeout(() => {
                if (pendingPokemonTrades[targetId]?.fromId === senderId) {
                    delete pendingPokemonTrades[targetId];
                }
            }, 120000);

            let senderName = senderId;
            try { const du = await client.users.fetch(senderId).catch(()=>null); if(du) senderName = du.globalName || du.username || senderId; } catch(_){}

            const priceStr = price > 0 ? ` for *$${formatNum(price)}*` : ' as a **free gift**';
            return chatObj.sendMessage(
                `🤝 *POKÉMON TRADE OFFER!*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `<@${senderId}> wants to trade *${pokemon.emoji} ${pokemon.name}*${priceStr} to <@${targetId}>!\n` +
                `❤️ HP: ${pokemon.hp}/${pokemon.maxHp} | ⚔️ ATK: ${pokemon.atk} | Lv.${pokemon.level || 1} | [${pokemon.tier}]\n\n` +
                `<@${targetId}>, type \`.ptaccept\` to accept or \`.ptdeny\` to decline.\n` +
                `_(Offer expires in 2 minutes)_`,
                { mentions: [senderId, targetId] }
            ).catch(() => {});
        }

        // ── .ptaccept — accept an incoming Pokémon trade offer ────────────────
        if (command === '.ptaccept') {
            const trade = pendingPokemonTrades[senderId];
            if (!trade) return msg.reply('❌ You have no pending Pokémon trade offer. Ask someone to `.ptrade` you first.');

            initUser(senderId); initUser(trade.fromId);
            const fromParty = db[trade.fromId].pokemon || [];
            // Re-verify the Pokémon is still in the seller's party
            const stillIdx = fromParty.findIndex(p => p.name.toLowerCase() === trade.pokemon.name.toLowerCase());
            if (stillIdx === -1) {
                delete pendingPokemonTrades[senderId];
                return msg.reply(`❌ *${trade.pokemon.name}* is no longer available — the trade was cancelled.`);
            }
            // Check buyer can afford it
            if (trade.price > 0 && db[senderId].wallet < trade.price) {
                delete pendingPokemonTrades[senderId];
                return msg.reply(`❌ You need *$${formatNum(trade.price)}* but only have *$${formatNum(db[senderId].wallet)}*. Trade cancelled.`);
            }

            // Execute trade
            const traded = fromParty.splice(stillIdx, 1)[0];
            db[senderId].pokemon = db[senderId].pokemon || [];
            db[senderId].pokemon.push(traded);
            if (trade.price > 0) {
                db[senderId].wallet -= trade.price;
                db[trade.fromId].wallet = (db[trade.fromId].wallet || 0) + trade.price;
            }
            delete pendingPokemonTrades[senderId];
            saveDB();

            const priceStr = trade.price > 0 ? ` • <@${trade.fromId}> received *$${formatNum(trade.price)}*` : ' (free gift)';
            return chatObj.sendMessage(
                `✅ *TRADE COMPLETE!* 🎉\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `${traded.emoji} *${traded.name}* now belongs to <@${senderId}>!${priceStr}\n` +
                `💡 Check your new squad with \`.inv\``,
                { mentions: [senderId, trade.fromId] }
            ).catch(() => {});
        }

        // ── .ptdeny — decline an incoming Pokémon trade offer ─────────────────
        if (command === '.ptdeny') {
            const trade = pendingPokemonTrades[senderId];
            if (!trade) return msg.reply('❌ No pending Pokémon trade offer to decline.');
            delete pendingPokemonTrades[senderId];
            return chatObj.sendMessage(
                `❌ <@${senderId}> *declined* the Pokémon trade from <@${trade.fromId}>!`,
                { mentions: [senderId, trade.fromId] }
            ).catch(() => {});
        }

        // ── .pc — view Pokémon stored in the PC Box (not on active team) ──────
        if (command === '.pc') {
            initUser(senderId);
            const party  = db[senderId].pokemon || [];
            const team   = db[senderId].team    || [];
            const teamSet = new Set(team.map(n => n.toLowerCase()));
            const onTeam = party.filter(p => teamSet.has(p.name.toLowerCase()));
            const inBox  = party.filter(p => !teamSet.has(p.name.toLowerCase()));

            const embed = new EmbedBuilder().setColor(0x3498DB).setTitle('🖥️ YOUR POKÉMON PC');
            let teamStr = onTeam.length
                ? onTeam.map((p,i) => `${i+1}. ${p.emoji} **${p.name}** [${p.tier}] · Lv.${p.level||1} · ❤️ ${p.hp}/${p.maxHp} · ⚔️ ${p.atk}`).join('\n')
                : '_Empty — catch a Pokémon and use `.team add <name>` to deploy one._';
            let boxStr = inBox.length
                ? inBox.map((p,i) => `${i+1}. ${p.emoji} **${p.name}** [${p.tier}] · Lv.${p.level||1} · ❤️ ${p.hp}/${p.maxHp} · ⚔️ ${p.atk}`).join('\n')
                : '_No Pokémon in storage._';

            embed.addFields(
                { name: `⚔️ ACTIVE TEAM (${onTeam.length}/6)`, value: teamStr },
                { name: `📦 PC BOX (${inBox.length} stored)`,   value: boxStr  }
            ).setFooter({ text: '.team add <name> • .team remove <name> • .swap <nameA> <nameB> to switch positions' });
            return msg.channel.send({ embeds: [embed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .team — manage active team (max 6) ────────────────────────────────
        // .team add <name>    → move from PC Box to team (if team < 6)
        // .team remove <name> → move from team back to PC Box
        // .team list          → same as .pc (shorthand)
        if (command === '.team') {
            initUser(senderId);
            const party  = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ You have no Pokémon yet! Catch some first.');
            const sub    = (args[1] || '').toLowerCase();
            const pokeName = args.slice(2).join(' ').toLowerCase().trim();

            if (!db[senderId].team) db[senderId].team = [];
            const team = db[senderId].team;
            const teamSet = new Set(team.map(n => n.toLowerCase()));

            if (sub === 'add') {
                if (!pokeName) return msg.reply('❌ Usage: `.team add <Pokémon name>`');
                const poke = party.find(p => p.name.toLowerCase() === pokeName);
                if (!poke) return msg.reply(`❌ You don't own *${pokeName}*. Check \`.inv\`.`);
                if (teamSet.has(pokeName)) return msg.reply(`⚡ *${poke.name}* is already on your team!`);
                if (team.length >= 6) return msg.reply('❌ Your team is full (6/6)! Use `.team remove <name>` to free a slot first.');
                team.push(poke.name);
                saveDB();
                return msg.reply(`✅ *${poke.emoji} ${poke.name}* added to your active team! (${team.length}/6)\n💡 Use \`.use ${poke.name}\` to set them as your battle lead.`);

            } else if (sub === 'remove') {
                if (!pokeName) return msg.reply('❌ Usage: `.team remove <Pokémon name>`');
                const idx = team.findIndex(n => n.toLowerCase() === pokeName);
                if (idx === -1) return msg.reply(`❌ *${pokeName}* isn't on your team. Check \`.pc\`.`);
                const removed = team.splice(idx, 1)[0];
                saveDB();
                return msg.reply(`📦 *${removed}* moved to your PC Box. (${team.length}/6 on team)`);

            } else {
                // .team / .team list → show current team
                const onTeam = party.filter(p => teamSet.has(p.name.toLowerCase()));
                if (onTeam.length === 0) return msg.reply('📋 Your team is empty! Use `.team add <name>` to add up to 6 Pokémon.');
                let out = `⚔️ *YOUR ACTIVE TEAM* (${onTeam.length}/6)\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
                onTeam.forEach((p, i) => {
                    const star  = i === 0 ? ' ⭐' : '';
                    out += `${i+1}. ${p.emoji} *${p.name}*${star} [${p.tier}] · Lv.${p.level||1} · ❤️ ${p.hp}/${p.maxHp} · ⚔️ ${p.atk}\n`;
                });
                out += `\n💡 \`.team add/remove <name>\` | \`.swap <a> <b>\` | \`.pc\` for full box`;
                return msg.reply(out);
            }
        }

        // ── .swap — swap two Pokémon positions in your full roster ─────────────
        // .swap <nameA> <nameB>  — swaps their positions (useful for ordering team vs box)
        if (command === '.swap') {
            initUser(senderId);
            const party = db[senderId].pokemon || [];
            if (party.length < 2) return msg.reply('❌ You need at least 2 Pokémon to swap positions.');
            if (args.length < 3) return msg.reply('❌ Usage: `.swap <Pokémon A> <Pokémon B>`\nExample: `.swap Pikachu Charizard`');
            const nameA = args[1].toLowerCase(), nameB = args[2].toLowerCase();
            const idxA  = party.findIndex(p => p.name.toLowerCase() === nameA);
            const idxB  = party.findIndex(p => p.name.toLowerCase() === nameB);
            if (idxA === -1) return msg.reply(`❌ You don't own *${args[1]}*.`);
            if (idxB === -1) return msg.reply(`❌ You don't own *${args[2]}*.`);
            if (idxA === idxB) return msg.reply('❌ That\'s the same Pokémon!');
            [party[idxA], party[idxB]] = [party[idxB], party[idxA]];
            saveDB();
            return msg.reply(
                `🔄 *SWAPPED!*\n` +
                `${party[idxB].emoji} *${party[idxB].name}* ↔️ ${party[idxA].emoji} *${party[idxA].name}*\n` +
                `💡 Check your updated roster with \`.pc\``
            );
        }

        // ── .transfer ─────────────────────────────────────────────────────────
        if (command === '.transfer') {
            initUser(senderId);
            const now = Date.now();
            const today = new Date().toDateString();

            // ── Reset daily counters if new day ───────────────────────────────
            if (!db[senderId].transferDay || db[senderId].transferDay !== today) {
                db[senderId].transferDay         = today;
                db[senderId].dailyTransferSent   = 0;
                db[senderId].dailyTransferCount  = 0;
                db[senderId].lastTransfer        = 0;
            }

            // ── SOFT COOLDOWN: 2 min after 15+ transfers in a day ────────────
            const txCount = db[senderId].dailyTransferCount || 0;
            if (txCount >= 15) {
                const lastT = db[senderId].lastTransfer || 0;
                const CD_SOFT = 2 * 60; // 2 minutes
                const elapsed = (now - lastT) / 1000;
                if (elapsed < CD_SOFT) {
                    const left = Math.ceil(CD_SOFT - elapsed);
                    const m = Math.floor(left / 60), s = left % 60;
                    return msg.reply(
                        `⏳ *Transfer cooldown!*\n` +
                        `You've made *${txCount} transfers* today. After 15 transfers a 2 min cooldown applies.\n` +
                        `Wait *${m}m ${s}s* before sending again.`
                    );
                }
            }

            // ── DAILY SEND CAP: $10M per day (Amex cards get higher caps) ────
            const senderAmex = (db[senderId].amexCard && db[senderId].amexCard.active) ? AMEX_CARDS[db[senderId].amexCard.tier] : null;
            const DAILY_TRANSFER_CAP = senderAmex ? senderAmex.dailyTransferCap : 10_000_000;
            const alreadySentToday = db[senderId].dailyTransferSent || 0;
            if (alreadySentToday >= DAILY_TRANSFER_CAP) {
                return msg.reply(
                    `🚫 *Daily send cap reached!*\n` +
                    `You've already sent *$${formatNum(alreadySentToday)}* today.\n` +
                    `Limit resets at midnight. Max: *$${formatNum(DAILY_TRANSFER_CAP)}/day*`
                );
            }

            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : msg.mentionedIds[0];
            if (!target) return msg.reply('❌ Tag someone or reply to their message.');
            if (target === senderId) return msg.reply('❌ Cannot transfer to yourself.');

            let amtStr = ''; let allFlag = false;
            for (let i = 1; i < args.length; i++) {
                if (args[i].toLowerCase() === 'all') { allFlag = true; break; }
                let clean = args[i].replace(/[^0-9]/g,'');
                if (clean && !args[i].includes('@')) { amtStr = clean; break; }
            }
            let amt = allFlag ? db[senderId].wallet : parseAmount(amtStr);
            if (isNaN(amt) || amt <= 0) return msg.reply('❌ Usage: `.transfer [amount] [@tag]`');
            if (amt > db[senderId].wallet) return msg.reply(`❌ You only have *$${formatNum(db[senderId].wallet)}*.`);

            // ── PER-TX LIMIT (Amex or default $10M) ──────────────────────────
            const perTxLimit = senderAmex ? senderAmex.transferLimit : 10_000_000;
            if (perTxLimit !== Infinity && amt > perTxLimit) {
                return msg.reply(
                    `🚫 *Transfer limit exceeded!*\n` +
                    `Your ${senderAmex ? senderAmex.emoji + ' ' + senderAmex.name + ' Card' : 'account'} allows max *$${formatNum(perTxLimit)}* per transfer.\n` +
                    (senderAmex ? `_Upgrade your card for higher limits._` : `_Get an Amex card for higher limits: \`.cardinfo\`_`)
                );
            }

            // ── Clamp to remaining daily send cap ─────────────────────────────
            const remaining = DAILY_TRANSFER_CAP - alreadySentToday;
            if (amt > remaining) {
                return msg.reply(
                    `🚫 *Transfer blocked!* You can only send *$${formatNum(remaining)}* more today.\n` +
                    `Daily cap: $${formatNum(DAILY_TRANSFER_CAP)} | Already sent: $${formatNum(alreadySentToday)}`
                );
            }

            // ── NEW ACCOUNT LOCK: accounts < 1 day old cap at $500k ──────────
            initUser(target);
            const NEW_ACCT_CAP = 500_000;
            const ONE_DAY_MS   = 24 * 60 * 60 * 1000;
            const targetAge    = now - (db[target].registeredAt || now);
            if (targetAge < ONE_DAY_MS && amt > NEW_ACCT_CAP) {
                return msg.reply(
                    `🔒 *New Account Restriction!*\n` +
                    `That account is less than *24 hours old* and can only receive up to *$${formatNum(NEW_ACCT_CAP)}*.\n` +
                    `_This protects against money laundering via alt accounts._`
                );
            }

            // ── DAILY RECEIVE CAP: $10M per day ──────────────────────────────
            const DAILY_RECEIVE_CAP = 10_000_000;
            const todayTarget = new Date().toDateString();
            if (!db[target].transferReceiveDay || db[target].transferReceiveDay !== todayTarget) {
                db[target].transferReceiveDay    = todayTarget;
                db[target].dailyTransferReceived = 0;
            }
            const alreadyReceivedToday = db[target].dailyTransferReceived || 0;
            if (alreadyReceivedToday >= DAILY_RECEIVE_CAP) {
                return msg.reply(
                    `🚫 *Receive cap reached!*\n` +
                    `That user has already received *$${formatNum(alreadyReceivedToday)}* today.\n` +
                    `They can receive more tomorrow. Max: *$${formatNum(DAILY_RECEIVE_CAP)}/day*`
                );
            }
            const remainingReceive = DAILY_RECEIVE_CAP - alreadyReceivedToday;
            if (amt > remainingReceive) {
                return msg.reply(
                    `🚫 *Receive cap blocked!* That user can only receive *$${formatNum(remainingReceive)}* more today.`
                );
            }

            // ── TAX: 20% on transfers above $500k ────────────────────────────
            const TAX_THRESHOLD = 500_000;
            let tax = 0;
            let amtAfterTax = amt;
            if (amt > TAX_THRESHOLD) {
                tax = Math.floor(amt * 0.20);
                amtAfterTax = amt - tax;
            }

            // ── Execute transfer ──────────────────────────────────────────────
            db[senderId].wallet -= amt;
            db[target].wallet   += amtAfterTax;
            db[senderId].lastTransfer       = now;
            db[senderId].dailyTransferSent  = alreadySentToday + amt;
            db[senderId].dailyTransferCount = txCount + 1;
            db[target].dailyTransferReceived = alreadyReceivedToday + amtAfterTax;
            saveDB();

            // ── Tax on large transfers is split equally among the owners ────────
            if (tax > 0) distributeTaxToOwners(tax);

            const txnId = 'TXN-' + Math.floor(100000 + Math.random() * 900000) + 'X';
            const newTxCount = db[senderId].dailyTransferCount;

            // Resolve display names + avatars for sender and receiver
            let senderName = senderId, receiverName = target;
            let senderAvatar = null, receiverAvatar = null;
            try {
                const sdu = await client.users.fetch(senderId).catch(() => null);
                if (sdu) { senderName = sdu.displayName || sdu.username || senderId; senderAvatar = sdu.displayAvatarURL({ size: 128, extension: 'png' }); }
                if (msg.guild) {
                    const sm = await msg.guild.members.fetch(senderId).catch(() => null);
                    if (sm) { senderName = sm.nickname || sm.displayName || senderName; senderAvatar = sm.displayAvatarURL({ size: 128, extension: 'png' }) || senderAvatar; }
                }
            } catch (_) {}
            try {
                const rdu = await client.users.fetch(target).catch(() => null);
                if (rdu) { receiverName = rdu.displayName || rdu.username || target; receiverAvatar = rdu.displayAvatarURL({ size: 128, extension: 'png' }); }
                if (msg.guild) {
                    const rm = await msg.guild.members.fetch(target).catch(() => null);
                    if (rm) { receiverName = rm.nickname || rm.displayName || receiverName; receiverAvatar = rm.displayAvatarURL({ size: 128, extension: 'png' }) || receiverAvatar; }
                }
            } catch (_) {}

            const transferEmbed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setTitle('⚡ Reserve Bank Wire Transfer')
                .setDescription('🏷️ **STATUS:** `SUCCESS ✅`')
                .addFields(
                    { name: '📤 Sender', value: senderName, inline: true },
                    { name: '📥 Receiver', value: receiverName, inline: true },
                    { name: '\u200b', value: '\u200b', inline: true },
                    { name: '💵 Amount Sent', value: `\`$${formatNum(amt)}\``, inline: true },
                    ...(tax > 0 ? [
                        { name: '🏦 Tax (20%)', value: `\`-$${formatNum(tax)}\``, inline: true },
                        { name: '💸 Receiver Gets', value: `\`$${formatNum(amtAfterTax)}\``, inline: true },
                    ] : [{ name: '💸 Receiver Gets', value: `\`$${formatNum(amtAfterTax)}\``, inline: true }, { name: '\u200b', value: '\u200b', inline: true }]),
                    { name: '🧾 Reference ID', value: `\`${txnId}\``, inline: false },
                    { name: '👛 Your Balance', value: `\`$${formatNum(db[senderId].wallet)}\``, inline: true },
                    { name: '📊 Daily Sent', value: `\`$${formatNum(db[senderId].dailyTransferSent)} / $${formatNum(DAILY_TRANSFER_CAP)}\``, inline: true },
                    { name: '🔢 Transfers Today', value: `\`${newTxCount}/15\` ${newTxCount >= 15 ? '*(2min CD active)*' : ''}`, inline: true },
                )
                .setAuthor({ name: senderName, iconURL: senderAvatar || undefined })
                .setThumbnail(receiverAvatar)
                .setFooter({ text: `Ref: ${txnId}` });

            await msg.channel.send({ embeds: [transferEmbed], reply: { messageReference: msg.id, failIfNotExists: false }, allowedMentions: { parse: [] } }).catch(() => {});

            // ── FLAG LARGE TRANSFERS (≥ $5M) to mods ─────────────────────────
            const FLAG_THRESHOLD = 5_000_000;
            if (amt >= FLAG_THRESHOLD) {
                const flagMsg =
                    `🚨 *LARGE TRANSFER ALERT* 🚨\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `📤 *Sender:* ${senderName} (${senderId.split('@')[0]})\n` +
                    `📥 *Receiver:* ${receiverName} (${target.split('@')[0]})\n` +
                    `💵 *Amount:* $${formatNum(amt)}\n` +
                    (tax > 0 ? `🏦 *Tax deducted:* $${formatNum(tax)}\n` : '') +
                    `🧾 *Ref:* \`${txnId}\`\n` +
                    `🕐 *Time:* ${new Date().toLocaleString()}\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `_Review if suspicious. Use \`.addmoney\` or \`.removemoney\` to correct if needed._`;
                await notifyStaff(flagMsg);
            }

            return;
        }

        // ── .rob ──────────────────────────────────────────────────────────────
        if (command === '.rob') {
            initUser(senderId);
            if (!isGroupChat) return msg.reply('❌ Robberies only in group chats!');
            const now = Date.now();
            if ((now - db[senderId].lastRob) / 1000 < CD_ROB) {
                let left = Math.ceil(CD_ROB - (now - db[senderId].lastRob) / 1000);
                return msg.reply(`🚔 Lay low for *${Math.floor(left/60)}m ${left%60}s*.`);
            }
            let targetId = msg.mentionedIds[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Tag someone: `.rob @username`');
            if (targetId === senderId) return msg.reply('🤡 Robbing yourself? No.');
            initUser(targetId);
            if (db[targetId].wallet < 1000) return msg.reply(`❌ Target is too broke to rob!`);
            if (db[senderId].wallet < 500) return msg.reply('❌ Need at least *$500* to fund a heist.');
            db[senderId].lastRob = now;

            const roll = Math.random() * 100;
            if (roll <= 35) {
                const pct = Math.random() * 0.25 + 0.05;
                let rawStolen = Math.max(500, Math.min(Math.floor(db[targetId].wallet * pct), db[targetId].wallet));
                db[targetId].wallet -= rawStolen; db[senderId].wallet += rawStolen; saveDB();
                return chatObj.sendMessage(
                    `🦹 *HEIST SUCCESS!* 🦹\n<@${senderId}> robbed <@${targetId}>!\n💰 Stolen: *+$${formatNum(rawStolen)}*\n👛 Your Wallet: $${formatNum(db[senderId].wallet)}`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            } else if (roll <= 80) {
                let fine = Math.max(500, Math.min(Math.floor(db[senderId].wallet * 0.15), db[senderId].wallet));
                db[senderId].wallet -= fine; saveDB();
                return chatObj.sendMessage(
                    `🚔 *CAUGHT!* <@${senderId}> tried to rob <@${targetId}>!` +
                    `\n💸 Fine: *-$${formatNum(fine)}*`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            } else {
                saveDB();
                return chatObj.sendMessage(
                    `🏃 <@${senderId}> attempted a robbery on <@${targetId}> but escaped with nothing!`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            }
        }

        // ── .sell ─────────────────────────────────────────────────────────────
        if (command === '.sell') {
            initUser(senderId);
            const item = args[1] ? args[1].toLowerCase() : '';
            const inv = db[senderId].inventory;

            // Fish selling
            if (!item) {
                return msg.reply(
                    `🐟 *MARITIME MARKET*\n• \`.sell fish\` — $200 each\n• \`.sell salmon\` — $800 each\n• \`.sell goldenfish\` — $5,000 each\n• \`.sell all\` — Sell everything\n\n` +
                    `📦 Stock: 🐟 x${inv.fish||0} | 🐟 x${inv.salmon||0} | ✨🐟 x${inv.goldenFish||0}\n\n` +
                    `🃏 *To sell a card:* \`.sell [card no.] [price] @buyer\``
                );
            }
            if (item === 'all') {
                let total = 0; let breakdown = '';
                for (let c of [{key:'fish',price:200,name:'Minnow',emoji:'🐟'},{key:'salmon',price:800,name:'Salmon',emoji:'🐟'},{key:'goldenFish',price:5000,name:'Golden Fish',emoji:'✨🐟'}]) {
                    const qty = inv[c.key] || 0;
                    if (qty > 0) { total += qty * c.price; breakdown += `${c.emoji} x${qty} ➔ +$${formatNum((qty*c.price))}\n`; inv[c.key] = 0; }
                }
                if (total === 0) return msg.reply('❌ Fish inventory empty! Go `.fish` first.');
                db[senderId].wallet += total; saveDB();
                return msg.reply(`🐟 *BULK SALE*\n${breakdown}\n💰 Total: *+$${formatNum(total)}*\n👛 Wallet: $${formatNum(db[senderId].wallet)}`);
            }
            const entry = FISH_SELL_PRICES[item];
            if (!entry) return msg.reply('❌ Unknown item. Try `.sell fish`, `.sell salmon`, `.sell goldenfish`, or `.sell all`.');
            const qty = inv[entry.key] || 0;
            if (qty === 0) return msg.reply(`❌ No ${entry.name} to sell. Go \`.fish\` first.`);
            const earned = qty * entry.price; inv[entry.key] = 0; db[senderId].wallet += earned; saveDB();
            return msg.reply(`🐟 Sold *${qty}x ${entry.name}* for *+$${formatNum(earned)}*!\n👛 Wallet: $${formatNum(db[senderId].wallet)}`);
        }

        // ── .daily ────────────────────────────────────────────────────────────
        // ── .redeem (create) — DM only ────────────────────────────────────────
        // Usage: .redeem 50000   or   .redeem 50k   or   .redeem 1m
        if (command === '.redeem') {
            if (!isMod) return msg.reply('❌ Only mods/owners can create redeem codes.\nAnyone can claim one with `.claim [code]`.');
            if (isGroupChat) return msg.reply(
                `🔒 *Redeem codes can only be created in DMs!*\n` +
                `Open a DM with the bot and type:\n\`.redeem [amount]\``
            );
            initUser(senderId);
            const amt = parseAmount(args[1]);
            if (isNaN(amt) || amt <= 0) return msg.reply('❌ Usage: `.redeem [amount]`\nExample: `.redeem 50000` or `.redeem 50k`');
            if (amt > db[senderId].wallet) return msg.reply(`❌ Not enough funds!\n💰 You have: \`$${formatNum(db[senderId].wallet)}\``);
            if (amt < 100) return msg.reply('❌ Minimum redeem amount is **$100**.');


            // Generate unique 6-char alphanumeric code (uppercase letters + digits)
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O,0,I,1 (confusing)
            let code;
            do {
                code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            } while (db._redeemCodes[code]); // ensure unique

            db[senderId].wallet -= amt;
            db._redeemCodes[code] = {
                amount: amt,
                creatorId: senderId,
                createdAt: Date.now(),
                claimed: false,
                claimedBy: null,
                claimedAt: null
            };
            saveDB();

            // ── FLAG LARGE REDEEM CODES (≥ $10M) to mods ─────────────────────
            const REDEEM_FLAG_THRESHOLD = 10_000_000;
            if (amt >= REDEEM_FLAG_THRESHOLD) {
                const creatorDu = await client.users.fetch(senderId).catch(() => null);
                const creatorName = creatorDu ? (creatorDu.globalName || creatorDu.username || senderId) : senderId;
                const flagMsg =
                    `🚨 *LARGE REDEEM CODE ALERT* 🚨\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `👤 *Creator:* ${creatorName} (${senderId})\n` +
                    `🎟️ *Code:* \`${code}\`\n` +
                    `💵 *Amount:* $${formatNum(amt)}\n` +
                    `🕐 *Time:* ${new Date().toLocaleString()}\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `_Review if suspicious._`;
                await notifyStaff(flagMsg);
            }

            return msg.reply(
                `🎟️ **Redeem Code Created!**\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `Code\n\`${code}\`\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `Amount\n\`$${formatNum(amt)}\`\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💰 Your Wallet: \`$${formatNum(db[senderId].wallet)}\`\n\n` +
                `Share this code with anyone — they can claim it using:\n` +
                `\`.claim ${code}\``
            );
        }

        // ── .claim (redeem code) — works in DM and GC ─────────────────────────
        if (command === '.claim') {
            initUser(senderId);
            const code = args[1] ? args[1].toUpperCase().trim() : '';
            if (!code) return msg.reply('❌ Usage: `.claim [code]`\nExample: `.claim AB3X7K`');

            const entry = db._redeemCodes[code];
            if (!entry) return msg.reply('❌ Invalid redeem code! Double-check and try again.');
            if (entry.claimed) return msg.reply(
                `❌ This code has already been claimed!\n` +
                `_Claimed by someone else._`
            );
            if (entry.creatorId === senderId) return msg.reply(
                `😂 Bruh you made this code yourself — you can't claim your own redeem code!\n` +
                `Share it with someone else.`
            );

            // Claim it!
            entry.claimed = true;
            entry.claimedBy = senderId;
            entry.claimedAt = Date.now();
            db[senderId].wallet += entry.amount;
            saveDB();

            return chatObj.sendMessage(
                `🎉 **Redeem Code Claimed!**\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `Code\n\`${code}\`\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `Amount\n\`$${formatNum(entry.amount)}\`\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💰 Your Wallet: \`$${formatNum(db[senderId].wallet)}\`\n\n` +
                `_Code created by <@${entry.creatorId}>_`,
                { mentions: [senderId, entry.creatorId] }
            ).catch(() => {});
        }

        // ── .americanexpress — full guide ─────────────────────────────────────
        if (command === '.americanexpress' || command === '.amex') {
            return msg.reply(
                `💳 *AMERICAN EXPRESS — TYRANT EXCLUSIVE* 💳\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `Amex cards are premium memberships for the richest players.\n` +
                `Higher the card = more perks, higher transfer limits, CD cuts & more.\n\n` +

                `━━━ 📋 *CARD TIERS* ━━━\n\n` +

                `🟢 *GREEN CARD*\n` +
                `💰 Eligibility: $20M net worth\n` +
                `💸 Avail cost: $1M | Maintenance: $3M/week\n` +
                `📤 Transfer: $50M/tx | $25M/day cap\n` +
                `⏱️ CD: -20% | 🎁 Daily: +25%\n\n` +

                `🥇 *GOLD CARD*\n` +
                `💰 Eligibility: $40M net worth\n` +
                `💸 Avail cost: $3M | Maintenance: $5M/week\n` +
                `📤 Transfer: $100M/tx | $50M/day cap\n` +
                `⏱️ CD: -30% | 🎁 Daily: +50% | 🛡️ Rob: -25%\n\n` +

                `💎 *PLATINUM CARD*\n` +
                `💰 Eligibility: $60M net worth\n` +
                `💸 Avail cost: $5M | Maintenance: $7M/week\n` +
                `📤 Transfer: $500M/tx | $200M/day cap\n` +
                `⏱️ CD: -50% | 🎁 Daily: +100% | 🛡️ Rob: -50%\n\n` +

                `🖤 *BLACK CARD*\n` +
                `💰 Eligibility: $100M net worth\n` +
                `💸 Avail cost: $10M | Maintenance: $10M/week\n` +
                `📤 Transfer: Unlimited | No daily cap\n` +
                `⏱️ CD: -70% | 🎁 Daily: +200% | 🛡️ Rob: Full immunity\n\n` +

                `━━━ 💰 *HOW TO GET ONE* ━━━\n\n` +
                `1️⃣ Build your net worth (wallet + bank)\n` +
                `2️⃣ Bot auto-DMs you an invite when eligible\n` +
                `3️⃣ Type *.avail [card]* to activate it\n` +
                `4️⃣ Pay weekly maintenance with *.paymaint*\n\n` +

                `━━━ 📅 *MAINTENANCE RULES* ━━━\n\n` +
                `• Pay every 7 days with *.paymaint*\n` +
                `• Miss payment → card deactivated\n` +
                `• 7 day grace period to pay & reactivate\n` +
                `• After 7 days → card permanently cancelled\n` +
                `• Get it back anytime with *.avail [card]*\n\n` +

                `━━━ 📱 *COMMANDS* ━━━\n\n` +
                `*.avail [green/gold/platinum/black]* — Get a card\n` +
                `*.mycard* — View your card & status\n` +
                `*.paymaint* — Pay weekly maintenance\n` +
                `*.cardinfo [card]* — View any card's details\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_Availing is optional. Invites are sent automatically when eligible._`
            );
        }

        // ── .cardinfo [tier] ──────────────────────────────────────────────────
        if (command === '.cardinfo') {
            const tierKey = args[1]?.toLowerCase();
            const card = tierKey ? AMEX_CARDS[tierKey] : null;
            if (!card) {
                return msg.reply(
                    `💳 *AMEX CARD TIERS*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    Object.entries(AMEX_CARDS).map(([k, c]) =>
                        `${c.emoji} *.cardinfo ${k}* — ${c.name} Card\n` +
                        `   Eligibility: $${formatNum(c.eligibility)} net worth`
                    ).join('\n\n') +
                    `\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Type \`.avail [card]\` to get a card._`
                );
            }
            return msg.reply(
                `${card.emoji} *AMEX ${card.name.toUpperCase()} CARD* ${card.emoji}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `💰 *Avail Cost:* $${formatNum(card.availCost)}\n` +
                `📅 *Weekly Maintenance:* $${formatNum(card.maintenance)}\n` +
                `📊 *Eligibility:* $${formatNum(card.eligibility)} net worth\n\n` +
                `✨ *Benefits:*\n` +
                `📤 Transfer limit per tx: ${card.transferLimit === Infinity ? 'Unlimited' : '$' + formatNum(card.transferLimit)}\n` +
                `📊 Daily transfer cap: ${card.dailyTransferCap === Infinity ? 'None' : '$' + formatNum(card.dailyTransferCap)}\n` +
                `⏱️ Gambling CD reduction: -${card.cdReduction * 100}%\n` +
                `🎁 Daily reward bonus: +${card.dailyBonus * 100}%\n` +
                `🛡️ Rob protection: ${card.robProtection === 0 ? 'None' : card.robProtection === 1 ? 'Full immunity' : (card.robProtection * 100) + '% damage reduction'}\n` +
                (card.shop ? `🏪 Exclusive shop: ${card.shop}\n` : '') +
                `🏅 Balance badge: ${card.badge}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
            );
        }

        // ── .avail [green/gold/platinum/black] ────────────────────────────────
        if (command === '.avail') {
            initUser(senderId);
            const tierKey = args[1]?.toLowerCase();
            const card = tierKey ? AMEX_CARDS[tierKey] : null;
            if (!card) return msg.reply('❌ Usage: `.avail [green/gold/platinum/black]`\nSee all cards: `.cardinfo`');

            const nw = getNetWorth(senderId);
            if (nw < card.eligibility) {
                return msg.reply(
                    `❌ *Not eligible for Amex ${card.emoji} ${card.name}!*\n` +
                    `Required net worth: *$${formatNum(card.eligibility)}*\n` +
                    `Your net worth: *$${formatNum(nw)}*\n` +
                    `Still need: *$${formatNum(card.eligibility - nw)}*`
                );
            }
            if (db[senderId].wallet < card.availCost) {
                return msg.reply(`❌ You need *$${formatNum(card.availCost)}* in your wallet to avail this card.\nYou have: *$${formatNum(db[senderId].wallet)}*`);
            }

            db[senderId].wallet -= card.availCost;
            db[senderId].amexCard = {
                tier: tierKey,
                active: true,
                availedAt: Date.now(),
                lastMaintenance: Date.now(),
                graceStart: null,
            };
            saveDB();

            return msg.reply(
                `${card.emoji} *AMEX ${card.name.toUpperCase()} CARD ACTIVATED!* ${card.emoji}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `✅ Card successfully availed!\n` +
                `💸 Avail fee deducted: *-$${formatNum(card.availCost)}*\n` +
                `👛 Remaining wallet: *$${formatNum(db[senderId].wallet)}*\n\n` +
                `📅 *Weekly maintenance:* $${formatNum(card.maintenance)}/week\n` +
                `💡 Pay with *.paymaint* every week to keep it active!\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🏅 Badge unlocked: *${card.badge}*`
            );
        }

        // ── .mycard ───────────────────────────────────────────────────────────
        if (command === '.mycard') {
            initUser(senderId);
            const amex = db[senderId].amexCard;
            if (!amex) {
                return msg.reply(
                    `💳 *You don't have an Amex card!*\n\n` +
                    `Check eligibility: \`.cardinfo\`\n` +
                    `Avail a card: \`.avail [green/gold/platinum/black]\``
                );
            }
            const card = AMEX_CARDS[amex.tier];
            const now  = Date.now();
            const lastMaint = amex.lastMaintenance || now;
            const nextDue   = lastMaint + 7 * 24 * 60 * 60 * 1000;
            const daysLeft  = Math.max(0, Math.floor((nextDue - now) / 86400000));
            const hoursLeft = Math.max(0, Math.floor(((nextDue - now) % 86400000) / 3600000));
            const graceLeft = amex.graceStart
                ? Math.max(0, 7 - Math.floor((now - amex.graceStart) / 86400000))
                : null;

            return msg.reply(
                `${card.emoji} *YOUR AMEX ${card.name.toUpperCase()} CARD* ${card.emoji}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🏅 *Badge:* ${card.badge}\n` +
                `✅ *Status:* ${amex.active ? '🟢 Active' : '🔴 Deactivated'}\n` +
                (graceLeft !== null ? `⚠️ *Grace period:* ${graceLeft} days left before permanent cancel!\n` : '') +
                `📅 *Next maintenance:* ${amex.active ? `in ${daysLeft}d ${hoursLeft}h` : 'Overdue — pay now!'}\n` +
                `💰 *Maintenance cost:* $${formatNum(card.maintenance)}/week\n\n` +
                `✨ *Active Benefits:*\n` +
                `📤 Transfer limit: ${card.transferLimit === Infinity ? 'Unlimited' : '$' + formatNum(card.transferLimit)}\n` +
                `📊 Daily transfer cap: ${card.dailyTransferCap === Infinity ? 'None' : '$' + formatNum(card.dailyTransferCap)}\n` +
                `⏱️ Gambling CD: -${card.cdReduction * 100}%\n` +
                `🎁 Daily bonus: +${card.dailyBonus * 100}%\n` +
                `🛡️ Rob protection: ${card.robProtection === 0 ? 'None' : card.robProtection === 1 ? 'Full immunity' : (card.robProtection * 100) + '% damage reduction'}\n` +
                (card.shop ? `🏪 Exclusive shop: ${card.shop}\n` : '') +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_Pay maintenance: \`.paymaint\`_`
            );
        }

        // ── .paymaint ─────────────────────────────────────────────────────────
        if (command === '.paymaint') {
            initUser(senderId);
            const amex = db[senderId].amexCard;
            if (!amex) return msg.reply('❌ You don\'t have an Amex card! Type `.cardinfo` to see available cards.');
            const card = AMEX_CARDS[amex.tier];
            const now  = Date.now();

            // Check if maintenance is actually due (within the 7-day window or overdue)
            const lastMaint = amex.lastMaintenance || 0;
            const nextDue   = lastMaint + 7 * 24 * 60 * 60 * 1000;
            if (now < nextDue) {
                const daysLeft  = Math.floor((nextDue - now) / 86400000);
                const hoursLeft = Math.floor(((nextDue - now) % 86400000) / 3600000);
                return msg.reply(`⏳ Maintenance not due yet! Come back in *${daysLeft}d ${hoursLeft}h*.`);
            }

            if (db[senderId].wallet < card.maintenance) {
                return msg.reply(
                    `❌ *Insufficient funds for maintenance!*\n` +
                    `Required: *$${formatNum(card.maintenance)}*\n` +
                    `Your wallet: *$${formatNum(db[senderId].wallet)}*\n\n` +
                    `⚠️ _Deposit money and pay soon or your card will be deactivated!_`
                );
            }

            db[senderId].wallet -= card.maintenance;
            amex.lastMaintenance = now;
            amex.active = true;
            amex.graceStart = null; // reset grace period if they pay
            saveDB();

            return msg.reply(
                `${card.emoji} *MAINTENANCE PAID!* ${card.emoji}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `✅ Card active for another 7 days!\n` +
                `💸 Deducted: *-$${formatNum(card.maintenance)}*\n` +
                `👛 Wallet: *$${formatNum(db[senderId].wallet)}*\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`
            );
        }

        // ── .daily ────────────────────────────────────────────────────────────
        if (command === '.daily') {
            initUser(senderId); const now = Date.now();
            const oneDay = 86400000; const twoDays = 172800000;
            if (db[senderId].lastDaily && (now - db[senderId].lastDaily) < oneDay) {
                let rem = oneDay - (now - db[senderId].lastDaily);
                let h = Math.floor(rem / 3600000); let m = Math.floor((rem % 3600000) / 60000);
                return msg.reply(`⏳ Daily claimed! Come back in *${h}h ${m}m*.\n🔥 Streak: *${db[senderId].dailyStreak} days*`);
            }
            if (db[senderId].lastDaily && (now - db[senderId].lastDaily) < twoDays) {
                db[senderId].dailyStreak = (db[senderId].dailyStreak || 0) + 1;
            } else { db[senderId].dailyStreak = 1; }
            const streak = db[senderId].dailyStreak;
            const base = Math.floor(Math.random() * 45000) + 5000;
            const bonus = (streak - 1) * 2500;
            // Amex daily bonus
            const amexData = db[senderId].amexCard;
            const amexBonus = (amexData && amexData.active && AMEX_CARDS[amexData.tier])
                ? Math.floor((base + bonus) * AMEX_CARDS[amexData.tier].dailyBonus) : 0;
            const total = base + bonus + amexBonus;
            const balls = streak >= 7 ? 5 : streak >= 3 ? 3 : 2;
            db[senderId].lastDaily = now; db[senderId].wallet += total;
            db[senderId].inventory.pokeball = (db[senderId].inventory.pokeball || 0) + balls; saveDB();
            checkAmexInvite(senderId).catch(() => {});
            const streakEmoji = streak >= 30 ? '🏆' : streak >= 14 ? '🔥' : streak >= 7 ? '⭐' : '✅';
            return msg.reply(
                `🎁 *DAILY REWARD UNLOCKED!* 🎁\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `${streakEmoji} *Streak:* ${streak} day${streak>1?'s':''}\n` +
                `💵 Base: *+$${formatNum(base)}*\n⭐ Streak Bonus: *+$${formatNum(bonus)}*\n` +
                (amexBonus > 0 ? `${amexData ? AMEX_CARDS[amexData.tier].emoji : ''} Amex Bonus: *+$${formatNum(amexBonus)}*\n` : '') +
                `🔴 Free Pokéballs: *+${balls}*\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n💰 *Total: +$${formatNum(total)}*\n👛 Wallet: $${formatNum(db[senderId].wallet)}`
            );
        }

        // ── .shop ─────────────────────────────────────────────────────────────
        if (command === '.shop') {
            initUser(senderId);
            const p1 = args[1] ? args[1].toLowerCase() : '';
            const p2 = args[2] ? args[2].toLowerCase() : '';

            if (p1 === 'balls' || p1 === 'pokeballs') {
                let menu = `🔴 *POKÉBALL SHOP* 🔴\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
                for (let key in POKEBALL_SHOP) {
                    const b = POKEBALL_SHOP[key];
                    menu += `${b.emoji} *${b.name}* — $${formatNum(b.price)} (\`.buy ${key}\`)\n📝 ${b.desc}\n\n`;
                }
                return msg.reply(menu);
            }
            if (p1 === 'food' || (p1 === 'pokemon' && p2 === 'food')) {
                let menu = `🍗 *POKÉMON FOOD SHOP* 🍗\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` + buildFoodShopMenu();
                return msg.reply(menu);
            }
            if (p1 === 'stones' || p1 === 'stone') {
                let menu = `🌟 *EVOLUTION STONE SHOP* 🌟\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
                for (let key in STONE_SHOP) {
                    const s = STONE_SHOP[key];
                    menu += `${s.emoji} *${s.name}* — $${formatNum(s.price)} (\`.buy ${key}\`)\n📝 ${s.desc}\n\n`;
                }
                return msg.reply(menu);
            }
            if (p1 === 'items' || p1 === 'item' || p1 === 'pokemonitems') {
                let menu = `🍬 *POKÉMON ITEMS* 🍬\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
                for (let key in RARE_CANDY_SHOP) {
                    const item = RARE_CANDY_SHOP[key];
                    menu += `${item.emoji} *${item.name}* — $${formatNum(item.price)} (.buy ${key})\n📝 ${item.desc}\n\n`;
                }
                return msg.reply(menu);
            }
            // Main shop menu (no pokemon buying store)
            return msg.reply(
                `🛒 *SHOP MENU* 🛒\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🔴 \`.shop balls\` — Pokéball store\n` +
                `🍗 \`.shop food\` — Pokémon food & items\n` +
                `🌟 \`.shop stones\` — Evolution stones\n\n` +
                `💡 To buy anything: \`.buy [item_name]\`\n` +
                `_Pokémon can only be obtained by catching wild ones!_ 🌿`
            );
        }

        // ── .buy ──────────────────────────────────────────────────────────────
        if (command === '.buy') {
            initUser(senderId);
            let itemKey = args[1] ? args[1].toLowerCase() : '';
            if (!itemKey) return msg.reply('❌ Usage: `.buy [item_name]`');

            // ── .buy lottery — Buy a lottery ticket ─────────────────────────────
            if (itemKey === 'lottery') {
                const lottery = db._config.lottery;
                if (lottery.entries.includes(senderId)) {
                    return msg.reply(`🎟️ You're already entered in this lottery round!\n📊 Check status with \`.ll\``);
                }
                if (lottery.entries.length >= LOTTERY_POOL_SIZE) {
                    return msg.reply(`❌ This round is full and drawing now — try again once a new round opens!`);
                }
                if (db[senderId].wallet < LOTTERY_TICKET_PRICE) {
                    return msg.reply(`❌ Not enough funds!\n🎟️ Ticket costs: *$${formatNum(LOTTERY_TICKET_PRICE)}*\n👛 Your wallet: *$${formatNum(db[senderId].wallet)}*`);
                }
                db[senderId].wallet -= LOTTERY_TICKET_PRICE;
                lottery.entries.push(senderId);
                saveDB();

                const slotsLeft = LOTTERY_POOL_SIZE - lottery.entries.length;
                await msg.reply(
                    `🎟️ *LOTTERY TICKET PURCHASED!* 🎟️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                    `🎰 You're entered in this round!\n💳 Paid: *-$${formatNum(LOTTERY_TICKET_PRICE)}*\n👛 Wallet: $${formatNum(db[senderId].wallet)}\n\n` +
                    `👥 Pool: *${lottery.entries.length}/${LOTTERY_POOL_SIZE}*` +
                    (slotsLeft > 0 ? ` — ${slotsLeft} more ticket(s) needed to trigger the draw!` : ` — draw triggering now! 🎉`) + `\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Check live status anytime with \`.ll\`_`
                );

                // Pool just filled — fire the draw
                if (lottery.entries.length >= LOTTERY_POOL_SIZE) {
                    await runLotteryDraw(msg.channel);
                }
                return;
            }

            if (FOOD_SHOP[itemKey]) {
                let prod = FOOD_SHOP[itemKey];
                if (db[senderId].wallet < prod.price) return msg.reply(`❌ Not enough cash! Price: $${formatNum(prod.price)}`);
                db[senderId].wallet -= prod.price;
                db[senderId].inventory[itemKey] = (db[senderId].inventory[itemKey] || 0) + 1; saveDB();
                return msg.reply(`🛍️ Purchased 1x ${prod.emoji} *${prod.name}*! Check \`.inv\`.`);
            }
            if (POKEBALL_SHOP[itemKey]) {
                let ball = POKEBALL_SHOP[itemKey];
                if (db[senderId].wallet < ball.price) return msg.reply(`❌ Not enough cash! Price: $${formatNum(ball.price)}`);
                db[senderId].wallet -= ball.price;
                db[senderId].inventory[itemKey] = (db[senderId].inventory[itemKey] || 0) + 1; saveDB();
                return msg.reply(`🛍️ Purchased 1x ${ball.emoji} *${ball.name}*! Check \`.inv\`.`);
            }
            if (STONE_SHOP[itemKey]) {
                let stone = STONE_SHOP[itemKey];
                if (db[senderId].wallet < stone.price) return msg.reply(`❌ Not enough cash! Price: $${formatNum(stone.price)}`);
                db[senderId].wallet -= stone.price;
                db[senderId].inventory[itemKey] = (db[senderId].inventory[itemKey] || 0) + 1; saveDB();
                return msg.reply(`🛍️ Purchased 1x ${stone.emoji} *${stone.name}*! Use \`.evolve <pokemon>\` to evolve an eligible Pokémon.`);
            }
            if (RARE_CANDY_SHOP[itemKey]) {
                const candy = RARE_CANDY_SHOP[itemKey];
                if (db[senderId].wallet < candy.price) return msg.reply(`❌ Not enough cash! Price: $${formatNum(candy.price)}`);
                db[senderId].wallet -= candy.price;
                db[senderId].inventory[itemKey] = (db[senderId].inventory[itemKey] || 0) + 1;
                saveDB();
                return msg.reply(`🛍️ Purchased 1x ${candy.emoji} *${candy.name}*! Use \`.rare <pokemon>\` to level up.`);
            }
            return msg.reply('❌ Item not found! Check \`.shop\` for available items.');
        }

        // ── .rare — use Rare Candy on a party Pokémon ───────────────────────────
        if (command === '.rare') {
            initUser(senderId);
            const party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon! Catch one first.');
            const nameArg = args.slice(1).join(' ').toLowerCase().trim();
            if (!nameArg) return msg.reply('❌ Usage: `.rare <pokemon name>`');
            const poke = party.find(p => p.name.toLowerCase() === nameArg);
            if (!poke) return msg.reply(`❌ You don't have a Pokémon named *${nameArg}*!`);
            const inv = db[senderId].inventory;
            if (!inv.rarecandy || inv.rarecandy <= 0) return msg.reply('❌ You need 🍬 *Rare Candy*. Buy one with `.buy rarecandy`.');
            const oldLevel = poke.level || 1;
            inv.rarecandy -= 1;
            const xr = addPokemonXp(poke, xpRequiredForLevel(oldLevel));
            saveDB();
            return msg.reply(
                `🍬 *${poke.emoji} ${poke.name}* used a Rare Candy!
` +
                `📈 Lv.${xr.oldLevel} ➜ *Lv.${xr.newLevel}*
` +
                `❤️ HP: ${poke.hp}/${poke.maxHp} | ⚔️ ATK: ${poke.atk}
` +
                `✨ XP: ${poke.xp}/${poke.maxXp}`
            );
        }

        // ── .evolve — use an Evolution Stone on a party Pokémon ─────────────────
        if (command === '.evolve') {
            initUser(senderId);
            const party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon! Catch one first.');

            const nameArg = args.slice(1).join(' ').toLowerCase();
            if (!nameArg) return msg.reply('❌ Usage: `.evolve <pokemon name>`\n_Requires 1x 🌟💎 Evolution Stone — buy with `.shop stones`_');

            const poke = party.find(p => p.name.toLowerCase() === nameArg);
            if (!poke) return msg.reply(`❌ You don't have a Pokémon named *${nameArg}*!`);

            const evolvedName = EVOLUTION_MAP[poke.name.toLowerCase()];
            if (!evolvedName) return msg.reply(`❌ *${poke.emoji} ${poke.name}* has no further evolution.`);

            const inv = db[senderId].inventory;
            if (!inv.evolutionstone || inv.evolutionstone <= 0) {
                return msg.reply(`❌ You need a 🌟💎 *Evolution Stone*! Buy one with \`.buy evolutionstone\` ($${formatNum(STONE_SHOP.evolutionstone.price)}).`);
            }

            const evolvedData = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === evolvedName.toLowerCase());
            if (!evolvedData) return msg.reply(`❌ Evolution data missing for *${evolvedName}* — contact an admin.`);

            inv.evolutionstone -= 1;

            const oldName = poke.name, oldEmoji = poke.emoji;
            poke.name = evolvedData.name;
            poke.emoji = evolvedData.emoji;
            poke.dexId = evolvedData.dexId;
            poke.tier = evolvedData.rarity;
            poke.category = evolvedData.category || evolvedData.rarity;
            poke.maxHp = evolvedData.hp;
            poke.hp = evolvedData.hp; // full heal on evolution
            poke.atk = evolvedData.atk;

            // Carry the active team over to the new name if it was on the team
            const teamIdx = (db[senderId].team || []).findIndex(n => n.toLowerCase() === oldName.toLowerCase());
            if (teamIdx !== -1) db[senderId].team[teamIdx] = poke.name;

            saveDB();
            const evoCaption = `🌟 *EVOLUTION!* 🌟\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `${oldEmoji} *${oldName}* is evolving...\n✨ 🌟 ✨\n` +
                `🎉 Congratulations! Your ${oldEmoji} ${oldName} evolved into *${evolvedData.emoji} ${evolvedData.name}*!\n\n` +
                `❤️ HP: ${evolvedData.hp} | ⚔️ ATK: ${evolvedData.atk}`;
            try {
                const media = await getPokemonArtMedia(evolvedData.dexId);
                return await chatObj.sendMessage(media, { caption: evoCaption, mentions: [senderId] });
            } catch (_) {
                return chatObj.sendMessage(evoCaption, { mentions: [senderId] }).catch(() => {});
            }
        }

        // ── .team — view/manage your active battle team (max 6) ────────────────
        if (command === '.team') {
            initUser(senderId);
            const party = db[senderId].pokemon || [];
            const sub = args[1] ? args[1].toLowerCase() : '';

            if (sub === 'add') {
                const nameArg = args.slice(2).join(' ').toLowerCase();
                const poke = party.find(p => p.name.toLowerCase() === nameArg);
                if (!poke) return msg.reply(`❌ You don't have a Pokémon named *${nameArg}*!`);
                if (db[senderId].team.some(n => n.toLowerCase() === nameArg)) return msg.reply(`⚡ *${poke.name}* is already on your team!`);
                if (db[senderId].team.length >= 6) return msg.reply('❌ Your team is full (6/6)! Remove one first with `.team remove <pokemon>`.');
                db[senderId].team.push(poke.name);
                saveDB();
                return msg.reply(`✅ *${poke.emoji} ${poke.name}* added to your team! (${db[senderId].team.length}/6)`);
            }

            if (sub === 'remove') {
                const nameArg = args.slice(2).join(' ').toLowerCase();
                const idx = db[senderId].team.findIndex(n => n.toLowerCase() === nameArg);
                if (idx === -1) return msg.reply(`❌ *${nameArg}* isn't on your team!`);
                const removed = db[senderId].team.splice(idx, 1)[0];
                saveDB();
                return msg.reply(`📦 *${removed}* moved to the PC. (${db[senderId].team.length}/6 on team)`);
            }

            // View team
            if (db[senderId].team.length === 0) return msg.reply('❌ Your team is empty! Add a Pokémon with `.team add <pokemon>`.');
            let out = `🐾 *${msg.pushName || 'Trainer'}'s TEAM* (${db[senderId].team.length}/6) 🐾\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            db[senderId].team.forEach((name, i) => {
                const p = party.find(pp => pp.name.toLowerCase() === name.toLowerCase());
                if (!p) return;
                out += `${i + 1}. ${p.emoji} *${p.name}* [${p.tier}] — ❤️ ${p.hp}/${p.maxHp} | ⚔️ ${p.atk} | Lv.${p.level || 1}\n`;
            });
            out += `\n💡 \`.team add <name>\` / \`.team remove <name>\` to manage your team.\n📦 See the rest with \`.pc\``;
            return msg.reply(out);
        }

        // ── .pc — view Pokémon stored in the PC (everyone not on your active team) ──
        if (command === '.pc') {
            initUser(senderId);
            const party = db[senderId].pokemon || [];
            const teamNames = (db[senderId].team || []).map(n => n.toLowerCase());
            const boxed = party.filter(p => !teamNames.includes(p.name.toLowerCase()));

            if (boxed.length === 0) return msg.reply('📦 Your PC is empty! Every Pokémon you own is on your active team.');

            let out = `📦 *${msg.pushName || 'Trainer'}'s PC BOX* (${boxed.length}) 📦\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            boxed.forEach((p, i) => {
                out += `${i + 1}. ${p.emoji} *${p.name}* [${p.tier}] — ❤️ ${p.hp}/${p.maxHp} | ⚔️ ${p.atk} | Lv.${p.level || 1}\n`;
            });
            out += `\n💡 \`.team add <name>\` to bring one onto your active team (max 6).`;
            return msg.reply(out);
        }

        // ── .feed ─────────────────────────────────────────────────────────────
        // Usage: .feed | .feed pikachu | .feed pikachu coke
        if (command === '.feed') {
            initUser(senderId);
            let party = db[senderId].pokemon || [];
            if (party.length === 0) return msg.reply('❌ No Pokémon! Catch one in a group first.');

            let targetPoke = null;
            let foodKey = null;

            if (args.length === 1) {
                // .feed — auto-feed active Pokémon with first available food
                targetPoke = party[0];
                const inv = db[senderId].inventory;
                for (let key of Object.keys(FOOD_SHOP)) {
                    if (inv[key] && inv[key] > 0) { foodKey = key; break; }
                }
                if (!foodKey) return msg.reply('❌ No food in inventory! Buy some with \`.buy [food]\`.Use \`.shop food\` to see options.');
            } else if (args.length === 2) {
                // .feed pikachu — feed active (or named) Pokémon with first available food
                const possiblePoke = args[1].toLowerCase();
                const foundPoke = party.find(p => p.name.toLowerCase() === possiblePoke);
                if (foundPoke) {
                    targetPoke = foundPoke;
                    const inv = db[senderId].inventory;
                    for (let key of Object.keys(FOOD_SHOP)) {
                        if (inv[key] && inv[key] > 0) { foodKey = key; break; }
                    }
                    if (!foodKey) return msg.reply('❌ No food in inventory! Buy some with \`.buy [food]\`.Use \`.shop food\` to see what\'s available.');
                } else {
                    // Maybe it's .feed coke (feed active Pokémon with specific food)
                    foodKey = possiblePoke;
                    targetPoke = party[0];
                    if (!FOOD_SHOP[foodKey]) return msg.reply(`❌ No Pokémon named "${args[1]}" or food named "${args[1]}" found.`);
                }
            } else {
                // .feed pikachu coke
                const pokeName = args.slice(1, args.length - 1).join(' ').toLowerCase();
                foodKey = args[args.length - 1].toLowerCase();
                targetPoke = party.find(p => p.name.toLowerCase() === pokeName);
                if (!targetPoke) return msg.reply(`❌ No Pokémon named "${pokeName}" in your roster. Check \`.inv\`.`);
                if (!FOOD_SHOP[foodKey]) return msg.reply(`❌ Unknown food "${foodKey}". Check \`.shop food\`.`);
            }

            const food = FOOD_SHOP[foodKey];
            const inv = db[senderId].inventory;
            if (!inv[foodKey] || inv[foodKey] <= 0) return msg.reply(`❌ Out of *${food.name}*! Buy with \`.buy ${foodKey}\`.`);

            // Fix maxHp if missing
            if (!targetPoke.maxHp || targetPoke.maxHp === 'undefined') {
                let lk = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === targetPoke.name.toLowerCase()) || { hp: 50, atk: 50 };
                targetPoke.maxHp = lk.hp; targetPoke.hp = lk.hp;
            }
            if (!targetPoke.atk) {
                let lk = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === targetPoke.name.toLowerCase()) || { atk: 50 };
                targetPoke.atk = lk.atk;
            }

            // FIX: mid-battle HP glitch. Battle damage only updates the in-memory
            // battle copy of a Pokémon (battle.p1/battle.p2) — it never touches the
            // party record in the database. `.feed` used to read/heal from the stale
            // party HP and then stomp the LIVE battle HP with that stale number,
            // which is why HP looked wrong (or a full heal seemed to do nothing/too
            // much) right after eating mid-fight. Now we find the live battle copy
            // first (if this Pokémon is currently fighting) and treat IT as the
            // source of truth for hp/maxHp/atk before healing.
            let liveBattleRef = null;
            for (const battle of Object.values(activeBattles)) {
                if (battle.p1Id === senderId && battle.p1.name.toLowerCase() === targetPoke.name.toLowerCase()) { liveBattleRef = battle.p1; break; }
                if (battle.p2Id === senderId && battle.p2.name.toLowerCase() === targetPoke.name.toLowerCase()) { liveBattleRef = battle.p2; break; }
            }
            if (liveBattleRef) {
                targetPoke.hp = liveBattleRef.hp;
                targetPoke.maxHp = liveBattleRef.maxHp;
                targetPoke.atk = liveBattleRef.atk;
            }

            // Refuse if HP already full (for regular food) — drinks/alcohol with an ATK buff are still useful at full HP
            const pokeName = targetPoke.name.toLowerCase();

            // ── Status-curing berries (Pecha/Lum) — works even if HP isn't full ──
            if (food.curesToxic && isToxic(senderId, pokeName)) {
                if (!db[senderId].toxicity[pokeName]) db[senderId].toxicity[pokeName] = { alcoholCount: 0, cigarCount: 0, toxicUntil: 0 };
                db[senderId].toxicity[pokeName].toxicUntil = 0;
                inv[foodKey] -= 1;
                const oldHp = targetPoke.hp;
                targetPoke.hp = Math.min(targetPoke.maxHp, targetPoke.hp + (food.heal || 0));
                saveDB();
                return msg.reply(
                    `${food.emoji} *${targetPoke.emoji} ${targetPoke.name}* ate the *${food.name}*!\n` +
                    `🧼 *Status cured* — no longer TOXIC!\n` +
                    `❤️ HP: ${oldHp} ➔ *${targetPoke.hp}/${targetPoke.maxHp}*`
                );
            }

            if (false && targetPoke.hp >= targetPoke.maxHp && !false && !food.atkBuff) {
                return msg.reply(`🍽️ *${targetPoke.emoji} ${targetPoke.name}* is already at full health and refuses to eat!\n❤️ HP: ${targetPoke.hp}/${targetPoke.maxHp} — already full!`);
            }

            // ── Normal food ───────────────────────────────────────────────────
            inv[foodKey] -= 1;
            const initHp = targetPoke.hp;
            const initMaxHp = targetPoke.maxHp;
            const initAtk = targetPoke.atk;

            // Food XP feeds into the same real level system used by battles.
            const xpResult = food.xpBonus ? addPokemonXp(targetPoke, food.xpBonus) : { gained:0, levels:0, oldLevel:targetPoke.level||1, newLevel:targetPoke.level||1 };
            // Temp ATK buff — instant boost for the NEXT PvP battle only (drinks, energy, alcohol)
            if (food.atkBuff) {
                db[senderId].atkBuff = (db[senderId].atkBuff || 0) + food.atkBuff;
            }

            // ── Permanent Pokémon stat boosts ───────────────────────────────────
            const atkGain = food.atkBoost || 0;
            const hpGain = Math.max(0, Math.floor((food.heal || 0) / 10));
            if (!db[senderId].permAtkBoost[pokeName]) db[senderId].permAtkBoost[pokeName] = 0;
            if (!db[senderId].permHpBoost[pokeName]) db[senderId].permHpBoost[pokeName] = 0;
            if (atkGain > 0) {
                db[senderId].permAtkBoost[pokeName] += atkGain;
                targetPoke.atk = (targetPoke.atk || 50) + atkGain;
            }
            if (hpGain > 0) {
                db[senderId].permHpBoost[pokeName] += hpGain;
                targetPoke.maxHp = (targetPoke.maxHp || 50) + hpGain;
                targetPoke.hp = Math.min(targetPoke.maxHp, (targetPoke.hp || 0) + hpGain);
            }

            targetPoke.hp = food.energy === 100 ? targetPoke.maxHp : Math.min(targetPoke.maxHp, initHp + food.heal);
            saveDB();

            // ── Sync heal to any active battle this user is in ───────────────
            // Write the healed hp/atk back into the SAME live battle object we
            // read from above, so the battle's real state and the party record
            // never fall out of sync again.
            if (liveBattleRef) {
                liveBattleRef.hp = targetPoke.hp;
                liveBattleRef.atk = targetPoke.atk;
            }

            return msg.reply(
                `🐾 Fed 1x ${food.emoji} *${food.name}* to *${targetPoke.emoji} ${targetPoke.name}*!\n` +
                `❤️ HP: ${initHp}/${targetPoke.maxHp} ➔ *${targetPoke.hp}/${targetPoke.maxHp}*` +
                (atkGain > 0 ? `\n⚔️ ATK: ${initAtk} ➔ *${targetPoke.atk}* (+${formatNum(atkGain)})` : '') +
                (food.xpBonus ? `\n⭐ +${food.xpBonus} XP!` : '') +
                (food.atkBuff ? `\n⚡ +${food.atkBuff} instant ATK buff for your next *PvP battle* only!` : '')
            );
        }

        // ── .inv ──────────────────────────────────────────────────────────────
        if (command === '.inv' || command === '.inventory') {
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || senderId);
            initUser(target);
            const inv = db[target].inventory; const party = db[target].pokemon || [];

            // Build pokéball line
            const balls = [
                inv.pokeball   ? `🔴 x${inv.pokeball}`   : null,
                inv.greatball  ? `🔵 x${inv.greatball}`  : null,
                inv.ultraball  ? `⚫ x${inv.ultraball}`  : null,
                inv.masterball ? `🟣 x${inv.masterball}` : null,
                inv.heavyball  ? `⚙️ x${inv.heavyball}`  : null,
                inv.lureball   ? `🎣 x${inv.lureball}`   : null,
            ].filter(Boolean);
            const ballsStr = balls.length ? balls.join('  ') : '_None_';

            // Build fish line
            const fishParts = [];
            if (inv.goldenFish) fishParts.push(`✨🐟 x${inv.goldenFish}`);
            if (inv.salmon)     fishParts.push(`🐟 Salmon x${inv.salmon}`);
            if (inv.fish)       fishParts.push(`🐟 Minnow x${inv.fish}`);
            const fishStr = fishParts.length ? fishParts.join('  ') : '_None_';

            // Build food line
            const foodParts = [];
            for (let key of Object.keys(FOOD_SHOP)) {
                const qty = inv[key] || 0;
                if (qty > 0) foodParts.push(`${FOOD_SHOP[key].emoji} x${qty}`);
            }
            const foodStr = foodParts.length ? foodParts.join('  ') : '_None_';

            const itemParts = [];
            if (inv.rarecandy) itemParts.push(`🍬 Rare Candy x${inv.rarecandy}`);
            const itemStr = itemParts.length ? itemParts.join('  ') : '_None_';

            // Build pokémon roster
            let rosterStr = '';
            if (party.length === 0) {
                rosterStr = '_No Pokémon yet — use .catch in a group_';
            } else {
                party.forEach((p, i) => {
                    if (!p.maxHp) { let lk = WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p.name.toLowerCase())||{hp:50}; p.maxHp=lk.hp; p.hp=lk.hp; }
                    const toxic = isToxic(target, p.name) ? ' ☠️' : '';
                    const star = i === 0 ? ' ⭐' : '';
                    rosterStr += `${i+1}. ${p.emoji} **${p.name}**${star}${toxic} · Lv.${p.level||1} · ❤️ ${p.hp}/${p.maxHp} · ⚔️ ${p.atk}\n`;
                });
                saveDB();
            }

            // Fetch target display name
            let targetName = target;
            try {
                const du = await client.users.fetch(target).catch(() => null);
                if (du) targetName = du.displayName || du.username || target;
                if (msg.guild) {
                    const mem = await msg.guild.members.fetch(target).catch(() => null);
                    if (mem && (mem.nickname || mem.displayName)) targetName = mem.nickname || mem.displayName || targetName;
                }
            } catch (_) {}

            const invEmbed = new EmbedBuilder()
                .setColor(0x1ABC9C)
                .setTitle(`🎒 ${targetName}'s Inventory`)
                .addFields(
                    { name: `💼 Bag — ${inv.assignedBag || 'Basic Sack'}`, value: '\u200b' },
                    { name: '🔴 Pokéballs', value: ballsStr },
                    { name: '🐠 Fish', value: fishStr, inline: true },
                    { name: '🍗 Food', value: foodStr, inline: true },
                    { name: '🍬 Pokémon Items', value: itemStr, inline: true },
                    { name: `🐾 Pokémon Roster (${party.length})`, value: rosterStr || '_Empty_' },
                )
                .setFooter({ text: '⭐ = Active Pokémon  •  ☠️ = Toxic' });
            return msg.channel.send({ embeds: [invEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .team — view your Pokémon roster & release (remove) any of them ────
        if (command === '.team') {
            initUser(senderId);
            if (!db[senderId].pokemon) db[senderId].pokemon = [];
            let party = db[senderId].pokemon;

            const sub = (args[1] || '').toLowerCase();

            // .team remove [number|name] — release a pokemon from your roster
            if (sub === 'remove' || sub === 'release' || sub === 'rm') {
                if (party.length === 0) return msg.reply('❌ You have no Pokémon to remove!');
                const query = args.slice(2).join(' ').trim().toLowerCase();
                if (!query) return msg.reply('❌ Syntax: `.team remove [number or name]`\nUse `.team` to see your roster with numbers.');

                let idx = -1;
                if (/^\d+$/.test(query)) {
                    idx = parseInt(query, 10) - 1;
                } else {
                    idx = party.findIndex(p => p.name.toLowerCase() === query);
                }
                if (idx < 0 || idx >= party.length) return msg.reply('❌ Pokémon not found. Check `.team` for the correct number/name.');

                const removed = party.splice(idx, 1)[0];
                saveDB();
                return chatObj.sendMessage(
                    `🗑️ *POKÉMON RELEASED* 🗑️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `${removed.emoji} *${removed.name}* has been removed from your roster.\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `_This cannot be undone._`,
                    { mentions: [senderId] }
                ).catch(() => {});
            }

            // .team (no args) — list roster
            if (party.length === 0) return msg.reply('❌ No Pokémon yet — use `.catch` in a group!');

            let teamStr = '';
            party.forEach((p, i) => {
                if (!p.maxHp) { let lk = WILD_POKEMON_POOL.find(w => w.name.toLowerCase() === p.name.toLowerCase()) || { hp: 50 }; p.maxHp = lk.hp; p.hp = lk.hp; }
                const toxic = isToxic(senderId, p.name) ? ' ☠️' : '';
                const star = i === 0 ? ' ⭐' : '';
                teamStr += `${i + 1}. ${p.emoji} *${p.name}*${star}${toxic} · Lv.${p.level || 1} · ❤️ ${p.hp}/${p.maxHp} · ⚔️ ${p.atk}\n`;
            });
            saveDB();

            return msg.reply(
                `🐾 *YOUR POKÉMON TEAM (${party.length})* 🐾\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                teamStr +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `⭐ = Active · ☠️ = Toxic\n` +
                `🗑️ Remove one: \`.team remove [number or name]\``
            );
        }


        if (command === '.battle') {
            initUser(senderId);
            if (!isGroupChat) return msg.reply('❌ Battles only in group chats!');
            if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('❌ Tag an opponent: `.battle [@tag]`');
            let targetId = msg.mentionedIds[0];
            if (targetId === senderId) return msg.reply('🤡 Fighting yourself? Seek help.');
            initUser(targetId);

            let p1Party = db[senderId].pokemon || [];
            let p2Party = db[targetId].pokemon || [];
            if (p1Party.length === 0) return msg.reply('❌ You have no Pokémon! Catch one first.');
            if (p2Party.length === 0) return msg.reply('❌ Opponent has no Pokémon!');

            let p1 = p1Party[0]; let p2 = p2Party[0];
            if (!p1.maxHp) { let lk = WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p1.name.toLowerCase())||{hp:50,atk:50}; p1.maxHp=lk.hp; p1.hp=lk.hp; p1.atk=lk.atk; }
            if (!p2.maxHp) { let lk = WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p2.name.toLowerCase())||{hp:50,atk:50}; p2.maxHp=lk.hp; p2.hp=lk.hp; p2.atk=lk.atk; }

            if (p1.hp < 10) return msg.reply(`❌ *${p1.emoji} ${p1.name}* is too weak (${p1.hp} HP)! Feed it first with \`.feed\`.`);
            if (isToxic(senderId, p1.name)) return msg.reply(`❌ *${p1.emoji} ${p1.name}* is TOXIC and can't battle! Wait for detox.`);

            pendingBattles[targetId] = { challengerId: senderId, challengerName: senderId.split('@')[0], defenderName: targetId.split('@')[0] };
            const moves1 = getMovesForPokemon(p1.name);
            let requestTxt = `🏟️ *BATTLE CHALLENGE!* 🏟️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                             `⚔️ <@${senderId}> challenges <@${targetId}>!\n` +
                             `🔴 *${p1.emoji} ${p1.name}* vs 🔵 *${p2.emoji} ${p2.name}*\n\n` +
                             `🟢 Type \`.accept\` to battle | 🔴 Type \`.reject\` to back down.\n` +
                             `_(Challenge expires in 2 min)_`;
            return chatObj.sendMessage(requestTxt, { mentions: [senderId, targetId] }).catch(() => {});
        }

        if (command === '.accept') {
            // Card trade accept takes priority if pending
            if (!pendingBattles[senderId]) return msg.reply('❌ No battle invitation found for you.');
            const bData = pendingBattles[senderId];
            delete pendingBattles[senderId];

            initUser(bData.challengerId); initUser(senderId);
            let p1 = db[bData.challengerId].pokemon[0];
            let p2 = db[senderId].pokemon[0];
            if (!p1.maxHp) { let lk=WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p1.name.toLowerCase())||{hp:50,atk:50}; p1.maxHp=lk.hp; p1.hp=lk.hp; p1.atk=lk.atk; }
            if (!p2.maxHp) { let lk=WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===p2.name.toLowerCase())||{hp:50,atk:50}; p2.maxHp=lk.hp; p2.hp=lk.hp; p2.atk=lk.atk; }

            if (p2.hp < 10) return msg.reply(`❌ *${p2.name}* is too weak! Feed it first.`);
            if (isToxic(senderId, p2.name)) return msg.reply(`❌ *${p2.name}* is TOXIC and can't battle!`);

            // Apply ATK buffs
            const p1AtkBuff = db[bData.challengerId].atkBuff || 0;
            const p2AtkBuff = db[senderId].atkBuff || 0;
            const p1Battle = { ...p1, atk: (p1.atk || 50) + p1AtkBuff };
            const p2Battle = { ...p2, atk: (p2.atk || 50) + p2AtkBuff };
            db[bData.challengerId].atkBuff = 0; db[senderId].atkBuff = 0;

            const battleId = generateBattleId();
            activeBattles[battleId] = { p1: p1Battle, p2: p2Battle, p1Id: bData.challengerId, p2Id: senderId, turn: 'p1', wildMode: false };

            const moves1 = getMovesForPokemon(p1Battle.name);
            let startMsg = `🏟️ *BATTLE BEGINS!* 🏟️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                           `🔴 @${bData.challengerName}: *${p1Battle.emoji} ${p1Battle.name}* ❤️ ${p1Battle.hp}/${p1Battle.maxHp}\n` +
                           `🔵 @${bData.defenderName}: *${p2Battle.emoji} ${p2Battle.name}* ❤️ ${p2Battle.hp}/${p2Battle.maxHp}\n\n` +
                           `⚔️ @${bData.challengerName}'s turn! Choose a move:\n`;
            moves1.forEach((m, i) => { startMsg += `${i+1}. ${m.emoji} *${m.name}* (${m.damage[0]}-${m.damage[1]} dmg)${m.special?' ✨':''}\n`; });
            startMsg += `\nReply with move number or name!`;

            // Auto-timeout battle after 5 minutes
            setTimeout(() => { if (activeBattles[battleId]) { delete activeBattles[battleId]; chatObj.sendMessage(`⏰ *Battle ${battleId} timed out!* No moves made for 5 minutes.`).catch(() => {}); } }, 300000);

            return chatObj.sendMessage(startMsg, { mentions: [bData.challengerId, senderId] }).catch(() => {});
        }

        if (command === '.reject') {
            if (!pendingBattles[senderId]) return msg.reply('❌ No pending invitations.');
            const bData = pendingBattles[senderId]; delete pendingBattles[senderId];
            return chatObj.sendMessage(`❌ @${bData.defenderName} backed down from the challenge!`, { mentions: [bData.challengerId, senderId] }).catch(() => {});
        }

        // ── .catch (start wild battle) ────────────────────────────────────────
        if (command === '.catch' && (!db[senderId].pokemon || db[senderId].pokemon.length === 0)) {
            const firstWild = wildPokemonState[chatObj.id._serialized]?.pokemon;
            if (!firstWild) return msg.reply('🐾 *POKÉMON STARTER GUIDE*\n\nWait for a wild Pokémon to appear first. Then type **.catch** to battle it.\n💡 For your first catch, start with a **Weak** Pokémon — they are the easiest to defeat and catch!').catch(() => {});
            if (firstWild.rarity !== 'Weak') return msg.reply('🐾 *FIRST CATCH TIP*\n\nFor your first Pokémon, try to catch a **Weak** Pokémon.\nCurrent encounter: ' + firstWild.emoji + ' *' + firstWild.name + '* [' + firstWild.rarity + ']\n\nYou can wait for a Weak spawn, or battle this one anyway.').catch(() => {});
        }

        if (command === '.catch') {
            if (!isGroupChat) return msg.reply('❌ Wild Pokémon only appear in groups!');
            // Pokémon GC restriction
            const _catchPokeChanId = db._config.pokemonChannelId;
            if (_catchPokeChanId && chatId !== _catchPokeChanId) {
                return msg.reply(`❌ Pokémon catching only works in the designated Pokémon GC! <#${_catchPokeChanId}>`);
            }
            initUser(senderId);
            const cid = chatObj.id._serialized;
            const wildState = wildPokemonState[cid];
            if (!wildState) return msg.reply('❌ No wild Pokémon lurking right now! Wait for one to spawn.');

            const wild = wildState.pokemon;

            // If already weakened — tell them to .throwball
            if (wildState.weakened) {
                return msg.reply(`🎯 *${wild.emoji} ${wild.name}* is already weakened! Use *.throwball [balltype]* to catch it!\n_(e.g. \`.throwball pokeball\`)_`);
            }

            let party = db[senderId].pokemon || [];

            // ── NEW USER FIRST CATCH ─────────────────────────────────────────
            // If player has no Pokémon, let them attempt a direct catch with their starter Pokéball
            if (party.length === 0) {
                const inv = db[senderId].inventory;
                if (!inv.pokeball || inv.pokeball <= 0) {
                    return msg.reply(
                        `🆕 *New Trainer Alert!*\n\n` +
                        `You have no Pokémon yet, but you're out of Pokéballs too! 😢\n` +
                        `Buy one with \`.buy pokeball\` (costs $500) and try again!`
                    );
                }

                // Give them a chance to catch it directly (lower base rate for new users — no battle weakening)
                const rateMap = { Weak: 55, Common: 40, Rare: 25, Epic: 15, Legendary: 5 };
                let catchChance = rateMap[wild.rarity] || 40;
                catchChance = Math.min(catchChance, 100);

                inv.pokeball -= 1;

                // Suspense GIF
                try {
                    const media = await getPokeballWobbleMedia();
                    await chatObj.sendMessage(media, {
                        caption: `🆕 *First catch attempt!* <@${senderId}> is a new trainer with no Pokémon!\n\n` +
                                 `🔴 Threw a Pokéball at *${wild.emoji} ${wild.name}*!\n⏳ _The ball wobbles... fingers crossed!_ 🤞`,
                        mentions: [senderId]
                    });
                } catch (_) {
                    await chatObj.sendMessage(
                        `🆕 *First catch attempt!* <@${senderId}> threw a 🔴 Pokéball at *${wild.emoji} ${wild.name}*!\n⏳ _Suspense..._ 🤞`,
                        { mentions: [senderId] }
                    ).catch(() => {});
                }

                await new Promise(r => setTimeout(r, 10000));

                const firstCaught = Math.random() * 100 <= catchChance;
                saveDB();

                if (firstCaught) {
                    delete wildPokemonState[cid];
                    db[senderId].pokemon.push({
                        name: wild.name, tier: wild.rarity, category: wild.category||wild.rarity, level: 1, xp: 0, maxXp: xpRequiredForLevel(1),
                        hp: wild.hp, maxHp: wild.hp, atk: wild.atk, emoji: wild.emoji, dexId: wild.dexId,
                        gender: Math.random() > 0.5 ? '♂' : '♀'
                    });
                    if (!db[senderId].team) db[senderId].team = [];
                    if (db[senderId].team.length < 6) db[senderId].team.push(wild.name);
                    saveDB();
                    const gotchaCaption = `🎉 *GOTCHA!* *${wild.emoji} ${wild.name}* [${wild.rarity}] was caught!\n` +
                        `❤️ HP: ${wild.hp} | ⚔️ ATK: ${wild.atk}\n\n` +
                        `🌟 *Welcome to your Pokémon journey, <@${senderId}>!*\n` +
                        `Type \`.team\` to see your active roster! Now you can battle and catch more! 🏆`;
                    try {
                        const media = await getPokemonArtMedia(wild.dexId);
                        return await chatObj.sendMessage(media, { caption: gotchaCaption, mentions: [senderId] });
                    } catch (_) {
                        return chatObj.sendMessage(gotchaCaption, { mentions: [senderId] }).catch(() => {});
                    }
                } else {
                    // 15% chance it flees entirely
                    if (Math.random() < 0.15) {
                        delete wildPokemonState[cid];
                        return chatObj.sendMessage(
                            `💨 *${wild.emoji} ${wild.name}* broke free and *FLED!* So close! 😤\n` +
                            `🔴 Pokéballs remaining: ${inv.pokeball}\n` +
                            `💡 _Wait for another Pokémon to spawn and try again!_`,
                            { mentions: [senderId] }
                        ).catch(() => {});
                    }
                    return chatObj.sendMessage(
                        `❌ *${wild.emoji} ${wild.name}* broke free from the Pokéball!\n` +
                        `🔴 Pokéballs remaining: ${inv.pokeball}\n` +
                        `💡 _The wild Pokémon is still here! Try \`.catch\` again or use \`.throwball pokeball\`!_`,
                        { mentions: [senderId] }
                    ).catch(() => {});
                }
            }
            // ── END NEW USER FIRST CATCH ─────────────────────────────────────

            let myPoke = party[0];
            if (!myPoke.maxHp) { let lk=WILD_POKEMON_POOL.find(w=>w.name.toLowerCase()===myPoke.name.toLowerCase())||{hp:50,atk:50}; myPoke.maxHp=lk.hp; myPoke.hp=lk.hp; myPoke.atk=lk.atk; }
            if (myPoke.hp < 5) return msg.reply(`❌ *${myPoke.emoji} ${myPoke.name}* is almost fainted! Feed it first with \`.feed\`.`);
            if (isToxic(senderId, myPoke.name)) return msg.reply(`❌ *${myPoke.emoji} ${myPoke.name}* is TOXIC! It can't battle.`);

            // Set up wild battle
            const wildBattlePoke = { ...wild, hp: wild.hp, maxHp: wild.hp };
            const battleId = generateBattleId();

            activeBattles[battleId] = {
                p1: { ...myPoke },
                p2: wildBattlePoke,
                p1Id: senderId,
                p2Id: 'wild',
                turn: 'p1',
                wildMode: true,
                wildPokemon: wild,
                chatId: cid
            };

            // Remove wild state temporarily (battle in progress)
            delete wildPokemonState[cid];

            const myMoves = getMovesForPokemon(myPoke.name);
            let battleMsg = `⚔️ *WILD BATTLE STARTED!* ⚔️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                            `🔴 *${myPoke.emoji} ${myPoke.name}* ❤️ ${myPoke.hp}/${myPoke.maxHp}\n` +
                            `🟢 *${wild.emoji} ${wild.name}* [${wild.rarity}] ❤️ ${wild.hp}/${wild.hp}\n\n` +
                            `⚔️ <@${senderId}>, choose your move:\n`;
            myMoves.forEach((m, i) => { battleMsg += `${i+1}. ${m.emoji} *${m.name}* (${m.damage[0]}-${m.damage[1]} dmg)${m.special?' ✨':''}\n`; });
            battleMsg += `\nReply with move number or name to attack!`;

            // Wild Pokémon auto-attacks on its turn — handled in the move handler
            // above (search for `battle.wildMode && battle.turn === 'p2'`).
            return chatObj.sendMessage(battleMsg, { mentions: [senderId] }).catch(() => {});
        }

        // ── .throwball ────────────────────────────────────────────────────────
        if (command === '.throwball') {
            if (!isGroupChat) return msg.reply('❌ Catching only in groups!');
            // Pokémon GC restriction
            const _throwPokeChanId = db._config.pokemonChannelId;
            if (_throwPokeChanId && chatId !== _throwPokeChanId) {
                return msg.reply(`❌ Pokémon catching only works in the designated Pokémon GC! <#${_throwPokeChanId}>`);
            }
            initUser(senderId);
            const cid = chatObj.id._serialized;
            const wildState = wildPokemonState[cid];
            if (!wildState || !wildState.weakened) return msg.reply('❌ No weakened Pokémon to catch! Battle it first with *.catch*.');

            // ── CATCH LOCK: only the trainer who weakened the Pokémon can catch it ──
            if (wildState.battleWinner && wildState.battleWinner !== senderId) {
                return msg.reply(`❌ You didn't weaken this Pokémon! Only <@${wildState.battleWinner}> who battled it can throw a ball at it.\n_Battle your own wild Pokémon with *.catch* to earn the right to catch it!_`);
            }

            const wild = wildState.pokemon;
            const ballKey = args[1] ? args[1].toLowerCase() : 'pokeball';
            const ballInfo = POKEBALL_SHOP[ballKey];
            if (!ballInfo) return msg.reply(`❌ Unknown ball type! Options: ${Object.keys(POKEBALL_SHOP).join(', ')}`);

            const inv = db[senderId].inventory;
            if (!inv[ballKey] || inv[ballKey] <= 0) return msg.reply(`❌ No ${ballInfo.emoji} *${ballInfo.name}*! Buy from \`.shop balls\`.`);

            inv[ballKey] -= 1;

            // Suspense message + GIF
            try {
                const media = await getPokeballWobbleMedia();
                await chatObj.sendMessage(media, { caption: `🎯 <@${senderId}> threw a ${ballInfo.emoji} *${ballInfo.name}* at *${wild.emoji} ${wild.name}*!\n\n⏳ _The ball wobbles... come on... come on..._ 🤞`, mentions: [senderId] });
            } catch (_) {
                await chatObj.sendMessage(`🎯 <@${senderId}> threw a ${ballInfo.emoji} *${ballInfo.name}* at *${wild.emoji} ${wild.name}*!\n⏳ _Suspense..._ 🤞`, { mentions: [senderId] }).catch(() => {});
            }

            // 10-second suspense
            await new Promise(r => setTimeout(r, 10000));

            // Rarity-based catch rates
            const rateMap = { Weak: 75, Common: 60, Rare: 40, Epic: 25, Legendary: 10 };
            let catchChance = (rateMap[wild.rarity] || 50) + (ballInfo.catchBonus || 0);
            if (ballInfo.catchBonus >= 100) catchChance = 100; // masterball
            catchChance = Math.min(catchChance, 100);

            const caught = Math.random() * 100 <= catchChance;

            if (caught) {
                delete wildPokemonState[cid];
                const alreadyOwns = (db[senderId].pokemon || []).some(p => p.name.toLowerCase() === wild.name.toLowerCase());
                let resultMsg;
                let attachArt = false;
                if (alreadyOwns) {
                    const bonus = Math.floor(Math.random() * 30000) + 10000;
                    db[senderId].wallet += bonus; saveDB();
                    resultMsg = `🎉 *CAUGHT!* But you already own *${wild.name}*!\n💰 Released for a bounty: *+$${formatNum(bonus)}*!`;
                } else {
                    db[senderId].pokemon = db[senderId].pokemon || [];
                    db[senderId].pokemon.push({
                        name: wild.name, tier: wild.rarity, category: wild.category||wild.rarity, level: 1, xp: 0, maxXp: xpRequiredForLevel(1),
                        hp: wild.hp, maxHp: wild.hp, atk: wild.atk, emoji: wild.emoji, dexId: wild.dexId,
                        gender: Math.random() > 0.5 ? '♂' : '♀'
                    });
                    if (!db[senderId].team) db[senderId].team = [];
                    let teamNote;
                    if (db[senderId].team.length < 6) {
                        db[senderId].team.push(wild.name);
                        teamNote = `⚡ Added to your team! (${db[senderId].team.length}/6)`;
                    } else {
                        teamNote = `📦 Your team is full (6/6) — sent straight to the *PC*! Use \`.team add ${wild.name}\` to swap it in.`;
                    }
                    saveDB();
                    resultMsg = `🎉 *GOTCHA!* *${wild.emoji} ${wild.name}* [${wild.rarity}] was caught!\n❤️ HP: ${wild.hp} | ⚔️ ATK: ${wild.atk}\n${teamNote}\n\n🎊 *Congratulations <@${senderId}>!*\nType \`.team\` or \`.pc\` to see your roster!`;
                    attachArt = true;
                }
                if (attachArt) {
                    try {
                        const media = await getPokemonArtMedia(wild.dexId);
                        return await chatObj.sendMessage(media, { caption: resultMsg, mentions: [senderId] });
                    } catch (_) { /* fall through to text-only below */ }
                }
                return chatObj.sendMessage(resultMsg, { mentions: [senderId] }).catch(() => {});
            } else {
                // 20% chance it already fled even after being weakened
                if (Math.random() < 0.2) {
                    delete wildPokemonState[cid];
                    return chatObj.sendMessage(`💨 *${wild.emoji} ${wild.name}* shook off the ball and *FLED!* Even after being weakened... unlucky! 😤\n🔴 ${ballInfo.name} used: ${inv[ballKey]+1} ➔ ${inv[ballKey]}`, { mentions: [senderId] }).catch(() => {});
                }
                // Still catchable
                saveDB();
                return chatObj.sendMessage(
                    `❌ *${wild.emoji} ${wild.name}* broke free from the ${ballInfo.emoji} ${ballInfo.name}!\n` +
                    `🔴 ${ballKey} remaining: ${inv[ballKey]}\n` +
                    `💡 Try again with \`.throwball [balltype]\` or use a stronger ball!`,
                    { mentions: [senderId] }
                ).catch(() => {});
            }
        }

        // ── .pp — MOD ONLY: full database profile lookup ──────────────────────
        if (command === '.pp') {
            if (!isMod) return msg.reply('❌ This command is restricted to moderators only.');
            let target = msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : (msg.mentionedIds[0] || null);
            if (!target) return msg.reply('❌ Tag someone or reply to their message.\nUsage: `.pp @user`');
            initUser(target);
            const u = db[target];
            const joinedDate = u.joinedAt ? new Date(u.joinedAt).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Unknown';
            const lastActiveDate = u.lastDaily ? new Date(u.lastDaily).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Never';
            const lastRobDate = u.lastRob && u.lastRob > 0 ? new Date(u.lastRob).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Never';
            const lastGambleDate = u.lastCasino && u.lastCasino > 0 ? new Date(u.lastCasino).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'Never';
            const totalGambles = (u.totalCasinoGames || 0) + (u.dailyDbCount || 0);
            const pokemonCount = (u.pokemon || []).length;
            const out =
                `🔍 *[MOD] DATABASE LOOKUP* 🔍\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `🆔 *DB Key (User ID):*\n\`${target}\`\n\n` +
                `👤 *Discord User:* <@${target}>\n` +
                `📅 *First Seen:* ${joinedDate}\n` +
                `🕐 *Last Daily:* ${lastActiveDate}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💰 *FINANCIALS*\n` +
                `👛 Wallet: *$${formatNum(u.wallet)}*\n` +
                `🏦 Bank: *$${formatNum(u.bank)}*\n` +
                `💎 Net Worth: *$${formatNum((u.wallet + u.bank))}*\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🎲 *GAMBLING HISTORY*\n` +
                `🎰 Last Casino: ${lastGambleDate}\n` +
                `🦹 Last Rob: ${lastRobDate}\n` +
                `🎯 DB Games Today: ${u.dailyDbCount || 0}/15\n` +
                `📊 Total Gambles: ~${totalGambles}\n` +
                `🔥 Daily Streak: ${u.dailyStreak || 0} days\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🎮 *GAME ASSETS*\n` +
                `🐾 Pokémon Owned: ${pokemonCount}\n` +
                `👜 Bag: ${u.inventory?.assignedBag || 'Basic Sack'}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_Use the DB key above to directly edit this user's data._`;
            return msg.reply(out);
        }

    } catch (err) {
        console.error('Critical bot error:', err.message);
    }
});

// ── LINK WARNING TRACKER ──────────────────────────────────────────────────────
let linkWarnings = {};  // { userId_chatId: count }

// ── FUNNY ROAST LINES (for .roast and .beg) ───────────────────────────────────
const FUNNY_ROASTS = [
    "You're the human version of a participation trophy. 🏆",
    "I've seen better moves at a chess club for grandmas. ♟️",
    "Your WiFi password is probably 'password123', isn't it? 🔑",
    "You bring joy to everyone when you leave the room. 👋",
    "Your cooking is so bad even the smoke alarm cheers you on. 🔔",
    "You're not stupid, you just have bad luck thinking. 🧠💀",
    "Even Google can't find your worth. 🔍",
    "You're the reason instructions have warnings on them. ⚠️",
    "Your birth certificate is an apology letter from the hospital. 📜",
    "If brains were petrol, you couldn't power a scooter. ⛽",
    "You're like a cloud — when you disappear it's a beautiful day. ☁️",
    "I'd roast you harder but my mom said I can't burn trash. 🗑️🔥",
    "You have something on your chin... no wait, that's just your personality. 😬",
    "You're the human equivalent of a 'terms and conditions' page. 📃",
    "Your ex was so right about everything. 💯",
    "Even your shadow tries to walk away from you. 🚶‍♂️",
    "If stupidity was a sport, you'd be an Olympian. 🥇",
    "You were born because a condom broke. Sorry, that's just facts. 😂",
    "Your hairline is running away from your face. 🏃",
    "I've met rocks smarter than you. 🪨",
    "You're like a software update — nobody wants you but you keep showing up. 💻",
    "Your life is the loading screen that never ends. ⏳",
    "Even your imaginary friend reported you for being boring. 🫀",
    "You're proof that even evolution makes mistakes sometimes. 🦧",
    "Your vibe is so off it needs a firmware update. 📡",
    "You're like a broken pencil — absolutely pointless. ✏️",
    "I'm not saying you're ugly, but Halloween must be your favourite holiday. 🎃",
    "You're the type to bring a fork to a soup kitchen. 🍴🍲",
    "I've eaten alphabet soup and pooped out smarter sentences than you. 💩",
    "You're so dry, camels feel bad for you. 🐪",
    "Your personality has the energy of a dying phone at 1%. 🔋",
    "You peaked in a dream you haven't had yet. 💤",
    "You're not even the main character in your own life. 🎬",
    "Your jokes are so bad they come back around to being good... jk they're still bad. 😐",
    "I'd say go to hell but I don't want to ruin their vibe. 😈",
    "You're the human equivalent of stepping on a LEGO. 🧩",
    "The trash gets picked up more consistently than your potential. 🚛",
    "You're what happens when AutoCorrect loses the will to try. 📝",
];
const BEG_ROASTS = [
    "Here's some charity money, you absolute broke goblin. 😂",
    "Congrats, you begged better than a stray dog. Here's your reward! 🐕",
    "Even the piggy bank felt sorry for you. Here! 🐷",
    "Stop begging and get a job... but okay fine, here. 💸",
    "You're so broke even your wallet cried. We felt bad. Here's cash! 😭",
    "The begging hotline connected you straight to us. Here's your survival money! 📞",
    "Poverty speedrun any% complete. Here's your consolation prize! 🏃",
    "You smelled like broke from here. Take this and buy some dignity. 🤑",
    "Even the economy felt bad for you. Here! 💰",
    "You've unlocked the 'Certified Beggar' achievement. +cash! 🏅",
];

// ── PATCH: Add new commands to the SECOND message_create listener ─────────────
// We inject into the existing message handler by extending it.
// Since both listeners run, we add a THIRD listener for new commands only.

client.on('messageCreate', async msg => {
    if (alreadyProcessed('menu_security', msg.id)) return; // FIX: deduplicate before any async work
    try {
        if (msg.partial) msg = await msg.fetch();
        if (!msg.author) return;
        if (typeof msg.author !== "string" && !msg.author.id) return;
    } catch (e) {
        console.error('Partial fetch failed:', e.message);
        return;
    }
    // FIX: if an earlier messageCreate listener already wrapped this message,
    // msg.author is a plain string ID (not a Discord User object) — .bot would throw/misbehave.
    if (!msg.__wrapped && msg.author.bot && msg.author.id !== '1528377826485473351') return;  // Allow Luna through
    msg = wrapMessage(msg);
    try {
        let body = msg.body ? msg.body.trim() : '';
        body = body.replace(/^\.\s+/, '.');
        const senderId = msg.author || msg.from;
        if (!body) return;

        const chatObj = await msg.getChat();
        const isGroupChat = chatObj.isGroup;

        let isMod = await checkIsMod(msg);

        // ── SECURITY: Auto link detection in groups ───────────────────────────
        if (isGroupChat && !isMod && !body.startsWith('.')) {
            const urlRegex = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|bit\.ly\/|tinyurl\.com\/)[^\s]*/i;
            if (urlRegex.test(body)) {
                const cid = chatObj.id._serialized;
                const warnKey = `${senderId}_${cid}`;
                linkWarnings[warnKey] = (linkWarnings[warnKey] || 0) + 1;
                const count = linkWarnings[warnKey];
                const mod1 = MOD_NUMBERS[0];
                const mod2 = MOD_NUMBERS[1];

                if (count >= 3) {
                    // Kick the user
                    try { await chatObj.removeParticipants([senderId]); } catch (_) {}
                    delete linkWarnings[warnKey];
                    return chatObj.sendMessage(
                        `🚫 *USER REMOVED* 🚫\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                        `👤 <@${senderId}> has been *removed from the group*.\n` +
                        `📋 *Reason:* Sending links (3 violations)\n\n` +
                        `👮 Notifying: <@${mod1}> <@${mod2}>`,
                        { mentions: [senderId, mod1, mod2] }
                    ).catch(() => {});
                } else {
                    const warnsLeft = 3 - count;
                    return chatObj.sendMessage(
                        `⚠️ *LINK WARNING ${count}/3* ⚠️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                        `<@${senderId}> — *sending links is NOT allowed!*\n` +
                        `❗ You have *${warnsLeft} warning${warnsLeft !== 1 ? 's' : ''} left* before removal.\n\n` +
                        `👮 Mods notified: <@${mod1}> <@${mod2}>`,
                        { mentions: [senderId, mod1, mod2] }
                    ).catch(() => {});
                }
            }
        }

        if (!body.startsWith('.')) return;
        const chatId = chatObj.id._serialized;
        const onboardingCommand = ['.reg', '.menu', '.help'].includes(body.split(/\s+/)[0].toLowerCase());
        if (!isBotActiveInChat(chatId) && !onboardingCommand && body !== '.bot on' && body !== '.bot off' && body !== '.lobby' && body !== '.unlobby') return;


        const args = body.split(' ').filter(a => a !== '');
        const command = args[0].toLowerCase();

        // ── REGISTRATION GATE — ignore everything except .reg/.menu until registered ──
        // (.reg itself is handled in the primary messageCreate listener. .menu stays
        // open so new users can actually learn that .reg exists and what it unlocks.)
        if (command !== '.reg' && command !== '.menu' && !isRegistered(senderId)) return;

        // ── LOBBY GC: block forbidden commands ───────────────────────────────
        if (isGroupChat && isLobbyGC(chatId) && LOBBY_BLOCKED_COMMANDS.has(command)) {
            return msg.reply(`🏛️ *Lobby GC Mode* — This command is not available here.\n_Gambling & Pokémon catching are disabled in lobby groups._`).catch(() => {});
        }

        // ── .help / .mods — tag all group admins ─────────────────────────────
        // (.help/.mods and .owners handled in another handler — removed duplicate)

        // ── .menu ─────────────────────────────────────────────────────────────
        if (command === '.menu') {
            const intro =
                `🆕 *New here?* Type \`.reg\` to create your account first — every other command is ignored until you do!\n\n` +

                `🐾 *POKÉMON GAME*\n` +
                `Wild Pokémon randomly appear in the group chat. Battle them with \`.catch\`, then once they're weakened, throw a ball with \`.throwball [type]\` to add them to your roster. Challenge other players to PvP with \`.battle [@user]\`, keep your team healthy with \`.feed\`, and check on them with \`.health\` / \`.inv\`. Gear up at \`.pstore\` (balls & food), or trade Pokémon with other players at \`.market\`. Type \`.pokemon\` for the full guide.\n\n` +

                `🎲 *GAMBLING GAMES*\n` +
                `Put your wallet on the line for a shot at multiplying it — slots (\`.casino\`, \`.slots\`), \`.roulette\`, \`.cf\` (coinflip), and \`.db\` (double or nothing) are all here, each with its own cooldown. Type \`.gamble\` for the full rundown of odds and rules. The house doesn't always lose. 😏\n\n` +

                `💸 *MONEY TRANSFER SYSTEM*\n` +
                `Your cash lives in two places: your *wallet* (cash on hand, but vulnerable to \`.rob\`) and your *bank* (safe, but locked away until you move it). Use \`.dep [amount]\` and \`.wd [amount]\` to shuffle funds between the two, and \`.transfer [amount] [@user]\` to send money straight to someone else. Check everything anytime with \`.bal\`.\n\n` +

                `🏦 *LOAN & BANK SYSTEM*\n` +
                `Use \.loan <amount> for a credit-score based bank loan — no collateral required. Repay with \.loan repay, check it with \.loan status, and type \.bankinfo for the full bank and credit-score guide.

` +

                `🎰 *LOTTERY*\n` +
                `Buy a ticket with \`.buy lottery\` ($70K) — once 5 players are in, the draw fires automatically. Top 3 win cash, the rest get nothing. Check the live pool with \`.ll\`.\n\n` +

                `⚙️ *MORE*\n` +
                `\`.cds\` for your cooldowns • \`.help\` / \`.mods\` to tag admins • \`.rich\` for the wealth leaderboard • \`.fish\` / \`.dig\` for side income • \`.daily\` for a free daily reward • \`.modhelp\` to see mod commands.\n\n` +

                `_Most commands work on their own too — try typing just the command name (e.g. \`.gamble\`, \`.market\`) for more detail._`;

            return sendLongEmbed(msg, {
                title: '🎮 WELCOME TO THE BOT 🎮',
                description: intro,
                color: 0x2ECC71
            });
        }

        // ── .roast ────────────────────────────────────────────────────────────
        if (command === '.roast') {
            let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            const roastLine = FUNNY_ROASTS[Math.floor(Math.random() * FUNNY_ROASTS.length)];

            if (!targetId) {
                // Roast the sender themselves
                return chatObj.sendMessage(
                    `🔥 *SELF-ROAST ACTIVATED* 🔥\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `🎯 <@${senderId}>, you asked for it...\n\n` +
                    `💀 ${roastLine}\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Next time tag someone else! 😂_`,
                    { mentions: [senderId] }
                ).catch(() => {});
            } else {
                // Roast the tagged user
                return chatObj.sendMessage(
                    `🔥 *ROAST INCOMING!* 🔥\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `🎯 <@${targetId}>, <@${senderId}> sent this for you...\n\n` +
                    `💀 ${roastLine}\n\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Get destroyed! 😂🔥_`,
                    { mentions: [senderId, targetId] }
                ).catch(() => {});
            }
        }

        // ── .beg ──────────────────────────────────────────────────────────────
        if (command === '.beg') {
            initUser(senderId);
            const now = Date.now();
            // 120s cooldown on beg
            if (!db[senderId].lastBeg) db[senderId].lastBeg = 0;
            if ((now - db[senderId].lastBeg) / 1000 < 120) {
                const left = Math.ceil(120 - (now - db[senderId].lastBeg) / 1000);
                return msg.reply(`😂 You just begged! Have some dignity. Wait *${left}s*.`);
            }
            const earned = Math.floor(Math.random() * 100) + 1;
            db[senderId].wallet += earned;
            db[senderId].lastBeg = now;
            saveDB();
            const roastLine = BEG_ROASTS[Math.floor(Math.random() * BEG_ROASTS.length)];
            return chatObj.sendMessage(
                `🙏 *BEG RESULT* 🙏\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `💬 ${roastLine}\n\n` +
                `💰 <@${senderId}> received *+$${formatNum(earned)}*!\n` +
                `👛 Wallet: $${formatNum(db[senderId].wallet)}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // ── .cds (show all cooldowns) ─────────────────────────────────────────
        if (command === '.cds') {
            initUser(senderId);
            const now = Date.now();
            const u = db[senderId];
            const cdLeft = (last, cd) => {
                const diff = cd - (now - last) / 1000;
                if (diff <= 0) return '✅ Ready';
                const m = Math.floor(diff / 60);
                const s = Math.ceil(diff % 60);
                return m > 0 ? `⏳ ${m}m ${s}s` : `⏳ ${s}s`;
            };
            const dailyLeft = u.lastDaily && (now - u.lastDaily) < 86400000
                ? `⏳ ${Math.floor((86400000 - (now - u.lastDaily)) / 3600000)}h ${Math.floor(((86400000 - (now - u.lastDaily)) % 3600000) / 60000)}m`
                : '✅ Ready';
            const cdsEmbed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('⏱️ Your Cooldowns')
                .addFields(
                    { name: '⛏️ Dig', value: cdLeft(u.lastDig, CD_DIG), inline: true },
                    { name: '🎣 Fish', value: cdLeft(u.lastFish, CD_FISH), inline: true },
                    { name: '🙏 Beg', value: cdLeft(u.lastBeg || 0, 120), inline: true },
                    { name: '🎰 Casino', value: cdLeft(u.lastCasino, CD_CASINO), inline: true },
                    { name: '🎰 Slots', value: cdLeft(u.lastSlots, CD_SLOTS), inline: true },
                    { name: '🎡 Roulette', value: cdLeft(u.lastRoulette, CD_ROULETTE), inline: true },
                    { name: '⚖️ Double', value: `${cdLeft(u.lastDb, CD_DB)} [${u.dailyDbCount || 0}/15]`, inline: true },
                    { name: '🪙 Coinflip', value: cdLeft(u.lastCoinflip, CD_COINFLIP), inline: true },
                    { name: '🦹 Rob', value: cdLeft(u.lastRob, CD_ROB), inline: true },
                    { name: '🎁 Daily', value: dailyLeft, inline: true },
                )
                .setFooter({ text: '✅ = Ready to use  •  ⏳ = On cooldown' });
            return msg.channel.send({ embeds: [cdsEmbed], reply: { messageReference: msg.id, failIfNotExists: false } }).catch(() => {});
        }

        // ── .pstore (combined Pokémon store) ──────────────────────────────────
        if (command === '.pstore') {
            initUser(senderId);
            let menu = `🔴 *POKÉBALLS*\n`;
            for (let key in POKEBALL_SHOP) {
                const b = POKEBALL_SHOP[key];
                menu += `${b.emoji} *${b.name}* — $${formatNum(b.price)}\n   📝 ${b.desc}\n   _(buy: \`.buy ${key}\`)_\n\n`;
            }
            menu += `🍗 *POKÉMON FOOD*\n` + buildFoodShopMenu(); 
            menu += `\n\n🍬 *POKÉMON ITEMS*\n`;
            for (let key in RARE_CANDY_SHOP) {
                const item = RARE_CANDY_SHOP[key];
                menu += `${item.emoji} *${item.name}* — $${formatNum(item.price)}\n   📝 ${item.desc}\n   _(buy: .buy ${key})_\n\n`;
            }
            await sendLongEmbed(msg, {
                title: '🏪 POKÉMON STORE 🏪',
                description: menu.trim(),
                color: 0xE74C3C,
                footer: 'Purchase anything with .buy [item]'
            });
            return;
        }

        // ── .rich (top 10 richest in group) ───────────────────────────────────
        if (command === '.rich') {
            if (!isGroupChat) return msg.reply('❌ This command only works in groups!');
            const isValidDiscordId = id => /^\d{17,19}$/.test(id);
            const participants = chatObj.participants || [];
            const richList = [];
            for (const p of participants) {
                const uid = p.id._serialized;
                // FIX: only include valid Discord snowflake IDs
                if (!isValidDiscordId(uid)) continue;
                if (db[uid]) {
                    const u = db[uid];
                    const total = (u.wallet || 0) + (u.bank || 0);
                    richList.push({ uid, total, wallet: u.wallet || 0, bank: u.bank || 0 });
                }
            }
            richList.sort((a, b) => b.total - a.total);
            const top = richList.slice(0, 10);
            if (top.length === 0) return msg.reply('❌ No registered players in this group yet!');
            const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            let txt = `💎 *TOP 10 RICHEST PLAYERS* 💎\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            top.forEach((r, i) => {
                txt += `${medals[i]} <@${r.uid}>\n`;
                txt += `   💰 Wallet: $${formatNum(r.wallet)} | 🏦 Bank: $${formatNum(r.bank)}\n`;
                txt += `   💎 Net Worth: *$${formatNum(r.total)}*\n\n`;
            });
            txt += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
            const mentions = top.map(r => r.uid);
            return chatObj.sendMessage(txt, { mentions }).catch(() => {});
        }

        // ── .kick ─────────────────────────────────────────────────────────────
        if (command === '.kick') {
            if (!isGroupChat) return msg.reply('❌ This command only works in groups!');
            if (!isMod) return msg.reply('❌ Only group admins can kick members!');
            let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Tag someone or reply to their message to kick them.');
            if (targetId === senderId) return msg.reply('❌ You cannot kick yourself!');
            if (MOD_NUMBERS.includes(targetId) || FBI_NUMBERS.includes(targetId)) return msg.reply('❌ Cannot kick a moderator/agent!');
            try {
                await chatObj.removeParticipants([targetId]);
                return chatObj.sendMessage(
                    `🚪 *MEMBER REMOVED* 🚪\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `👤 <@${targetId}> has been *kicked from the group*.\n` +
                    `⚖️ Action by: <@${senderId}>\n` +
                    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                    { mentions: [targetId, senderId] }
                ).catch(() => {});
            } catch (e) {
                return msg.reply(`❌ Could not kick <@${targetId}>. Make sure the bot is an admin!`);
            }
        }

        // ── .ban ──────────────────────────────────────────────────────────────
        if (command === '.ban') {
            const canBan = isMod || FBI_NUMBERS.includes(senderId);
            if (!canBan) return msg.reply('❌ Only mods/FBI agents can ban users from the bot!');
            let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Tag someone or reply to their message to ban them.');
            if (targetId === senderId) return msg.reply('❌ You cannot ban yourself!');
            if (MOD_NUMBERS.includes(targetId) || FBI_NUMBERS.includes(targetId)) return msg.reply('❌ Cannot ban a moderator/agent!');
            if (db._config.bannedUsers[targetId]) return msg.reply(`⚠️ <@${targetId}> is already banned.`);
            db._config.bannedUsers[targetId] = { bannedBy: senderId, at: Date.now() };
            saveDB();
            return chatObj.sendMessage(
                `🔨 *USER BANNED* 🔨\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 <@${targetId}> has been *banned from using the bot*.\n` +
                `⚖️ Banned by: <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [targetId, senderId] }
            ).catch(() => {});
        }

        // ── .unban ────────────────────────────────────────────────────────────
        if (command === '.unban') {
            const canUnban = isMod || FBI_NUMBERS.includes(senderId);
            if (!canUnban) return msg.reply('❌ Only mods/FBI agents can unban users!');
            let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Tag someone or reply to their message to unban them.');
            if (!db._config.bannedUsers[targetId]) return msg.reply(`⚠️ <@${targetId}> is not banned.`);
            delete db._config.bannedUsers[targetId];
            saveDB();
            return chatObj.sendMessage(
                `✅ *USER UNBANNED* ✅\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 <@${targetId}> can now use the bot again.\n` +
                `⚖️ Unbanned by: <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [targetId, senderId] }
            ).catch(() => {});
        }

        // ── .fbi — tag all FBI agents in the group ───────────────────────────
        if (command === '.fbi') {
            if (!isGroupChat) return msg.reply('❌ This command only works in groups!');
            const fbiTags = FBI_NUMBERS.map(id => `<@${id}>`).join(' ');
            return chatObj.sendMessage(
                `🚨 *FBI OPEN UP!* 🚨\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `${fbiTags}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `_Requested by: <@${senderId}>_`,
                { mentions: [...FBI_NUMBERS, senderId] }
            ).catch(() => {});
        }

        // ── .regmod [userid] — OWNER ONLY — promote a user to mod ──────────────
        if (command === '.regmod') {
            if (!OWNER_NUMBERS.includes(senderId)) return msg.reply('❌ Only the owner can use this command!');
            let targetId = msg.mentionedIds?.[0] || args[1] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Syntax: `.regmod [user id]` (or tag/reply to them).');
            targetId = targetId.replace(/\D/g, '');
            if (!targetId) return msg.reply('❌ Invalid user ID.');
            if (MOD_NUMBERS.includes(targetId)) return msg.reply(`⚠️ <@${targetId}> is already a mod.`);
            MOD_NUMBERS.push(targetId);
            db._config.extraMods.push(targetId);
            saveDB();
            return chatObj.sendMessage(
                `🛡️ *NEW MOD ADDED* 🛡️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 <@${targetId}> is now a *moderator*.\n` +
                `⚖️ Added by: <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [targetId, senderId] }
            ).catch(() => {});
        }

        // ── .removemod [userid] — OWNER ONLY — demote a mod ─────────────────────
        if (command === '.removemod') {
            if (!OWNER_NUMBERS.includes(senderId)) return msg.reply('❌ Only the owner can use this command!');
            let targetId = msg.mentionedIds?.[0] || args[1] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Syntax: `.removemod [user id]` (or tag/reply to them).');
            targetId = targetId.replace(/\D/g, '');
            if (!targetId) return msg.reply('❌ Invalid user ID.');
            if (OWNER_NUMBERS.includes(targetId)) return msg.reply('❌ Cannot remove an owner from mod!');
            if (!MOD_NUMBERS.includes(targetId)) return msg.reply(`⚠️ <@${targetId}> is not a mod.`);
            const modIdx = MOD_NUMBERS.indexOf(targetId);
            if (modIdx !== -1) MOD_NUMBERS.splice(modIdx, 1);
            const extraIdx = db._config.extraMods.indexOf(targetId);
            if (extraIdx !== -1) db._config.extraMods.splice(extraIdx, 1);
            saveDB();
            return chatObj.sendMessage(
                `🚫 *MOD REMOVED* 🚫\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 <@${targetId}> is no longer a *moderator*.\n` +
                `⚖️ Removed by: <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [targetId, senderId] }
            ).catch(() => {});
        }

        // ── .regagent [userid] — OWNER/FBI — add a new FBI agent ────────────────
        if (command === '.regagent') {
            const canManageFbi = OWNER_NUMBERS.includes(senderId) || FBI_NUMBERS.includes(senderId);
            if (!canManageFbi) return msg.reply('❌ Only owners/FBI agents can use this command!');
            let targetId = msg.mentionedIds?.[0] || args[1] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Syntax: `.regagent [user id]` (or tag/reply to them).');
            targetId = targetId.replace(/\D/g, '');
            if (!targetId) return msg.reply('❌ Invalid user ID.');
            if (FBI_NUMBERS.includes(targetId)) return msg.reply(`⚠️ <@${targetId}> is already an FBI agent.`);
            FBI_NUMBERS.push(targetId);
            db._config.extraFbiAgents.push(targetId);
            saveDB();
            return chatObj.sendMessage(
                `🕵️ *NEW FBI AGENT RECRUITED* 🕵️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 <@${targetId}> is now an *FBI agent*.\n` +
                `⚖️ Recruited by: <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [targetId, senderId] }
            ).catch(() => {});
        }

        // ── .removeagent [userid] — OWNER/FBI — remove an FBI agent ─────────────
        if (command === '.removeagent') {
            const canManageFbi = OWNER_NUMBERS.includes(senderId) || FBI_NUMBERS.includes(senderId);
            if (!canManageFbi) return msg.reply('❌ Only owners/FBI agents can use this command!');
            let targetId = msg.mentionedIds?.[0] || args[1] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply('❌ Syntax: `.removeagent [user id]` (or tag/reply to them).');
            targetId = targetId.replace(/\D/g, '');
            if (!targetId) return msg.reply('❌ Invalid user ID.');
            if (!FBI_NUMBERS.includes(targetId)) return msg.reply(`⚠️ <@${targetId}> is not an FBI agent.`);
            const fbiIdx = FBI_NUMBERS.indexOf(targetId);
            if (fbiIdx !== -1) FBI_NUMBERS.splice(fbiIdx, 1);
            const extraIdx = db._config.extraFbiAgents.indexOf(targetId);
            if (extraIdx !== -1) db._config.extraFbiAgents.splice(extraIdx, 1);
            saveDB();
            return chatObj.sendMessage(
                `🚫 *FBI AGENT REMOVED* 🚫\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 <@${targetId}> is no longer an *FBI agent*.\n` +
                `⚖️ Removed by: <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [targetId, senderId] }
            ).catch(() => {});
        }


        // ── .reset money|inv|pokemon|cards — OWNER ONLY ─────────────────────────
        // Wipes the given thing for EVERY registered user. Since this is
        // destructive and irreversible, the first run only shows a warning +
        // asks the owner to run the exact same command again with "confirm"
        // tacked on (e.g. ".reset money confirm") within 60 seconds.
        if (command === '.reset') {
            if (!OWNER_NUMBERS.includes(senderId)) return msg.reply('❌ Only the owner can use this command!');

            const resetType = (args[1] || '').toLowerCase();
            const validResetTypes = ['money', 'inv', 'pokemon', 'loans'];
            if (!validResetTypes.includes(resetType)) {
                return msg.reply(
                    `❌ Usage: \`.reset [money|inv|pokemon|cards|loans]\`\n` +
                    `⚠️ This wipes that thing for *EVERY registered user* — use with care!`
                );
            }

            const resetLabels = {
                money:   { label: 'everyone\'s money (wallet + bank)', emoji: '💰' },
                inv:     { label: 'everyone\'s inventory (items, balls, food, fish)', emoji: '🎒' },
                pokemon: { label: 'everyone\'s caught Pokémon', emoji: '🐾' },
                loans:   { label: 'everyone\'s bank loans, credit scores & balance history', emoji: '🏦' },
            };
            const info = resetLabels[resetType];

            const confirmArg = (args[2] || '').toLowerCase();

            // Step 1: first call — warn and ask to re-run with "confirm"
            if (confirmArg !== 'confirm') {
                pendingResets[senderId] = { type: resetType, expiresAt: Date.now() + 60_000 };
                return chatObj.sendMessage(
                    `⚠️ *ARE YOU SURE?* ⚠️\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                    `${info.emoji} You're about to *permanently reset ${info.label}* for *ALL registered users*.\n` +
                    `❗ This *cannot be undone*.\n\n` +
                    `To confirm, type:\n\`.reset ${resetType} confirm\`\n` +
                    `_(expires in 60 seconds — run \`.reset ${resetType}\` again if it lapses)_`,
                    { mentions: [senderId] }
                ).catch(() => {});
            }

            // Step 2: confirmation — must match a still-valid pending request
            const pending = pendingResets[senderId];
            if (!pending || pending.type !== resetType || Date.now() > pending.expiresAt) {
                return msg.reply(
                    `❌ No pending confirmation for \`.reset ${resetType}\` (or it expired).\n` +
                    `Run \`.reset ${resetType}\` first, then confirm within 60 seconds.`
                );
            }
            delete pendingResets[senderId];

            // Perform the actual wipe across every registered user
            let affected = 0;
            for (const [userId, userData] of Object.entries(db)) {
                if (userId.startsWith('_') || !userData || typeof userData !== 'object') continue;
                if (!isRegistered(userId)) continue;

                switch (resetType) {
                    case 'money':
                        userData.wallet = 0;
                        userData.bank = 0;
                        break;
                    case 'inv':
                        zeroUserInventory(userData);
                        break;
                    case 'pokemon':
                        userData.pokemon = [];
                        break;
                    case 'loans':
                        userData.bankLoan          = null;
                        userData.loanBanUntil      = null;
                        userData.bankLoanOverdueAt = null;
                        userData.bankLoanCount     = 0;
                        userData.creditScore       = 500;   // back to default starting score
                        userData.balanceHistory    = [];    // fresh start for the balance-based cap too
                        break;
                }
                affected++;
            }
            saveDB();

            return chatObj.sendMessage(
                `${info.emoji} *GLOBAL RESET COMPLETE* ${info.emoji}\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `✅ Reset *${info.label}* for *${affected}* registered user${affected !== 1 ? 's' : ''}.\n` +
                `⚖️ Executed by: <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [senderId] }
            ).catch(() => {});
        }

        // ── .addmoney / .removemoney — OWNER ONLY ───────────────────────────────
        // Usage: .addmoney [amount] [@user]   |   .removemoney [amount] [@user]
        if (command === '.addmoney' || command === '.removemoney') {
            if (!OWNER_NUMBERS.includes(senderId)) return msg.reply('❌ Only the owner can use this command!');

            let targetId = msg.mentionedIds?.[0] || (msg.hasQuotedMsg ? (await msg.getQuotedMessage()).author : null);
            if (!targetId) return msg.reply(`❌ Tag someone or reply to their message.\nUsage: \`${command} [amount] [@user]\``);

            let amtStr = '';
            for (let i = 1; i < args.length; i++) {
                let clean = args[i].replace(/[^0-9a-zA-Z.]/g, '');
                if (clean && !args[i].includes('@')) { amtStr = clean; break; }
            }
            const amt = parseAmount(amtStr);
            if (isNaN(amt) || amt <= 0) return msg.reply(`❌ Usage: \`${command} [amount] [@user]\`\nExample: \`${command} 50000 @user\` or \`${command} 1m @user\``);

            initUser(targetId);

            let targetName = targetId;
            const targetDu = await client.users.fetch(targetId).catch(() => null);
            if (targetDu) targetName = targetDu.globalName || targetDu.username || targetId;

            if (command === '.addmoney') {
                db[targetId].wallet += amt;
            } else {
                db[targetId].wallet = Math.max(0, db[targetId].wallet - amt);
            }
            saveDB();

            const verb = command === '.addmoney' ? 'added to' : 'removed from';
            const emoji = command === '.addmoney' ? '💰' : '💸';
            return chatObj.sendMessage(
                `${emoji} *BALANCE ${command === '.addmoney' ? 'ADDED' : 'REMOVED'}* ${emoji}\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `👤 *User:* ${targetName} (${targetId})\n` +
                `💵 *Amount ${verb} wallet:* $${formatNum(amt)}\n` +
                `👛 *New Balance:* $${formatNum(db[targetId].wallet)}\n` +
                `⚖️ *Action by:* <@${senderId}>\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
                { mentions: [targetId, senderId] }
            ).catch(() => {});
        }

        // ── .bankinfo ─────────────────────────────────────────────────────────
        if (command === '.bankinfo') {
            initUser(senderId);
            const u = db[senderId];
            const creditScore = u.creditScore || 500;
            const band = getCreditBand(creditScore);

            const activeBankLoan  = u.bankLoan  || null;
            const bankLoanLine    = activeBankLoan
                ? `⚠️ *$${formatNum(activeBankLoan.totalRepay)}* due <t:${Math.floor(activeBankLoan.dueDate/1000)}:R>`
                : `✅ None`;

            const bankInfoText =
                `🏦 *BANK SYSTEM — FULL GUIDE* 🏦\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +

                `💰 *YOUR FINANCES*\n` +
                `👛 Wallet: *$${formatNum(u.wallet)}*  _(vulnerable to .rob)_\n` +
                `🏦 Bank: *$${formatNum(u.bank)}* / *${formatCapacity(u)}* capacity\n` +
                `📊 Credit Score: *${creditScore}* — ${band.label}\n` +
                `🏦 Bank Loan: ${bankLoanLine}\n` +

                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🏦 *HOW THE BANK WORKS*\n` +
                `Your money lives in two places:\n` +
                `• 👛 *Wallet* — spendable & gambleable, but robbers can steal from it\n` +
                `• 🏦 *Bank* — safe storage, can't be robbed, has a capacity cap\n\n` +
                `📥 \`.dep [amount]\` — Wallet → Bank\n` +
                `📤 \`.wd [amount]\` — Bank → Wallet\n` +
                `💸 \`.transfer [amount] @user\` — Send money to someone\n` +
                `📊 \`.bal\` — Check wallet, bank & total wealth\n\n` +

                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🏗️ *BANK CAPACITY*\n` +
                `Default cap: *$500K*. Buy upgrades with \`.bank buy <1-10>\`:\n` +
                `• 1️⃣ +$500K — costs $100K\n` +
                `• 2️⃣ +$1M — costs $300K\n` +
                `• 3️⃣ +$5M — costs $800K\n` +
                `• 4️⃣ +$10M — costs $1M\n` +
                `• 5️⃣ +$30M — costs $10M\n` +
                `_Preview upgrades: \`.bank upgrade\`_\n\n` +

                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🏦 *BANK LOANS (\`.bank loan\`) — Credit System*\n` +
                `No collateral needed — borrowing power based on your credit score.\n\n` +
                `*Loan Tiers:*\n` +
                `• Micro: $1K–$50K | 5% interest | 2 days\n` +
                `• Small: $50K–$500K | 8% interest | 4 days\n` +
                `• Medium: $500K–$2M | 12% interest | 7 days\n` +
                `• Large: $2M–$10M | 18% interest | 14 days\n` +
                `• Elite: $10M+ | 25% interest | 30 days _(700+ credit required)_\n\n` +
                `*Commands:*\n` +
                `• \`.bank loan [amount]\` — Request a bank loan\n` +
                `• \`.bank repay\` — Repay your active bank loan\n` +
                `• \`.bank loans\` — View active bank loan details\n` +
                `• \`.bank credit\` — View your credit score & band\n\n` +
                `🔴 *Default consequences:*\n` +
                `• Overdue → gambling blocked, -3 credit per gambling attempt\n` +
                `• 2+ days unpaid → *4-day gambling ban* + *-80 credit*\n` +
                `• Debt stays during ban — repay anytime with \`.bank repay\`\n\n` +

                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `📊 *CREDIT SCORE SYSTEM*\n` +
                `Controls your bank loan limit. Starts at 500.\n\n` +
                `*Score Bands:*\n` +
                `• 💎 Platinum 800+ — Unlimited\n` +
                `• 🥇 Gold 700–799 — Unlimited\n` +
                `• 🥈 Silver 550–699 — Up to $10M\n` +
                `• 🥉 Bronze 400–549 — Up to $2M\n` +
                `• 📉 Low 250–399 — Up to $500K\n` +
                `• 🚫 Poor 0–249 — Up to $50K\n\n` +
                `📈 *Improve score:* repay bank loans early (⭐ +20 to +60 pts)\n` +
                `📉 *Hurt score:* bank loan default (-80), late payment (-3/attempt)`;

            return sendLongEmbed(msg, {
                title: '🏦 BANK SYSTEM GUIDE 🏦',
                description: bankInfoText,
                color: 0xF1C40F,
                footer: '.loan • .loan repay • .loan status • .upgrades • .u1-.u10'
            });
        }

// ── .wealthy / .rich — Top 10 richest users in this group ────────────
        if (command === '.wealthy' || command === '.rich') {
            if (!isGroupChat) return msg.reply('❌ This command only works in groups!');

            const isValidDiscordId = id => /^\d{17,19}$/.test(id);

            const richList = Object.keys(db)
                .filter(id => id !== '_config' && isValidDiscordId(id) && db[id].wallet !== undefined)
                .map(id => ({
                    id,
                    wealth: (db[id].wallet || 0) + (db[id].bank || 0)
                }))
                .sort((a, b) => b.wealth - a.wealth)
                .slice(0, 10);

            if (richList.length === 0)
                return msg.reply('❌ No users found in the database yet!');

            const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
            const short = n => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(2)+'K' : formatNum(n);

            // Resolve names + avatars for each entry (no pings)
            let desc = '';
            for (let i = 0; i < richList.length; i++) {
                const entry = richList[i];
                const u2 = db[entry.id];
                let uName = entry.id;
                let uAvatar = null;
                try {
                    const du = await client.users.fetch(entry.id).catch(() => null);
                    if (du) { uName = du.displayName || du.username || entry.id; uAvatar = du.displayAvatarURL({ size: 32, extension: 'png' }); }
                    if (msg.guild) {
                        const mem = await msg.guild.members.fetch(entry.id).catch(() => null);
                        if (mem) { uName = mem.nickname || mem.displayName || uName; uAvatar = mem.displayAvatarURL({ size: 32, extension: 'png' }) || uAvatar; }
                    }
                } catch (_) {}
                desc += `${medals[i] || (i+1)+'.'} **${uName}**\n`;
                desc += `🏦 \`${short(u2.bank||0)}\`  💰 \`${short(u2.wallet||0)}\`  💵 **\`${short(entry.wealth)}\`**\n\n`;
            }

            // Use #1 entry's avatar as the embed thumbnail
            let topAvatar = null;
            try {
                const topDu = await client.users.fetch(richList[0].id).catch(() => null);
                if (topDu) topAvatar = topDu.displayAvatarURL({ size: 128, extension: 'png' });
                if (msg.guild) {
                    const topMem = await msg.guild.members.fetch(richList[0].id).catch(() => null);
                    if (topMem) topAvatar = topMem.displayAvatarURL({ size: 128, extension: 'png' }) || topAvatar;
                }
            } catch (_) {}

            const wealthyEmbed = new EmbedBuilder()
                .setColor(0xF1C40F)
                .setTitle('💰 Global Rich List')
                .setDescription(desc.trim())
                .setThumbnail(topAvatar)
                .setFooter({ text: '🏦 Bank  💰 Wallet  💵 Total Net Worth' });

            return msg.channel.send({ embeds: [wealthyEmbed], reply: { messageReference: msg.id, failIfNotExists: false }, allowedMentions: { parse: [] } }).catch(() => {});
        }

// ── HELPER: get target from mention or quoted msg ─────────────────────
        const getFunTarget = async () => {
            if (msg.mentionedIds?.[0]) return msg.mentionedIds[0];
            if (msg.hasQuotedMsg) return (await msg.getQuotedMessage()).author;
            return null;
        };

        // ── FUN COMMANDS ──────────────────────────────────────────────────────
        const FUN_CMD_RESPONSES = {
            play: [
                "🎮 started a game with {target} and got absolutely destroyed in 5 minutes 💀",
                "🎲 challenged {target} to chess. {target} didn't even look up from their phone 😭",
                "🎯 tried playing with {target} but {target} keeps changing the rules mid-game 😤",
                "🃏 played cards with {target} and lost every single round. Unbelievable. 💸",
                "🎮 and {target} played tag. {target} is still 'it' from 2019 😂",
                "🕹️ invited {target} to play but {target} said 'one sec' and never came back 💔",
                "🎳 played bowling with {target}. The ball went backwards. Nobody knows how. 🤷",
                "🎰 played a game with {target} and somehow both lost. That's a new record. 😮",
                "🏓 played ping pong with {target}. {target} hit the ball into next week. 📅",
                "🎮 rage-quit playing with {target} after 30 seconds. Personal record. 🏆",
                "🎲 forced {target} into a board game. {target} flipped the table. Classic. 😂",
                "🎮 played GTA with {target}. {target} drove into the ocean immediately. 🌊",
                "🏋️ and {target} played arm wrestling. The table broke. Draw! 💥",
                "🎮 queued with {target} and they went AFK in the loading screen 😑",
                "🎯 did a 1v1 with {target}. {target} tea-bagged and left. Disrespectful. 😤",
                "🎮 played hide and seek with {target}. {target} is still hiding from their responsibilities 👀",
                "🎲 started monopoly with {target}. Friendship: on thin ice. 🧊",
                "🕹️ carried {target} through the game but {target} took all the credit 🙄",
                "🎮 played AMONG US with {target}. {target} was the impostor. As always. 🔪",
                "🎯 and {target} competed. {target} lost and blamed lag. Disgusting. 😂",
                "🎮 played Minecraft with {target}. {target} punched a tree for 2 hours straight 🌲",
                "🃏 played UNO with {target} and drew +4 three times in a row. The universe hates them. 😭",
                "🎮 teamed up with {target}. Immediately regretted it. 💀",
                "🏊 challenged {target} to a swim race. {target} brought floaties. Adults. 🤦",
                "🎮 played 5 seconds with {target} and {target} already asked 'are we there yet?' 😭",
            ],
            slap: [
                "👋 slapped {target} so hard their ancestors felt it 💀",
                "🖐️ slapped {target} with the force of 1000 disappointed parents 😤",
                "👊 smacked {target} with a wet fish. Nobody knows why. 🐟",
                "🖐️ slapped {target} into next Tuesday 📅",
                "👋 slapped {target} and {target}'s wig went flying 💨",
                "🤚 gave {target} a slap so loud the neighbours called the cops 🚔",
                "🖐️ slapped {target} and {target} said 'thank you' and walked away 😳",
                "👋 slapped {target} across the chat! *CRACK* 💥",
                "🤜 slapped {target} with a slipper. Grandma-style. 👡",
                "🖐️ slapped {target} and {target} got sent to the shadow realm 👻",
                "👋 backhanded {target} into 2026 📆",
                "🤚 slapped {target} so hard Google Maps updated the location 📍",
                "🖐️ gave {target} the slap of shame 😂",
                "👊 slapped {target}'s phone right out of their hand mid-text 📱💔",
                "🤜 delivered a slap that echoed through the entire group 📢",
                "🖐️ slapped {target} into another dimension 🌀",
                "👋 slapped {target} with a rolled-up newspaper like a bad dog 🗞️🐕",
                "🤚 slapped {target} so clean it sounded like a high five 🙌",
                "🖐️ smacked {target} and the whole group heard it 👂",
                "👋 slapped {target} into therapy 🛋️",
                "🤜 slapped {target} with the power of all unread notifications 🔔",
                "🖐️ slapped {target} and time stopped for 3 seconds ⏱️",
                "👊 slapped {target} right out of their comfort zone 😳",
                "🖐️ slapped {target} so hard autocorrect couldn't even fix it 📝",
                "👋 delivered justice via slap to {target}. Court dismissed. ⚖️",
            ],
            hug: [
                "🤗 gave {target} a warm hug and {target} started crying. Touch-starved. 😢",
                "💛 hugged {target} so tight {target} made a squeaky toy noise 🧸",
                "🤗 tried to hug {target} but {target} said 'ew get off' 😭",
                "💗 hugged {target} and {target} patted back awkwardly. They tried. 😂",
                "🤗 gave {target} a bear hug and cracked 3 of their ribs. Oops. 🦴",
                "💛 and {target} had a moment. The whole group is crying. 😭",
                "🫂 hugged {target} for 47 seconds. Nobody said anything. 🕐",
                "🤗 ran and hugged {target} full speed. Both fell. Worth it. 😂",
                "💗 gave {target} the most comforting hug known to mankind 🌟",
                "🤗 hugged {target} and {target}'s trust issues temporarily paused ⏸️",
                "🫂 went in for a hug but {target} went for a handshake. Awkward. 😬",
                "💛 squeezed {target} so tight their eyes popped 👀",
                "🤗 surprised {target} with a hug from behind. {target} screamed. 😱",
                "💗 held {target} and whispered 'we're getting through this' 🥹",
                "🫂 and {target} hugged for so long people thought they fused together 🧬",
                "🤗 tried to hug {target} but {target} pointed at a 'no touching' sign 🚫",
                "💛 gave {target} the dad-hug they never had 🥲",
                "🤗 full-body launched onto {target}. {target} accepted their fate. 💀",
                "🫂 hugged {target} and whispered 'you owe me $20' right after 💸",
                "🤗 and {target} have now officially entered the homies phase 👊",
                "💗 gave {target} a hug so good {target} called their mom after 📞",
                "🤗 hugged {target} and solved 3 of their life problems in the process 🧩",
                "🫂 wrapped arms around {target} and refused to let go 🔒",
                "💛 hugged {target} and the surrounding temperature rose by 5 degrees 🌡️",
                "🤗 gave {target} a group hug by themselves. Champion. 🏆",
            ],
            fuck: [
                "💀 and {target} tried. The vibe was off. It was quiet. Very quiet. 😶",
                "😳 looked at {target} and immediately regretted sending this command 💀",
                "🔥 and {target} got together and somehow caught feelings instead. Tragic. 💔",
                "😂 sent this command to {target} and {target} replied 'lol ok' and left 🚪",
                "💀 and {target} disappeared for 5 minutes. Nobody asked. Nobody will. 🤐",
                "😈 and {target} — the group doesn't wanna know. The group will never know. 🙈",
                "💥 and {target}... yep. That happened. Allegedly. 🤷",
                "😤 tried, but {target} had a headache. Again. Third time this week. 🥴",
                "🔥 and {target} made memories the internet wasn't ready for 📵",
                "😂 sent this command and {target} screenshotted it. Sent to mom. 📸",
                "💀 and {target} had the most awkward 47 seconds in recorded history ⏱️",
                "😳 and {target} — we move on. We don't discuss. We heal. 🛐",
                "🔥 thought it was gonna be legendary with {target}. It was not. 💩",
                "😈 and {target} wrote history. Nobody will read that chapter. 📖🔒",
                "💥 and {target} — the neighbours filed a noise complaint. 🏘️",
                "😂 this command was sent to {target}. {target} is now in therapy. 🛋️",
                "💀 and {target} went for it. {target}'s character arc has changed forever. 🌀",
                "😤 and {target} — God is watching. And taking notes. 📋👆",
                "🔥 confessed to {target} via this command. {target} said 'ok' and nothing else. 💬",
                "😳 and {target} started something the bot is NOT going to finish describing 🙅",
                "💀 and {target}. Let's just say the simulation nearly crashed. 💻",
                "😈 did the unthinkable with {target}. The prophecy is fulfilled. 📜",
                "🔥 and {target} have entered a new era. Nobody is ready. 🌅",
                "😂 and {target} — zero chemistry, maximum chaos. 💥",
                "💀 and {target} tried once. Just once. The universe said 'no more'. 🌍",
            ],
            kiss: [
                "💋 kissed {target} and {target} wiped it off immediately 😭",
                "😘 went in for a kiss but {target} turned their head. Cheek kiss. Pain. 💔",
                "💋 kissed {target} and {target} blushed so hard they went offline 🌹",
                "😏 kissed {target} and now the whole group is gossiping 👀",
                "💋 surprised {target} with a kiss. {target} bit them instead. Classic. 😂",
                "😘 gave {target} a kiss and {target} said 'ew you have garlic breath' 🧄",
                "💋 kissed {target}'s forehead like a parent. Weird but sweet. 😂",
                "😍 and {target} kissed under the stars. Okay Romeo take it easy. 🌟",
                "💋 kissed {target} and {target} immediately changed their relationship status. Fast. 💍",
                "😘 went for {target}'s lips but accidentally kissed {target}'s nose. Still counts. 👃",
                "💋 kissed {target} and {target} passed out from the shock 😵",
                "😏 gave {target} the kiss of betrayal. Et tu? 🗡️",
                "💋 kissed {target} and {target} rated it 6/10. Cold. 😶",
                "😘 kissed {target} gently. {target} cried. Nobody expected that. 😭",
                "💋 gave {target} a flying kiss. {target} let it hit the wall. 🧱",
                "😍 kissed {target} for so long the bot had to restart ♻️",
                "💋 kissed {target} and {target} said 'okay but that doesn't mean anything' 💔",
                "😘 leaned in for a kiss with {target}. {target} sneezed. Perfect timing. 🤧",
                "💋 kissed {target} and immediately regretted it. The feeling was mutual. 😬",
                "😏 kissed {target} on the hand like royalty. {target} did not ask for this. 👑",
                "💋 kissed {target} softly. {target} short-circuited. 💻",
                "😘 and {target} kissed and three people in the group lost their appetite 🤢",
                "💋 gave {target} a kiss and {target}'s whole personality changed 🌀",
                "😍 kissed {target} and heard wedding bells. {target} heard nothing. 💔",
                "💋 kissed {target} right in the middle of their sentence. Rude but iconic. 😂",
            ],
            lick: [
                "👅 licked {target}'s cheek like a golden retriever 🐕",
                "😜 licked {target} and {target} immediately questioned their life choices 💀",
                "👅 licked {target}'s face and {target} tasted like regret 😂",
                "😛 licked {target}'s ear and {target} yeeted off the building 🏢",
                "👅 licked {target} and {target} filed a formal complaint with HR 📋",
                "😜 licked {target} like an ice cream. {target} was NOT ice cream. 🍦",
                "👅 gave {target} the full dog treatment. Wet. Unwanted. Enthusiastic. 🐶",
                "😛 licked {target} and {target} looked at the camera like The Office 📷",
                "👅 licked {target} and {target} has been in the shower for 3 hours now 🚿",
                "😜 licked {target}'s forehead. Nobody in the group is okay. 😶",
                "👅 licked {target} and {target} said 'stop that' in 4 languages 🌍",
                "😛 licked {target} and the whole chat went silent for 10 seconds 🔇",
                "👅 and {target} — someone needed to call animal control 🚨",
                "😜 licked {target} and {target} moved to a different country 🌏",
                "👅 licked {target} clean off. {target} evaporated. 💨",
                "😛 licked {target} like a stamp. Sent. 📮",
                "👅 licked {target} and {target} said 'not again' — AGAIN?? 😱",
                "😜 gave {target} the full lick experience. {target} uninstalled the app. 📵",
                "👅 licked {target} and {target}'s soul left the body momentarily 👻",
                "😛 licked {target} and somehow unlocked a new side quest 🗺️",
                "👅 licked {target}'s phone screen. That was their password. Hacked. 💻",
                "😜 licked {target} while {target} was talking. {target} forgot every word. 😶",
                "👅 licked {target} and got immediately blocked 🚫",
                "😛 licked {target} so enthusiastically the bot blushed 🤖❤️",
                "👅 licked {target} and {target} gave it a solid 4/10 with feedback 📝",
            ],
            kill: [
                "💀 eliminated {target} with the force of 1000 unread notifications 🔔",
                "🔪 and {target} had a duel. {target} lost. Badly. 😂",
                "💀 finished {target} with a single look 👀",
                "🗡️ took out {target} before {target} could say 'wait—' ⚡",
                "💀 deleted {target} from the group chat of life 🗑️",
                "🔫 shot {target} with facts and logic. Fatal. 🧠",
                "💀 and {target} fought. {target} disconnected from reality 📡",
                "🗡️ ended {target}'s career, reputation, and WiFi all at once 📵",
                "💀 sneezed and {target} flew away 🤧💨",
                "🔪 hunted {target} across 7 group chats and found them 📱",
                "💀 and {target} — {target} respawned but with less confidence 🔄",
                "🗡️ eliminated {target} quicker than {target}'s attention span ⏱️",
                "💀 finished {target} off with the most passive-aggressive 'ok' ever sent 📩",
                "🔫 took {target} out with one sentence. The pen is mightier. ✍️",
                "💀 and {target}. Cause of death: embarrassment. 😳",
                "🗡️ hunted {target} like a final boss fight and won first try 🏆",
                "💀 ended {target}'s entire legacy in under 10 seconds ⏰",
                "🔪 sent {target} to the shadow realm. No return address. 👻",
                "💀 and {target} — witnesses said it was painless. They lied. 😂",
                "🗡️ destroyed {target} so thoroughly Google no longer recognizes their name 🔍",
                "💀 gave {target} the final boss treatment. Easy mode. 😴",
                "🔫 and {target} fought. {target} respawned as a new person. For the better. 🌱",
                "💀 wiped {target} out of the simulation entirely 🖥️",
                "🗡️ took down {target} and then walked away without looking at the explosion 🔥🚶",
                "💀 eliminated {target} from the top of the leaderboard. Step aside. 📊",
            ],
            kidnap: [
                "🚗 kidnapped {target} and {target} fell asleep in the van 😴",
                "🪢 grabbed {target} and {target} immediately asked for the WiFi password 📶",
                "🚐 kidnapped {target} but {target} started rating the van's interior 🛋️",
                "🪢 took {target} hostage. {target} is now running the operation. 💀",
                "🚗 kidnapped {target} and {target} said 'finally, an adventure' 😂",
                "🪢 tried to kidnap {target} but {target} just walked in voluntarily 🚪",
                "🚐 blindfolded {target} and took them somewhere secret. {target} filmed a vlog. 🎥",
                "🪢 kidnapped {target} and now {target} won't stop giving unsolicited opinions 🗣️",
                "🚗 snatched {target} but {target} had already packed a bag 🧳",
                "🪢 took {target} and now both are stuck arguing about what to eat 🍕🍔",
                "🚐 kidnapped {target} at 3am. {target} was already awake. No reason given. 🌙",
                "🪢 grabbed {target} and {target} sent their location to 7 people before leaving 📍",
                "🚗 kidnapped {target}. Ransom demanded. Family paid within 30 seconds. That hurt. 💸",
                "🪢 and {target} have been on the run for 4 hours. {target} is having fun. 😄",
                "🚐 kidnapped {target} and {target} started auditing all decisions 📋",
                "🪢 took {target} hostage. {target} is now giving a TED talk. 🎤",
                "🚗 tried to kidnap {target} but {target} kicked the door open 🦵",
                "🪢 kidnapped {target} and {target} organized the whole situation better 📊",
                "🚐 and {target} are still missing. The bot isn't worried. The bot is concerned. 😐",
                "🪢 grabbed {target} mid-sentence. {target} finished the sentence in the van. 😂",
                "🚗 kidnapped {target} and {target} Yelp-reviewed the experience 3/5 stars 📝",
                "🪢 took {target} and now {target} has Stockholm Syndrome within 10 minutes 💔",
                "🚐 kidnapped {target} but {target} started redecorating the van 🎨",
                "🪢 grabbed {target} but ran out of breath. {target} lapped them. 🏃",
                "🚗 kidnapped {target} and genuinely forgot why. Oops. 🤦",
            ],
            punch: [
                "🥊 punched {target} so hard {target}'s shadow felt it 👤",
                "👊 punched {target} and {target} spun like a cartoon character 🌀",
                "🥊 delivered a punch to {target} that echoed in 3 time zones ⏰",
                "👊 punched {target} and {target}'s wig went into another group chat 💨",
                "🥊 hit {target} so hard {target} buffered for 10 seconds ⏳",
                "👊 punched {target} clean into next month 📅",
                "🥊 wound up and punched {target} with the energy of a Monday morning 😤",
                "👊 sucker-punched {target} mid-sentence. {target} never finished the thought. 💭",
                "🥊 punched {target} and {target} immediately had a character arc 🌅",
                "👊 punched {target} and the bot rated it 10/10 for technique 🏅",
                "🥊 hit {target} so hard the chat went silent 🔇",
                "👊 punched {target} into sobriety and self-awareness 🧘",
                "🥊 delivered the punch {target} has needed since primary school 🏫",
                "👊 punched {target} and {target} said 'I deserved that' 😔",
                "🥊 hit {target} with the haymaker of truth 💥",
                "👊 punched {target} so hard Google felt the vibration 🌍",
                "🥊 punched {target} into the shadow realm and {target} is now rent-free in there 🧠",
                "👊 punched {target} and all of {target}'s bad decisions flashed before them 💀",
                "🥊 landed the cleanest punch on {target}. Textbook. Beautiful. 😤",
                "👊 punched {target} and {target} respawned with better energy ✨",
                "🥊 gave {target} the punch they've been ignoring from karma 🔄",
                "👊 knocked {target} clear into a different storyline 📖",
                "🥊 punched {target} and the wind said 'daaaang' 💨",
                "👊 punched {target} so hard {target}'s ancestors flinched 👴",
                "🥊 punched {target} once. That was enough. 😶",
            ],
            pat: [
                "🫶 patted {target} on the head like a golden retriever 🐾",
                "👋 gave {target} the most patronizing head pat in history 😌",
                "🫶 patted {target} gently and {target} purred 😂",
                "👋 patted {target} on the back and {target} started crying. Long time coming. 😢",
                "🫶 pat pat pat. {target} needed that. You know it. 🥹",
                "👋 patted {target} on the head. {target} is 6 foot tall. It was a stretch. 😅",
                "🫶 gave {target} the supportive pat of a disappointed parent 😔",
                "👋 patted {target} slowly like 'good try buddy'. {target} knows. 💀",
                "🫶 patted {target} on the head and {target} said 'I am NOT a child' 😤",
                "👋 gave {target} three gentle pats and walked away. Said everything. 💬",
                "🫶 patted {target}'s head and accidentally gave them +10 confidence ✨",
                "👋 pat-patted {target} and {target} went full dog mode 🐕",
                "🫶 patted {target} so softly {target} got goosebumps 😳",
                "👋 patted {target} mid-rant. {target} immediately calmed down. 🧘",
                "🫶 gave {target} the 'there there' pat. {target} is NOT okay but okay now. 😭",
                "👋 patted {target} on the head with two fingers like royalty 👑",
                "🫶 patted {target} and {target} leaned into it like a needy cat 🐱",
                "👋 gave {target} a pat that said 'you tried' without saying a word 😶",
                "🫶 patted {target} on the back for even showing up today ✅",
                "👋 gently patted {target} and {target} broke into tears immediately 😭",
                "🫶 patted {target} and {target}'s whole mood shifted from 2 to 7 📈",
                "👋 patted {target} on the head and {target} asked for it again. Twice. 🐕",
                "🫶 gave {target} the most gentle pat and everyone melted 🥺",
                "👋 patted {target} and said nothing. The silence was healing. 🌿",
                "🫶 patted {target} so kindly {target} questioned if they were loveable. They are. 💛",
            ],
            
        };

        // ── GIF assets for fun commands ─────────────────────────────────────
        // Put files like assets/hug1.gif, assets/hug2.gif, assets/kiss1.gif etc.
        // Commands with no matching files (or excluded below) just send text, same as before.
        const FUN_GIF_DIR = path.join(__dirname, 'assets');
        const FUN_GIF_EXCLUDED = ['fuck']; // never attach media for these
        function getRandomFunGif(cmd) {
            if (FUN_GIF_EXCLUDED.includes(cmd)) return null;
            try {
                const files = fs.readdirSync(FUN_GIF_DIR).filter(f =>
                    new RegExp(`^${cmd}\\d*\\.(gif|mp4|webp|png|jpg|jpeg)$`, 'i').test(f)
                );
                if (!files.length) return null;
                const pick = files[Math.floor(Math.random() * files.length)];
                return path.join(FUN_GIF_DIR, pick);
            } catch (_) {
                return null; // assets folder missing or unreadable — fall back to text-only
            }
        }

        const FUN_COMMANDS = ['play','slap','hug','fuck','kiss','lick','kill','kidnap','punch','pat',];
        const cleanCmd = command.startsWith('.') ? command.slice(1) : command;

        if (FUN_COMMANDS.includes(cleanCmd)) {
            const targetId = await getFunTarget();
            const responses = FUN_CMD_RESPONSES[cleanCmd];
            const raw = responses[Math.floor(Math.random() * responses.length)];
            const senderName = `<@${senderId}>`;

            if (!targetId) {
                return chatObj.sendMessage(
                    `❌ Tag someone or reply to their message!\nUsage: \`.${cleanCmd} @user\``,
                    { mentions: [senderId] }
                ).catch(() => {});
            }

            const targetName = `<@${targetId}>`;
            const text = raw.replace(/\{target\}/g, targetName);
            const caption = `${senderName} ${text}`;

            const gifPath = getRandomFunGif(cleanCmd);
            if (gifPath) {
                const media = MessageMedia.fromFilePath(gifPath);
                return chatObj.sendMessage(media, { caption, mentions: [senderId, targetId] }).catch(() => {});
            }

            return chatObj.sendMessage(
                caption,
                { mentions: [senderId, targetId] }
            ).catch(() => {});
        }
    } catch (err) {
        console.error('New commands error:', err.message);
    }
});

// ── .amazon STORE ─────────────────────────────────────────────────────────────
client.on('messageCreate', async msg => {
    if (alreadyProcessed('amazon_store', msg.id)) return; // FIX: deduplicate before any async work
    try {
        if (msg.partial) msg = await msg.fetch();
        if (!msg.author) return;
        if (typeof msg.author !== "string" && !msg.author.id) return;
    } catch (e) {
        console.error('Partial fetch failed:', e.message);
        return;
    }
    if (!msg.__wrapped && msg.author.bot && msg.author.id !== '1528377826485473351') return;  // Allow Luna through
    msg = wrapMessage(msg);
    try {
        let body = msg.body ? msg.body.trim() : '';
        body = body.replace(/^\.\s+/, '.');
        if (!body.startsWith('.amazon')) return;
        const senderId = msg.author || msg.from;
        const chatObj  = await msg.getChat();
        if (!isBotActiveInChat(chatObj.id._serialized)) return;
        const args     = body.split(' ').filter(a => a !== '');
        const command  = args[0].toLowerCase();
        if (command !== '.amazon') return;

        // ── REGISTRATION GATE — .amazon requires .reg first ──────────────────
        if (!isRegistered(senderId)) return;

        initUser(senderId);

        const sub = (args[1] || '').toLowerCase();

        // ── .amazon — Show store ──────────────────────────────────────────────
        if (!sub || sub === 'store') {
            let out = `🛒 *AMAZON STORE* 🛒\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n`;
            out += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            out += `👜 *DESIGNER BAGS*\n_(Replaces your current bag in inventory)_\n\n`;
            for (const [k, bag] of Object.entries(AMAZON_BAGS)) {
                out += `${bag.emoji} *${bag.name}*\n`;
                out += `   💰 Price: *$${formatNum(bag.price)}*\n`;
                out += `   📋 ${bag.desc}\n`;
                out += `   🛒 Buy: \`.amazon buy bag ${k}\`\n\n`;
            }
            out += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            out += `🎟️ *LOTTERY TICKET*\n_(5 entrants per round — top 3 win cash!)_\n\n`;
            out += `🎰 *Lottery Ticket*\n`;
            out += `   💰 Price: *$${formatNum(LOTTERY_TICKET_PRICE)}*\n`;
            out += `   📋 1st: $300K-$500K | 2nd: $160K-$200K | 3rd: $70K-$150K\n`;
            out += `   🛒 Buy: \`.buy lottery\`\n`;
            out += `   📊 Check status: \`.ll\`\n\n`;
            out += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            out += `💳 *Your wallet:* $${formatNum(db[senderId].wallet)}\n`;
            out += `👜 *Current bag:* ${db[senderId].inventory.assignedBag || 'Basic Sack'}`;
            return msg.reply(out);
        }

        // ── .amazon buy bag <bagkey> ──────────────────────────────────────────
        if (sub === 'buy' && (args[2] || '').toLowerCase() === 'bag') {
            const bagKey = (args[3] || '').toLowerCase();
            const bag    = AMAZON_BAGS[bagKey];
            if (!bag) return msg.reply(`❌ Unknown bag! Valid: ${Object.keys(AMAZON_BAGS).map(k => `\`.amazon buy bag ${k}\``).join(', ')}`);
            if (db[senderId].wallet < bag.price) return msg.reply(`❌ Not enough funds!\n💰 *${bag.name}* costs: *$${formatNum(bag.price)}*\n👛 Your wallet: *$${formatNum(db[senderId].wallet)}*`);
            const oldBag = db[senderId].inventory.assignedBag || 'Basic Sack';
            db[senderId].wallet -= bag.price;
            db[senderId].inventory.assignedBag = bag.name; saveDB();
            return msg.reply(
                `${bag.emoji} *BAG PURCHASED!* ${bag.emoji}\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `👜 *${bag.name}* is now in your inventory!\n📋 ${bag.desc}\n\n` +
                `🔄 Replaced: *${oldBag}*\n💳 Paid: *-$${formatNum(bag.price)}*\n👛 Wallet: $${formatNum(db[senderId].wallet)}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n_Check \`.inv\` to see your new bag! 🎒_`
            );
        }

        return msg.reply(`❌ Unknown subcommand. Try:
• \.amazon — Browse store
• \.amazon buy bag <brand> — Buy a designer bag
• \.buy lottery — Buy a lottery ticket
• \.ll — Check lottery status`);
    } catch (err) {
        console.error('Amazon store error:', err.message);
    }
});

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // ── AUTO-SPAWN: roughly 2 wild Pokémon per hour in the designated Pokémon GC ──
    async function autoSpawnPokemon() {
        const pokemonChanId = db._config.pokemonChannelId;
        if (!pokemonChanId) return scheduleNextSpawn();

        // Don't spawn if one is already active
        if (wildPokemonState[pokemonChanId]) return scheduleNextSpawn();

        try {
            const channel = await client.channels.fetch(pokemonChanId).catch(() => null);
            if (!channel) return scheduleNextSpawn();

            const wild = pickWildPokemon(pokemonChanId);
            wildPokemonState[pokemonChanId] = {
                pokemon: { ...wild, currentHp: wild.hp },
                spawnTime: Date.now(),
                weakened: false
            };

            const spawnCard =
                `🌿 *A WILD POKÉMON APPEARED!* 🌿\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
                `${wild.emoji} *${wild.name}* [${wild.rarity}] appeared!\n` +
                `❤️ HP: ${wild.hp} | ⚔️ ATK: ${wild.atk}\n\n` +
                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                `🥊 Type *.catch* to battle it!\n` +
                `_(Flees in 3 minutes if nobody challenges!)_`;

            try {
                const artUrl = pokemonArtUrl(wild.dexId);
                await channel.send({ files: [new AttachmentBuilder(artUrl, { name: 'pokemon.png' })], content: spawnCard, allowedMentions: { parse: [] } });
            } catch (_) {
                await channel.send({ content: spawnCard, allowedMentions: { parse: [] } }).catch(() => {});
            }

            // Auto-flee after 3 minutes
            setTimeout(() => {
                if (wildPokemonState[pokemonChanId] && !wildPokemonState[pokemonChanId].weakened) {
                    delete wildPokemonState[pokemonChanId];
                    channel.send({ content: `💨 *Wild ${wild.emoji} ${wild.name} fled into the bushes!* Nobody was brave enough.`, allowedMentions: { parse: [] } }).catch(() => {});
                }
            }, 3 * 60 * 1000);

        } catch (e) {
            console.error('Auto-spawn error:', e.message);
        }

        scheduleNextSpawn();
    }

    function scheduleNextSpawn() {
        // Random interval between 25 and 35 minutes (~2 Pokémon/hour)
        const delayMs = (Math.floor(Math.random() * 11) + 25) * 60 * 1000;
        setTimeout(autoSpawnPokemon, delayMs);
    }

    // Kick off the first auto-spawn after 25–35 minutes
    scheduleNextSpawn();

    // ── AMEX WEEKLY MAINTENANCE CHECKER — runs every hour ─────────────────
    async function checkAmexMaintenance() {
        const now = Date.now();
        const ONE_DAY  = 24 * 60 * 60 * 1000;
        const ONE_WEEK = 7 * ONE_DAY;
        const SEVEN_DAYS = 7 * ONE_DAY; // grace period length (unchanged)

        for (const [userId, userData] of Object.entries(db)) {
            if (userId.startsWith('_') || !userData || typeof userData !== 'object' || !userData.amexCard) continue;
            const amex = userData.amexCard;
            const card = AMEX_CARDS[amex.tier];
            if (!card) continue;

            const lastMaint = amex.lastMaintenance || 0;
            const overdue   = now - lastMaint > ONE_WEEK;

            // Deactivate + notify if active and due
            if (amex.active && overdue) {
                amex.active = false;
                amex.graceStart = amex.graceStart || now;
                saveDB();
                const discordUser = await client.users.fetch(userId).catch(() => null);
                if (discordUser) {
                    await discordUser.send(
                        `⚠️ *Your Amex ${card.emoji} ${card.name} Card has been deactivated!*\n\n` +
                        `Weekly maintenance of *$${formatNum(card.maintenance)}* was not paid.\n` +
                        `All card benefits are now suspended.\n\n` +
                        `Pay now with *.paymaint* to reactivate.\n` +
                        `⏳ You have *7 days* before the card is permanently cancelled!`
                    ).catch(() => {});
                }
            }

            // Day 5 warning
            if (!amex.active && amex.graceStart) {
                const daysGone = Math.floor((now - amex.graceStart) / ONE_DAY);
                if (daysGone === 5 && !amex.day5WarnSent) {
                    amex.day5WarnSent = true;
                    saveDB();
                    const discordUser = await client.users.fetch(userId).catch(() => null);
                    if (discordUser) {
                        await discordUser.send(
                            `🚨 *2 days left before your Amex ${card.emoji} ${card.name} is permanently cancelled!*\n\n` +
                            `Pay maintenance now with *.paymaint* to save your card!\n` +
                            `Cost: *$${formatNum(card.maintenance)}*`
                        ).catch(() => {});
                    }
                }

                // Day 7 — permanently cancel
                if (daysGone >= 7) {
                    const discordUser = await client.users.fetch(userId).catch(() => null);
                    userData.amexCard = null;
                    saveDB();
                    if (discordUser) {
                        await discordUser.send(
                            `❌ *Your Amex ${card.emoji} ${card.name} Card has been permanently cancelled.*\n\n` +
                            `7-day grace period expired without payment.\n` +
                            `You can get it again anytime with *.avail ${amex.tier}* (avail fee applies).`
                        ).catch(() => {});
                    }
                }
            }

            // Send reminder to active card holders
            if (amex.active && !overdue) {
                const timeUntilDue = (lastMaint + ONE_WEEK) - now;
                // Send reminder 2 hours before due
                if (timeUntilDue < 2 * 60 * 60 * 1000 && !amex.reminderSent) {
                    amex.reminderSent = true;
                    saveDB();
                    const discordUser = await client.users.fetch(userId).catch(() => null);
                    if (discordUser) {
                        await discordUser.send(
                            `💳 *Weekly maintenance reminder!*\n` +
                            `Your Amex ${card.emoji} ${card.name} maintenance of *$${formatNum(card.maintenance)}* is due in ~2 hours.\n` +
                            `Pay now with *.paymaint* to keep your card active!`
                        ).catch(() => {});
                    }
                }
                // Reset reminder flag when maintenance is paid (handled in .paymaint)
                if (timeUntilDue > 2 * 60 * 60 * 1000) amex.reminderSent = false;
            }
        }
    }

    // Run maintenance check every hour
    setInterval(checkAmexMaintenance, 60 * 60 * 1000);
    checkAmexMaintenance(); // run once on startup

    // ── BANK LOAN OVERDUE / DEFAULT CHECKER ─────────────────────────────────
    // Hourly checker. A default restricts the economy, but .loan repay remains available.
    async function checkBankLoanDefaults() {
        const now = Date.now();
        for (const [userId, u] of Object.entries(db)) {
            if (userId.startsWith('_') || !u || typeof u !== 'object' || !u.registered || !u.bankLoan) continue;
            const loan = u.bankLoan;
            if (now <= loan.dueDate) continue;
            if (!u.bankLoanOverdueAt) {
                u.bankLoanOverdueAt = now;
                u.creditScore = Math.max(0, (u.creditScore || 500) - 20);
                const du = await client.users.fetch(userId).catch(() => null);
                if (du) await du.send('⚠️ *BANK LOAN OVERDUE*\\n\\nYour loan of **$' + formatNum(loan.totalRepay) + '** is past due.\\n📉 Civil score: **-20**\\n💸 Repay with **.loan repay** as soon as possible.\\n\\nIf it stays unpaid for 48 hours after the due date, a temporary economy/gambling restriction will be applied.').catch(() => {});
            } else if (now - u.bankLoanOverdueAt >= 48 * 60 * 60 * 1000 && !u.loanDefaultBanUntil) {
                u.loanDefaultBanUntil = now + 7 * 24 * 60 * 60 * 1000;
                u.loanBanUntil = now + 4 * 24 * 60 * 60 * 1000;
                u.defaultedLoanCount = (u.defaultedLoanCount || 0) + 1;
                u.creditScore = Math.max(0, (u.creditScore || 500) - 80);
                const du = await client.users.fetch(userId).catch(() => null);
                if (du) await du.send('🚫 *LOAN DEFAULT — ECONOMY RESTRICTION*\\n\\nYour debt stayed unpaid for 48h after the due date.\\n📉 Civil score: **-80**\\n🔒 Economy restriction: 7 days\\n🎰 Gambling restriction: 4 days\\n💸 You can still use **.loan repay** to clear the debt.').catch(() => {});
            }
        }
        saveDB();
    }
    setInterval(checkBankLoanDefaults, 60 * 60 * 1000);
    checkBankLoanDefaults();

    // ── VIP PASS EXPIRY CHECKER — runs every hour ────────────────────────
    async function checkVipExpiry() {
        const now = Date.now();
        for (const [userId, userData] of Object.entries(db)) {
            if (userId.startsWith('_') || !userData || typeof userData !== 'object' || !userData.vip) continue;
            const vip = userData.vip;
            if (!vip.active) continue;

            const timeLeft = vip.expiresAt - now;

            // ── Expired without recharge — bank capacity is just whatever it ────
            // already was (we never mutated maxCapacity for VIP), so "reverting"
            // is nothing more than flipping the flag off.
            if (timeLeft <= 0) {
                vip.active = false;
                saveDB();
                const discordUser = await client.users.fetch(userId).catch(() => null);
                if (discordUser) {
                    await discordUser.send(
                        `💔 *Your VIP Pass has expired!*\n\n` +
                        `You didn't recharge in time, so unlimited bank space has been turned off.\n` +
                        `🏦 *Bank Capacity is now back to:* $${formatNum(userData.maxCapacity || 500_000)}\n\n` +
                        `Recharge anytime with *.vip buy* ($${formatNum(VIP_MONTHLY_FEE)}/month) to go unlimited again!`
                    ).catch(() => {});
                }
                continue;
            }

            // ── 3-day reminder ──────────────────────────────────────────────────
            if (timeLeft <= VIP_REMINDER_3D_MS && !vip.reminder3dSent) {
                vip.reminder3dSent = true;
                saveDB();
                const discordUser = await client.users.fetch(userId).catch(() => null);
                if (discordUser) {
                    await discordUser.send(
                        `💎 *VIP Pass reminder!*\n\n` +
                        `Your VIP Pass expires in about *3 days* (<t:${Math.floor(vip.expiresAt / 1000)}:R>).\n` +
                        `Recharge now with *.vip buy* ($${formatNum(VIP_MONTHLY_FEE)}) to keep your bank *UNLIMITED*!\n` +
                        `⚠️ If it lapses, your bank capacity goes back to $${formatNum(userData.maxCapacity || 500_000)}.`
                    ).catch(() => {});
                }
            }

            // ── 1-day urgent reminder ─────────────────────────────────────────────
            if (timeLeft <= VIP_REMINDER_1D_MS && !vip.reminder1dSent) {
                vip.reminder1dSent = true;
                saveDB();
                const discordUser = await client.users.fetch(userId).catch(() => null);
                if (discordUser) {
                    await discordUser.send(
                        `🚨 *VIP Pass expiring in ~24 hours!* 🚨\n\n` +
                        `Recharge now with *.vip buy* ($${formatNum(VIP_MONTHLY_FEE)}) or you'll lose *UNLIMITED* bank space tomorrow — it'll drop to $${formatNum(userData.maxCapacity || 500_000)}!`
                    ).catch(() => {});
                }
            }
        }
    }

    // Run VIP expiry check every hour
    setInterval(checkVipExpiry, 60 * 60 * 1000);
    checkVipExpiry(); // run once on startup

    // ── DAILY BALANCE SNAPSHOT — feeds the balance-based loan cap ────────
    // Runs once every 24h so `.bank loan` can check RECENT AVERAGE balance
    // instead of instantaneous balance (harder to game by stuffing cash in
    // right before requesting a loan).
    setInterval(recordBalanceSnapshots, 24 * 60 * 60 * 1000);
    recordBalanceSnapshots(); // take an initial snapshot on startup
});

client.login(process.env.DISCORD_TOKEN);
