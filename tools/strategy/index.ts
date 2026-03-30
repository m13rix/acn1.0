import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import util from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', '..', 'data', 'strategy');

const PROBABILITY_TOLERANCE = 1e-9;
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

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
  routes: StrategyRoute[];
  cycle: StrategyCycleState;
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
  routeCount: number;
  cycle: StrategyCycleState;
  createdAt: string;
  updatedAt: string;
}

export type StrategyRouteDecision = 'undecided' | 'keep' | 'kill';
export type StrategyCycleStatus = 'draft' | 'active' | 'complete';

export interface StrategyRoute {
  id: string;
  parentRouteId?: string;
  depth: number;
  name: string;
  slug: string;
  theme?: string;
  category?: string;
  summary?: string;
  note?: string;
  folderPath: string;
  intakePath: string;
  evalPath: string;
  decision: StrategyRouteDecision;
  decisionReason?: string;
  evidence?: string;
  confidence?: number;
  rank?: number;
  subroutesGenerated: boolean;
  subroutesGeneratedAt?: string;
  generationNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyRouteSummary {
  id: string;
  parentRouteId?: string;
  depth: number;
  name: string;
  slug: string;
  theme?: string;
  category?: string;
  summary?: string;
  folderPath: string;
  intakePath: string;
  evalPath: string;
  decision: StrategyRouteDecision;
  rank?: number;
  subroutesGenerated: boolean;
  childCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyCycleState {
  maxDepth: number;
  currentDepth: number;
  status: StrategyCycleStatus;
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

interface CreateRouteInput {
  name: string;
  parentRouteId?: string;
  theme?: string;
  category?: string;
  summary?: string;
  slug?: string;
  note?: string;
  folderPath?: string;
  intakePath?: string;
  evalPath?: string;
  rank?: number;
}

interface CreateRouteBatchInput {
  parentRouteId?: string;
  theme?: string;
  category?: string;
  routes: CreateRouteInput[];
}

interface ListRoutesInput {
  parentRouteId?: string | null;
  depth?: number;
  decision?: StrategyRouteDecision;
}

interface UpdateRouteInput {
  name?: string;
  theme?: string;
  category?: string;
  summary?: string;
  slug?: string;
  note?: string;
  folderPath?: string;
  intakePath?: string;
  evalPath?: string;
  rank?: number;
  evidence?: string;
  confidence?: number;
}

interface RouteDecisionInput {
  reason: string;
  evidence?: string;
  confidence?: number;
  rank?: number;
}

interface MarkSubroutesGeneratedInput {
  note?: string;
}

interface UpdateCycleInput {
  maxDepth?: number;
  currentDepth?: number;
  status?: StrategyCycleStatus;
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

function assertOptionalFiniteNumber(value: unknown, fieldName: string): number | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  return assertFiniteNumber(value, fieldName);
}

function assertProbability(value: unknown): number {
  const probability = assertFiniteNumber(value, 'probability');
  if (probability < 0 || probability > 1) {
    throw new Error('probability must be between 0 and 1.');
  }
  return probability;
}

function assertOptionalProbability(value: unknown, fieldName: string): number | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  const probability = assertFiniteNumber(value, fieldName);
  if (probability < 0 || probability > 1) {
    throw new Error(`${fieldName} must be between 0 and 1.`);
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

function findJsonObjectBoundary(raw: string): number | null {
  let startIndex = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!/\s/.test(char)) {
      startIndex = index;
      break;
    }
  }

  if (startIndex === -1 || raw[startIndex] !== '{') {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

function parseStrategyJson(raw: string, strategyId: string): StrategyProject {
  try {
    return JSON.parse(raw) as StrategyProject;
  } catch (error: any) {
    const boundary = findJsonObjectBoundary(raw);
    if (!boundary) {
      throw error;
    }

    const trailing = raw.slice(boundary).trim();
    if (!trailing) {
      throw error;
    }

    try {
      const recovered = JSON.parse(raw.slice(0, boundary)) as StrategyProject;
      console.warn(
        `[strategy] Recovered trailing data while reading ${strategyFilePath(strategyId)}; ignored ${trailing.length} trailing characters.`
      );
      return recovered;
    } catch {
      throw error;
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function attachAwaitHint<T>(promise: Promise<T>, label: string): Promise<T> {
  const hint = {
    __await_required__: `Await strategy call before logging or reading the result: await ${label}`,
  };

  try {
    Object.defineProperty(promise, 'toJSON', {
      value: () => hint,
      configurable: true,
    });
  } catch {
    // Ignore if Promise object cannot be decorated in this runtime.
  }

  try {
    Object.defineProperty(promise, INSPECT_CUSTOM, {
      value: () => hint,
      configurable: true,
    });
  } catch {
    // Ignore if Promise object cannot be decorated in this runtime.
  }

  return promise;
}

function decorateAsyncApi<T extends Record<string, any>>(obj: T, prefix: string): T {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'function') {
      continue;
    }

    const original = value;
    (obj as Record<string, unknown>)[key] = (...args: unknown[]) => {
      const result = original(...args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return attachAwaitHint(Promise.resolve(result), `${prefix}.${key}(...)`);
      }
      return result;
    };
  }

  return obj;
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'route';
}

function padDepth(depth: number): string {
  return String(depth).padStart(2, '0');
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
    routeCount: strategy.routes.length,
    cycle: clone(strategy.cycle),
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

function sortRoutes(left: StrategyRoute, right: StrategyRoute): number {
  const leftRank = typeof left.rank === 'number' ? left.rank : Number.POSITIVE_INFINITY;
  const rightRank = typeof right.rank === 'number' ? right.rank : Number.POSITIVE_INFINITY;
  return (
    left.depth - right.depth
    || leftRank - rightRank
    || left.name.localeCompare(right.name)
    || left.createdAt.localeCompare(right.createdAt)
  );
}

function summarizeRoute(strategy: StrategyProject, route: StrategyRoute): StrategyRouteSummary {
  const childCount = strategy.routes.filter(item => item.parentRouteId === route.id).length;
  return {
    id: route.id,
    parentRouteId: route.parentRouteId,
    depth: route.depth,
    name: route.name,
    slug: route.slug,
    theme: route.theme,
    category: route.category,
    summary: route.summary,
    folderPath: route.folderPath,
    intakePath: route.intakePath,
    evalPath: route.evalPath,
    decision: route.decision,
    rank: route.rank,
    subroutesGenerated: route.subroutesGenerated,
    childCount,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

async function readStrategy(strategyId: string): Promise<StrategyProject> {
  const normalizedId = assertNonEmptyString(strategyId, 'strategyId');
  await ensureStore();
  try {
    const raw = await fs.readFile(strategyFilePath(normalizedId), 'utf8');
    return normalizeStrategy(parseStrategyJson(raw, normalizedId));
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
  const targetPath = strategyFilePath(strategy.id);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(strategy, null, 2), 'utf8');
  await fs.rename(tempPath, targetPath);
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

  if (!Array.isArray(normalized.routes)) {
    normalized.routes = [];
  } else {
    normalized.routes = normalized.routes.map((route) => normalizeRoute(route, timestamp));
    normalized.routes.sort(sortRoutes);
  }

  normalized.cycle = normalizeCycleState(normalized.cycle as StrategyCycleState | undefined, timestamp);

  return normalized;
}

function normalizeRoute(raw: StrategyRoute, fallbackTimestamp: string): StrategyRoute {
  const name = assertNonEmptyString(raw?.name, 'route.name');
  const slug = assertOptionalString(raw?.slug, 'route.slug') || slugifyName(name);
  const timestamp = assertOptionalString(raw?.updatedAt, 'route.updatedAt') || fallbackTimestamp;
  const createdAt = assertOptionalString(raw?.createdAt, 'route.createdAt') || timestamp;
  const depth = mustBePositiveInteger(raw?.depth, 'route.depth');
  const decision = normalizeRouteDecision(raw?.decision);
  const folderPath = assertOptionalString(raw?.folderPath, 'route.folderPath')
    || defaultRouteFolderPath(undefined, depth, slug);

  return {
    id: assertNonEmptyString(raw?.id, 'route.id'),
    parentRouteId: assertOptionalString(raw?.parentRouteId, 'route.parentRouteId'),
    depth,
    name,
    slug,
    theme: assertOptionalString(raw?.theme, 'route.theme'),
    category: assertOptionalString(raw?.category, 'route.category'),
    summary: assertOptionalString(raw?.summary, 'route.summary'),
    note: assertOptionalString(raw?.note, 'route.note'),
    folderPath,
    intakePath: assertOptionalString(raw?.intakePath, 'route.intakePath') || `${folderPath}/${slug}_intake.md`,
    evalPath: assertOptionalString(raw?.evalPath, 'route.evalPath') || `${folderPath}/${slug}_eval.md`,
    decision,
    decisionReason: assertOptionalString(raw?.decisionReason, 'route.decisionReason'),
    evidence: assertOptionalString(raw?.evidence, 'route.evidence'),
    confidence: assertOptionalProbability(raw?.confidence, 'route.confidence'),
    rank: assertOptionalFiniteNumber(raw?.rank, 'route.rank'),
    subroutesGenerated: typeof raw?.subroutesGenerated === 'boolean' ? raw.subroutesGenerated : false,
    subroutesGeneratedAt: assertOptionalString(raw?.subroutesGeneratedAt, 'route.subroutesGeneratedAt'),
    generationNote: assertOptionalString(raw?.generationNote, 'route.generationNote'),
    createdAt,
    updatedAt: timestamp,
  };
}

function normalizeCycleState(raw: StrategyCycleState | undefined, fallbackTimestamp: string): StrategyCycleState {
  const maxDepthRaw = raw && typeof raw.maxDepth !== 'undefined' ? raw.maxDepth : 10;
  const currentDepthRaw = raw && typeof raw.currentDepth !== 'undefined' ? raw.currentDepth : 1;
  const maxDepth = mustBePositiveInteger(maxDepthRaw, 'cycle.maxDepth');
  const currentDepth = mustBePositiveInteger(currentDepthRaw, 'cycle.currentDepth');
  if (currentDepth > maxDepth) {
    throw new Error(`cycle.currentDepth (${currentDepth}) cannot exceed cycle.maxDepth (${maxDepth}).`);
  }

  return {
    maxDepth,
    currentDepth,
    status: normalizeCycleStatus(raw?.status),
    updatedAt: assertOptionalString(raw?.updatedAt, 'cycle.updatedAt') || fallbackTimestamp,
  };
}

function normalizeRouteDecision(value: unknown): StrategyRouteDecision {
  if (value === 'keep' || value === 'kill' || value === 'undecided') {
    return value;
  }
  return 'undecided';
}

function normalizeCycleStatus(value: unknown): StrategyCycleStatus {
  if (value === 'active' || value === 'complete' || value === 'draft') {
    return value;
  }
  return 'draft';
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

function getRouteOrThrow(strategy: StrategyProject, routeId: string): StrategyRoute {
  const normalizedRouteId = assertNonEmptyString(routeId, 'routeId');
  const route = strategy.routes.find(item => item.id === normalizedRouteId);
  if (!route) {
    throw new Error(`Route "${normalizedRouteId}" was not found in strategy "${strategy.id}".`);
  }
  return route;
}

function defaultRouteFolderPath(parentRoute: StrategyRoute | undefined, depth: number, slug: string): string {
  if (!parentRoute) {
    return `strategy_workspace/routes/${slug}`;
  }
  return `${parentRoute.folderPath}/${slug}`;
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
    if (probabilitySum > 1 + PROBABILITY_TOLERANCE) {
      issues.push(
        `Outgoing probabilities from node "${node.name}" (${node.id}) cannot exceed 1. Current sum: ${probabilitySum}.`
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

      const probabilitySum = outgoing.reduce((sum, event) => sum + event.probability, 0);
      const residualProbability = Math.max(0, 1 - probabilitySum);
      if (residualProbability > PROBABILITY_TOLERANCE) {
        incrementProbability(nextDistribution, nodeId, probabilityMass * residualProbability);
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
      routes: [],
      cycle: {
        maxDepth: 10,
        currentDepth: 1,
        status: 'draft',
        updatedAt: timestamp,
      },
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

export const routes = {
  async create(strategyId: string, input: CreateRouteInput): Promise<StrategyRouteSummary> {
    const strategy = await readStrategy(strategyId);
    const timestamp = nowIso();
    const name = assertNonEmptyString(input?.name, 'name');
    const parentRouteId = assertOptionalString(input?.parentRouteId, 'parentRouteId');
    const parentRoute = parentRouteId ? getRouteOrThrow(strategy, parentRouteId) : undefined;
    const depth = parentRoute ? parentRoute.depth + 1 : strategy.cycle.currentDepth;
    const slug = assertOptionalString(input?.slug, 'slug') || slugifyName(name);
    const folderPath = assertOptionalString(input?.folderPath, 'folderPath')
      || defaultRouteFolderPath(parentRoute, depth, slug);
    const route: StrategyRoute = {
      id: makeId('route'),
      parentRouteId,
      depth,
      name,
      slug,
      theme: assertOptionalString(input?.theme, 'theme'),
      category: assertOptionalString(input?.category, 'category'),
      summary: assertOptionalString(input?.summary, 'summary'),
      note: assertOptionalString(input?.note, 'note'),
      folderPath,
      intakePath: assertOptionalString(input?.intakePath, 'intakePath') || `${folderPath}/${slug}_intake.md`,
      evalPath: assertOptionalString(input?.evalPath, 'evalPath') || `${folderPath}/${slug}_eval.md`,
      decision: 'undecided',
      decisionReason: undefined,
      evidence: undefined,
      confidence: undefined,
      rank: assertOptionalFiniteNumber(input?.rank, 'rank'),
      subroutesGenerated: false,
      subroutesGeneratedAt: undefined,
      generationNote: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    strategy.routes.push(route);
    if (parentRoute && !parentRoute.subroutesGenerated) {
      parentRoute.subroutesGenerated = true;
      parentRoute.subroutesGeneratedAt = timestamp;
      parentRoute.generationNote = 'Subroutes were created.';
      parentRoute.updatedAt = timestamp;
    }
    strategy.routes.sort(sortRoutes);
    if (strategy.cycle.status === 'draft') {
      strategy.cycle.status = 'active';
      strategy.cycle.updatedAt = timestamp;
    }
    await writeStrategy(strategy);
    return summarizeRoute(strategy, route);
  },

  async createBatch(strategyId: string, input: CreateRouteBatchInput): Promise<StrategyRouteSummary[]> {
    const created: StrategyRouteSummary[] = [];
    for (const routeInput of input?.routes || []) {
      created.push(await routes.create(strategyId, {
        ...routeInput,
        parentRouteId: routeInput.parentRouteId ?? input?.parentRouteId,
        theme: routeInput.theme ?? input?.theme,
        category: routeInput.category ?? input?.category,
      }));
    }
    return created;
  },

  async list(strategyId: string, query: ListRoutesInput = {}): Promise<StrategyRouteSummary[]> {
    const strategy = await readStrategy(strategyId);
    const parentRouteId = typeof query?.parentRouteId === 'string'
      ? assertNonEmptyString(query.parentRouteId, 'parentRouteId')
      : query?.parentRouteId === null
        ? null
        : undefined;
    const depth = typeof query?.depth === 'undefined'
      ? undefined
      : mustBePositiveInteger(query.depth, 'depth');
    const decision = typeof query?.decision === 'undefined'
      ? undefined
      : normalizeRouteDecision(query.decision);

    return strategy.routes
      .filter((route) => {
        if (typeof depth === 'number' && route.depth !== depth) {
          return false;
        }
        if (typeof decision !== 'undefined' && route.decision !== decision) {
          return false;
        }
        if (typeof parentRouteId !== 'undefined') {
          if (parentRouteId === null) {
            return !route.parentRouteId;
          }
          return route.parentRouteId === parentRouteId;
        }
        return true;
      })
      .sort(sortRoutes)
      .map(route => summarizeRoute(strategy, route));
  },

  async get(strategyId: string, routeId: string): Promise<StrategyRoute> {
    const strategy = await readStrategy(strategyId);
    return clone(getRouteOrThrow(strategy, routeId));
  },

  async update(strategyId: string, routeId: string, patch: UpdateRouteInput): Promise<StrategyRoute> {
    const strategy = await readStrategy(strategyId);
    const route = getRouteOrThrow(strategy, routeId);
    const parentRoute = route.parentRouteId ? getRouteOrThrow(strategy, route.parentRouteId) : undefined;
    const previousSlug = route.slug;
    const previousFolderPath = route.folderPath;

    if (typeof patch?.name !== 'undefined') {
      route.name = assertNonEmptyString(patch.name, 'name');
    }
    if (typeof patch?.theme !== 'undefined') {
      route.theme = assertOptionalString(patch.theme, 'theme');
    }
    if (typeof patch?.category !== 'undefined') {
      route.category = assertOptionalString(patch.category, 'category');
    }
    if (typeof patch?.summary !== 'undefined') {
      route.summary = assertOptionalString(patch.summary, 'summary');
    }
    if (typeof patch?.note !== 'undefined') {
      route.note = assertOptionalString(patch.note, 'note');
    }
    if (typeof patch?.evidence !== 'undefined') {
      route.evidence = assertOptionalString(patch.evidence, 'evidence');
    }
    if (typeof patch?.confidence !== 'undefined') {
      route.confidence = assertOptionalProbability(patch.confidence, 'confidence');
    }
    if (typeof patch?.rank !== 'undefined') {
      route.rank = assertOptionalFiniteNumber(patch.rank, 'rank');
    }

    const nextSlug = typeof patch?.slug !== 'undefined'
      ? (assertOptionalString(patch.slug, 'slug') || slugifyName(route.name))
      : route.slug;
    route.slug = nextSlug;

    if (typeof patch?.folderPath !== 'undefined') {
      route.folderPath = assertOptionalString(patch.folderPath, 'folderPath')
        || defaultRouteFolderPath(parentRoute, route.depth, route.slug);
    } else if (previousSlug !== route.slug) {
      route.folderPath = defaultRouteFolderPath(parentRoute, route.depth, route.slug);
    }

    if (typeof patch?.intakePath !== 'undefined') {
      route.intakePath = assertOptionalString(patch.intakePath, 'intakePath') || `${route.folderPath}/${route.slug}_intake.md`;
    } else if (previousSlug !== route.slug || previousFolderPath !== route.folderPath) {
      route.intakePath = `${route.folderPath}/${route.slug}_intake.md`;
    }

    if (typeof patch?.evalPath !== 'undefined') {
      route.evalPath = assertOptionalString(patch.evalPath, 'evalPath') || `${route.folderPath}/${route.slug}_eval.md`;
    } else if (previousSlug !== route.slug || previousFolderPath !== route.folderPath) {
      route.evalPath = `${route.folderPath}/${route.slug}_eval.md`;
    }

    route.updatedAt = nowIso();
    strategy.routes.sort(sortRoutes);
    await writeStrategy(strategy);
    return clone(route);
  },

  async keep(strategyId: string, routeId: string, input: RouteDecisionInput): Promise<StrategyRoute> {
    const strategy = await readStrategy(strategyId);
    const route = getRouteOrThrow(strategy, routeId);
    route.decision = 'keep';
    route.decisionReason = assertNonEmptyString(input?.reason, 'reason');
    route.evidence = assertOptionalString(input?.evidence, 'evidence');
    route.confidence = assertOptionalProbability(input?.confidence, 'confidence');
    route.rank = assertOptionalFiniteNumber(input?.rank, 'rank');
    route.updatedAt = nowIso();
    await writeStrategy(strategy);
    return clone(route);
  },

  async kill(strategyId: string, routeId: string, input: RouteDecisionInput): Promise<StrategyRoute> {
    const strategy = await readStrategy(strategyId);
    const route = getRouteOrThrow(strategy, routeId);
    route.decision = 'kill';
    route.decisionReason = assertNonEmptyString(input?.reason, 'reason');
    route.evidence = assertOptionalString(input?.evidence, 'evidence');
    route.confidence = assertOptionalProbability(input?.confidence, 'confidence');
    route.rank = assertOptionalFiniteNumber(input?.rank, 'rank');
    route.updatedAt = nowIso();
    await writeStrategy(strategy);
    return clone(route);
  },

  async reopen(strategyId: string, routeId: string, reason?: string): Promise<StrategyRoute> {
    const strategy = await readStrategy(strategyId);
    const route = getRouteOrThrow(strategy, routeId);
    route.decision = 'undecided';
    route.decisionReason = assertOptionalString(reason, 'reason');
    route.updatedAt = nowIso();
    await writeStrategy(strategy);
    return clone(route);
  },

  async markSubroutesGenerated(
    strategyId: string,
    routeId: string,
    input: MarkSubroutesGeneratedInput = {}
  ): Promise<StrategyRoute> {
    const strategy = await readStrategy(strategyId);
    const route = getRouteOrThrow(strategy, routeId);
    const timestamp = nowIso();
    route.subroutesGenerated = true;
    route.subroutesGeneratedAt = timestamp;
    route.generationNote = assertOptionalString(input?.note, 'note');
    route.updatedAt = timestamp;
    await writeStrategy(strategy);
    return clone(route);
  },

  async listPendingExpansion(strategyId: string, depth?: number): Promise<StrategyRouteSummary[]> {
    const strategy = await readStrategy(strategyId);
    const targetDepth = typeof depth === 'undefined'
      ? undefined
      : mustBePositiveInteger(depth, 'depth');

    return strategy.routes
      .filter((route) => {
        if (route.decision !== 'keep') {
          return false;
        }
        if (route.subroutesGenerated) {
          return false;
        }
        if (typeof targetDepth === 'number' && route.depth !== targetDepth) {
          return false;
        }
        return true;
      })
      .sort(sortRoutes)
      .map(route => summarizeRoute(strategy, route));
  },

  async remove(strategyId: string, routeId: string): Promise<{ ok: true }> {
    const strategy = await readStrategy(strategyId);
    const normalizedRouteId = assertNonEmptyString(routeId, 'routeId');
    getRouteOrThrow(strategy, normalizedRouteId);
    const descendants = new Set<string>([normalizedRouteId]);

    let changed = true;
    while (changed) {
      changed = false;
      for (const route of strategy.routes) {
        if (route.parentRouteId && descendants.has(route.parentRouteId) && !descendants.has(route.id)) {
          descendants.add(route.id);
          changed = true;
        }
      }
    }

    strategy.routes = strategy.routes.filter(route => !descendants.has(route.id));
    await writeStrategy(strategy);
    return { ok: true };
  },
};

export const cycle = {
  async get(strategyId: string): Promise<StrategyCycleState> {
    const strategy = await readStrategy(strategyId);
    return clone(strategy.cycle);
  },

  async configure(strategyId: string, patch: UpdateCycleInput): Promise<StrategyCycleState> {
    const strategy = await readStrategy(strategyId);
    const next: StrategyCycleState = {
      maxDepth: typeof patch?.maxDepth === 'undefined'
        ? strategy.cycle.maxDepth
        : mustBePositiveInteger(patch.maxDepth, 'maxDepth'),
      currentDepth: typeof patch?.currentDepth === 'undefined'
        ? strategy.cycle.currentDepth
        : mustBePositiveInteger(patch.currentDepth, 'currentDepth'),
      status: typeof patch?.status === 'undefined'
        ? strategy.cycle.status
        : normalizeCycleStatus(patch.status),
      updatedAt: nowIso(),
    };

    if (next.currentDepth > next.maxDepth) {
      throw new Error(`currentDepth (${next.currentDepth}) cannot exceed maxDepth (${next.maxDepth}).`);
    }

    strategy.cycle = next;
    await writeStrategy(strategy);
    return clone(strategy.cycle);
  },

  async depthSummary(strategyId: string, depth?: number): Promise<{
    depth: number;
    total: number;
    keep: number;
    kill: number;
    undecided: number;
    routeIds: string[];
  }> {
    const strategy = await readStrategy(strategyId);
    const targetDepth = typeof depth === 'undefined'
      ? strategy.cycle.currentDepth
      : mustBePositiveInteger(depth, 'depth');
    const routesAtDepth = strategy.routes.filter(route => route.depth === targetDepth);
    return {
      depth: targetDepth,
      total: routesAtDepth.length,
      keep: routesAtDepth.filter(route => route.decision === 'keep').length,
      kill: routesAtDepth.filter(route => route.decision === 'kill').length,
      undecided: routesAtDepth.filter(route => route.decision === 'undecided').length,
      routeIds: routesAtDepth.map(route => route.id),
    };
  },

  async getExpansionParents(strategyId: string, targetDepth?: number): Promise<StrategyRouteSummary[]> {
    const strategy = await readStrategy(strategyId);
    const requestedDepth = typeof targetDepth === 'undefined'
      ? strategy.cycle.currentDepth
      : mustBePositiveInteger(targetDepth, 'targetDepth');

    if (requestedDepth === 1) {
      return [];
    }

    return strategy.routes
      .filter(route => route.depth === requestedDepth - 1 && route.decision === 'keep')
      .sort(sortRoutes)
      .map(route => summarizeRoute(strategy, route));
  },

  async canAdvance(strategyId: string): Promise<{
    canAdvance: boolean;
    currentDepth: number;
    nextDepth: number | null;
    reasons: string[];
    keptRouteIds: string[];
  }> {
    const strategy = await readStrategy(strategyId);
    const currentDepth = strategy.cycle.currentDepth;
    const reasons: string[] = [];

    if (currentDepth >= strategy.cycle.maxDepth) {
      reasons.push('Already at maxDepth.');
    }

    const routesAtDepth = strategy.routes.filter(route => route.depth === currentDepth);
    if (routesAtDepth.length === 0) {
      reasons.push('No routes exist at the current depth.');
    }

    const undecided = routesAtDepth.filter(route => route.decision === 'undecided');
    if (undecided.length > 0) {
      reasons.push(`Undecided routes remain at depth ${currentDepth}.`);
    }

    const kept = routesAtDepth.filter(route => route.decision === 'keep');
    if (kept.length === 0) {
      reasons.push(`No kept routes remain at depth ${currentDepth}.`);
    }

    return {
      canAdvance: reasons.length === 0,
      currentDepth,
      nextDepth: reasons.length === 0 ? currentDepth + 1 : null,
      reasons,
      keptRouteIds: kept.map(route => route.id),
    };
  },

  async advance(strategyId: string): Promise<StrategyCycleState> {
    const strategy = await readStrategy(strategyId);
    const readiness = await cycle.canAdvance(strategyId);
    if (!readiness.canAdvance || !readiness.nextDepth) {
      throw new Error(`Cannot advance depth:\n- ${readiness.reasons.join('\n- ')}`);
    }

    strategy.cycle.currentDepth = readiness.nextDepth;
    strategy.cycle.status = 'active';
    strategy.cycle.updatedAt = nowIso();
    await writeStrategy(strategy);
    return clone(strategy.cycle);
  },
};

decorateAsyncApi(strategies, 'strategy.strategies');
decorateAsyncApi(paths, 'strategy.paths');
decorateAsyncApi(nodes, 'strategy.nodes');
decorateAsyncApi(events, 'strategy.events');
decorateAsyncApi(analysis, 'strategy.analysis');
decorateAsyncApi(divergence, 'strategy.divergence');
decorateAsyncApi(routes, 'strategy.routes');
decorateAsyncApi(cycle, 'strategy.cycle');

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
export const createRoute = routes.create;
export const createRouteBatch = routes.createBatch;
export const listRoutes = routes.list;
export const getRoute = routes.get;
export const keepRoute = routes.keep;
export const killRoute = routes.kill;
export const reopenRoute = routes.reopen;
export const markRouteSubroutesGenerated = routes.markSubroutesGenerated;
export const listPendingRouteExpansion = routes.listPendingExpansion;
export const getCycle = cycle.get;
export const configureCycle = cycle.configure;
export const advanceCycle = cycle.advance;
export async function calculatePathUtility(strategyId: string, pathId: string, maxSteps: number): Promise<number> {
  return analysis.expectedStateDelta(strategyId, pathId, maxSteps);
}
