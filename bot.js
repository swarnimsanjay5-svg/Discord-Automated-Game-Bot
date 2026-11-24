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