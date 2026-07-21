import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DecisionStatus = 'active' | 'resolved' | 'archived';

export interface DecisionEntry {
  id: string;
  text: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface DecisionResolution {
  direction: string;
  rationale: string;
  strongestAlternative?: string;
  reconsiderWhen?: string | string[];
  confidence?: string | number;
  resolvedAt: string;
  [key: string]: unknown;
}

export interface DecisionNode {
  id: string;
  parentId?: string;
  label: string;
  purpose: string;
  parentConstraint?: string;
  horizon?: string;
  successCondition?: string;
  invariants: DecisionEntry[];
  values: DecisionEntry[];
  evidence: DecisionEntry[];
  uncertainty: DecisionEntry[];
  transformations: DecisionEntry[];
  options: DecisionEntry[];
  evaluatedPlans: DecisionEntry[];
  resolution?: DecisionResolution;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface DecisionCollections {
  world: {
    observations: DecisionEntry[];
    retrievedClaims: DecisionEntry[];
    inferences: DecisionEntry[];
    hypotheses: DecisionEntry[];
    unknowns: DecisionEntry[];
    modelUncertainty: DecisionEntry[];
  };
  deliberation: {
    robustActions: DecisionEntry[];
    informationRequests: DecisionEntry[];
    creativeSearchBudget?: string;
    stoppingCondition?: string;
  };
  execution: {
    executorJobs: DecisionEntry[];
    userFacingJobs: DecisionEntry[];
    implementationSteps: DecisionEntry[];
    approvedSideEffects: DecisionEntry[];
    progress: DecisionEntry[];
    verification: DecisionEntry[];
    rollback: DecisionEntry[];
  };
  temporal: {
    notes: DecisionEntry[];
    heartbeatBindings: DecisionEntry[];
    futureTriggers: DecisionEntry[];
    planningSessions: DecisionEntry[];
    expectedEvidence: DecisionEntry[];
  };
  learning: {
    predictedOutcomes: DecisionEntry[];
    observedOutcomes: DecisionEntry[];
    causalInterpretations: DecisionEntry[];
    confidenceUpdates: DecisionEntry[];
    memoryChanges: DecisionEntry[];
  };
}

export interface DecisionWorkspace extends DecisionCollections {
  schemaVersion: 2;
  id: string;
  title: string;
  status: DecisionStatus;
  trigger?: string;
  modes: string[];
  userWaiting?: boolean;
  timeSensitivity?: string;
  constitutionalDomains: string[];
  observationChannels: string[];
  capabilityMapStatus?: string;
  rootNodeId: string;
  activeNodeId: string;
  nodes: DecisionNode[];
  finalOutcome?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDecisionInput {
  title: string;
  trigger?: string;
  modes?: string[];
  userWaiting?: boolean;
  timeSensitivity?: string;
  constitutionalDomains?: string[];
  observationChannels?: string[];
  capabilityMapStatus?: string;
  metadata?: Record<string, unknown>;
  root: {
    label?: string;
    purpose: string;
    horizon?: string;
    successCondition?: string;
    invariants?: EntryInput[];
    values?: EntryInput[];
    metadata?: Record<string, unknown>;
  };
}

export interface AddNodeInput {
  parentId: string;
  label?: string;
  purpose: string;
  parentConstraint?: string;
  horizon?: string;
  successCondition?: string;
  invariants?: EntryInput[];
  values?: EntryInput[];
  evidence?: EntryInput[];
  uncertainty?: EntryInput[];
  transformations?: EntryInput[];
  options?: EntryInput[];
  evaluatedPlans?: EntryInput[];
  metadata?: Record<string, unknown>;
}

export type EntryInput = string | ({ text?: string; action?: string; unknown?: string } & Record<string, unknown>);
type WorkspaceCollectionPath = keyof typeof WORKSPACE_COLLECTION_PATHS;
type NodeCollectionField = typeof NODE_COLLECTION_FIELDS[number];

const WORKSPACE_COLLECTION_PATHS = {
  'world.observations': ['world', 'observations'],
  'world.retrievedClaims': ['world', 'retrievedClaims'],
  'world.inferences': ['world', 'inferences'],
  'world.hypotheses': ['world', 'hypotheses'],
  'world.unknowns': ['world', 'unknowns'],
  'world.modelUncertainty': ['world', 'modelUncertainty'],
  'deliberation.robustActions': ['deliberation', 'robustActions'],
  'deliberation.informationRequests': ['deliberation', 'informationRequests'],
  'execution.executorJobs': ['execution', 'executorJobs'],
  'execution.userFacingJobs': ['execution', 'userFacingJobs'],
  'execution.implementationSteps': ['execution', 'implementationSteps'],
  'execution.approvedSideEffects': ['execution', 'approvedSideEffects'],
  'execution.progress': ['execution', 'progress'],
  'execution.verification': ['execution', 'verification'],
  'execution.rollback': ['execution', 'rollback'],
  'temporal.notes': ['temporal', 'notes'],
  'temporal.heartbeatBindings': ['temporal', 'heartbeatBindings'],
  'temporal.futureTriggers': ['temporal', 'futureTriggers'],
  'temporal.planningSessions': ['temporal', 'planningSessions'],
  'temporal.expectedEvidence': ['temporal', 'expectedEvidence'],
  'learning.predictedOutcomes': ['learning', 'predictedOutcomes'],
  'learning.observedOutcomes': ['learning', 'observedOutcomes'],
  'learning.causalInterpretations': ['learning', 'causalInterpretations'],
  'learning.confidenceUpdates': ['learning', 'confidenceUpdates'],
  'learning.memoryChanges': ['learning', 'memoryChanges'],
} as const;

const NODE_COLLECTION_FIELDS = [
  'invariants',
  'values',
  'evidence',
  'uncertainty',
  'transformations',
  'options',
  'evaluatedPlans',
] as const;

const mutationQueues = new Map<string, Promise<void>>();

function storeDirectory(): string {
  const configured = String(process.env.TELOS_DECISION_DIR || '').trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(process.env.TELOS_PROJECT_ROOT || process.cwd(), 'data', 'decisions');
}

function cleanString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function assertId(value: unknown, label = 'decisionId'): string {
  const id = cleanString(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error(`${label} contains invalid characters.`);
  }
  return id;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return structuredClone(value);
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'decision';
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function workspacePath(id: string): string {
  return path.join(storeDirectory(), `${assertId(id)}.json`);
}

function normalizeEntry(input: EntryInput, now = new Date().toISOString()): DecisionEntry {
  if (typeof input === 'string') {
    return { id: newId('item'), text: cleanString(input, 'entry'), createdAt: now };
  }
  if (!isRecord(input)) {
    throw new Error('Entries must be strings or objects.');
  }
  const copy = structuredClone(input);
  const text = String(copy.text ?? copy.action ?? copy.unknown ?? '').trim();
  if (!text) {
    throw new Error('Structured entries require text, action, or unknown.');
  }
  return {
    ...copy,
    id: typeof copy.id === 'string' && copy.id.trim() ? assertId(copy.id, 'entry.id') : newId('item'),
    text,
    createdAt: typeof copy.createdAt === 'string' && copy.createdAt.trim() ? copy.createdAt : now,
  };
}

function normalizeEntries(entries: EntryInput[] | EntryInput | undefined): DecisionEntry[] {
  if (entries === undefined) return [];
  const values = Array.isArray(entries) ? entries : [entries];
  return values.map((entry) => normalizeEntry(entry));
}

function emptyCollections(): DecisionCollections {
  return {
    world: {
      observations: [],
      retrievedClaims: [],
      inferences: [],
      hypotheses: [],
      unknowns: [],
      modelUncertainty: [],
    },
    deliberation: {
      robustActions: [],
      informationRequests: [],
    },
    execution: {
      executorJobs: [],
      userFacingJobs: [],
      implementationSteps: [],
      approvedSideEffects: [],
      progress: [],
      verification: [],
      rollback: [],
    },
    temporal: {
      notes: [],
      heartbeatBindings: [],
      futureTriggers: [],
      planningSessions: [],
      expectedEvidence: [],
    },
    learning: {
      predictedOutcomes: [],
      observedOutcomes: [],
      causalInterpretations: [],
      confidenceUpdates: [],
      memoryChanges: [],
    },
  };
}

function makeNode(input: {
  id?: string;
  parentId?: string;
  label?: string;
  purpose: string;
  parentConstraint?: string;
  horizon?: string;
  successCondition?: string;
  invariants?: EntryInput[];
  values?: EntryInput[];
  evidence?: EntryInput[];
  uncertainty?: EntryInput[];
  transformations?: EntryInput[];
  options?: EntryInput[];
  evaluatedPlans?: EntryInput[];
  metadata?: Record<string, unknown>;
}): DecisionNode {
  const now = new Date().toISOString();
  return {
    id: input.id ? assertId(input.id, 'node.id') : newId('node'),
    ...(input.parentId ? { parentId: assertId(input.parentId, 'parentId') } : {}),
    label: String(input.label || '').trim() || 'Decision node',
    purpose: cleanString(input.purpose, 'node purpose'),
    ...(input.parentConstraint?.trim() ? { parentConstraint: input.parentConstraint.trim() } : {}),
    ...(input.horizon?.trim() ? { horizon: input.horizon.trim() } : {}),
    ...(input.successCondition?.trim() ? { successCondition: input.successCondition.trim() } : {}),
    invariants: normalizeEntries(input.invariants),
    values: normalizeEntries(input.values),
    evidence: normalizeEntries(input.evidence),
    uncertainty: normalizeEntries(input.uncertainty),
    transformations: normalizeEntries(input.transformations),
    options: normalizeEntries(input.options),
    evaluatedPlans: normalizeEntries(input.evaluatedPlans),
    metadata: cloneRecord(input.metadata),
    createdAt: now,
    updatedAt: now,
  };
}

async function readWorkspace(id: string): Promise<DecisionWorkspace> {
  const normalizedId = assertId(id);
  let raw: string;
  try {
    raw = await readFile(workspacePath(normalizedId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Decision workspace "${normalizedId}" does not exist.`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Decision workspace "${normalizedId}" is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.id !== normalizedId || !Array.isArray(parsed.nodes)) {
    throw new Error(`Decision workspace "${normalizedId}" has an invalid schema.`);
  }
  parsed.schemaVersion = 2;
  if (typeof parsed.activeNodeId !== 'string') parsed.activeNodeId = parsed.rootNodeId;
  if (isRecord(parsed.execution) && !Array.isArray(parsed.execution.implementationSteps)) {
    parsed.execution.implementationSteps = [];
  }
  return parsed as unknown as DecisionWorkspace;
}

async function writeWorkspace(workspace: DecisionWorkspace): Promise<void> {
  const directory = storeDirectory();
  await mkdir(directory, { recursive: true });
  const destination = workspacePath(workspace.id);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function mutate<T>(id: string, operation: (workspace: DecisionWorkspace) => T | Promise<T>): Promise<T> {
  const normalizedId = assertId(id);
  const key = workspacePath(normalizedId);
  const previous = mutationQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const workspace = await readWorkspace(normalizedId);
    const result = await operation(workspace);
    workspace.updatedAt = new Date().toISOString();
    await writeWorkspace(workspace);
    return result;
  });
  const guard = run.then(() => undefined, () => undefined);
  mutationQueues.set(key, guard);
  try {
    return await run;
  } finally {
    if (mutationQueues.get(key) === guard) mutationQueues.delete(key);
  }
}

function findNode(workspace: DecisionWorkspace, nodeId: string): DecisionNode {
  const normalized = assertId(nodeId, 'nodeId');
  const node = workspace.nodes.find((candidate) => candidate.id === normalized);
  if (!node) throw new Error(`Node "${normalized}" does not exist in decision "${workspace.id}".`);
  return node;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    const current = target[key];
    if (isRecord(current) && isRecord(value)) {
      deepMerge(current, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value.trim() || undefined;
}

function normalizeCollectionSection(
  value: unknown,
  allowedFields: readonly string[],
  label: string,
): Record<string, DecisionEntry[]> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const result: Record<string, DecisionEntry[]> = {};
  for (const [field, entries] of Object.entries(value)) {
    if (!allowedFields.includes(field)) throw new Error(`Unsupported ${label} field "${field}".`);
    if (!Array.isArray(entries)) throw new Error(`${label}.${field} must be an array.`);
    result[field] = normalizeEntries(entries as EntryInput[]);
  }
  return result;
}

function normalizeWorkspacePatch(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'title',
    'status',
    'trigger',
    'modes',
    'userWaiting',
    'timeSensitivity',
    'constitutionalDomains',
    'observationChannels',
    'capabilityMapStatus',
    'metadata',
    'world',
    'deliberation',
    'execution',
    'temporal',
    'learning',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`decision.patch cannot change ${key}.`);
  }

  const output: Record<string, unknown> = {};
  if (Object.hasOwn(input, 'title')) output.title = cleanString(input.title, 'title');
  if (Object.hasOwn(input, 'status')) {
    assertStatus(input.status);
    output.status = input.status;
  }
  for (const field of ['trigger', 'timeSensitivity', 'capabilityMapStatus'] as const) {
    if (Object.hasOwn(input, field)) output[field] = optionalString(input[field], field);
  }
  for (const field of ['modes', 'constitutionalDomains', 'observationChannels'] as const) {
    if (Object.hasOwn(input, field)) {
      if (!Array.isArray(input[field])) throw new Error(`${field} must be an array of strings.`);
      output[field] = uniqueStrings(input[field]);
    }
  }
  if (Object.hasOwn(input, 'userWaiting')) {
    if (typeof input.userWaiting !== 'boolean') throw new Error('userWaiting must be a boolean.');
    output.userWaiting = input.userWaiting;
  }
  if (Object.hasOwn(input, 'metadata')) {
    if (!isRecord(input.metadata)) throw new Error('metadata must be an object.');
    output.metadata = cloneRecord(input.metadata);
  }
  if (Object.hasOwn(input, 'world')) {
    output.world = normalizeCollectionSection(input.world, [
      'observations', 'retrievedClaims', 'inferences', 'hypotheses', 'unknowns', 'modelUncertainty',
    ], 'world');
  }
  if (Object.hasOwn(input, 'execution')) {
    output.execution = normalizeCollectionSection(input.execution, [
      'executorJobs', 'userFacingJobs', 'implementationSteps', 'approvedSideEffects', 'progress', 'verification', 'rollback',
    ], 'execution');
  }
  if (Object.hasOwn(input, 'temporal')) {
    output.temporal = normalizeCollectionSection(input.temporal, [
      'notes', 'heartbeatBindings', 'futureTriggers', 'planningSessions', 'expectedEvidence',
    ], 'temporal');
  }
  if (Object.hasOwn(input, 'learning')) {
    output.learning = normalizeCollectionSection(input.learning, [
      'predictedOutcomes', 'observedOutcomes', 'causalInterpretations', 'confidenceUpdates', 'memoryChanges',
    ], 'learning');
  }
  if (Object.hasOwn(input, 'deliberation')) {
    if (!isRecord(input.deliberation)) throw new Error('deliberation must be an object.');
    const deliberation: Record<string, unknown> = {};
    const allowedDeliberation = new Set([
      'robustActions', 'informationRequests', 'creativeSearchBudget', 'stoppingCondition',
    ]);
    for (const key of Object.keys(input.deliberation)) {
      if (!allowedDeliberation.has(key)) throw new Error(`Unsupported deliberation field "${key}".`);
    }
    for (const field of ['robustActions', 'informationRequests'] as const) {
      if (Object.hasOwn(input.deliberation, field)) {
        const entries = input.deliberation[field];
        if (!Array.isArray(entries)) throw new Error(`deliberation.${field} must be an array.`);
        deliberation[field] = normalizeEntries(entries as EntryInput[]);
      }
    }
    for (const field of ['creativeSearchBudget', 'stoppingCondition'] as const) {
      if (Object.hasOwn(input.deliberation, field)) {
        deliberation[field] = optionalString(input.deliberation[field], `deliberation.${field}`);
      }
    }
    output.deliberation = deliberation;
  }
  return output;
}

function normalizeNodePatch(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'label',
    'purpose',
    'parentConstraint',
    'horizon',
    'successCondition',
    ...NODE_COLLECTION_FIELDS,
    'metadata',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`decision.nodes.patch cannot change ${key}.`);
  }
  const output: Record<string, unknown> = {};
  if (Object.hasOwn(input, 'label')) output.label = cleanString(input.label, 'node label');
  if (Object.hasOwn(input, 'purpose')) output.purpose = cleanString(input.purpose, 'node purpose');
  for (const field of ['parentConstraint', 'horizon', 'successCondition'] as const) {
    if (Object.hasOwn(input, field)) output[field] = optionalString(input[field], `node.${field}`);
  }
  for (const field of NODE_COLLECTION_FIELDS) {
    if (Object.hasOwn(input, field)) {
      const entries = input[field];
      if (!Array.isArray(entries)) throw new Error(`node.${field} must be an array.`);
      output[field] = normalizeEntries(entries as EntryInput[]);
    }
  }
  if (Object.hasOwn(input, 'metadata')) {
    if (!isRecord(input.metadata)) throw new Error('node.metadata must be an object.');
    output.metadata = cloneRecord(input.metadata);
  }
  return output;
}

function assertStatus(value: unknown): asserts value is DecisionStatus {
  if (!['active', 'resolved', 'archived'].includes(String(value))) {
    throw new Error('status must be active, resolved, or archived.');
  }
}

export async function create(input: CreateDecisionInput): Promise<DecisionWorkspace> {
  if (!isRecord(input)) throw new Error('decision.create(input) requires an object.');
  if (!isRecord(input.root)) throw new Error('decision.create(input) requires root: { purpose }.');
  const title = cleanString(input.title, 'title');
  const root = makeNode({
    id: 'root',
    label: input.root.label || 'Root outcome',
    purpose: input.root.purpose,
    horizon: input.root.horizon,
    successCondition: input.root.successCondition,
    invariants: input.root.invariants,
    values: input.root.values,
    metadata: input.root.metadata,
  });
  const now = new Date().toISOString();
  const id = `${slug(title)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const workspace: DecisionWorkspace = {
    schemaVersion: 2,
    id,
    title,
    status: 'active',
    ...(input.trigger?.trim() ? { trigger: input.trigger.trim() } : {}),
    modes: uniqueStrings(input.modes),
    ...(typeof input.userWaiting === 'boolean' ? { userWaiting: input.userWaiting } : {}),
    ...(input.timeSensitivity?.trim() ? { timeSensitivity: input.timeSensitivity.trim() } : {}),
    constitutionalDomains: uniqueStrings(input.constitutionalDomains),
    observationChannels: uniqueStrings(input.observationChannels),
    ...(input.capabilityMapStatus?.trim() ? { capabilityMapStatus: input.capabilityMapStatus.trim() } : {}),
    rootNodeId: root.id,
    activeNodeId: root.id,
    nodes: [root],
    metadata: cloneRecord(input.metadata),
    ...emptyCollections(),
    createdAt: now,
    updatedAt: now,
  };
  await writeWorkspace(workspace);
  return structuredClone(workspace);
}

export async function get(decisionId: string): Promise<DecisionWorkspace> {
  return structuredClone(await readWorkspace(decisionId));
}

export async function list(options: { status?: DecisionStatus } = {}) {
  if (options.status !== undefined) assertStatus(options.status);
  const directory = storeDirectory();
  let filenames: string[];
  try {
    filenames = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const workspaces = await Promise.all(filenames.map(async (filename) => {
    const id = filename.slice(0, -5);
    try {
      return await readWorkspace(id);
    } catch {
      return null;
    }
  }));
  return workspaces
    .filter((workspace): workspace is DecisionWorkspace => Boolean(workspace))
    .filter((workspace) => !options.status || workspace.status === options.status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      status: workspace.status,
      modes: workspace.modes,
      nodeCount: workspace.nodes.length,
      resolvedNodeCount: workspace.nodes.filter((node) => Boolean(node.resolution)).length,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    }));
}

export async function summary(decisionId: string) {
  const workspace = await readWorkspace(decisionId);
  const depthOf = (node: DecisionNode): number => {
    let depth = 0;
    let current = node;
    const visited = new Set<string>();
    while (current.parentId) {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      const parent = workspace.nodes.find((candidate) => candidate.id === current.parentId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  };
  return {
    id: workspace.id,
    title: workspace.title,
    status: workspace.status,
    modes: workspace.modes,
    userWaiting: workspace.userWaiting,
    timeSensitivity: workspace.timeSensitivity,
    activeNodeId: workspace.activeNodeId,
    stoppingCondition: workspace.deliberation.stoppingCondition,
    world: Object.fromEntries(Object.entries(workspace.world).map(([key, value]) => [key, value.length])),
    execution: {
      executorJobs: workspace.execution.executorJobs.length,
      userFacingJobs: workspace.execution.userFacingJobs.length,
      progress: workspace.execution.progress.slice(-5),
      verification: workspace.execution.verification.slice(-5),
    },
    temporal: {
      futureTriggers: workspace.temporal.futureTriggers,
      expectedEvidence: workspace.temporal.expectedEvidence,
    },
    nodes: workspace.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      depth: depthOf(node),
      label: node.label,
      purpose: node.purpose,
      uncertaintyCount: node.uncertainty.length,
      optionCount: node.options.length,
      resolution: node.resolution,
    })),
    updatedAt: workspace.updatedAt,
  };
}

export async function patch(decisionId: string, input: Record<string, unknown>): Promise<DecisionWorkspace> {
  if (!isRecord(input)) throw new Error('decision.patch requires a patch object.');
  const normalized = normalizeWorkspacePatch(input);
  return mutate(decisionId, (workspace) => {
    deepMerge(workspace as unknown as Record<string, unknown>, normalized);
    return workspace;
  });
}

export async function append(
  decisionId: string,
  collectionPath: WorkspaceCollectionPath,
  entries: EntryInput[] | EntryInput,
): Promise<DecisionWorkspace> {
  const segments = WORKSPACE_COLLECTION_PATHS[collectionPath];
  if (!segments) {
    throw new Error(`Unsupported decision collection path "${String(collectionPath)}".`);
  }
  const additions = normalizeEntries(entries);
  return mutate(decisionId, (workspace) => {
    const section = (workspace as unknown as Record<string, any>)[segments[0]];
    const collection = section?.[segments[1]];
    if (!Array.isArray(collection)) throw new Error(`Decision collection "${collectionPath}" is unavailable.`);
    collection.push(...additions);
    return workspace;
  });
}

async function addNode(decisionId: string, input: AddNodeInput): Promise<DecisionNode> {
  if (!isRecord(input)) throw new Error('decision.nodes.add requires an input object.');
  const parentId = assertId(input.parentId, 'parentId');
  return mutate(decisionId, (workspace) => {
    const parent = findNode(workspace, parentId);
    if (!parent.resolution) {
      throw new Error(`Cannot add a child to unresolved node "${parentId}". Resolve the parent direction first.`);
    }
    const node = makeNode({
      ...input,
      parentId,
      parentConstraint: input.parentConstraint || parent.resolution.direction,
    });
    if (node.evaluatedPlans.length > 0 && node.options.length === 0) {
      throw new Error('Evaluated plans require generated options first.');
    }
    if (workspace.nodes.some((candidate) => candidate.id === node.id)) {
      throw new Error(`Node "${node.id}" already exists.`);
    }
    workspace.nodes.push(node);
    return node;
  });
}

async function focusNode(decisionId: string, nodeId: string): Promise<DecisionWorkspace> {
  const normalizedNodeId = assertId(nodeId, 'nodeId');
  return mutate(decisionId, (workspace) => {
    findNode(workspace, normalizedNodeId);
    workspace.activeNodeId = normalizedNodeId;
    return workspace;
  });
}

async function patchNode(
  decisionId: string,
  nodeId: string,
  input: Record<string, unknown>,
): Promise<DecisionNode> {
  if (!isRecord(input)) throw new Error('decision.nodes.patch requires a patch object.');
  const normalized = normalizeNodePatch(input);
  return mutate(decisionId, (workspace) => {
    const node = findNode(workspace, nodeId);
    deepMerge(node as unknown as Record<string, unknown>, normalized);
    node.updatedAt = new Date().toISOString();
    return node;
  });
}

async function appendNode(
  decisionId: string,
  nodeId: string,
  field: NodeCollectionField,
  entries: EntryInput[] | EntryInput,
): Promise<DecisionNode> {
  if (!NODE_COLLECTION_FIELDS.includes(field)) {
    throw new Error(`Unsupported node collection "${String(field)}".`);
  }
  const additions = normalizeEntries(entries);
  return mutate(decisionId, (workspace) => {
    const node = findNode(workspace, nodeId);
    if (field === 'evaluatedPlans' && node.options.length === 0) {
      throw new Error('Evaluated plans require generated options first.');
    }
    node[field].push(...additions);
    node.updatedAt = new Date().toISOString();
    return node;
  });
}

async function addOptions(
  decisionId: string,
  nodeId: string,
  options: EntryInput[] | EntryInput,
): Promise<DecisionNode> {
  return appendNode(decisionId, nodeId, 'options', options);
}

async function resolveNode(
  decisionId: string,
  nodeId: string,
  input: Omit<DecisionResolution, 'resolvedAt'> & { resolvedAt?: string },
): Promise<DecisionNode> {
  if (!isRecord(input)) throw new Error('decision.nodes.resolve requires a resolution object.');
  const direction = cleanString(input.direction, 'resolution.direction');
  const rationale = cleanString(input.rationale, 'resolution.rationale');
  return mutate(decisionId, (workspace) => {
    const node = findNode(workspace, nodeId);
    const children = workspace.nodes.filter((candidate) => candidate.parentId === node.id);
    if (node.resolution && node.resolution.direction !== direction && children.length > 0) {
      throw new Error('Cannot change a resolved parent direction while dependent children exist. Reopen the node and remove its descendants first.');
    }
    node.resolution = {
      ...structuredClone(input),
      direction,
      rationale,
      resolvedAt: typeof input.resolvedAt === 'string' && input.resolvedAt.trim()
        ? input.resolvedAt
        : new Date().toISOString(),
    };
    node.updatedAt = new Date().toISOString();
    return node;
  });
}

async function reopenNode(
  decisionId: string,
  nodeId: string,
  input: { reason: string; removeDescendants?: boolean },
): Promise<DecisionNode> {
  const normalizedNodeId = assertId(nodeId, 'nodeId');
  if (!isRecord(input)) throw new Error('decision.nodes.reopen requires { reason, removeDescendants? }.');
  const reason = cleanString(input.reason, 'reason');
  return mutate(decisionId, (workspace) => {
    const node = findNode(workspace, normalizedNodeId);
    const descendants = new Set<string>();
    let frontier = [node.id];
    while (frontier.length > 0) {
      const parents = new Set(frontier);
      frontier = workspace.nodes.filter((candidate) => candidate.parentId && parents.has(candidate.parentId)).map((candidate) => candidate.id);
      for (const descendant of frontier) descendants.add(descendant);
    }
    if (descendants.size > 0 && !input.removeDescendants) {
      throw new Error('Reopening this node invalidates dependent children; pass removeDescendants: true.');
    }
    workspace.nodes = workspace.nodes.filter((candidate) => !descendants.has(candidate.id));
    delete node.resolution;
    node.metadata = {
      ...node.metadata,
      reopenedAt: new Date().toISOString(),
      reopenReason: reason,
    };
    node.updatedAt = new Date().toISOString();
    workspace.activeNodeId = node.id;
    return node;
  });
}

async function removeNode(
  decisionId: string,
  nodeId: string,
  options: { recursive?: boolean } = {},
): Promise<DecisionWorkspace> {
  const normalizedNodeId = assertId(nodeId, 'nodeId');
  return mutate(decisionId, (workspace) => {
    if (normalizedNodeId === workspace.rootNodeId) throw new Error('The root node cannot be removed.');
    findNode(workspace, normalizedNodeId);
    const descendants = new Set<string>([normalizedNodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of workspace.nodes) {
        if (node.parentId && descendants.has(node.parentId) && !descendants.has(node.id)) {
          descendants.add(node.id);
          changed = true;
        }
      }
    }
    if (descendants.size > 1 && !options.recursive) {
      throw new Error(`Node "${normalizedNodeId}" has children; pass { recursive: true } to remove its branch.`);
    }
    workspace.nodes = workspace.nodes.filter((node) => !descendants.has(node.id));
    if (descendants.has(workspace.activeNodeId)) {
      workspace.activeNodeId = workspace.rootNodeId;
    }
    return workspace;
  });
}

function stringList(input: Record<string, unknown>, field: string, required = false): string[] {
  const values = uniqueStrings(input[field]);
  if (required && values.length === 0) throw new Error(`${field} requires at least one string.`);
  return values;
}

function lines(label: string, values: string[]): string[] {
  return [label, ...(values.length > 0 ? values.map((value) => `- ${value}`) : ['- none'])];
}

function entryLines(label: string, entries: DecisionEntry[], limit = 6): string[] {
  const visible = entries.slice(-limit).map((entry) => entry.text);
  return lines(label, visible);
}

export async function trace(decisionId: string): Promise<string> {
  const workspace = await readWorkspace(decisionId);
  const active = findNode(workspace, workspace.activeNodeId || workspace.rootNodeId);
  const children = workspace.nodes.filter((node) => node.parentId === active.id);
  const resolution = active.resolution;
  const reconsider = resolution?.reconsiderWhen
    ? (Array.isArray(resolution.reconsiderWhen) ? resolution.reconsiderWhen : [resolution.reconsiderWhen])
    : [];

  return [
    'MODE',
    workspace.modes.join(' + ') || 'unspecified',
    '',
    'ROOT QUESTION',
    findNode(workspace, workspace.rootNodeId).purpose,
    '',
    'CURRENT NODE',
    `${active.label}: ${active.purpose}`,
    '',
    'PARENT CONSTRAINT',
    active.parentConstraint || 'none (root)',
    '',
    ...entryLines('OBSERVATIONS', workspace.world.observations),
    '',
    ...entryLines('RETRIEVED CLAIMS', workspace.world.retrievedClaims),
    '',
    ...entryLines('HYPOTHESES / UNKNOWNS', [...workspace.world.hypotheses, ...workspace.world.unknowns]),
    '',
    ...entryLines('MODEL UNCERTAINTY', workspace.world.modelUncertainty),
    '',
    'DELIBERATION CONTROL',
    `- robust provisional actions: ${workspace.deliberation.robustActions.map((entry) => entry.text).join('; ') || 'none'}`,
    `- information request: ${workspace.deliberation.informationRequests.slice(-1)[0]?.text || 'none'}`,
    `- stopping condition: ${workspace.deliberation.stoppingCondition || 'not recorded'}`,
    '',
    'NODE RESOLUTION',
    resolution ? `${resolution.direction} — ${resolution.rationale}` : 'unresolved',
    '',
    'CHILDREN',
    ...(children.length > 0 ? children.map((node) => `- ${node.label}: ${node.purpose}`) : ['- none']),
    '',
    ...entryLines('DELEGATED JOBS', [...workspace.execution.executorJobs, ...workspace.execution.userFacingJobs]),
    '',
    ...lines('RECONSIDERATION CONDITIONS', reconsider),
  ].join('\n');
}

export async function finish(decisionId: string, input: { outcome: string }): Promise<DecisionWorkspace> {
  if (!isRecord(input)) throw new Error('decision.finish requires { outcome }.');
  const outcome = cleanString(input.outcome, 'outcome');
  return mutate(decisionId, (workspace) => {
    const unresolved = workspace.nodes.filter((node) => !node.resolution);
    if (unresolved.length > 0) {
      throw new Error(`Cannot finish while nodes are unresolved: ${unresolved.map((node) => node.label).join(', ')}.`);
    }
    const expectsFutureEvidence = workspace.temporal.expectedEvidence.length > 0;
    const hasContinuation = workspace.temporal.futureTriggers.length > 0
      || workspace.temporal.planningSessions.length > 0
      || workspace.temporal.heartbeatBindings.length > 0;
    if (expectsFutureEvidence && !hasContinuation) {
      throw new Error('Cannot finish: expected future evidence has no real trigger, planning session, or verified heartbeat binding.');
    }
    workspace.status = 'resolved';
    workspace.finalOutcome = outcome;
    return workspace;
  });
}

async function prepareUserFacingRequest(
  decisionIdOrInput: string | Record<string, unknown>,
  maybeInput?: Record<string, unknown>,
) {
  const persistent = typeof decisionIdOrInput === 'string';
  const decisionId = persistent ? decisionIdOrInput : undefined;
  const input = persistent ? maybeInput : decisionIdOrInput;
  if (!isRecord(input)) throw new Error('decision.requests.userFacing requires an object.');
  if (['draft', 'reply', 'finalMessage'].some((field) => typeof input[field] === 'string' && input[field].trim())) {
    throw new Error('The user-facing request describes context and outcomes, not root-written reply prose.');
  }

  const workspace = persistent ? await readWorkspace(decisionId!) : undefined;
  const nodeId = persistent
    ? (typeof input.nodeId === 'string' && input.nodeId.trim()
      ? assertId(input.nodeId, 'nodeId')
      : workspace!.activeNodeId || workspace!.rootNodeId)
    : undefined;
  const requestId = newId('user-facing');
  const firstText = (...values: unknown[]): string => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const userMessage = firstText(
    input.userMessage,
    input.message,
    input.originalMessage,
    workspace?.trigger,
  ) || '(No verbatim user message was supplied. Do not invent or quote one.)';
  const naturalInstruction = firstText(input.systemMessage, input.instruction);
  const desiredOutcome = firstText(input.desiredOutcome, naturalInstruction)
    || 'Respond to what the user actually said, using the grounded context supplied.';
  const legacyList = (field: string): string => stringList(input, field).join('; ');

  // Primary contract: the speaking agent receives the user's actual words and
  // one natural instruction from root. A prose instruction preserves intent
  // without stylistically priming the response with generated checklists.
  // Old structured inputs are accepted, then flattened into the same single
  // prose message. Compatibility must not resurrect the form-completion prompt.
  const systemMessage = naturalInstruction || [
    firstText(input.situation) || workspace?.title || 'Use the user message and available grounded context.',
    `The communication should accomplish this: ${desiredOutcome}`,
    legacyList('userShouldUnderstand') && `The user should come away understanding ${legacyList('userShouldUnderstand')}.`,
    legacyList('stateToCreate') && `The intended human state is ${legacyList('stateToCreate')}.`,
    legacyList('evidence') && `Ground this in ${legacyList('evidence')}.`,
    legacyList('uncertainty') && `Keep this uncertainty honest: ${legacyList('uncertainty')}.`,
    legacyList('prohibitedClaims') && `Do not claim or imply ${legacyList('prohibitedClaims')}.`,
    legacyList('easierAction') && `Make this easier to do: ${legacyList('easierAction')}.`,
    firstText(input.toneTiming) && `Use this timing and degree of detail: ${firstText(input.toneTiming)}.`,
    legacyList('misinterpretations') && `Avoid leaving the impression that ${legacyList('misinterpretations')}.`,
    firstText(input.exactWording) && `Use this exact externally constrained wording where required: ${firstText(input.exactWording)}.`,
    'Use your own established voice. Do not invent evidence or expose internal reasoning.',
  ].filter(Boolean).join(' ');
  const payload = `!24311!USER:\n${userMessage}\n\n!24311!SYSTEM:\n${systemMessage}`;

  if (!persistent) {
    return { requestId, agent: 'user-facing' as const, payload, persistent: false };
  }

  return mutate(decisionId!, (workspace) => {
    const node = findNode(workspace, nodeId!);
    workspace.activeNodeId = nodeId!;
    workspace.execution.userFacingJobs.push(normalizeEntry({
      text: naturalInstruction
        ? `Prepared natural communication instruction for ${node.label}`
        : `Prepared legacy communication brief for ${node.label}`,
      requestId,
      nodeId: nodeId!,
      desiredOutcome,
      status: 'prepared',
    }));
    return { requestId, agent: 'user-facing' as const, payload };
  });
}

async function completeRequest(
  decisionId: string,
  requestId: string,
  input: { status: 'completed' | 'delivered' | 'failed'; summary: string; evidence?: EntryInput[] },
): Promise<DecisionWorkspace> {
  const normalizedRequestId = assertId(requestId, 'requestId');
  if (!isRecord(input) || !['completed', 'delivered', 'failed'].includes(String(input.status))) {
    throw new Error('decision.requests.complete requires status completed, delivered, or failed and a summary.');
  }
  const summaryText = cleanString(input.summary, 'summary');
  return mutate(decisionId, (workspace) => {
    const entry = [...workspace.execution.executorJobs, ...workspace.execution.userFacingJobs]
      .find((candidate) => candidate.requestId === normalizedRequestId);
    if (!entry) throw new Error(`Request "${normalizedRequestId}" does not exist.`);
    entry.status = input.status;
    entry.completedAt = new Date().toISOString();
    entry.summary = summaryText;
    if (input.evidence) workspace.execution.verification.push(...normalizeEntries(input.evidence));
    return workspace;
  });
}

export const requests = {
  userFacing: prepareUserFacingRequest,
  complete: completeRequest,
};

export const nodes = {
  add: addNode,
  focus: focusNode,
  patch: patchNode,
  append: appendNode,
  addOptions,
  resolve: resolveNode,
  reopen: reopenNode,
  remove: removeNode,
};

export const __internals = {
  storeDirectory,
  normalizeEntry,
  normalizeEntries,
  deepMerge,
  normalizeWorkspacePatch,
  normalizeNodePatch,
};
