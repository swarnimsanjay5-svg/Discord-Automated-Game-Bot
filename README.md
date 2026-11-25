# Installation and Bot Commands

This is a Discord bot I made for my own server. It has an economy with a wallet and a bank, a few gambling games, loans, a Pokémon catching game, a lottery and some mod tools. I've been running it for a few months now.

Every command starts with a dot, like `.bal`. Before anything works you have to type `.reg` once to make your account.

## Installation

You need Node.js (version 18 or newer), Git, and a bot token from Discord.

**Making the bot on Discord**

1. Go to https://discord.com/developers/applications and click New Application.
2. Open the Bot tab, press Reset Token and copy the token. Keep it private.
3. On that same page, turn on Message Content Intent, Server Members Intent and Presence Intent. The bot won't work properly without them.
4. Go to OAuth2, then URL Generator, tick `bot`, give it permission to read and send messages, and open the link it gives you to add the bot to your server.

**Running it**

```
git clone <your-repo-url>
cd Discord-Automated-Game-Bot
npm install
```

Now make your own `.env` file from the example.

On Windows:
```
copy .env.example .env
```
On Mac or Linux:
```
cp .env.example .env
```

Open `.env` and paste your token after `DISCORD_TOKEN=`. No quotes and no spaces. Then start the bot:

```
node bot.js
```

Once the console says the bot is logged in, go to your server and type `.reg`, then `.menu`.

**.env settings**

| Name | Needed | What it's for |
|---|---|---|
| `DISCORD_TOKEN` | yes | your bot token |
| `DEBUG_MESSAGES` | no | set to `true` if you want extra debug output |

**A few things worth knowing**

- Player data is saved in `database.json`, with a backup in `database.json.bak`. I didn't upload mine because it has my server's data in it. The bot makes its own when it runs.
- The pictures and GIFs the bot sends (coins, fish, hug GIFs etc.) come from the `assets` folder. If one is missing, some commands just send text instead.
- Owner and mod IDs are at the top of `bot.js` in `OWNER_NUMBERS`, `MOD_NUMBERS` and `FBI_NUMBERS`. Put your own Discord user ID in `OWNER_NUMBERS` or the owner commands won't work for you. To find it, turn on Developer Mode in Discord, right click your name and press Copy User ID.
- Use `.ppp` in one channel to make it the Pokémon channel, that's the only place wild Pokémon show up. `.lobby` turns off gambling and Pokémon catching in a channel.

**If something goes wrong**

- `npm install` errors: run `node -v` and make sure it says 18 or higher.
- The bot is online but ignores you: check that the three intents are on, the token is right, and the bot can see and send messages in that channel.
- Commands do nothing for one person: they probably haven't done `.reg` yet.

## Bot commands

If you're new, do this first: `.reg`, then `.daily` for free money, then `.bal` to check your cash. Put money in the bank with `.dep` because cash in your wallet can be stolen with `.rob`. After that, try the gambling games, or catch some Pokémon. `.menu` shows an overview any time and `.cds` shows your cooldowns.

### Basics

| Command | What it does |
|---|---|
| `.reg` | make your account (do this first) |
| `.menu` | overview of everything the bot can do |
| `.help` or `.mods` | tags the admins |
| `.owners` | shows who the owners are |
| `.p` or `.profile` | your profile, level and activity |
| `.xp` | check your XP |
| `.cds` | shows all your cooldowns |
| `.afk [reason]` | set yourself as away, use it again to turn it off |
| `.rich` or `.wealthy` | top 10 richest players in the group |
| `.roast [@user]` | roasts someone, or you if you don't tag anyone |

### Money and bank

| Command | What it does |
|---|---|
| `.bal [@user]` | wallet, bank and total money |
| `.dep [amount]` or `.deposit` | wallet to bank |
| `.wd [amount]` or `.withdraw` | bank to wallet |
| `.transfer [amount] [@user]` | send money to someone (there are daily limits) |
| `.rob [@user]` | try to steal from someone's wallet, groups only, long cooldown |
| `.daily` | free reward once a day |
| `.beg` | beg for a bit of cash, 2 minute cooldown |
| `.fish` | go fishing |
| `.dig` | dig for stuff |
| `.sell [item]` | sell things like fish |
| `.bank` | your bank balance, capacity and credit score |
| `.bank upgrade` | shows the bank capacity packages |
| `.bank buy <1-10>` | buy a package (`.upgrades` and `.u1` to `.u10` work too) |
| `.bank credit` | check your credit score |
| `.vip` or `.vippass` | VIP pass, gives unlimited bank space while it's active (monthly fee) |
| `.bankinfo` | explains the bank, loans and credit score |

### Loans

| Command | What it does |
|---|---|
| `.loan <amount>` | take a loan, it depends on your credit score and needs no collateral |
| `.loan repay` | pay your loan back |
| `.loan status` | see your current loan |

Paying back on time raises your credit score, and a better score lets you borrow more. If you don't pay, your score drops and you can get banned from gambling for a while. `.bankinfo` explains it properly.

### Gambling

You can only bet up to 5% of your total money in one go, and gambling is off in lobby channels. `.gamble` shows all of this in the bot.

| Command | Win chance | Payout | Cooldown |
|---|---|---|---|
| `.casino [bet]` | 38% | 2.4x | 5 min |
| `.slots [bet]` | 30% | 2.5x | 1 min |
| `.roulette [red/black/green] [bet]` | 25% | 1.9x | 1 min |
| `.db [bet]` (double or nothing) | 33% | 1.9x | 1 min, max 15 a day |
| `.cf [heads/tails] [bet]` (coinflip) | 25% | 1.9x | 1 min |

### Lottery

| Command | What it does |
|---|---|
| `.buy lottery` | buy a ticket for $70K. Once 5 people have joined, the draw happens by itself and the top 3 win money |
| `.ll` | see how the current lottery is going |

### American Express cards

These are for rich players. Better cards give you higher transfer limits, shorter cooldowns, bigger daily rewards and some protection from robbers.

| Command | What it does |
|---|---|
| `.amex` or `.americanexpress` | explains all the card tiers |
| `.cardinfo` | compare the cards |
| `.avail [green/gold/platinum/black]` | apply for a card, you need enough net worth |
| `.mycard` | see your card and its perks |
| `.paymaint` | pay your card's weekly fee |

You need $20M net worth for Green, $40M for Gold, $60M for Platinum and $100M for Black.

### Redeem codes

| Command | What it does |
|---|---|
| `.claim [code]` | claim a code that a mod made |

### Pokémon

Wild Pokémon show up randomly in the Pokémon channel. Fight one to weaken it, then throw a ball to catch it. `.pokemon` has the full guide in the bot.

| Command | What it does |
|---|---|
| `.catch` | battle the wild Pokémon to weaken it |
| `.throwball [type]` | throw a ball at a weakened Pokémon, better balls catch more |
| `.battle [@user]` | challenge another player |
| `.accept` or `.reject` | accept or decline a battle challenge |
| `.health` | HP and status of your active Pokémon |
| `.feed [pokemon] [food]` | heal and buff a Pokémon with food |
| `.use [pokemon]` | pick which Pokémon is active |
| `.inv` or `.inventory` | your items and Pokémon |
| `.team add <name>` | move a Pokémon from the PC box to your team (max 6) |
| `.team remove <name>` | move a Pokémon from your team back to the PC box |
| `.team list` or `.pc` | see the Pokémon in your PC box |
| `.swap <A> <B>` | swap the positions of two Pokémon |
| `.pstore` | Pokémon store |
| `.shop` | shop menu, try `.shop balls`, `.shop food`, `.shop stones` or `.shop items` |
| `.buy [item]` | buy something from the shop |
| `.rare <pokemon>` | use a Rare Candy on a Pokémon in your party |
| `.evolve <pokemon>` | use an Evolution Stone on a Pokémon in your party |
| `.ptrade @user <pokemon> [price]` | offer a trade, a price of 0 makes it a gift |
| `.ptaccept` or `.ptdeny` | accept or decline a trade |

## Mod commands

You need your ID in `MOD_NUMBERS` for these. Owners count as mods too. `.modhelp` shows this list in the bot.

| Command | What it does |
|---|---|
| `.bot on` or `.bot off` | turn the bot on or off in this channel |
| `.lobby` or `.unlobby` | turn lobby mode on or off (no gambling or Pokémon catching) |
| `.ppp` | make this channel the Pokémon channel |
| `.lll` | make this channel the lottery announcement channel |
| `.pp @user` | see a user's full profile from the database |
| `.kick @user` | kick someone |
| `.ban @user` or `.unban @user` | ban or unban someone from the bot (mods and agents) |
| `.fbi` | tags the FBI agents |
| `.redeem [amount]` | make a redeem code for people to `.claim` |
| `.debugme` | debug info about yourself |

## Owner commands

You need your ID in `OWNER_NUMBERS` for these.

| Command | What it does |
|---|---|
| `.regmod [user id]` or `.removemod [user id]` | make someone a mod or take it away |
| `.regagent [user id]` or `.removeagent [user id]` | add or remove an FBI agent (owners and agents can do this) |
| `.addmoney [amount] [@user]` or `.removemoney [amount] [@user]` | give or take someone's money |
| `.reset [money, inv, pokemon or loans]` | wipes that data for every registered user. The first time you run it, it only warns you. Run it again with `confirm` on the end within 60 seconds to actually do it |

## Files in this repo

```
assets/             images and GIFs the commands use
bot.js              the whole bot
package.json        list of what to install (discord.js, dotenv)
package-lock.json   exact versions of everything
.env.example        copy this to .env and add your token
.gitignore          keeps .env, node_modules and the database out of git
```
