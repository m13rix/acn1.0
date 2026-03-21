import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', '..', 'data', 'strategy');

const PROBABILITY_TOLERANCE = 1e-9;

export type StrategyNodeKind = 'root' | 'intermediate' | 'goal' | 'fail';

export interface StrategyNode {
  id: string;
  name: string;
  kind: StrategyNodeKind;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyEvent {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  name: string;
  probability: number;
  stateDelta: number;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyPath {
  id: string;
  name: string;
  description?: string;
  rootNodeId: string;
  nodes: StrategyNode[];
  events: StrategyEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface StrategyProject {
  id: string;
  name: string;
  description?: string;
  divergence: StrategyDivergence;
  paths: StrategyPath[];
  createdAt: string;
  updatedAt: string;
}

export interface StrategyDivergence {
  x: number;
  y: number;
  updatedAt: string;
}

export interface StrategySummary {
  id: string;
  name: string;
  description?: string;
  divergence: StrategyDivergence;
  pathCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyPathSummary {
  id: string;
  name: string;
  description?: string;
  rootNodeId: string;
  nodeCount: number;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PathValidationResult {
  valid: boolean;
  issues: string[];
}

export interface AnalyzePathOptions {
  maxSteps: number;
}

export interface StepDistribution {
  step: number;
  nodeProbabilities: Array<{
    nodeId: string;
    nodeName: string;
    kind: StrategyNodeKind;
    probability: number;
  }>;
  expectedStepStateDelta: number;
  cumulativeExpectedStateDelta: number;
  probabilityReachGoal: number;
  probabilityReachFail: number;
  unresolvedProbability: number;
}

export interface PathAnalysisResult {
  strategyId: string;
  pathId: string;
  maxSteps: number;
  probabilityReachGoal: number;
  probabilityReachFail: number;
  unresolvedProbability: number;
  expectedCumulativeStateDelta: number;
  expectedStepsToGoal: number | null;
  hittingTimeGoal: Array<{ step: number; probability: number }>;
  hittingTimeFail: Array<{ step: number; probability: number }>;
  stepDistributions: StepDistribution[];
}

interface CreatePathInput {
  name: string;
  description?: string;
  rootName?: string;
}

interface AddNodeInput {
  name: string;
  kind?: Exclude<StrategyNodeKind, 'root'>;
  note?: string;
}

interface UpdateNodeInput {
  name?: string;
  kind?: Exclude<StrategyNodeKind, 'root'>;
  note?: string;
}

interface AddEventInput {
  fromNodeId: string;
  toNodeId: string;
  name: string;
  probability: number;
  stateDelta: number;
  reason?: string;
}

interface UpdateEventInput {
  fromNodeId?: string;
  toNodeId?: string;
  name?: string;
  probability?: number;
  stateDelta?: number;
  reason?: string;
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function assertOptionalString(value: unknown, fieldName: string): string | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string when provided.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function assertFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return value;
}

function assertProbability(value: unknown): number {
  const probability = assertFiniteNumber(value, 'probability');
  if (probability < 0 || probability > 1) {
    throw new Error('probability must be between 0 and 1.');
  }
  return probability;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function ensureStore(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

function strategyFilePath(strategyId: string): string {
  return path.join(STORE_DIR, `${strategyId}.json`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortStrategies(left: StrategyProject, right: StrategyProject): number {
  return left.name.localeCompare(right.name) || left.createdAt.localeCompare(right.createdAt);
}

function summarizeStrategy(strategy: StrategyProject): StrategySummary {
  return {
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    divergence: clone(strategy.divergence),
    pathCount: strategy.paths.length,
    createdAt: strategy.createdAt,
    updatedAt: strategy.updatedAt,
  };
}

function summarizePath(pathRecord: StrategyPath): StrategyPathSummary {
  return {
    id: pathRecord.id,
    name: pathRecord.name,
    description: pathRecord.description,
    rootNodeId: pathRecord.rootNodeId,
    nodeCount: pathRecord.nodes.length,
    eventCount: pathRecord.events.length,
    createdAt: pathRecord.createdAt,
    updatedAt: pathRecord.updatedAt,
  };
}

async function readStrategy(strategyId: string): Promise<StrategyProject> {
  const normalizedId = assertNonEmptyString(strategyId, 'strategyId');
  await ensureStore();
  try {
    const raw = await fs.readFile(strategyFilePath(normalizedId), 'utf8');
    return normalizeStrategy(JSON.parse(raw));
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Strategy "${normalizedId}" was not found.`);
    }
    throw error;
  }
}

async function writeStrategy(strategy: StrategyProject): Promise<void> {
  await ensureStore();
  strategy.updatedAt = nowIso();
  await fs.writeFile(strategyFilePath(strategy.id), JSON.stringify(strategy, null, 2), 'utf8');
}

async function readAllStrategies(): Promise<StrategyProject[]> {
  await ensureStore();
  const entries = await fs.readdir(STORE_DIR, { withFileTypes: true });
  const strategiesList: StrategyProject[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const raw = await fs.readFile(path.join(STORE_DIR, entry.name), 'utf8');
    strategiesList.push(normalizeStrategy(JSON.parse(raw)));
  }

  return strategiesList.sort(sortStrategies);
}

function normalizeStrategy(raw: StrategyProject): StrategyProject {
  const normalized = clone(raw);
  const timestamp = typeof normalized.updatedAt === 'string' && normalized.updatedAt
    ? normalized.updatedAt
    : nowIso();

  if (
    !normalized.divergence
    || typeof normalized.divergence.x !== 'number'
    || typeof normalized.divergence.y !== 'number'
  ) {
    normalized.divergence = {
      x: 0,
      y: 0,
      updatedAt: timestamp,
    };
  } else if (typeof normalized.divergence.updatedAt !== 'string' || !normalized.divergence.updatedAt) {
    normalized.divergence.updatedAt = timestamp;
  }

  return normalized;
}

function getPathOrThrow(strategy: StrategyProject, pathId: string): StrategyPath {
  const normalizedPathId = assertNonEmptyString(pathId, 'pathId');
  const pathRecord = strategy.paths.find(item => item.id === normalizedPathId);
  if (!pathRecord) {
    throw new Error(`Path "${normalizedPathId}" was not found in strategy "${strategy.id}".`);
  }
  return pathRecord;
}

function getNodeOrThrow(pathRecord: StrategyPath, nodeId: string): StrategyNode {
  const normalizedNodeId = assertNonEmptyString(nodeId, 'nodeId');
  const node = pathRecord.nodes.find(item => item.id === normalizedNodeId);
  if (!node) {
    throw new Error(`Node "${normalizedNodeId}" was not found in path "${pathRecord.id}".`);
  }
  return node;
}

function getEventOrThrow(pathRecord: StrategyPath, eventId: string): StrategyEvent {
  const normalizedEventId = assertNonEmptyString(eventId, 'eventId');
  const event = pathRecord.events.find(item => item.id === normalizedEventId);
  if (!event) {
    throw new Error(`Event "${normalizedEventId}" was not found in path "${pathRecord.id}".`);
  }
  return event;
}

function rootNodeCount(pathRecord: StrategyPath): number {
  return pathRecord.nodes.filter(node => node.kind === 'root').length;
}

function nodeByIdMap(pathRecord: StrategyPath): Map<string, StrategyNode> {
  return new Map(pathRecord.nodes.map(node => [node.id, node]));
}

function eventsBySource(pathRecord: StrategyPath): Map<string, StrategyEvent[]> {
  const grouped = new Map<string, StrategyEvent[]>();
  for (const event of pathRecord.events) {
    const bucket = grouped.get(event.fromNodeId) || [];
    bucket.push(event);
    grouped.set(event.fromNodeId, bucket);
  }
  return grouped;
}

function validatePathGraph(pathRecord: StrategyPath): PathValidationResult {
  const issues: string[] = [];
  const nodeMap = nodeByIdMap(pathRecord);
  const groupedEvents = eventsBySource(pathRecord);

  if (pathRecord.nodes.length === 0) {
    issues.push('Path has no nodes.');
  }

  if (!pathRecord.rootNodeId || !nodeMap.has(pathRecord.rootNodeId)) {
    issues.push('Path rootNodeId does not reference an existing node.');
  }

  const rootCount = rootNodeCount(pathRecord);
  if (rootCount !== 1) {
    issues.push(`Path must contain exactly one root node, found ${rootCount}.`);
  }

  for (const node of pathRecord.nodes) {
    if (node.kind === 'root' && node.id !== pathRecord.rootNodeId) {
      issues.push(`Node "${node.id}" is marked as root but does not match path.rootNodeId.`);
    }
  }

  for (const event of pathRecord.events) {
    if (!nodeMap.has(event.fromNodeId)) {
      issues.push(`Event "${event.id}" references missing source node "${event.fromNodeId}".`);
    }
    if (!nodeMap.has(event.toNodeId)) {
      issues.push(`Event "${event.id}" references missing target node "${event.toNodeId}".`);
    }
    if (event.probability < 0 || event.probability > 1) {
      issues.push(`Event "${event.id}" has probability outside [0, 1].`);
    }
    if (!Number.isFinite(event.stateDelta)) {
      issues.push(`Event "${event.id}" has non-finite stateDelta.`);
    }
  }

  for (const [nodeId, outgoing] of groupedEvents) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    if (node.kind === 'goal' || node.kind === 'fail') {
      issues.push(`Terminal node "${node.name}" (${node.id}) cannot have outgoing events.`);
      continue;
    }

    const probabilitySum = outgoing.reduce((sum, event) => sum + event.probability, 0);
    if (Math.abs(probabilitySum - 1) > PROBABILITY_TOLERANCE) {
      issues.push(
        `Outgoing probabilities from node "${node.name}" (${node.id}) must sum to 1. Current sum: ${probabilitySum}.`
      );
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

function incrementProbability(map: Map<string, number>, key: string, amount: number): void {
  if (amount === 0) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function formatDistribution(
  distribution: Map<string, number>,
  nodeMap: Map<string, StrategyNode>
): StepDistribution['nodeProbabilities'] {
  return Array.from(distribution.entries())
    .filter(([, probability]) => probability > PROBABILITY_TOLERANCE)
    .map(([nodeId, probability]) => {
      const node = nodeMap.get(nodeId)!;
      return {
        nodeId,
        nodeName: node.name,
        kind: node.kind,
        probability,
      };
    })
    .sort((left, right) => right.probability - left.probability || left.nodeName.localeCompare(right.nodeName));
}

function probabilityInKinds(
  distribution: Map<string, number>,
  nodeMap: Map<string, StrategyNode>,
  kinds: StrategyNodeKind[]
): number {
  const wanted = new Set(kinds);
  let total = 0;
  for (const [nodeId, probability] of distribution) {
    const node = nodeMap.get(nodeId);
    if (node && wanted.has(node.kind)) {
      total += probability;
    }
  }
  return total;
}

function mustBePositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return Number(value);
}

async function analyzePathInternal(
  strategyId: string,
  pathId: string,
  options: AnalyzePathOptions
): Promise<PathAnalysisResult> {
  const maxSteps = mustBePositiveInteger(options?.maxSteps, 'maxSteps');
  const strategy = await readStrategy(strategyId);
  const pathRecord = getPathOrThrow(strategy, pathId);
  const validation = validatePathGraph(pathRecord);
  if (!validation.valid) {
    throw new Error(`Path "${pathRecord.id}" is invalid:\n- ${validation.issues.join('\n- ')}`);
  }

  const nodeMap = nodeByIdMap(pathRecord);
  const groupedEvents = eventsBySource(pathRecord);
  let currentDistribution = new Map<string, number>([[pathRecord.rootNodeId, 1]]);
  let cumulativeExpectedStateDelta = 0;
  const hittingTimeGoal: Array<{ step: number; probability: number }> = [];
  const hittingTimeFail: Array<{ step: number; probability: number }> = [];
  const stepDistributions: StepDistribution[] = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    const nextDistribution = new Map<string, number>();
    let expectedStepStateDelta = 0;
    let goalHitThisStep = 0;
    let failHitThisStep = 0;

    for (const [nodeId, probabilityMass] of currentDistribution) {
      if (probabilityMass <= PROBABILITY_TOLERANCE) {
        continue;
      }

      const node = nodeMap.get(nodeId);
      if (!node) {
        throw new Error(`Encountered missing node "${nodeId}" during analysis.`);
      }

      if (node.kind === 'goal' || node.kind === 'fail') {
        incrementProbability(nextDistribution, nodeId, probabilityMass);
        continue;
      }

      const outgoing = groupedEvents.get(nodeId) || [];
      if (outgoing.length === 0) {
        incrementProbability(nextDistribution, nodeId, probabilityMass);
        continue;
      }

      for (const event of outgoing) {
        const transitionedMass = probabilityMass * event.probability;
        expectedStepStateDelta += transitionedMass * event.stateDelta;
        incrementProbability(nextDistribution, event.toNodeId, transitionedMass);

        const targetNode = nodeMap.get(event.toNodeId)!;
        if (targetNode.kind === 'goal') {
          goalHitThisStep += transitionedMass;
        } else if (targetNode.kind === 'fail') {
          failHitThisStep += transitionedMass;
        }
      }
    }

    cumulativeExpectedStateDelta += expectedStepStateDelta;
    hittingTimeGoal.push({ step, probability: goalHitThisStep });
    hittingTimeFail.push({ step, probability: failHitThisStep });

    const probabilityReachGoal = probabilityInKinds(nextDistribution, nodeMap, ['goal']);
    const probabilityReachFail = probabilityInKinds(nextDistribution, nodeMap, ['fail']);

    stepDistributions.push({
      step,
      nodeProbabilities: formatDistribution(nextDistribution, nodeMap),
      expectedStepStateDelta,
      cumulativeExpectedStateDelta,
      probabilityReachGoal,
      probabilityReachFail,
      unresolvedProbability: Math.max(0, 1 - probabilityReachGoal - probabilityReachFail),
    });

    currentDistribution = nextDistribution;
  }

  const probabilityReachGoal = hittingTimeGoal.reduce((sum, item) => sum + item.probability, 0);
  const probabilityReachFail = hittingTimeFail.reduce((sum, item) => sum + item.probability, 0);
  const expectedGoalStepNumerator = hittingTimeGoal.reduce((sum, item) => sum + item.step * item.probability, 0);

  return {
    strategyId: strategy.id,
    pathId: pathRecord.id,
    maxSteps,
    probabilityReachGoal,
    probabilityReachFail,
    unresolvedProbability: Math.max(0, 1 - probabilityReachGoal - probabilityReachFail),
    expectedCumulativeStateDelta: cumulativeExpectedStateDelta,
    expectedStepsToGoal: probabilityReachGoal > PROBABILITY_TOLERANCE
      ? expectedGoalStepNumerator / probabilityReachGoal
      : null,
    hittingTimeGoal,
    hittingTimeFail,
    stepDistributions,
  };
}

export const strategies = {
  async create(name: string, description?: string): Promise<StrategySummary> {
    const normalizedName = assertNonEmptyString(name, 'name');
    const normalizedDescription = assertOptionalString(description, 'description');
    const timestamp = nowIso();
    const strategy: StrategyProject = {
      id: makeId('strat'),
      name: normalizedName,
      description: normalizedDescription,
      divergence: {
        x: 0,
        y: 0,
        updatedAt: timestamp,
      },
      paths: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeStrategy(strategy);
    return summarizeStrategy(strategy);
  },

  async list(): Promise<StrategySummary[]> {
    const all = await readAllStrategies();
    return all.map(summarizeStrategy);
  },

  async get(strategyId: string): Promise<StrategyProject> {
    return clone(await readStrategy(strategyId));
  },

  async remove(strategyId: string): Promise<{ ok: true }> {
    const normalizedId = assertNonEmptyString(strategyId, 'strategyId');
    await readStrategy(normalizedId);
    await fs.unlink(strategyFilePath(normalizedId));
    return { ok: true };
  },
};

export const paths = {
  async create(strategyId: string, input: CreatePathInput): Promise<StrategyPathSummary> {
    const strategy = await readStrategy(strategyId);
    const name = assertNonEmptyString(input?.name, 'name');
    const description = assertOptionalString(input?.description, 'description');
    const rootName = assertOptionalString(input?.rootName, 'rootName') || 'root';
    const timestamp = nowIso();
    const rootNode: StrategyNode = {
      id: makeId('node'),
      name: rootName,
      kind: 'root',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const pathRecord: StrategyPath = {
      id: makeId('path'),
      name,
      description,
      rootNodeId: rootNode.id,
      nodes: [rootNode],
      events: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    strategy.paths.push(pathRecord);
    await writeStrategy(strategy);
    return summarizePath(pathRecord);
  },

  async list(strategyId: string): Promise<StrategyPathSummary[]> {
    const strategy = await readStrategy(strategyId);
    return strategy.paths.map(summarizePath);
  },

  async get(strategyId: string, pathId: string): Promise<StrategyPath> {
    const strategy = await readStrategy(strategyId);
    return clone(getPathOrThrow(strategy, pathId));
  },

  async remove(strategyId: string, pathId: string): Promise<{ ok: true }> {
    const strategy = await readStrategy(strategyId);
    const normalizedPathId = assertNonEmptyString(pathId, 'pathId');
    const before = strategy.paths.length;
    strategy.paths = strategy.paths.filter(item => item.id !== normalizedPathId);
    if (strategy.paths.length === before) {
      throw new Error(`Path "${normalizedPathId}" was not found in strategy "${strategy.id}".`);
    }
    await writeStrategy(strategy);
    return { ok: true };
  },

  async validate(strategyId: string, pathId: string): Promise<PathValidationResult> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    return validatePathGraph(pathRecord);
  },
};

export const nodes = {
  async add(strategyId: string, pathId: string, input: AddNodeInput): Promise<StrategyNode> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    const timestamp = nowIso();
    const node: StrategyNode = {
      id: makeId('node'),
      name: assertNonEmptyString(input?.name, 'name'),
      kind: input?.kind || 'intermediate',
      note: assertOptionalString(input?.note, 'note'),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    pathRecord.nodes.push(node);
    pathRecord.updatedAt = timestamp;
    await writeStrategy(strategy);
    return clone(node);
  },

  async list(strategyId: string, pathId: string): Promise<StrategyNode[]> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    return clone(pathRecord.nodes);
  },

  async update(strategyId: string, pathId: string, nodeId: string, patch: UpdateNodeInput): Promise<StrategyNode> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    const node = getNodeOrThrow(pathRecord, nodeId);

    if (typeof patch?.name !== 'undefined') {
      node.name = assertNonEmptyString(patch.name, 'name');
    }
    if (typeof patch?.note !== 'undefined') {
      node.note = assertOptionalString(patch.note, 'note');
    }
    if (typeof patch?.kind !== 'undefined') {
      if (node.id === pathRecord.rootNodeId) {
        throw new Error('Root node kind cannot be changed.');
      }
      node.kind = patch.kind;
    }

    node.updatedAt = nowIso();
    pathRecord.updatedAt = node.updatedAt;
    await writeStrategy(strategy);
    return clone(node);
  },

  async remove(strategyId: string, pathId: string, nodeId: string): Promise<{ ok: true }> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    const normalizedNodeId = assertNonEmptyString(nodeId, 'nodeId');

    if (normalizedNodeId === pathRecord.rootNodeId) {
      throw new Error('Root node cannot be removed. Remove the entire path instead.');
    }

    getNodeOrThrow(pathRecord, normalizedNodeId);
    pathRecord.nodes = pathRecord.nodes.filter(node => node.id !== normalizedNodeId);
    pathRecord.events = pathRecord.events.filter(
      event => event.fromNodeId !== normalizedNodeId && event.toNodeId !== normalizedNodeId
    );
    pathRecord.updatedAt = nowIso();
    await writeStrategy(strategy);
    return { ok: true };
  },
};

export const events = {
  async add(strategyId: string, pathId: string, input: AddEventInput): Promise<StrategyEvent> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    getNodeOrThrow(pathRecord, input?.fromNodeId);
    getNodeOrThrow(pathRecord, input?.toNodeId);

    const timestamp = nowIso();
    const event: StrategyEvent = {
      id: makeId('event'),
      fromNodeId: assertNonEmptyString(input?.fromNodeId, 'fromNodeId'),
      toNodeId: assertNonEmptyString(input?.toNodeId, 'toNodeId'),
      name: assertNonEmptyString(input?.name, 'name'),
      probability: assertProbability(input?.probability),
      stateDelta: assertFiniteNumber(input?.stateDelta, 'stateDelta'),
      reason: assertOptionalString(input?.reason, 'reason'),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    pathRecord.events.push(event);
    pathRecord.updatedAt = timestamp;
    await writeStrategy(strategy);
    return clone(event);
  },

  async list(strategyId: string, pathId: string): Promise<StrategyEvent[]> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    return clone(pathRecord.events);
  },

  async update(strategyId: string, pathId: string, eventId: string, patch: UpdateEventInput): Promise<StrategyEvent> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    const event = getEventOrThrow(pathRecord, eventId);

    if (typeof patch?.fromNodeId !== 'undefined') {
      getNodeOrThrow(pathRecord, patch.fromNodeId);
      event.fromNodeId = assertNonEmptyString(patch.fromNodeId, 'fromNodeId');
    }
    if (typeof patch?.toNodeId !== 'undefined') {
      getNodeOrThrow(pathRecord, patch.toNodeId);
      event.toNodeId = assertNonEmptyString(patch.toNodeId, 'toNodeId');
    }
    if (typeof patch?.name !== 'undefined') {
      event.name = assertNonEmptyString(patch.name, 'name');
    }
    if (typeof patch?.probability !== 'undefined') {
      event.probability = assertProbability(patch.probability);
    }
    if (typeof patch?.stateDelta !== 'undefined') {
      event.stateDelta = assertFiniteNumber(patch.stateDelta, 'stateDelta');
    }
    if (typeof patch?.reason !== 'undefined') {
      event.reason = assertOptionalString(patch.reason, 'reason');
    }

    event.updatedAt = nowIso();
    pathRecord.updatedAt = event.updatedAt;
    await writeStrategy(strategy);
    return clone(event);
  },

  async remove(strategyId: string, pathId: string, eventId: string): Promise<{ ok: true }> {
    const strategy = await readStrategy(strategyId);
    const pathRecord = getPathOrThrow(strategy, pathId);
    const normalizedEventId = assertNonEmptyString(eventId, 'eventId');
    getEventOrThrow(pathRecord, normalizedEventId);
    pathRecord.events = pathRecord.events.filter(event => event.id !== normalizedEventId);
    pathRecord.updatedAt = nowIso();
    await writeStrategy(strategy);
    return { ok: true };
  },
};

export const analysis = {
  analyzePath: analyzePathInternal,

  async probabilityToReachGoal(strategyId: string, pathId: string, maxSteps: number): Promise<number> {
    const result = await analyzePathInternal(strategyId, pathId, { maxSteps });
    return result.probabilityReachGoal;
  },

  async expectedStepsToGoal(strategyId: string, pathId: string, maxSteps: number): Promise<number | null> {
    const result = await analyzePathInternal(strategyId, pathId, { maxSteps });
    return result.expectedStepsToGoal;
  },

  async expectedStateDelta(strategyId: string, pathId: string, maxSteps: number): Promise<number> {
    const result = await analyzePathInternal(strategyId, pathId, { maxSteps });
    return result.expectedCumulativeStateDelta;
  },

  async hittingTimeDistribution(
    strategyId: string,
    pathId: string,
    maxSteps: number
  ): Promise<Array<{ step: number; probability: number }>> {
    const result = await analyzePathInternal(strategyId, pathId, { maxSteps });
    return result.hittingTimeGoal;
  },

  async distributionAtStep(strategyId: string, pathId: string, step: number): Promise<StepDistribution> {
    const normalizedStep = mustBePositiveInteger(step, 'step');
    const result = await analyzePathInternal(strategyId, pathId, { maxSteps: normalizedStep });
    return result.stepDistributions[result.stepDistributions.length - 1]!;
  },
};

export const divergence = {
  async get(strategyId: string): Promise<StrategyDivergence> {
    const strategy = await readStrategy(strategyId);
    return clone(strategy.divergence);
  },

  async set(strategyId: string, value: { x: number; y: number }): Promise<StrategyDivergence> {
    const strategy = await readStrategy(strategyId);
    strategy.divergence = {
      x: assertFiniteNumber(value?.x, 'x'),
      y: assertFiniteNumber(value?.y, 'y'),
      updatedAt: nowIso(),
    };
    await writeStrategy(strategy);
    return clone(strategy.divergence);
  },
};

export const createStrategy = strategies.create;
export const listStrategies = strategies.list;
export const getStrategy = strategies.get;
export const removeStrategy = strategies.remove;
export const createProject = strategies.create;
export const listProjects = strategies.list;
export const getProject = strategies.get;
export const removeProject = strategies.remove;

export const createPath = paths.create;
export const validatePath = paths.validate;
export const addNode = nodes.add;
export const addEvent = events.add;
export const connectNodes = events.add;
export const analyzePath = analysis.analyzePath;
export const probabilityToReachGoal = analysis.probabilityToReachGoal;
export const expectedStepsToGoal = analysis.expectedStepsToGoal;
export const expectedStateDelta = analysis.expectedStateDelta;
export const getDivergence = divergence.get;
export const setDivergence = divergence.set;
export async function calculatePathUtility(strategyId: string, pathId: string, maxSteps: number): Promise<number> {
  return analysis.expectedStateDelta(strategyId, pathId, maxSteps);
}
