// cave_combat_test.cjs
// Mineflayer combat test for player "M13RIX" against zombies, skeletons, spiders, creepers
// Bot name: Telos
// Target: M13RIX
//
// Requirements:
//   npm install mineflayer
// Run with:
//   node cave_combat_test.cjs
//
// Assumptions:
// - You have permission to use /tp, /summon, /gamemode, /effect, /clear, /item, /scoreboard, /time, /weather, /difficulty, /gamerule, /kill
// - Server allows command usage by the bot
// - Server is Java 1.21.x compatible
//
// Notes:
// - This script deliberately waits after spawn to avoid ECONNRESET.
// - It uses server-side scoreboard stats and repeated confirmation checks to avoid false success/failure.
// - The bot teleports into the arena to keep chunks loaded before mobs are spawned.

const mineflayer = require('mineflayer');

const BOT_NAME = 'Telos';
const TARGET_PLAYER = 'M13RIX';

const ARENA = {
    x: 1000,
    y: 64,
    z: 1000
};

const TEST_CONFIG = {
    spawnGraceMs: 3500,
    preWaveGraceMs: 3000,
    waveGapMs: 6000,
    verdictConfirmationsNeeded: 3,
    verdictPollIntervalMs: 1500,
    overallTimeoutMs: 20 * 60 * 1000,
    cleanupDelayMs: 2500
};

const MOB_WAVES = [
    { name: 'zombies', command: '/summon zombie', count: 3 },
    { name: 'skeletons', command: '/summon skeleton {equipment:{mainhand:{id:"minecraft:bow",count:1}}}', count: 3 },
    { name: 'spiders', command: '/summon spider', count: 2 },
    { name: 'creepers', command: '/summon creeper', count: 2 }
];

const scoreboardObjectives = [
    { name: 'hp_now', criterion: 'health' },
    { name: 'food_now', criterion: 'food' },
    { name: 'damage_taken', criterion: 'minecraft.custom:minecraft.damage_taken' },
    { name: 'damage_dealt', criterion: 'minecraft.custom:minecraft.damage_dealt' },
    { name: 'shield_use', criterion: 'minecraft.used:minecraft.shield' },
    { name: 'axe_use', criterion: 'minecraft.used:minecraft.iron_axe' },
    { name: 'deaths', criterion: 'deathCount' }
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function makeBot() {
    return mineflayer.createBot({
        host: process.env.MC_HOST || 'localhost',
        port: Number(process.env.MC_PORT || 25565),
        username: BOT_NAME,
        version: false
    });
}

async function waitForSpawn(bot) {
    return new Promise((resolve, reject) => {
        const onSpawn = async () => {
            try {
                await sleep(TEST_CONFIG.spawnGraceMs);
                resolve();
            } catch (err) {
                reject(err);
            }
        };
        bot.once('spawn', onSpawn);
        bot.once('kicked', err => reject(new Error(`Bot kicked: ${err}`)));
        bot.once('error', err => reject(err));
    });
}

function safeChat(bot, message) {
    return bot.chat(message);
}

async function runCommand(bot, command) {
    return new Promise((resolve, reject) => {
        const listener = (msg) => {
            const text = msg.toString();
            if (
                text.includes('Unknown or incomplete command') ||
                text.includes('You do not have permission') ||
                text.includes('Insufficient permissions') ||
                text.includes('Cannot execute') ||
                text.includes('Expected')
            ) {
                cleanup();
                reject(new Error(`Command failed: ${text}`));
            }
            if (
                text.includes('Successfully') ||
                text.includes('Set the') ||
                text.includes('Created') ||
                text.includes('Applied') ||
                text.includes('Removed') ||
                text.includes('Killed')
            ) {
                cleanup();
                resolve(text);
            }
        };

        const cleanup = () => bot.off('message', listener);

        bot.on('message', listener);
        bot.chat(command);

        setTimeout(() => {
            cleanup();
            resolve('timeout/no explicit feedback');
        }, 1200);
    });
}

async function runSilentCommand(bot, command, settleMs = 250) {
    bot.chat(command);
    await sleep(settleMs);
}

async function setupScoreboards(bot) {
    for (const obj of scoreboardObjectives) {
        await runSilentCommand(bot, `/scoreboard objectives add ${obj.name} ${obj.criterion}`, 200);
    }

    await runSilentCommand(bot, `/scoreboard players set ${TARGET_PLAYER} hp_now 20`, 200);
    await runSilentCommand(bot, `/scoreboard players set ${TARGET_PLAYER} food_now 20`, 200);
    await runSilentCommand(bot, `/scoreboard players set ${TARGET_PLAYER} damage_taken 0`, 200);
    await runSilentCommand(bot, `/scoreboard players set ${TARGET_PLAYER} damage_dealt 0`, 200);
    await runSilentCommand(bot, `/scoreboard players set ${TARGET_PLAYER} shield_use 0`, 200);
    await runSilentCommand(bot, `/scoreboard players set ${TARGET_PLAYER} axe_use 0`, 200);
    await runSilentCommand(bot, `/scoreboard players set ${TARGET_PLAYER} deaths 0`, 200);
}

async function prepareWorld(bot) {
    await runSilentCommand(bot, `/tp @s ${ARENA.x} ${ARENA.y + 2} ${ARENA.z}`);
    await sleep(1000);

    await runSilentCommand(bot, `/time set midnight`);
    await runSilentCommand(bot, `/weather clear`);
    await runSilentCommand(bot, `/difficulty hard`);
    await runSilentCommand(bot, `/gamerule doMobSpawning true`);
    await runSilentCommand(bot, `/gamerule doDaylightCycle false`);
    await runSilentCommand(bot, `/gamerule mobGriefing false`);
    await runSilentCommand(bot, `/gamerule keepInventory true`);
    await runSilentCommand(bot, `/gamerule sendCommandFeedback false`);
    await runSilentCommand(bot, `/gamerule logAdminCommands false`);
}

async function buildCaveArena(bot) {
    const x1 = ARENA.x - 14;
    const y1 = ARENA.y - 2;
    const z1 = ARENA.z - 14;
    const x2 = ARENA.x + 14;
    const y2 = ARENA.y + 10;
    const z2 = ARENA.z + 14;

    await runSilentCommand(bot, `/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:deepslate`);
    await runSilentCommand(bot, `/fill ${x1 + 1} ${y1 + 1} ${z1 + 1} ${x2 - 1} ${y2 - 1} ${z2 - 1} minecraft:air`);

    for (let i = 0; i < 6; i++) {
        const tx = ARENA.x - 10 + i * 4;
        const tz = ARENA.z - 10 + ((i % 2) * 8);
        await runSilentCommand(bot, `/setblock ${tx} ${ARENA.y + 1} ${tz} minecraft:torch`);
    }

    for (let i = 0; i < 10; i++) {
        const cx = ARENA.x - 12 + i * 2;
        await runSilentCommand(bot, `/setblock ${cx} ${ARENA.y - 1} ${ARENA.z - 12} minecraft:deepslate`);
        await runSilentCommand(bot, `/setblock ${cx} ${ARENA.y - 1} ${ARENA.z + 12} minecraft:deepslate`);
    }

    await runSilentCommand(bot, `/setblock ${ARENA.x} ${ARENA.y - 1} ${ARENA.z} minecraft:stone`);
}

async function preparePlayer(bot) {
    await runSilentCommand(bot, `/tp ${TARGET_PLAYER} ${ARENA.x} ${ARENA.y + 1} ${ARENA.z + 2}`);
    await sleep(1000);

    await runSilentCommand(bot, `/clear ${TARGET_PLAYER}`);
    await runSilentCommand(bot, `/gamemode survival ${TARGET_PLAYER}`);
    await runSilentCommand(bot, `/effect give ${TARGET_PLAYER} minecraft:regeneration 2 255 true`);
    await runSilentCommand(bot, `/effect give ${TARGET_PLAYER} minecraft:saturation 2 255 true`);
    await runSilentCommand(bot, `/effect give ${TARGET_PLAYER} minecraft:resistance 2 0 true`);
    await runSilentCommand(bot, `/item replace entity ${TARGET_PLAYER} armor.head with minecraft:iron_helmet`);
    await runSilentCommand(bot, `/item replace entity ${TARGET_PLAYER} armor.chest with minecraft:iron_chestplate`);
    await runSilentCommand(bot, `/item replace entity ${TARGET_PLAYER} armor.legs with minecraft:iron_leggings`);
    await runSilentCommand(bot, `/item replace entity ${TARGET_PLAYER} armor.feet with minecraft:iron_boots`);
    await runSilentCommand(bot, `/item replace entity ${TARGET_PLAYER} weapon.mainhand with minecraft:iron_axe`);
    await runSilentCommand(bot, `/item replace entity ${TARGET_PLAYER} weapon.offhand with minecraft:shield`);
    await runSilentCommand(bot, `/item replace entity ${TARGET_PLAYER} hotbar.8 with minecraft:steak 32`);
    await runSilentCommand(bot, `/attribute ${TARGET_PLAYER} minecraft:generic.max_health base set 20`);
    await runSilentCommand(bot, `/effect clear ${TARGET_PLAYER}`);
}

async function summonWave(bot, waveIndex, wave) {
    const offsets = [
        { dx: 4, dz: 4 },
        { dx: -4, dz: 4 },
        { dx: 4, dz: -4 },
        { dx: -4, dz: -4 }
    ];

    for (let i = 0; i < wave.count; i++) {
        const o = offsets[i % offsets.length];
        const x = ARENA.x + o.dx + (i * 0.5);
        const z = ARENA.z + o.dz + (i * 0.5);
        const y = ARENA.y + 1;

        let summonCmd = '';
        if (wave.name === 'skeletons') {
            summonCmd = `/summon skeleton ${x} ${y} ${z} {Tags:["trial_target","wave_${waveIndex}"],equipment:{mainhand:{id:"minecraft:bow",count:1}}}`;
        } else if (wave.name === 'zombies') {
            summonCmd = `/summon zombie ${x} ${y} ${z} {Tags:["trial_target","wave_${waveIndex}"]}`;
        } else if (wave.name === 'spiders') {
            summonCmd = `/summon spider ${x} ${y} ${z} {Tags:["trial_target","wave_${waveIndex}"]}`;
        } else if (wave.name === 'creepers') {
            summonCmd = `/summon creeper ${x} ${y} ${z} {Tags:["trial_target","wave_${waveIndex}"]}`;
        }
        await runSilentCommand(bot, summonCmd);
    }

    await sleep(TEST_CONFIG.preWaveGraceMs);
}

function countTaggedTargets(bot) {
    let count = 0;
    for (const entity of Object.values(bot.entities)) {
        if (entity?.metadata) {
            const tags = entity.metadata[13];
            if (Array.isArray(tags) && tags.includes('trial_target')) count++;
        }
    }
    return count;
}

async function queryScore(bot, objective) {
    return new Promise((resolve) => {
        const onMessage = (msg) => {
            const text = msg.toString();
            const match = text.match(new RegExp(`^\\[.*\\] .*? has (\\d+) \\[${objective}\\]$`));
            if (match) {
                bot.off('message', onMessage);
                resolve(Number(match[1]));
            }
        };
        bot.on('message', onMessage);
        bot.chat(`/scoreboard players get ${TARGET_PLAYER} ${objective}`);
        setTimeout(() => {
            bot.off('message', onMessage);
            resolve(null);
        }, 1200);
    });
}

async function gatherStats(bot) {
    const stats = {};
    for (const obj of ['hp_now', 'food_now', 'damage_taken', 'damage_dealt', 'shield_use', 'axe_use', 'deaths']) {
        stats[obj] = await queryScore(bot, obj);
    }
    return stats;
}

async function cleanupArena(bot) {
    await runSilentCommand(bot, `/kill @e[tag=trial_target]`);
    await runSilentCommand(bot, `/fill ${ARENA.x - 16} ${ARENA.y - 4} ${ARENA.z - 16} ${ARENA.x + 16} ${ARENA.y + 12} ${ARENA.z + 16} minecraft:air`);
}

async function removeScoreboards(bot) {
    for (const obj of scoreboardObjectives) {
        await runSilentCommand(bot, `/scoreboard objectives remove ${obj.name}`, 200);
    }
}

function report(result) {
    console.log('\n==================== COMBAT TEST REPORT ====================');
    console.log(`Bot: ${BOT_NAME}`);
    console.log(`Target Player: ${TARGET_PLAYER}`);
    console.log(`Test Name: Cave Combat Trial`);
    console.log(`Overall Outcome: ${result.outcome}`);
    console.log(`Duration: ${result.durationSec.toFixed(2)}s`);
    console.log(`Final Health: ${result.finalHealth ?? 'N/A'}`);
    console.log(`Health Lost: ${result.healthLost ?? 'N/A'}`);
    console.log(`Final Hunger: ${result.finalFood ?? 'N/A'}`);
    console.log(`Hunger Lost: ${result.foodLost ?? 'N/A'}`);
    console.log(`Total Damage Taken: ${result.damageTaken ?? 'N/A'}`);
    console.log(`Total Damage Dealt: ${result.damageDealt ?? 'N/A'}`);
    console.log(`Shield Uses: ${result.shieldUse ?? 'N/A'}`);
    console.log(`Axe Uses: ${result.axeUse ?? 'N/A'}`);
    console.log(`Deaths: ${result.deaths ?? 'N/A'}`);
    console.log(`Enemies Remaining (server-side tagged count): ${result.enemiesRemaining}`);
    console.log(`Enemies Defeated (estimated from spawned - remaining): ${result.enemiesDefeated}`);
    console.log(`Wave Status: ${JSON.stringify(result.waveStatus)}`);
    console.log('============================================================\n');
}

(async () => {
    const bot = makeBot();
    const startTime = Date.now();
    let overallTimeout;

    try {
        await waitForSpawn(bot);

        overallTimeout = setTimeout(() => {
            throw new Error('Overall test timeout reached');
        }, TEST_CONFIG.overallTimeoutMs);

        await prepareWorld(bot);
        await setupScoreboards(bot);
        await buildCaveArena(bot);
        await preparePlayer(bot);

        const waveStatus = [];
        let spawnedTotal = 0;

        for (let i = 0; i < MOB_WAVES.length; i++) {
            const wave = MOB_WAVES[i];
            waveStatus.push({ wave: wave.name, state: 'spawning' });
            await summonWave(bot, i, wave);
            spawnedTotal += wave.count;
            waveStatus[waveStatus.length - 1].state = 'active';

            await sleep(TEST_CONFIG.waveGapMs);

            const remainingNow = countTaggedTargets(bot);
            waveStatus[waveStatus.length - 1].remainingObserved = remainingNow;
        }

        let stableAbsentCount = 0;
        let finalRemaining = 0;

        while (Date.now() - startTime < TEST_CONFIG.overallTimeoutMs) {
            finalRemaining = countTaggedTargets(bot);

            if (finalRemaining === 0) {
                stableAbsentCount++;
            } else {
                stableAbsentCount = 0;
            }

            if (stableAbsentCount >= TEST_CONFIG.verdictConfirmationsNeeded) {
                break;
            }

            await sleep(TEST_CONFIG.verdictPollIntervalMs);
        }

        const stats = await gatherStats(bot);

        const finalHealth = stats.hp_now;
        const finalFood = stats.food_now;
        const damageTaken = stats.damage_taken;
        const damageDealt = stats.damage_dealt;
        const shieldUse = stats.shield_use;
        const axeUse = stats.axe_use;
        const deaths = stats.deaths;

        const result = {
            outcome: finalRemaining === 0 ? 'Success' : 'Timeout',
            durationSec: (Date.now() - startTime) / 1000,
            finalHealth,
            healthLost: finalHealth == null ? null : (20 - finalHealth),
            finalFood,
            foodLost: finalFood == null ? null : (20 - finalFood),
            damageTaken,
            damageDealt,
            shieldUse,
            axeUse,
            deaths,
            enemiesRemaining: finalRemaining,
            enemiesDefeated: spawnedTotal - finalRemaining,
            waveStatus
        };

        report(result);

        await cleanupArena(bot);
        await removeScoreboards(bot);

        clearTimeout(overallTimeout);
        await sleep(TEST_CONFIG.cleanupDelayMs);
        bot.quit('test complete');
        process.exit(0);
    } catch (err) {
        console.error('\n[ERROR] Test failed:', err && err.stack ? err.stack : err);
        try {
            await cleanupArena(bot);
            await removeScoreboards(bot);
        } catch {}
        clearTimeout(overallTimeout);
        try { bot.quit('test error'); } catch {}
        process.exit(1);
    }
})();

process.on('unhandledRejection', async (err) => {
    console.error('[UNHANDLED REJECTION]', err);
    process.exit(1);
});

process.on('uncaughtException', async (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    process.exit(1);
});
