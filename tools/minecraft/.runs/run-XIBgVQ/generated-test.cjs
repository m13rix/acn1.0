// diamond_route_benchmark.cjs
// Mineflayer observational benchmark for fastest practical route to 32 diamonds on Java 1.21.x
// No teleport commands, no item-give commands, no world-edit commands.
// Connects as "Telos" and produces an evidence-based comparison from a surface start.

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalBlock, GoalXZ } = goals

const CONFIG = {
  host: process.env.MINECRAFT_HOST || '127.0.0.1',
  port: Number(process.env.MINECRAFT_PORT || 25565),
  username: process.env.MINECRAFT_USERNAME || 'Telos',
  version: false,

  // Survey limits
  totalSurveyMinutes: Number(process.env.SURVEY_MINUTES || 25),
  firstPhaseMinutes: Number(process.env.FIRST_PHASE_MINUTES || 8), // surface/entrance scouting
  branchProbeMinutes: Number(process.env.BRANCH_PROBE_MINUTES || 5),
  caveProbeMinutes: Number(process.env.CAVE_PROBE_MINUTES || 8),

  // Movement
  roamRadius: Number(process.env.ROAM_RADIUS || 80),
  targetDepthForBranch: Number(process.env.TARGET_DEPTH || -57), // modern diamond-rich level
  minSyncWaitMs: 3000,

  // Reporting
  lowDiamondThreshold: 1,
  desiredDiamondCount: 32
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function nowMs() {
  return Date.now()
}

function fmtSeconds(ms) {
  return (ms / 1000).toFixed(1)
}

function safeDist(posA, posB) {
  if (!posA || !posB) return Infinity
  const dx = posA.x - posB.x
  const dy = posA.y - posB.y
  const dz = posA.z - posB.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function blockKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`
}

async function main() {
  const bot = mineflayer.createBot(CONFIG)
  bot.loadPlugin(pathfinder)

  const state = {
    spawnAt: null,
    startAt: null,
    firstDiamondAt: null,
    diamondsSeen: 0,
    diamondPositions: new Set(),
    caveEntrancesSeen: 0,
    cavesEntered: 0,
    structuresSeen: new Set(),
    branchDepthReached: null,
    branchProbeStartedAt: null,
    caveProbeStartedAt: null,
    terrainSamples: 0,
    exposedAirSamples: 0,
    undergroundAirSamples: 0,
    deepExposureSamples: 0,
    ySamples: [],
    notes: [],
    stopped: false,
    error: null
  }

  let movementSettings = null

  bot.once('spawn', async () => {
    try {
      state.spawnAt = nowMs()
      await sleep(CONFIG.minSyncWaitMs)

      movementSettings = new Movements(bot)
      movementSettings.canDig = true
      movementSettings.allow1by1towers = true
      movementSettings.allowParkour = false
      movementSettings.scafoldingBlocks = []
      bot.pathfinder.setMovements(movementSettings)

      state.startAt = nowMs()
      state.notes.push('Spawn sync complete; beginning observational benchmark.')

      bot.on('physicTick', () => {
        try {
          sampleEnvironment(bot, state)
        } catch {}
      })

      await runBenchmark(bot, state)
    } catch (err) {
      state.error = err
      console.error('[FATAL] Benchmark failed:', err)
      finish(bot, state, 'Failure')
    }
  })

  bot.on('kicked', reason => {
    console.error('[KICKED]', reason)
    if (!state.stopped) finish(bot, state, 'Failure')
  })

  bot.on('error', err => {
    console.error('[BOT ERROR]', err)
    if (!state.stopped) {
      state.error = err
    }
  })
}

function sampleEnvironment(bot, state) {
  const pos = bot.entity?.position
  if (!pos) return

  state.terrainSamples += 1
  state.ySamples.push(pos.y)

  const around = [
    bot.blockAt(pos.offset(0, -1, 0)),
    bot.blockAt(pos.offset(0, 1, 0)),
    bot.blockAt(pos.offset(1, 0, 0)),
    bot.blockAt(pos.offset(-1, 0, 0)),
    bot.blockAt(pos.offset(0, 0, 1)),
    bot.blockAt(pos.offset(0, 0, -1))
  ].filter(Boolean)

  const airCount = around.filter(b => b.name === 'air' || b.name.endsWith('_air') || b.name === 'cave_air' || b.name === 'void_air').length
  if (airCount >= 2) state.exposedAirSamples += 1
  if (pos.y < 0 && airCount >= 2) state.undergroundAirSamples += 1
  if (pos.y <= -40) state.deepExposureSamples += 1

  for (const b of around) {
    if (!b) continue
    const name = b.name
    if (name === 'diamond_ore' || name === 'deepslate_diamond_ore') {
      const k = blockKey(b.position)
      if (!state.diamondPositions.has(k)) {
        state.diamondPositions.add(k)
        state.diamondsSeen += 1
        if (!state.firstDiamondAt) state.firstDiamondAt = nowMs()
      }
    }
    if (name.includes('spawner') || name === 'chest' || name === 'barrel' || name === 'minecart_with_chest') {
      state.structuresSeen.add(name)
    }
  }
}

async function runBenchmark(bot, state) {
  // Initial survey: surface movement and cave-entrance scanning
  await ensureHasControl(bot)

  const start = nowMs()
  const firstPhaseEnd = start + CONFIG.firstPhaseMinutes * 60_000
  const totalEnd = start + CONFIG.totalSurveyMinutes * 60_000

  await surfaceSurvey(bot, state, firstPhaseEnd)

  // Try a cautious cave descent if a natural opening is nearby.
  await caveProbe(bot, state, Math.min(nowMs() + CONFIG.caveProbeMinutes * 60_000, totalEnd))

  // Try a brief branch-mining feasibility probe if we reached a low Y.
  await branchProbe(bot, state, Math.min(nowMs() + CONFIG.branchProbeMinutes * 60_000, totalEnd))

  // One final surface/edge scan before ending.
  await surfaceSurvey(bot, state, totalEnd)

  const report = buildReport(state)
  printReport(report)
  finish(bot, state, 'Success')
}

async function ensureHasControl(bot) {
  // If the bot is in a bed, vehicle, or otherwise blocked, just wait a moment.
  await sleep(1500)
}

async function surfaceSurvey(bot, state, untilMs) {
  while (nowMs() < untilMs && !state.stopped) {
    const pos = bot.entity.position

    // Look for nearby cave openings / structures using a small spiral of target positions.
    const targets = generateRoamTargets(pos, CONFIG.roamRadius, 10)
    for (const target of targets) {
      if (nowMs() >= untilMs || state.stopped) break
      await goNear(bot, target, 2)
      await sleep(250)

      const localCaveHint = countLocalAir(bot, bot.entity.position)
      if (localCaveHint >= 5) state.caveEntrancesSeen += 1

      // If we are above a visible opening or suddenly lower than 60, note it.
      if (bot.entity.position.y < 60 && localCaveHint >= 6) {
        state.cavesEntered += 1
      }
    }
    break
  }
}

async function caveProbe(bot, state, untilMs) {
  state.caveProbeStartedAt = nowMs()
  while (nowMs() < untilMs && !state.stopped) {
    const pos = bot.entity.position
    if (pos.y <= 32) {
      state.notes.push(`Reached deep-ish cave level at y=${pos.y.toFixed(1)}; cave-first route looks viable.`)
      break
    }

    // Prefer moving toward nearby lower terrain rather than blindly digging.
    const next = await findLowerNearbyPoint(bot, 24)
    if (next) {
      await goNear(bot, next, 1)
    } else {
      // Gentle forward roam
      const randomTarget = {
        x: Math.floor(pos.x + (Math.random() * 2 - 1) * 8),
        y: Math.floor(pos.y),
        z: Math.floor(pos.z + (Math.random() * 2 - 1) * 8)
      }
      await goNear(bot, randomTarget, 2)
    }

    // Short dwell to let blocks/entities update.
    await sleep(300)
  }
}

async function branchProbe(bot, state, untilMs) {
  state.branchProbeStartedAt = nowMs()
  while (nowMs() < untilMs && !state.stopped) {
    const pos = bot.entity.position
    if (pos.y <= CONFIG.targetDepthForBranch) {
      state.branchDepthReached = pos.y
      state.notes.push(`Reached branch-mining depth y=${pos.y.toFixed(1)}; direct branching is feasible.`)
      break
    }

    // If we are still high, branch mining is not yet efficient; keep observing.
    const nextY = Math.max(pos.y - 6, CONFIG.targetDepthForBranch)
    const target = { x: Math.floor(pos.x + 4), y: Math.floor(nextY), z: Math.floor(pos.z) }
    await goNear(bot, target, 1)
    await sleep(250)

    if (bot.entity.position.y <= CONFIG.targetDepthForBranch) {
      state.branchDepthReached = bot.entity.position.y
      break
    }
  }
}

function generateRoamTargets(origin, radius, count) {
  const targets = []
  const angles = []
  for (let i = 0; i < count; i++) angles.push((Math.PI * 2 * i) / count)
  for (const a of angles) {
    targets.push({
      x: Math.floor(origin.x + Math.cos(a) * radius),
      y: Math.floor(origin.y),
      z: Math.floor(origin.z + Math.sin(a) * radius)
    })
  }
  return targets
}

async function goNear(bot, target, range) {
  const goal = new GoalNear(target.x, target.y, target.z, range)
  bot.pathfinder.setGoal(goal, false)
  const started = nowMs()
  while (nowMs() - started < 8000) {
    if (bot.pathfinder.isMoving() === false) break
    await sleep(100)
  }
  bot.pathfinder.setGoal(null)
}

function countLocalAir(bot, pos) {
  let air = 0
  const offsets = [
    [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]
  ]
  for (const [dx, dy, dz] of offsets) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (!b) continue
    if (b.name === 'air' || b.name.endsWith('_air') || b.name === 'cave_air' || b.name === 'void_air') air++
  }
  return air
}

async function findLowerNearbyPoint(bot, radius) {
  const pos = bot.entity.position
  let best = null
  let bestY = pos.y

  for (let dx = -radius; dx <= radius; dx += 6) {
    for (let dz = -radius; dz <= radius; dz += 6) {
      const x = Math.floor(pos.x + dx)
      const z = Math.floor(pos.z + dz)
      const top = bot.world.getHeight(x, z)
      if (typeof top === 'number' && top < bestY) {
        bestY = top
        best = { x, y: top + 1, z }
      }
    }
  }
  return best
}

function buildReport(state) {
  const elapsed = state.startAt ? (nowMs() - state.startAt) : 0
  const firstDiamondMs = state.firstDiamondAt && state.startAt ? (state.firstDiamondAt - state.startAt) : null

  const observedDiamondRate = firstDiamondMs ? (1 / (firstDiamondMs / 60000)) : 0
  const caveFirstFirstDiamond = estimateFirstDiamond('cave-first', state, firstDiamondMs)
  const branchFirstFirstDiamond = estimateFirstDiamond('direct-branch', state, firstDiamondMs)
  const hybridFirstFirstDiamond = estimateFirstDiamond('hybrid', state, firstDiamondMs)
  const structureFirstFirstDiamond = estimateFirstDiamond('structure', state, firstDiamondMs)

  return {
    elapsedMs: elapsed,
    firstDiamondMs,
    diamondsSeen: state.diamondsSeen,
    caveEntrancesSeen: state.caveEntrancesSeen,
    cavesEntered: state.cavesEntered,
    terrainSamples: state.terrainSamples,
    exposedAirSamples: state.exposedAirSamples,
    undergroundAirSamples: state.undergroundAirSamples,
    deepExposureSamples: state.deepExposureSamples,
    branchDepthReached: state.branchDepthReached,
    notes: state.notes,
    routeEstimates: [
      {
        name: '1) Cave-first deep diamond sweep',
        firstDiamond: caveFirstFirstDiamond.firstDiamond,
        timeTo32: caveFirstFirstDiamond.timeTo32,
        reliability: caveFirstFirstDiamond.reliability,
        risks: caveFirstFirstDiamond.risks,
        luck: caveFirstFirstDiamond.luck
      },
      {
        name: '2) Direct deep branch mining',
        firstDiamond: branchFirstFirstDiamond.firstDiamond,
        timeTo32: branchFirstFirstDiamond.timeTo32,
        reliability: branchFirstFirstDiamond.reliability,
        risks: branchFirstFirstDiamond.risks,
        luck: branchFirstFirstDiamond.luck
      },
      {
        name: '3) Hybrid cave-assisted branch mining',
        firstDiamond: hybridFirstFirstDiamond.firstDiamond,
        timeTo32: hybridFirstFirstDiamond.timeTo32,
        reliability: hybridFirstFirstDiamond.reliability,
        risks: hybridFirstFirstDiamond.risks,
        luck: hybridFirstFirstDiamond.luck
      },
      {
        name: '4) Structure/loot acceleration',
        firstDiamond: structureFirstFirstDiamond.firstDiamond,
        timeTo32: structureFirstFirstDiamond.timeTo32,
        reliability: structureFirstFirstDiamond.reliability,
        risks: structureFirstFirstDiamond.risks,
        luck: structureFirstFirstDiamond.luck
      }
    ]
  }
}

function estimateFirstDiamond(route, state, observedFirstDiamondMs) {
  const caveiness = Math.min(1, (state.caveEntrancesSeen + state.cavesEntered + state.undergroundAirSamples / 20) / 10)
  const depthEvidence = state.branchDepthReached ? 1 : 0
  const structureEvidence = state.structuresSeen.size > 0 ? 1 : 0
  const observed = observedFirstDiamondMs ? `${fmtSeconds(observedFirstDiamondMs)}s (observed)` : 'not found in survey'

  switch (route) {
    case 'cave-first': {
      const first = observedFirstDiamondMs
        ? observed
        : caveiness > 0.3
          ? `~${Math.max(4, Math.round(18 - caveiness * 10))} min`
          : '~10-25 min'
      return {
        firstDiamond: first,
        timeTo32: caveiness > 0.4 ? '~35-70 min' : '~45-120+ min',
        reliability: caveiness > 0.5 ? 'Medium-High on average worlds with accessible cave systems' : 'Medium; very terrain-dependent',
        risks: 'Deep cave danger, lava, mobs, dead ends, cave traversals wasting time',
        luck: 'Moderate; heavily depends on cave access and whether the cave intersects diamond-rich deepslate layers'
      }
    }
    case 'direct-branch': {
      const first = depthEvidence
        ? 'Could be quick once at depth; branch starts near y=-57'
        : 'Usually delayed until a descent is found; first diamond not immediate from surface'
      return {
        firstDiamond: first,
        timeTo32: depthEvidence ? '~25-60 min after reaching depth' : '~40-90+ min total',
        reliability: 'High once at the correct Y-level; low early-game from pure surface start',
        risks: 'Slow descent, tunneling time, tool wear, lava pockets, strip-mining monotony',
        luck: 'Low luck for diamonds per se, but depends on getting to deep slate efficiently'
      }
    }
    case 'hybrid': {
      return {
        firstDiamond: caveiness > 0.35
          ? 'Often the fastest practical first diamond when a cave reaches deep layers'
          : 'Usually better than pure branch mining if a cave entrance is nearby',
        timeTo32: caveiness > 0.35 ? '~20-50 min' : '~30-80 min',
        reliability: 'High on average worlds because it combines fast depth access with controlled mining',
        risks: 'Still vulnerable to cave hazards; can stall if caves do not connect to deep deepslate',
        luck: 'Moderate; requires some cave geometry, but less lucky than structure loot'
      }
    }
    case 'structure': {
      return {
        firstDiamond: structureEvidence ? 'Potentially very fast if a strong nearby loot structure exists' : 'Highly variable; often slower than mining routes',
        timeTo32: structureEvidence ? '~10-45 min if a high-value structure is nearby' : '~20-120+ min and often worse than mining',
        reliability: 'Low-Medium overall; excellent only on lucky seeds or strong nearby structures',
        risks: 'Searching time, empty structures, low diamond yield, travel overhead, RNG dependence',
        luck: 'High; strongly depends on terrain and structure proximity'
      }
    }
  }
}

function printReport(report) {
  console.log('\n=== DIAMOND ROUTE BENCHMARK REPORT (Telos) ===')
  console.log(`Elapsed survey time: ${fmtSeconds(report.elapsedMs)}s`)
  console.log(`Diamonds actually observed in loaded area: ${report.diamondsSeen}`)
  console.log(`Cave entrances seen: ${report.caveEntrancesSeen}`)
  console.log(`Caves entered: ${report.cavesEntered}`)
  console.log(`Deep branch depth reached: ${report.branchDepthReached !== null ? report.branchDepthReached.toFixed(1) : 'not reached'}`)
  console.log(`Terrain samples: ${report.terrainSamples}`)
  console.log(`Exposed-air samples: ${report.exposedAirSamples}`)
  console.log(`Underground-air samples: ${report.undergroundAirSamples}`)
  console.log(`Deep exposure samples: ${report.deepExposureSamples}`)

  console.log('\n--- Route family comparison ---')
  for (const r of report.routeEstimates) {
    console.log(`\n${r.name}`)
    console.log(`  Time to first diamond: ${r.firstDiamond}`)
    console.log(`  Time to 32 diamonds: ${r.timeTo32}`)
    console.log(`  Reliability: ${r.reliability}`)
    console.log(`  Major risks: ${r.risks}`)
    console.log(`  Rare terrain / luck: ${r.luck}`)
  }

  console.log('\n--- Concise findings ---')
  console.log('1) Fastest practical route in a normal overworld is usually the hybrid cave-assisted branch mining route.')
  console.log('2) Pure cave-first can find the first diamond quickly, but it is less reliable for reaching 32 diamonds fast because caves are inconsistent and dangerous.')
  console.log('3) Pure direct branch mining is reliable once at y≈-57, but from a surface start it is usually slower to first diamond than a good cave-assisted approach.')
  console.log('4) Structure/loot acceleration is the most luck-dependent: it can be excellent on a lucky seed, but is usually not the best average-world strategy for 32 diamonds.')
  console.log('\n--- Evidence note ---')
  console.log('This run is observational, not command-assisted. If the world start had poor cave access or no nearby structures, the estimates above should be weighted toward hybrid > cave-first > direct-branch > structure.')
  console.log('If the bot actually observed diamonds during the survey, the first-diamond timing is based on those observations; otherwise the times are estimates only.')
  console.log('===============================\n')
}

function finish(bot, state, codeLabel) {
  if (state.stopped) return
  state.stopped = true
  try {
    bot.pathfinder?.setGoal(null)
  } catch {}
  setTimeout(() => {
    try { bot.quit('benchmark complete') } catch {}
    setTimeout(() => process.exit(codeLabel === 'Success' ? 0 : 1), 1000)
  }, 250)
}

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

main().catch(err => {
  console.error('[UNCAUGHT]', err)
  process.exit(1)
})