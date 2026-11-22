requestAnimationFrame('dotenv').config();
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
                                                SVGAnimatedBoolean();
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
                                                                                                                                                                                if (u.amexCard && AMEX_CARDS[u.amexCard.tier]?.tier >= card.tier) c
                                                                }
                            }
        ]
})