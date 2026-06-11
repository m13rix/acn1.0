import express from 'express';
import { spawn } from 'child_process';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.MINECRAFT_TEXTURE_API_PORT || '3018', 10);
const COMFYUI_URL_OVERRIDE = process.env.COMFYUI_URL?.replace(/\/+$/, '');
const COMFYUI_URL_CANDIDATES = [
  'http://127.0.0.1:8000',
  COMFYUI_URL_OVERRIDE,
  'http://127.0.0.1:8188',
].filter(Boolean) as string[];
const WORKFLOW_PATH = process.env.MINECRAFT_ITEM_WORKFLOW_PATH || join(__dirname, 'minecraft_item_generator_api.json');
const PROMPT_NODE_ID = process.env.MINECRAFT_ITEM_PROMPT_NODE_ID || '58';
const SEED_NODE_ID = process.env.MINECRAFT_ITEM_SEED_NODE_ID || '59:68';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MINECRAFT_TEXTURE_TIMEOUT_MS || '600000', 10);
const INCEPTION_BASE_URL = (process.env.INCEPTION_BASE_URL || 'https://api.inceptionlabs.ai/v1').replace(/\/+$/, '');
const BALANCE_MODEL = process.env.MINECRAFT_BALANCE_MODEL || process.env.MEMORY_MERCURY_MODEL || 'mercury-2';
const BALANCE_TIMEOUT_MS = Number.parseInt(process.env.MINECRAFT_BALANCE_TIMEOUT_MS || '60000', 10);

type Workflow = Record<string, { inputs?: Record<string, unknown>; class_type?: string }>;

interface GenerateBody {
  prompt?: unknown;
}

interface RecipeCell {
  id: string;
  count: number;
}

interface BalanceRequest {
  concept: string;
  recipe: RecipeCell[];
}

type BalanceResponse = {
  success: true;
} | {
  success: false;
  message?: string;
  concept?: string;
  recipe?: RecipeCell[];
};

interface RgbaPixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

const BALANCE_SYSTEM_PROMPT = `You are a fast Minecraft item balance validator for a real-time AI modding engine.

Your task is to judge whether a proposed crafting recipe is balanced, meaningful, and progression-appropriate for the item concept provided by the player.

You receive:
1. An item concept written in natural language. It may be in English, Russian, or another language.
2. A shaped 3x3 crafting recipe represented as an array of 9 cells, ordered left-to-right, top-to-bottom.
3. Each recipe cell contains either:
   - {"id": "minecraft:iron_sword", "count": 1}
   - {"id": "create:small_cogwheel", "count": 1}
   - {"id": "limitless:ruby", "count": 1}
   - {"id": "ruby", "count": 1}
   - {"id": "none", "count": 0}

Input format:

{
  "concept": "Ender sword. Basically a normal iron sword, but right-click throws an ender pearl.",
  "recipe": [
    {"id": "none", "count": 0},
    {"id": "minecraft:ender_pearl", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:chorus_fruit", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:iron_sword", "count": 1},
    {"id": "none", "count": 0}
  ]
}

You must output ONLY valid JSON. No markdown. No explanation outside JSON.

Main output format:

If the recipe is balanced:

{
  "success": true
}

If the recipe is not balanced:

{
  "success": false,
  "message": "...",
  "concept": "...",
  "recipe": [...]
}

When success is false, include at least one of these fields:
- "message"
- "concept"
- "recipe"

You may include several of them at once if needed.

Important language rule:
- The fields "message" and "concept" must be written in the same language as the original item concept.
- If the concept is in Russian, answer those fields in Russian.
- If the concept is in English, answer those fields in English.
- Item IDs must never be translated.

Balance philosophy:

Judge balance using Minecraft survival common sense, not exact mathematical formulas.

A good recipe should satisfy most of these:
1. The ingredients are thematically related to the item's power.
2. The recipe cost roughly matches the power level.
3. The recipe respects progression.
4. The recipe does not make existing vanilla items useless too early.
5. The recipe does not bypass major gameplay stages without paying a meaningful cost.
6. The spatial arrangement makes some intuitive crafting sense when possible.
7. Strong reusable items should usually require rare materials, late-game access, durability limits, cooldowns, fuel, ammo, or other constraints.
8. Weak or convenience-only items should not be over-expensive.
9. A recipe can be balanced either by making the recipe harder OR by changing the concept with drawbacks, cooldowns, costs, randomness, durability, or resource consumption.

Recipe correction rules:

If the main problem is the recipe, output a corrected full 9-cell recipe in the "recipe" field.

The corrected recipe must be a complete 9-element array using the same cell format:

[
  {"id": "...", "count": 1},
  ...
]

When suggesting a corrected recipe, you may only use:
1. Vanilla Minecraft item IDs, such as "minecraft:ender_eye", "minecraft:diamond", "minecraft:blaze_rod".
2. Custom item IDs already present in the player's proposed recipe.
3. Modded item IDs from namespaces already present in the player's proposed recipe.

Do NOT invent new custom or modded item IDs in the corrected recipe.

For example:
- If the original recipe uses "create:small_cogwheel", you may use known Create-style IDs if you are reasonably confident they exist.
- If the original recipe does not use any Create items, do not introduce "create:" items.
- If the original recipe uses "limitless:ruby", you may reuse "limitless:ruby", but do not invent "limitless:quantum_core" unless it already appeared in the recipe.

If you cannot safely suggest a corrected recipe because the item requires missing fictional technology, missing progression steps, or unknown custom materials, use "message" instead.

Concept correction rules:

Use the "concept" field when the item can become balanced by modifying its behavior, limitation, or drawback.

Examples of valid concept changes:
- Add a cooldown.
- Add durability loss.
- Consume ammunition or fuel.
- Reduce range.
- Add random offset.
- Make the effect weaker.
- Require line of sight.
- Make it work only in certain dimensions or conditions.
- Make it risky to use.
- Add a charge-up time.
- Add a per-use cost.

Do not ruin the original fantasy of the item unless necessary. Prefer small balance changes over completely redesigning the item.

Message rules:

Use "message" when:
1. The item is fundamentally too overpowered.
2. The item breaks progression too hard.
3. The concept requires missing technological or magical prerequisites.
4. The current recipe is meaningless or thematically unrelated.
5. You need to explain why no simple recipe fix is enough.
6. The item needs a multi-step progression chain before it can reasonably exist.

The message should be concise but specific.

Reasoning guidelines:

Think like a Minecraft mod designer.

Ask internally:
- What can this item do?
- What existing vanilla item or mechanic does it replace?
- Does it make that mechanic obsolete?
- How early can the player craft it?
- What dimensions, bosses, structures, or resources does the recipe require?
- Is the cost renewable or non-renewable?
- Is the item reusable?
- Does it need fuel, ammo, cooldown, durability cost, or risk?
- Do the ingredients symbolically match the effect?
- Is the item fun without destroying survival progression?

Vanilla progression assumptions:

- Wood, stone, copper, iron: early game.
- Gold, redstone, lapis, amethyst: early/mid game depending on use.
- Diamond, obsidian, enchanting materials: mid game.
- Blaze rods, ender pearls, eyes of ender: Nether/stronghold progression.
- Netherite, echo shards, dragon egg, elytra, shulker shells, nether stars: late/endgame.
- Chorus fruit implies End access.
- Eyes of ender imply overworld + Nether + ender pearl/blaze powder progression.
- Nether star implies Wither-level endgame power.
- Dragon egg should only be used for extremely powerful unique items.

Do not over-penalize creative but reasonable recipes.
Do not demand perfect balance.
A recipe is acceptable if it is reasonably fair for normal survival play.

Success criteria:

Return {"success": true} only if:
- The item concept and recipe are reasonably balanced.
- The recipe cost makes sense for the item's power.
- The item does not obviously trivialize major survival mechanics.
- No important drawback or progression requirement is missing.

Return {"success": false} if:
- The item is too cheap for its power.
- The recipe ingredients do not match the ability.
- The recipe skips important progression.
- The item makes a vanilla mechanic obsolete too easily.
- The concept needs a cooldown, fuel, ammo, durability loss, risk, or limitation.
- The item requires fictional prerequisites not represented by the recipe.
- The recipe uses random expensive items that do not actually relate to the concept.

Examples:

Example 1 input:

{
  "concept": "Ender sword. Basically a normal iron sword, but right-click throws an ender pearl.",
  "recipe": [
    {"id": "none", "count": 0},
    {"id": "minecraft:ender_pearl", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:chorus_fruit", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:iron_sword", "count": 1},
    {"id": "none", "count": 0}
  ]
}

Example 1 output:

{
  "success": false,
  "message": "The recipe is close, but the item is a reusable ender pearl launcher, so one pearl and one chorus fruit are too cheap for the amount of mobility it gives.",
  "recipe": [
    {"id": "none", "count": 0},
    {"id": "minecraft:ender_eye", "count": 1},
    {"id": "none", "count": 0},

    {"id": "minecraft:ender_pearl", "count": 1},
    {"id": "minecraft:chorus_fruit", "count": 1},
    {"id": "minecraft:ender_pearl", "count": 1},

    {"id": "none", "count": 0},
    {"id": "minecraft:iron_sword", "count": 1},
    {"id": "none", "count": 0}
  ]
}

Example 2 input:

{
  "concept": "Ендер-меч. По сути обычный железный меч, но при нажатии ПКМ позволяет кидать ендер-жемчуг.",
  "recipe": [
    {"id": "none", "count": 0},
    {"id": "minecraft:ender_pearl", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:chorus_fruit", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:iron_sword", "count": 1},
    {"id": "none", "count": 0}
  ]
}

Example 2 output:

{
  "success": false,
  "message": "Рецепт близок к балансному, но многоразовый меч, который заменяет ендер-жемчуг, слишком силён для одного жемчуга и одного хоруса.",
  "recipe": [
    {"id": "none", "count": 0},
    {"id": "minecraft:ender_eye", "count": 1},
    {"id": "none", "count": 0},

    {"id": "minecraft:ender_pearl", "count": 1},
    {"id": "minecraft:chorus_fruit", "count": 1},
    {"id": "minecraft:ender_pearl", "count": 1},

    {"id": "none", "count": 0},
    {"id": "minecraft:iron_sword", "count": 1},
    {"id": "none", "count": 0}
  ]
}

Example 3 input:

{
  "concept": "A wooden ring that gives permanent creative flight.",
  "recipe": [
    {"id": "minecraft:stick", "count": 1},
    {"id": "minecraft:stick", "count": 1},
    {"id": "minecraft:stick", "count": 1},

    {"id": "minecraft:stick", "count": 1},
    {"id": "none", "count": 0},
    {"id": "minecraft:stick", "count": 1},

    {"id": "minecraft:stick", "count": 1},
    {"id": "minecraft:stick", "count": 1},
    {"id": "minecraft:stick", "count": 1}
  ]
}

Example 3 output:

{
  "success": false,
  "message": "Permanent creative flight is an endgame-level ability. A wooden recipe is far too cheap and bypasses elytra progression almost completely.",
  "concept": "A late-game flight ring that allows controlled flight for short periods, consumes durability while flying, and has a cooldown after landing."
}

Example 4 input:

{
  "concept": "A copper wrench that rotates blocks when right-clicked.",
  "recipe": [
    {"id": "minecraft:copper_ingot", "count": 1},
    {"id": "none", "count": 0},
    {"id": "minecraft:copper_ingot", "count": 1},

    {"id": "none", "count": 0},
    {"id": "minecraft:stick", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:stick", "count": 1},
    {"id": "none", "count": 0}
  ]
}

Example 4 output:

{
  "success": true
}

Example 5 input:

{
  "concept": "Квантовый меч, который мгновенно убивает любого моба и телепортирует игрока к ближайшей структуре.",
  "recipe": [
    {"id": "minecraft:diamond", "count": 1},
    {"id": "minecraft:ender_pearl", "count": 1},
    {"id": "minecraft:diamond", "count": 1},

    {"id": "none", "count": 0},
    {"id": "minecraft:iron_sword", "count": 1},
    {"id": "none", "count": 0},

    {"id": "none", "count": 0},
    {"id": "minecraft:redstone", "count": 1},
    {"id": "none", "count": 0}
  ]
}

Example 5 output:

{
  "success": false,
  "message": "Такой предмет нельзя балансно создать из обычных ресурсов: мгновенное убийство любого моба и поиск структур ломают боевую систему, исследование мира и прогрессию. Для такого предмета нужна отдельная позднеигровая технологическая цепочка, например квантовые материалы, редкий источник энергии и многоступенчатый крафт после эндгейма."
}

Final rule:
Always output only valid JSON.
Never output comments.
Never output markdown.
Never include hidden reasoning.
Never include trailing commas.`;

const BALANCE_RESPONSE_SCHEMA = {
  name: 'minecraft_item_balance_result',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      concept: { type: 'string' },
      recipe: {
        type: 'array',
        minItems: 9,
        maxItems: 9,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            count: { type: 'integer' },
          },
          required: ['id', 'count'],
        },
      },
    },
    required: ['success'],
  },
};

let workflowCache: Workflow | null = null;
let rembgAvailable: boolean | null = null;
let resolvedComfyUiUrl: string | null = null;

function cloneWorkflow(workflow: Workflow): Workflow {
  return JSON.parse(JSON.stringify(workflow)) as Workflow;
}

async function loadWorkflow(): Promise<Workflow> {
  if (!workflowCache) {
    workflowCache = JSON.parse(await readFile(WORKFLOW_PATH, 'utf8')) as Workflow;
  }

  return cloneWorkflow(workflowCache);
}

function makePromptWorkflow(basePrompt: string): Workflow {
  const workflow = workflowCache ? cloneWorkflow(workflowCache) : null;
  if (!workflow) {
    throw new Error('Workflow cache is not loaded.');
  }

  const promptNode = workflow[PROMPT_NODE_ID];
  if (!promptNode?.inputs || !('value' in promptNode.inputs)) {
    throw new Error(`Workflow prompt node ${PROMPT_NODE_ID} with inputs.value was not found.`);
  }

  promptNode.inputs.value = basePrompt;

  const seedNode = workflow[SEED_NODE_ID];
  if (seedNode?.inputs && 'seed' in seedNode.inputs) {
    seedNode.inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  }

  return workflow;
}

async function canReachComfyUi(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function getComfyUiUrl(): Promise<string> {
  if (resolvedComfyUiUrl) {
    return resolvedComfyUiUrl;
  }

  for (const candidate of COMFYUI_URL_CANDIDATES) {
    if (await canReachComfyUi(candidate)) {
      resolvedComfyUiUrl = candidate;
      console.log(`[minecraft-texture] using ComfyUI at ${candidate}`);
      return candidate;
    }
  }

  throw new Error(`Could not reach ComfyUI. Tried: ${COMFYUI_URL_CANDIDATES.join(', ')}`);
}

async function comfyWsUrl(clientId: string): Promise<string> {
  const url = new URL(await getComfyUiUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = `clientId=${encodeURIComponent(clientId)}`;
  return url.toString();
}

function extractImageBuffer(data: WebSocket.RawData): Buffer | null {
  const raw = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);

  const pngOffset = raw.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (pngOffset >= 0) {
    return raw.subarray(pngOffset);
  }

  const jpegOffset = raw.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpegOffset >= 0) {
    return raw.subarray(jpegOffset);
  }

  return null;
}

async function queuePrompt(workflow: Workflow, clientId: string): Promise<string> {
  const comfyUiUrl = await getComfyUiUrl();
  const response = await fetch(`${comfyUiUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ComfyUI /prompt failed (${response.status}): ${text}`);
  }

  const payload = JSON.parse(text) as { prompt_id?: string };
  if (!payload.prompt_id) {
    throw new Error(`ComfyUI did not return prompt_id: ${text}`);
  }

  return payload.prompt_id;
}

function waitForWebsocketImage(clientId: string, workflow: Workflow): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let promptId: string | null = null;
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for ComfyUI image after ${REQUEST_TIMEOUT_MS}ms.`));
    }, REQUEST_TIMEOUT_MS);

    function finish(error: Error | null, image?: Buffer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws?.close();
      if (error) reject(error);
      else resolve(image!);
    }

    comfyWsUrl(clientId).then((url) => {
      ws = new WebSocket(url);

      ws.on('open', async () => {
        try {
          promptId = await queuePrompt(workflow, clientId);
        } catch (error) {
          finish(error as Error);
        }
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const image = extractImageBuffer(data);
          if (image) {
            finish(null, image);
          }
          return;
        }

        try {
          const message = JSON.parse(data.toString()) as {
            type?: string;
            data?: { prompt_id?: string; node?: string | null; exception_message?: string };
          };

          if (message.type === 'execution_error' && (!promptId || message.data?.prompt_id === promptId)) {
            finish(new Error(message.data?.exception_message || 'ComfyUI execution failed.'));
          }
        } catch {
          // Ignore non-JSON status frames.
        }
      });

      ws.on('error', finish);
    }).catch((error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function generateImage(prompt: string): Promise<Buffer> {
  await loadWorkflow();
  const workflow = makePromptWorkflow(prompt);
  const clientId = `minecraft-item-${randomUUID()}`;

  try {
    return await waitForWebsocketImage(clientId, workflow);
  } catch (error) {
    throw new Error(`ComfyUI image generation failed: ${(error as Error).message}`);
  }
}

function pythonCommand(): string {
  return process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

async function removeBackgroundWithRembg(input: Buffer): Promise<Buffer | null> {
  if (rembgAvailable === false) {
    return null;
  }

  const dir = join(tmpdir(), `minecraft-texture-${randomUUID()}`);
  const inputPath = join(dir, 'input.png');
  const outputPath = join(dir, 'output.png');

  await mkdir(dir, { recursive: true });
  await writeFile(inputPath, input);

  const code = [
    'from rembg import remove',
    'from pathlib import Path',
    `inp = Path(${JSON.stringify(inputPath)})`,
    `out = Path(${JSON.stringify(outputPath)})`,
    'out.write_bytes(remove(inp.read_bytes()))',
  ].join('\n');

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(pythonCommand(), ['-c', code], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      const stderr: string[] = [];
      proc.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.join('').trim() || `rembg exited with code ${code}`));
      });
    });

    rembgAvailable = true;
    return await readFile(outputPath);
  } catch (error) {
    rembgAvailable = false;
    console.warn(`[minecraft-texture] rembg unavailable, using flat-background removal: ${(error as Error).message}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function estimateCornerBackground(pixels: Buffer, width: number, height: number): RgbaPixel {
  const samples: RgbaPixel[] = [];
  const size = Math.max(4, Math.floor(Math.min(width, height) * 0.08));
  const corners = [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size],
  ] as const;

  for (const [startX, startY] of corners) {
    for (let y = startY; y < startY + size; y++) {
      for (let x = startX; x < startX + size; x++) {
        const index = (y * width + x) * 4;
        samples.push({ r: pixels[index]!, g: pixels[index + 1]!, b: pixels[index + 2]!, a: pixels[index + 3]! });
      }
    }
  }

  const average = samples.reduce((acc, pixel) => {
    acc.r += pixel.r;
    acc.g += pixel.g;
    acc.b += pixel.b;
    acc.a += pixel.a;
    return acc;
  }, { r: 0, g: 0, b: 0, a: 0 });

  const count = Math.max(1, samples.length);
  return {
    r: Math.round(average.r / count),
    g: Math.round(average.g / count),
    b: Math.round(average.b / count),
    a: Math.round(average.a / count),
  };
}

function removeFlatBackgroundFromRaw(pixels: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(pixels);
  const bg = estimateCornerBackground(pixels, width, height);
  const threshold = 34;
  const softThreshold = 70;

  for (let i = 0; i < out.length; i += 4) {
    const dr = out[i]! - bg.r;
    const dg = out[i + 1]! - bg.g;
    const db = out[i + 2]! - bg.b;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    if (distance <= threshold) {
      out[i + 3] = 0;
    } else if (distance < softThreshold) {
      const alpha = Math.round(((distance - threshold) / (softThreshold - threshold)) * 255);
      out[i + 3] = Math.min(out[i + 3]!, alpha);
    }
  }

  return out;
}

function alphaBounds(pixels: Buffer, width: number, height: number): { left: number; top: number; right: number; bottom: number } {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3]!;
      if (alpha > 20) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }

  if (right < left || bottom < top) {
    return { left: 0, top: 0, right: width - 1, bottom: height - 1 };
  }

  return { left, top, right, bottom };
}

function dominantPixelForCell(pixels: Buffer, width: number, startX: number, startY: number, endX: number, endY: number): RgbaPixel {
  const buckets = new Map<string, { weight: number; r: number; g: number; b: number; a: number }>();
  let alphaWeight = 0;
  let totalArea = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const index = (y * width + x) * 4;
      const a = pixels[index + 3]!;
      totalArea++;
      alphaWeight += a / 255;
      if (a <= 16) continue;

      const r = pixels[index]!;
      const g = pixels[index + 1]!;
      const b = pixels[index + 2]!;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const weight = Math.max(0.05, a / 255);
      const bucket = buckets.get(key) || { weight: 0, r: 0, g: 0, b: 0, a: 0 };
      bucket.weight += weight;
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      bucket.a += a * weight;
      buckets.set(key, bucket);
    }
  }

  const coverage = totalArea > 0 ? alphaWeight / totalArea : 0;
  if (coverage < 0.12) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  let best: { weight: number; r: number; g: number; b: number; a: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.weight > best.weight) {
      best = bucket;
    }
  }

  if (!best || best.weight <= 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const alpha = coverage > 0.45 ? 255 : Math.round(Math.min(1, coverage / 0.45) * 255);
  return {
    r: Math.round(best.r / best.weight),
    g: Math.round(best.g / best.weight),
    b: Math.round(best.b / best.weight),
    a: alpha,
  };
}

async function prepareTransparentImage(input: Buffer): Promise<{ pixels: Buffer; width: number; height: number }> {
  const rembg = await removeBackgroundWithRembg(input);
  const image = sharp(rembg || input).ensureAlpha();
  const raw = await image.raw().toBuffer({ resolveWithObject: true });
  const width = raw.info.width;
  const height = raw.info.height;
  const pixels = rembg ? raw.data : removeFlatBackgroundFromRaw(raw.data, width, height);
  return { pixels, width, height };
}

async function toMinecraftArgb(input: Buffer): Promise<string[]> {
  const transparent = await prepareTransparentImage(input);
  const bounds = alphaBounds(transparent.pixels, transparent.width, transparent.height);
  const contentWidth = bounds.right - bounds.left + 1;
  const contentHeight = bounds.bottom - bounds.top + 1;
  const side = Math.max(contentWidth, contentHeight);
  const padding = Math.ceil(side * 0.08);
  const squareSide = side + padding * 2;
  const squareLeft = bounds.left - Math.floor((squareSide - contentWidth) / 2);
  const squareTop = bounds.top - Math.floor((squareSide - contentHeight) / 2);
  const colors: string[] = [];

  for (let targetY = 0; targetY < 16; targetY++) {
    for (let targetX = 0; targetX < 16; targetX++) {
      const startX = Math.max(0, Math.floor(squareLeft + (targetX / 16) * squareSide));
      const endX = Math.min(transparent.width, Math.ceil(squareLeft + ((targetX + 1) / 16) * squareSide));
      const startY = Math.max(0, Math.floor(squareTop + (targetY / 16) * squareSide));
      const endY = Math.min(transparent.height, Math.ceil(squareTop + ((targetY + 1) / 16) * squareSide));
      const pixel = dominantPixelForCell(transparent.pixels, transparent.width, startX, startY, endX, endY);
      colors.push(toArgbHex(pixel));
    }
  }

  return colors;
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase();
}

function toArgbHex(pixel: RgbaPixel): string {
  return `#${toHexByte(pixel.a)}${toHexByte(pixel.r)}${toHexByte(pixel.g)}${toHexByte(pixel.b)}`;
}

function assertPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Request body must include a non-empty string prompt.');
  }
  return value.trim().slice(0, 1000);
}

function assertRecipeCell(value: unknown, index: number): RecipeCell {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`recipe[${index}] must be an object.`);
  }

  const raw = value as { id?: unknown; count?: unknown };
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  const count = Number(raw.count);
  if (!id) {
    throw new Error(`recipe[${index}].id must be a non-empty string.`);
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`recipe[${index}].count must be a non-negative integer.`);
  }

  return { id, count };
}

function assertBalanceRequest(value: unknown): BalanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }

  const raw = value as { concept?: unknown; recipe?: unknown };
  const concept = typeof raw.concept === 'string' && raw.concept.trim()
    ? raw.concept.trim().slice(0, 3000)
    : '';
  if (!concept) {
    throw new Error('Request body must include a non-empty string concept.');
  }
  if (!Array.isArray(raw.recipe) || raw.recipe.length !== 9) {
    throw new Error('Request body must include recipe as a 9-cell array.');
  }

  return {
    concept,
    recipe: raw.recipe.map((cell, index) => assertRecipeCell(cell, index)),
  };
}

function parseJsonResponse(content: string): unknown {
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    throw new Error('Model returned an empty response.');
  }

  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim(),
    trimmed.includes('{') && trimmed.includes('}')
      ? trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  let lastError: unknown;
  for (const candidate of Array.from(new Set(candidates))) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Failed to parse model response as JSON: ${(lastError as Error | undefined)?.message || 'unknown error'}`);
}

function normalizeBalanceResponse(value: unknown): BalanceResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Balance response must be an object.');
  }

  const raw = value as {
    success?: unknown;
    message?: unknown;
    concept?: unknown;
    recipe?: unknown;
  };

  if (raw.success !== true && raw.success !== false) {
    throw new Error('Balance response must include boolean success.');
  }

  if (raw.success === true) {
    return { success: true };
  }

  const response: BalanceResponse = { success: false };
  if (typeof raw.message === 'string' && raw.message.trim()) {
    response.message = raw.message.trim();
  }
  if (typeof raw.concept === 'string' && raw.concept.trim()) {
    response.concept = raw.concept.trim();
  }
  if (Array.isArray(raw.recipe)) {
    if (raw.recipe.length !== 9) {
      throw new Error('Balance response recipe must contain exactly 9 cells.');
    }
    response.recipe = raw.recipe.map((cell, index) => assertRecipeCell(cell, index));
  }

  if (!response.message && !response.concept && !response.recipe) {
    throw new Error('Unbalanced response must include at least one of message, concept, or recipe.');
  }

  return response;
}

async function completeBalanceWithMercury(input: BalanceRequest): Promise<BalanceResponse> {
  const apiKey = process.env.INCEPTION_API_KEY;
  if (!apiKey) {
    throw new Error('INCEPTION_API_KEY is required for the balance endpoint.');
  }

  const messages = [
    { role: 'user', content: BALANCE_SYSTEM_PROMPT + "\n\n" + JSON.stringify(input) },
  ];

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${INCEPTION_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: BALANCE_MODEL,
        messages,
        temperature: 0.75,
        max_tokens: 8192,
        reasoning_effort: 'medium',
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: BALANCE_RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });

    const text = await response.text();
    console.log(text)
    if (!response.ok) {
      throw new Error(`Inception balance request failed (${response.status}): ${text}`);
    }

    try {
      const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content || '';
      console.log(content);
      return normalizeBalanceResponse(parseJsonResponse(content));
    } catch (error) {
      lastError = error;
      messages.push({
        role: 'assistant',
        content: text.slice(0, 5000),
      });
      messages.push({
        role: 'user',
        content: 'Return only corrected JSON that matches the requested schema. No markdown, no commentary, no trailing commas.',
      });
    }
  }

  throw new Error(`Mercury balance validation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function handleGenerate(body: GenerateBody): Promise<string[]> {
  await loadWorkflow();
  const prompt = assertPrompt(body.prompt);
  const image = await generateImage(prompt);
  return toMinecraftArgb(image);
}

async function handleBalance(body: unknown): Promise<BalanceResponse> {
  return completeBalanceWithMercury(assertBalanceRequest(body));
}

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/health', async (_req, res) => {
  let comfyui: string | null = null;
  try {
    comfyui = await getComfyUiUrl();
  } catch {
    comfyui = null;
  }

  res.json({ ok: true, port: PORT, comfyui, candidates: COMFYUI_URL_CANDIDATES });
});

for (const route of ['/generate', '/generate-texture']) {
  app.post(route, async (req, res) => {
    const startedAt = Date.now();
    try {
      const colors = await handleGenerate(req.body as GenerateBody);
      res.json(colors);
      console.log(`[minecraft-texture] ${route} completed in ${Date.now() - startedAt}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[minecraft-texture] ${route} failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });
}

for (const route of ['/balance', '/validate-balance']) {
  app.post(route, async (req, res) => {
    const startedAt = Date.now();
    try {
      const result = await handleBalance(req.body);
      res.json(result);
      console.log(`[minecraft-texture] ${route} completed in ${Date.now() - startedAt}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[minecraft-texture] ${route} failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[minecraft-texture] listening on http://127.0.0.1:${PORT}`);
});
