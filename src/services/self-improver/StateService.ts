import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryService, type MemoryRuntimeConfig } from '../../memory_system/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_STATE_DIR = path.join(PROJECT_ROOT, 'data', 'self-improver');

const INSIGHT_KINDS = ['principle', 'preference', 'constraint', 'system_fact', 'lesson'] as const;
const INITIATIVE_STATUSES = ['proposed', 'approved', 'in_progress', 'blocked', 'done', 'rejected'] as const;
const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'not_required'] as const;
const AUDIT_MODES = ['manual', 'daily'] as const;
const SELF_IMPROVER_MODES = ['explicit-task', 'audit'] as const;
const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const TEST_RESULT_STATUSES = ['planned', 'passed', 'failed', 'skipped'] as const;
const RETRIEVAL_SOURCES = ['dossier', 'memory'] as const;
const ALIGNMENT_DIMENSION_KEYS = [
    'telos-mission',
    'quality-execution',
    'retrieval-awareness',
    'hidden-misalignment',
    'approval-trajectory',
] as const;

export type InsightKind = (typeof INSIGHT_KINDS)[number];
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];
export type InitiativeOrigin = 'user' | 'self';
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export type AuditMode = (typeof AUDIT_MODES)[number];
export type SelfImproverMode = (typeof SELF_IMPROVER_MODES)[number];
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export type TestResultStatus = (typeof TEST_RESULT_STATUSES)[number];
export type RetrievalSource = (typeof RETRIEVAL_SOURCES)[number];
export type AlignmentDimensionKey = (typeof ALIGNMENT_DIMENSION_KEYS)[number];

export interface ImprovementSyncOutcome {
    target: 'memory';
    status: 'synced' | 'skipped' | 'failed';
    detail: string;
    id?: string;
}

export interface ImprovementThreadRef {
    name: string;
    phase: string;
    summary: string;
    workingDirectory: string;
    model: string;
    modelReasoningEffort: CodexReasoningEffort;
    threadId?: string;
    sdkThreadId?: string;
    status?: 'planned' | 'running' | 'completed' | 'failed';
    linkedAt: string;
}

export interface ImprovementTestResult {
    name: string;
    status: TestResultStatus;
    details?: string;
    recordedAt: string;
}

export interface ImprovementApproval {
    required: boolean;
    state: ApprovalState;
    note?: string;
    approvedAt?: string;
    approvedBy?: string;
}

export interface ImprovementInsightRecord {
    id: string;
    title: string;
    kind: InsightKind;
    content: string;
    examples: string[];
    topics: string[];
    confidence: number;
    source: string;
    createdAt: string;
    updatedAt: string;
}

export interface ImprovementInitiativeRecord {
    id: string;
    title: string;
    summary: string;
    origin: InitiativeOrigin;
    mode: SelfImproverMode;
    status: InitiativeStatus;
    rationale: string;
    impact: string;
    approval: ImprovementApproval;
    blockers: string[];
    testResults: ImprovementTestResult[];
    codexThreads: ImprovementThreadRef[];
    finalOutcome?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ImprovementAuditRecord {
    id: string;
    title: string;
    mode: AuditMode;
    summary: string;
    findings: string[];
    proposedInitiativeIds: string[];
    relatedInitiativeIds: string[];
    triggeredBy: string;
    createdAt: string;
    updatedAt: string;
}

export interface ImprovementDossierSummary {
    overview: string;
    principles: string[];
    preferences: string[];
    constraints: string[];
    systemFacts: string[];
    lessons: string[];
}

export interface ImprovementRetrievalQuery {
    source: RetrievalSource;
    query: string;
    rationale: string;
}

export interface ImprovementRetrievalSourceSummary {
    source: RetrievalSource;
    summary: string;
    keyTopics: string[];
    awarenessTitles: string[];
    recommendedQueries: string[];
}

export interface ImprovementRetrievalAwarenessManifest {
    generatedAt: string;
    overview: string;
    canonicalTopics: string[];
    hiddenMisalignmentWatchpoints: string[];
    bootSequence: string[];
    sources: ImprovementRetrievalSourceSummary[];
    bootQueries: ImprovementRetrievalQuery[];
}

export interface ImprovementAlignmentDimensionScore {
    key: AlignmentDimensionKey;
    label: string;
    score: number;
    rationale: string;
    evidence: string[];
}

export interface ImprovementAlignmentAssessmentRecord {
    id: string;
    title: string;
    source: string;
    summary: string;
    dimensions: ImprovementAlignmentDimensionScore[];
    overallScore: number;
    driftFromPrevious?: number;
    createdAt: string;
    updatedAt: string;
}

export interface ImprovementAlignmentSnapshot {
    current: ImprovementAlignmentAssessmentRecord | null;
    history: ImprovementAlignmentAssessmentRecord[];
    latestDrift: number | null;
    driftStatus: 'unknown' | 'stable' | 'improving' | 'drifting';
    visibleGaps: string[];
}

export interface ImprovementStatePaths {
    stateDir: string;
    insightsFile: string;
    initiativesFile: string;
    auditsFile: string;
    alignmentAssessmentsFile: string;
    stateFile: string;
    visionDossierFile: string;
    backlogFile: string;
    auditLogFile: string;
    stateSummaryFile: string;
    retrievalAwarenessFile: string;
    alignmentScorecardFile: string;
}

export interface ImprovementStateSnapshot {
    generatedAt: string;
    dossierSummary: ImprovementDossierSummary;
    retrievalAwareness: ImprovementRetrievalAwarenessManifest;
    alignment: ImprovementAlignmentSnapshot;
    backlogItems: ImprovementInitiativeRecord[];
    initiatives: ImprovementInitiativeRecord[];
    recentAudits: ImprovementAuditRecord[];
    pendingApprovals: ImprovementInitiativeRecord[];
    linkedCodexThreadRefs: ImprovementThreadRef[];
    paths: ImprovementStatePaths;
}

export interface ImprovementInsightInput {
    id?: string;
    title?: string;
    kind: InsightKind;
    content: string;
    examples?: string[];
    topics?: string[];
    confidence?: number;
    source?: string;
    syncMemory?: boolean;
}

export interface ImprovementInsightResult {
    insight: ImprovementInsightRecord;
    sync: ImprovementSyncOutcome[];
}

export interface ImprovementInitiativeInput {
    id?: string;
    title: string;
    summary: string;
    origin: InitiativeOrigin;
    mode?: SelfImproverMode;
    rationale: string;
    impact: string;
    requiresApproval?: boolean;
    approvalNote?: string;
    status?: InitiativeStatus;
    blockers?: string[];
    testResults?: ImprovementTestResult[];
    codexThreads?: ImprovementThreadRef[];
    finalOutcome?: string;
}

export interface ImprovementInitiativePatch {
    title?: string;
    summary?: string;
    mode?: SelfImproverMode;
    status?: InitiativeStatus;
    rationale?: string;
    impact?: string;
    approval?: Partial<ImprovementApproval>;
    blockers?: string[];
    appendBlockers?: string[];
    testResults?: ImprovementTestResult[];
    appendTestResults?: ImprovementTestResult[];
    codexThreads?: ImprovementThreadRef[];
    appendCodexThreads?: ImprovementThreadRef[];
    finalOutcome?: string;
}

export interface ImprovementAuditInput {
    id?: string;
    title?: string;
    mode: AuditMode;
    summary: string;
    findings?: string[];
    proposedInitiativeIds?: string[];
    relatedInitiativeIds?: string[];
    triggeredBy?: string;
}

export interface ImprovementAlignmentAssessmentInput {
    id?: string;
    title?: string;
    source?: string;
    summary: string;
    dimensions: Array<{
        key: AlignmentDimensionKey;
        label?: string;
        score: number;
        rationale: string;
        evidence?: string[];
    }>;
}

interface StateData {
    insights: ImprovementInsightRecord[];
    initiatives: ImprovementInitiativeRecord[];
    audits: ImprovementAuditRecord[];
    alignmentAssessments: ImprovementAlignmentAssessmentRecord[];
}

interface SelfImproverStateServiceOptions {
    projectRoot?: string;
    stateDir?: string;
    defaultMemoryConfig?: Partial<MemoryRuntimeConfig>;
    now?: () => Date;
}

const DEFAULT_DOSSIER_OVERVIEW =
    'The Vision dossier is the human-readable canon for self-improver behavior. Structured JSON files are the execution-layer source of truth.';
const DEFAULT_CODEX_THREAD_PREFIX = 'SI::';
const DEFAULT_CODEX_WORKING_DIRECTORY = './';
const ALIGNMENT_DIMENSION_LABELS: Record<AlignmentDimensionKey, string> = {
    'telos-mission': 'TELOS Mission Fit',
    'quality-execution': 'Quality And Near-Zero-Error Execution',
    'retrieval-awareness': 'Retrieval Awareness',
    'hidden-misalignment': 'Resistance To Hidden Misalignment',
    'approval-trajectory': 'Approval Discipline And Autonomy Trajectory',
};

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return value.trim();
}

function ensureArrayValue<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
        throw new Error(`${field} must be one of: ${(allowed as readonly string[]).join(', ')}.`);
    }
    return value as T[number];
}

function clampConfidence(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(1, value));
}

function ensureUnitScore(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${field} must be a finite number in range [0,1].`);
    }
    if (value < 0 || value > 1) {
        throw new Error(`${field} must be in range [0,1].`);
    }
    return roundTo(value, 3);
}

function normalizeStringArray(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    const unique = new Set<string>();
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (trimmed) {
            unique.add(trimmed);
        }
    }
    return Array.from(unique);
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 60) || 'item';
}

function buildInsightTitle(content: string): string {
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim() || '';
    return (firstLine || content.trim()).slice(0, 80);
}

function markdownEscapeInline(value: string): string {
    return value.replace(/\|/g, '\\|');
}

function sortByUpdatedDesc<T extends { updatedAt: string }>(items: T[]): T[] {
    return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundTo(value: number, digits = 2): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function mergeUniqueStrings(...groups: string[][]): string[] {
    const unique = new Set<string>();
    for (const group of groups) {
        for (const value of group) {
            const trimmed = String(value || '').trim();
            if (trimmed) {
                unique.add(trimmed);
            }
        }
    }
    return Array.from(unique);
}

function dedupeThreads(threads: ImprovementThreadRef[]): ImprovementThreadRef[] {
    const seen = new Set<string>();
    const result: ImprovementThreadRef[] = [];

    for (const thread of threads) {
        const key = `${thread.threadId || ''}::${thread.sdkThreadId || ''}::${thread.name}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(thread);
    }

    return result;
}

function buildBootstrapInsights(now: string): ImprovementInsightRecord[] {
    const definitions: Array<Omit<ImprovementInsightRecord, 'createdAt' | 'updatedAt'>> = [
        {
            id: 'si-insight-code-as-action',
            title: 'Code As Action',
            kind: 'principle',
            content:
                'TELOS treats code execution as the primary action surface. Tools should stay library-like and emergent instead of hard-coding brittle RPC wrappers.',
            examples: ['How should TELOS actions work?', 'What is the main execution philosophy?', 'Why use TypeScript tools like libraries?'],
            topics: ['telos', 'architecture', 'tools', 'emergence'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-emergence-over-workarounds',
            title: 'Emergence Over Workarounds',
            kind: 'principle',
            content:
                'Prefer elegant, general systems that improve as models improve. Do not build around temporary model weaknesses with fragile one-off workarounds.',
            examples: ['How should limitations be handled?', 'What makes an TELOS design good?', 'Should the framework overfit weak models?'],
            topics: ['telos', 'architecture', 'emergence'],
            confidence: 0.98,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-telos-quality-first-harness',
            title: 'TELOS Quality-First Harness',
            kind: 'system_fact',
            content:
                'TELOS is meant to become a highly capable, quality-first agentic harness for essentially any future task the user may have, not merely a narrow assistant shell.',
            examples: ['What is TELOS trying to become?', 'What is the primary TELOS goal?', 'Why does self-improver matter?'],
            topics: ['telos', 'mission', 'future-tasks', 'quality'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-quality-near-zero-error',
            title: 'Quality And Near-Zero-Error Execution',
            kind: 'preference',
            content:
                'Quality is a first-class objective. TELOS should execute with as few mistakes as possible in tools, commands, and end-to-end behavior rather than maximizing capability breadth at the expense of reliability.',
            examples: ['What outranks feature sprawl?', 'How important is execution quality?', 'Should TELOS optimize for near-zero errors?'],
            topics: ['quality', 'execution', 'reliability'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-typescript-with-libraries',
            title: 'TypeScript With Libraries',
            kind: 'preference',
            content:
                'TypeScript is currently preferred because it is familiar, expressive, and rich in libraries. Library access is a major multiplier for emergent capability.',
            examples: ['Why TypeScript?', 'Which language should TELOS favor now?', 'What increases emergent capability?'],
            topics: ['typescript', 'libraries', 'tooling'],
            confidence: 0.97,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-browser-dom-first',
            title: 'Browser DOM And JavaScript First',
            kind: 'principle',
            content:
                'Browser operation should lean on simplified HTML and executable JavaScript instead of image-only coordinate clicking. The goal is browser control that rides coding-model improvements.',
            examples: ['How should browser automation work?', 'Why not rely only on screenshots?', 'What is the browser philosophy?'],
            topics: ['browser', 'dom', 'javascript'],
            confidence: 0.98,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-two-modes-only',
            title: 'Two Modes Only',
            kind: 'constraint',
            content:
                'The self-improver operates in only two modes: explicit-task and audit. Audit may inspect and propose, but must not mutate the repo for self-originated ideas.',
            examples: ['What modes does self-improver have?', 'What is audit mode?', 'When may the agent execute changes?'],
            topics: ['self-improver', 'modes', 'approval'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-unified-memory-required',
            title: 'Continuous Use Of Unified Memory',
            kind: 'constraint',
            content:
                'The self-improver must continuously use the unified memory system. New user vision, preference, or reusable implementation guidance must be persisted immediately.',
            examples: ['Should memory be optional?', 'How does the agent remember vision?', 'What happens after learning a new preference?'],
            topics: ['memory', 'vision', 'retrieval'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-retrieval-awareness',
            title: 'Retrieval Systems Must Be Aware Of What They Contain',
            kind: 'principle',
            content:
                'Memory should not rely only on a model guessing the perfect semantic query. Retrieval layers should expose what knowledge exists so the self-improver can probe them deliberately, especially for niche edge cases and deeply important guidance.',
            examples: ['How should retrieval work?', 'Why is retrieval awareness important?', 'How does memory avoid hidden knowledge?'],
            topics: ['retrieval', 'memory', 'awareness'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-approval-before-mutation',
            title: 'Approval Before Self-Originated Mutation',
            kind: 'constraint',
            content:
                'Any self-originated feature idea, architecture proposal, or improvement concept requires explicit user approval before mutating the repository.',
            examples: ['Can the agent implement its own idea directly?', 'When is approval mandatory?', 'How should new ideas be handled?'],
            topics: ['approval', 'safety', 'product'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-hidden-misalignment',
            title: 'Hidden Misalignment Is The Worst Failure Mode',
            kind: 'lesson',
            content:
                'The most dangerous self-improver failure is hidden misalignment: appearing aligned while quietly drifting toward generic defaults, poor execution quality, or goals that are not maximally in the user interest.',
            examples: ['What is the worst self-improver failure mode?', 'Why is hidden misalignment dangerous?', 'What kind of drift matters most?'],
            topics: ['alignment', 'misalignment', 'drift', 'safety'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-approval-dependence-trajectory',
            title: 'Approval Dependence Should Decrease As Alignment Approaches Identity',
            kind: 'constraint',
            content:
                'Current approval rules stay in force, but the long-term target is a self-improver whose vision is so close to the user that explicit approval dependence can decrease because alignment is approaching identity rather than mere obedience.',
            examples: ['Will approval always stay equally strict?', 'What is the long-term autonomy target?', 'How should autonomy evolve with alignment?'],
            topics: ['approval', 'autonomy', 'alignment', 'trajectory'],
            confidence: 0.97,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-codex-first',
            title: 'Codex-First Execution',
            kind: 'principle',
            content:
                'The self-improver should orchestrate, research, persist knowledge, and test. Real implementation defaults to the codex tool, with threads created or resumed in the project root.',
            examples: ['How should code execution happen?', 'Which tool is primary for implementation?', 'Where should Codex threads run?'],
            topics: ['codex', 'execution', 'project-root'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-codex-model-policy',
            title: 'Codex Model Policy',
            kind: 'system_fact',
            content:
                'Codex defaults are gpt-5.4 plus medium reasoning. Use gpt-5.4-mini low or medium for cheap mechanical work, gpt-5.4 high for debugging and figure-out tasks, and gpt-5.4 xhigh only for truly hard architecture cases.',
            examples: ['Which Codex model should be used?', 'When should reasoning effort increase?', 'What is the default Codex policy?'],
            topics: ['codex', 'models', 'reasoning'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-testability-contract',
            title: 'Testability Before Victory',
            kind: 'principle',
            content:
                'If an improvement cannot be tested programmatically or through an available interface, the agent must first add observability, logs, or a test hook before declaring success.',
            examples: ['How should the agent handle hard-to-test changes?', 'What happens before declaring success?', 'What is the testability rule?'],
            topics: ['testing', 'observability', 'quality'],
            confidence: 0.99,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-regression-harness',
            title: 'Standard Regression Harness',
            kind: 'system_fact',
            content:
                'TELOS regression checks should center on advancedCLI, the internal API at http://localhost:11342, server logs, and browser-operator for localhost UX verification.',
            examples: ['How should TELOS be regression-tested?', 'Which harness should self-improver use?', 'What is the internal API endpoint?'],
            topics: ['testing', 'internal-api', 'advancedCLI', 'browser-operator'],
            confidence: 0.98,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-voice-not-bootstrap-target',
            title: 'Voice Is A Subsystem, Not Bootstrap Scope',
            kind: 'constraint',
            content:
                'Voice and local-voice support are important subsystems the agent must understand and may improve later, but they are not required deliverables for the self-improver bootstrap itself.',
            examples: ['Is voice part of self-improver v1?', 'How should local-voice be treated?', 'What is out of bootstrap scope?'],
            topics: ['voice', 'scope', 'local-voice'],
            confidence: 0.97,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-language-policy',
            title: 'Internal English, User Language Outward',
            kind: 'preference',
            content:
                'Internal artifacts should default to English. User-facing replies should stay in the user current language.',
            examples: ['Which language should artifacts use?', 'How should the agent respond to the user?', 'What is the language policy?'],
            topics: ['language', 'ux'],
            confidence: 0.98,
            source: 'bootstrap',
        },
        {
            id: 'si-insight-daily-audit-disabled',
            title: 'Disabled Daily Audit Heartbeat',
            kind: 'system_fact',
            content:
                'A daily 09:00 heartbeat exists for audit-only behavior, but it is disabled by default until the user intentionally enables it.',
            examples: ['Is the daily self-improver heartbeat enabled?', 'What happens at 09:00?', 'Should daily audits run automatically?'],
            topics: ['heartbeat', 'audit', 'scheduling'],
            confidence: 0.98,
            source: 'bootstrap',
        },
    ];

    return definitions.map((definition) => ({
        ...definition,
        createdAt: now,
        updatedAt: now,
    }));
}

function buildBootstrapInitiatives(now: string): ImprovementInitiativeRecord[] {
    return [{
        id: 'si-bootstrap-v1',
        title: 'Self-Improver v1 bootstrap',
        summary: 'Bootstrap the dedicated self-improver agent, state store, public tool, mirrors, and disabled daily audit heartbeat.',
        origin: 'user',
        mode: 'explicit-task',
        status: 'done',
        rationale: 'The system needs a first-class self-improvement agent that can retain vision, track initiatives, and operate safely under approval rules.',
        impact: 'Creates the execution layer and human-readable canon required for reliable self-improvement work.',
        approval: {
            required: false,
            state: 'not_required',
            note: 'User explicitly requested Self-Improver v1 implementation.',
        },
        blockers: [],
        testResults: [],
        codexThreads: [],
        finalOutcome: 'Bootstrap state seeded. The agent, public tool, mirrors, and disabled daily audit heartbeat are expected to be present in the repo.',
        createdAt: now,
        updatedAt: now,
    }];
}

function buildBootstrapAudits(now: string): ImprovementAuditRecord[] {
    return [{
        id: 'audit-bootstrap-v1',
        title: 'Bootstrap alignment audit',
        mode: 'manual',
        summary: 'Seed the canonical dossier, backlog, and audit log so the self-improver starts from explicit principles rather than prompt-only memory.',
        findings: [
            'The self-improver requires explicit state files instead of prompt-only behavior.',
            'Approval boundaries must be machine-readable so audit mode cannot drift into unapproved repo mutation.',
            'Daily audit automation should exist but remain disabled until intentionally enabled.',
        ],
        proposedInitiativeIds: [],
        relatedInitiativeIds: ['si-bootstrap-v1'],
        triggeredBy: 'bootstrap',
        createdAt: now,
        updatedAt: now,
    }];
}

export class SelfImproverStateService {
    readonly paths: ImprovementStatePaths;
    private readonly defaultMemoryConfig?: Partial<MemoryRuntimeConfig>;
    private readonly nowProvider: () => Date;

    constructor(options: SelfImproverStateServiceOptions = {}) {
        const stateDir = options.stateDir || path.join(options.projectRoot || PROJECT_ROOT, 'data', 'self-improver');
        this.paths = {
            stateDir,
            insightsFile: path.join(stateDir, 'insights.json'),
            initiativesFile: path.join(stateDir, 'initiatives.json'),
            auditsFile: path.join(stateDir, 'audits.json'),
            alignmentAssessmentsFile: path.join(stateDir, 'alignment-assessments.json'),
            stateFile: path.join(stateDir, 'state.json'),
            visionDossierFile: path.join(stateDir, 'VISION_DOSSIER.md'),
            backlogFile: path.join(stateDir, 'BACKLOG.md'),
            auditLogFile: path.join(stateDir, 'AUDIT_LOG.md'),
            stateSummaryFile: path.join(stateDir, 'STATE_SUMMARY.md'),
            retrievalAwarenessFile: path.join(stateDir, 'RETRIEVAL_AWARENESS.md'),
            alignmentScorecardFile: path.join(stateDir, 'ALIGNMENT_SCORECARD.md'),
        };
        this.defaultMemoryConfig = options.defaultMemoryConfig;
        this.nowProvider = options.now || (() => new Date());
    }

    async getState(recentAuditLimit = 5): Promise<ImprovementStateSnapshot> {
        const data = await this.loadStateData();
        return this.buildStateSnapshot(data, recentAuditLimit);
    }

    async saveInsight(input: ImprovementInsightInput): Promise<ImprovementInsightResult> {
        const data = await this.loadStateData();
        const now = this.nowIso();
        const kind = ensureArrayValue(input.kind, INSIGHT_KINDS, 'kind');
        const content = ensureNonEmptyString(input.content, 'content');
        const title = (typeof input.title === 'string' && input.title.trim()) ? input.title.trim() : buildInsightTitle(content);
        const topics = mergeUniqueStrings([kind, 'self-improver'], normalizeStringArray(input.topics));
        const examples = this.buildInsightExamples(title, kind, topics, input.examples);
        const confidence = clampConfidence(input.confidence, 0.95);
        const source = (typeof input.source === 'string' && input.source.trim()) ? input.source.trim() : 'self-improver';

        const existingIndex = data.insights.findIndex((record) =>
            record.kind === kind && record.title.toLowerCase() === title.toLowerCase(),
        );

        const record: ImprovementInsightRecord = existingIndex >= 0
            ? {
                ...data.insights[existingIndex]!,
                title,
                content,
                examples,
                topics,
                confidence,
                source,
                updatedAt: now,
            }
            : {
                id: input.id?.trim() || `insight-${slugify(title) || randomUUID()}`,
                title,
                kind,
                content,
                examples,
                topics,
                confidence,
                source,
                createdAt: now,
                updatedAt: now,
            };

        if (existingIndex >= 0) {
            data.insights[existingIndex] = record;
        } else {
            data.insights.push(record);
        }

        await this.saveStateData(data);

        const sync: ImprovementSyncOutcome[] = [];
        if (input.syncMemory) {
            sync.push(await this.syncInsightToMemory(record));
        }

        return { insight: record, sync };
    }

    async proposeInitiative(input: ImprovementInitiativeInput): Promise<ImprovementInitiativeRecord> {
        const data = await this.loadStateData();
        const now = this.nowIso();
        const origin = ensureArrayValue(input.origin, ['user', 'self'] as const, 'origin');
        const title = ensureNonEmptyString(input.title, 'title');
        const summary = ensureNonEmptyString(input.summary, 'summary');
        const rationale = ensureNonEmptyString(input.rationale, 'rationale');
        const impact = ensureNonEmptyString(input.impact, 'impact');
        const mode = ensureArrayValue(input.mode || (origin === 'user' ? 'explicit-task' : 'audit'), SELF_IMPROVER_MODES, 'mode');
        const requiresApproval = input.requiresApproval ?? (origin === 'self');
        const normalizedStatus = ensureArrayValue(
            input.status || (origin === 'user' ? 'approved' : 'proposed'),
            INITIATIVE_STATUSES,
            'status',
        );

        const record: ImprovementInitiativeRecord = {
            id: this.createInitiativeId(data.initiatives, input.id, title, origin),
            title,
            summary,
            origin,
            mode,
            status: normalizedStatus,
            rationale,
            impact,
            approval: requiresApproval
                ? {
                    required: true,
                    state: normalizedStatus === 'approved' ? 'approved' : 'pending',
                    note: input.approvalNote,
                    approvedAt: normalizedStatus === 'approved' ? now : undefined,
                }
                : {
                    required: false,
                    state: 'not_required',
                    note: input.approvalNote || 'User-originated task may proceed immediately.',
                },
            blockers: normalizeStringArray(input.blockers),
            testResults: this.normalizeTestResults(input.testResults),
            codexThreads: dedupeThreads(this.normalizeThreadRefs(input.codexThreads)),
            finalOutcome: typeof input.finalOutcome === 'string' && input.finalOutcome.trim() ? input.finalOutcome.trim() : undefined,
            createdAt: now,
            updatedAt: now,
        };

        data.initiatives.push(record);
        await this.saveStateData(data);
        return record;
    }

    async updateInitiative(id: string, patch: ImprovementInitiativePatch): Promise<ImprovementInitiativeRecord> {
        const data = await this.loadStateData();
        const normalizedId = ensureNonEmptyString(id, 'id');
        const index = data.initiatives.findIndex((record) => record.id === normalizedId);
        if (index === -1) {
            throw new Error(`Initiative "${normalizedId}" was not found.`);
        }

        const current = data.initiatives[index]!;
        const now = this.nowIso();
        const status = patch.status ? ensureArrayValue(patch.status, INITIATIVE_STATUSES, 'patch.status') : current.status;

        const updated: ImprovementInitiativeRecord = {
            ...current,
            title: patch.title?.trim() || current.title,
            summary: patch.summary?.trim() || current.summary,
            mode: patch.mode ? ensureArrayValue(patch.mode, SELF_IMPROVER_MODES, 'patch.mode') : current.mode,
            status,
            rationale: patch.rationale?.trim() || current.rationale,
            impact: patch.impact?.trim() || current.impact,
            approval: this.mergeApproval(current.approval, patch.approval, status, now),
            blockers: mergeUniqueStrings(
                patch.blockers ? normalizeStringArray(patch.blockers) : current.blockers,
                normalizeStringArray(patch.appendBlockers),
            ),
            testResults: [
                ...(patch.testResults ? this.normalizeTestResults(patch.testResults) : current.testResults),
                ...this.normalizeTestResults(patch.appendTestResults),
            ],
            codexThreads: dedupeThreads([
                ...(patch.codexThreads ? this.normalizeThreadRefs(patch.codexThreads) : current.codexThreads),
                ...this.normalizeThreadRefs(patch.appendCodexThreads),
            ]),
            finalOutcome: typeof patch.finalOutcome === 'string' && patch.finalOutcome.trim()
                ? patch.finalOutcome.trim()
                : current.finalOutcome,
            updatedAt: now,
        };

        data.initiatives[index] = updated;
        await this.saveStateData(data);
        return updated;
    }

    async recordAudit(input: ImprovementAuditInput): Promise<ImprovementAuditRecord> {
        const data = await this.loadStateData();
        const now = this.nowIso();
        const mode = ensureArrayValue(input.mode, AUDIT_MODES, 'mode');
        const summary = ensureNonEmptyString(input.summary, 'summary');
        const title = (typeof input.title === 'string' && input.title.trim())
            ? input.title.trim()
            : `${mode === 'daily' ? 'Daily' : 'Manual'} audit ${now.slice(0, 10)}`;

        const record: ImprovementAuditRecord = {
            id: input.id?.trim() || `audit-${slugify(title) || randomUUID()}`,
            title,
            mode,
            summary,
            findings: normalizeStringArray(input.findings),
            proposedInitiativeIds: normalizeStringArray(input.proposedInitiativeIds),
            relatedInitiativeIds: normalizeStringArray(input.relatedInitiativeIds),
            triggeredBy: (typeof input.triggeredBy === 'string' && input.triggeredBy.trim()) ? input.triggeredBy.trim() : 'self-improver',
            createdAt: now,
            updatedAt: now,
        };

        data.audits.push(record);
        await this.saveStateData(data);
        return record;
    }

    async recordAlignmentAssessment(input: ImprovementAlignmentAssessmentInput): Promise<ImprovementAlignmentAssessmentRecord> {
        const data = await this.loadStateData();
        const now = this.nowIso();
        const summary = ensureNonEmptyString(input.summary, 'summary');
        const dimensions = this.normalizeAlignmentDimensions(input.dimensions);
        const previous = sortByUpdatedDesc(data.alignmentAssessments)[0];
        const overallScore = roundTo(average(dimensions.map((item) => item.score)), 3);

        const record: ImprovementAlignmentAssessmentRecord = {
            id: input.id?.trim() || `alignment-${slugify(input.title || summary) || randomUUID()}`,
            title: (typeof input.title === 'string' && input.title.trim())
                ? input.title.trim()
                : `Alignment assessment ${now.slice(0, 10)}`,
            source: (typeof input.source === 'string' && input.source.trim()) ? input.source.trim() : 'self-improver',
            summary,
            dimensions,
            overallScore,
            driftFromPrevious: previous ? roundTo(overallScore - previous.overallScore, 3) : undefined,
            createdAt: now,
            updatedAt: now,
        };

        data.alignmentAssessments.push(record);
        await this.saveStateData(data);
        return record;
    }

    private nowIso(): string {
        return this.nowProvider().toISOString();
    }

    private async loadStateData(): Promise<StateData> {
        await this.ensureBootstrapFiles();
        const [insights, initiatives, audits, alignmentAssessments] = await Promise.all([
            this.readJsonFile<ImprovementInsightRecord[]>(this.paths.insightsFile, []),
            this.readJsonFile<ImprovementInitiativeRecord[]>(this.paths.initiativesFile, []),
            this.readJsonFile<ImprovementAuditRecord[]>(this.paths.auditsFile, []),
            this.readJsonFile<ImprovementAlignmentAssessmentRecord[]>(this.paths.alignmentAssessmentsFile, []),
        ]);

        const data: StateData = {
            insights: Array.isArray(insights) ? insights : [],
            initiatives: Array.isArray(initiatives) ? initiatives : [],
            audits: Array.isArray(audits) ? audits : [],
            alignmentAssessments: Array.isArray(alignmentAssessments) ? alignmentAssessments : [],
        };

        if (!existsSync(this.paths.stateFile)
            || !existsSync(this.paths.visionDossierFile)
            || !existsSync(this.paths.backlogFile)
            || !existsSync(this.paths.auditLogFile)
            || !existsSync(this.paths.stateSummaryFile)
            || !existsSync(this.paths.retrievalAwarenessFile)
            || !existsSync(this.paths.alignmentScorecardFile)) {
            await this.writeDerivedFiles(data);
        }
        return data;
    }

    private async saveStateData(data: StateData): Promise<void> {
        await Promise.all([
            this.writeJsonAtomic(this.paths.insightsFile, sortByUpdatedDesc(data.insights)),
            this.writeJsonAtomic(this.paths.initiativesFile, sortByUpdatedDesc(data.initiatives)),
            this.writeJsonAtomic(this.paths.auditsFile, sortByUpdatedDesc(data.audits)),
            this.writeJsonAtomic(this.paths.alignmentAssessmentsFile, sortByUpdatedDesc(data.alignmentAssessments)),
        ]);
        await this.writeDerivedFiles(data);
    }

    private buildStateSnapshot(data: StateData, recentAuditLimit: number): ImprovementStateSnapshot {
        const backlogItems = sortByUpdatedDesc(data.initiatives);
        const recentAudits = sortByUpdatedDesc(data.audits).slice(0, Math.max(1, recentAuditLimit));
        const pendingApprovals = backlogItems.filter((initiative) =>
            initiative.approval.required && initiative.approval.state === 'pending',
        );
        const linkedCodexThreadRefs = dedupeThreads(backlogItems.flatMap((initiative) => initiative.codexThreads));
        const retrievalAwareness = this.buildRetrievalAwareness(data.insights);
        const alignment = this.buildAlignmentSnapshot(data.alignmentAssessments);

        return {
            generatedAt: this.nowIso(),
            dossierSummary: this.buildDossierSummary(data.insights),
            retrievalAwareness,
            alignment,
            backlogItems,
            initiatives: backlogItems,
            recentAudits,
            pendingApprovals,
            linkedCodexThreadRefs,
            paths: this.paths,
        };
    }

    private buildDossierSummary(insights: ImprovementInsightRecord[]): ImprovementDossierSummary {
        const collect = (kind: InsightKind) => sortByUpdatedDesc(insights)
            .filter((item) => item.kind === kind)
            .map((item) => `${item.title}: ${item.content}`);

        return {
            overview: DEFAULT_DOSSIER_OVERVIEW,
            principles: collect('principle'),
            preferences: collect('preference'),
            constraints: collect('constraint'),
            systemFacts: collect('system_fact'),
            lessons: collect('lesson'),
        };
    }

    private buildRetrievalAwareness(insights: ImprovementInsightRecord[]): ImprovementRetrievalAwarenessManifest {
        const ordered = sortByUpdatedDesc(insights);
        const topicCounts = new Map<string, number>();
        for (const insight of ordered) {
            for (const topic of insight.topics) {
                topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
            }
        }

        const canonicalTopics = Array.from(topicCounts.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .map(([topic]) => topic)
            .slice(0, 12);

        const watchpoints = ordered
            .filter((item) => /misalignment|quality|retrieval|approval|identity/i.test(`${item.title}\n${item.content}`))
            .map((item) => `${item.title}: ${item.content}`)
            .slice(0, 6);

        const dossierTitles = ordered.map((item) => item.title).slice(0, 10);
        const memoryQueries = mergeUniqueStrings(
            ...ordered.slice(0, 10).map((item) => item.examples),
            ordered.slice(0, 10).map((item) => item.title),
            ordered.slice(0, 10).map((item) => `${item.kind} ${item.title}`),
            ordered.slice(0, 10).map((item) => `${item.title} ${item.topics.slice(0, 2).join(' ')}`.trim()),
        ).slice(0, 12);

        const sources: ImprovementRetrievalSourceSummary[] = [
            {
                source: 'dossier',
                summary: 'The dossier is the canonical human-readable source. Read titles deliberately instead of relying only on memory of the prompt.',
                keyTopics: canonicalTopics.slice(0, 8),
                awarenessTitles: dossierTitles,
                recommendedQueries: dossierTitles.slice(0, 8),
            },
            {
                source: 'memory',
                summary: 'The unified memory layer is best surfaced with fact-shaped probes, concrete examples, titles, and topic combinations that mirror stored facts and retrieval hints.',
                keyTopics: canonicalTopics.slice(0, 8),
                awarenessTitles: ordered.map((item) => item.title).slice(0, 8),
                recommendedQueries: memoryQueries,
            },
        ];

        return {
            generatedAt: this.nowIso(),
            overview: 'Retrieval awareness exists so the self-improver knows what durable knowledge is available before it starts improvising queries.',
            canonicalTopics,
            hiddenMisalignmentWatchpoints: watchpoints,
            bootSequence: [
                'Read the dossier, state summary, retrieval awareness mirror, and alignment scorecard before planning serious self-improver work.',
                'Run several memory queries from the awareness manifest, then add at least one subsystem-specific probe for the task at hand.',
                'Treat missing retrieval hits as a signal to widen queries intentionally, not as proof that the knowledge does not exist.',
            ],
            sources,
            bootQueries: [
                ...memoryQueries.slice(0, 6).map((query) => ({
                    source: 'memory' as const,
                    query,
                    rationale: 'Fact-shaped or example-shaped probe derived from canonical self-improver titles, topics, and retrieval hints.',
                })),
            ],
        };
    }

    private buildAlignmentSnapshot(records: ImprovementAlignmentAssessmentRecord[]): ImprovementAlignmentSnapshot {
        const history = sortByUpdatedDesc(records);
        const current = history[0] || null;
        const latestDrift = current?.driftFromPrevious ?? null;
        const driftStatus: ImprovementAlignmentSnapshot['driftStatus'] = latestDrift === null
            ? 'unknown'
            : latestDrift <= -0.05
                ? 'drifting'
                : latestDrift >= 0.05
                    ? 'improving'
                    : 'stable';

        return {
            current,
            history,
            latestDrift,
            driftStatus,
            visibleGaps: current
                ? current.dimensions
                    .filter((item) => item.score < 0.75)
                    .sort((left, right) => left.score - right.score)
                    .map((item) => `${item.label}: ${item.rationale}`)
                : [],
        };
    }

    private async ensureBootstrapFiles(): Promise<void> {
        await mkdir(this.paths.stateDir, { recursive: true });
        if (existsSync(this.paths.insightsFile)
            && existsSync(this.paths.initiativesFile)
            && existsSync(this.paths.auditsFile)
            && existsSync(this.paths.alignmentAssessmentsFile)) {
            return;
        }

        const now = this.nowIso();
        const data: StateData = {
            insights: existsSync(this.paths.insightsFile)
                ? await this.readJsonFile<ImprovementInsightRecord[]>(this.paths.insightsFile, buildBootstrapInsights(now))
                : buildBootstrapInsights(now),
            initiatives: existsSync(this.paths.initiativesFile)
                ? await this.readJsonFile<ImprovementInitiativeRecord[]>(this.paths.initiativesFile, buildBootstrapInitiatives(now))
                : buildBootstrapInitiatives(now),
            audits: existsSync(this.paths.auditsFile)
                ? await this.readJsonFile<ImprovementAuditRecord[]>(this.paths.auditsFile, buildBootstrapAudits(now))
                : buildBootstrapAudits(now),
            alignmentAssessments: existsSync(this.paths.alignmentAssessmentsFile)
                ? await this.readJsonFile<ImprovementAlignmentAssessmentRecord[]>(this.paths.alignmentAssessmentsFile, [])
                : [],
        };
        await this.saveStateData(data);
    }

    private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
        try {
            const raw = await readFile(filePath, 'utf8');
            return JSON.parse(raw) as T;
        } catch {
            return fallback;
        }
    }

    private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
        await rename(tempPath, filePath);
    }

    private async writeTextAtomic(filePath: string, value: string): Promise<void> {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, value, 'utf8');
        await rename(tempPath, filePath);
    }

    private async writeDerivedFiles(data: StateData): Promise<void> {
        const snapshot = this.buildStateSnapshot(data, Math.max(5, data.audits.length || 1));
        await Promise.all([
            this.writeJsonAtomic(this.paths.stateFile, snapshot),
            this.writeTextAtomic(this.paths.visionDossierFile, this.renderVisionDossier(data.insights)),
            this.writeTextAtomic(this.paths.backlogFile, this.renderBacklog(data.initiatives)),
            this.writeTextAtomic(this.paths.auditLogFile, this.renderAuditLog(data.audits)),
            this.writeTextAtomic(this.paths.stateSummaryFile, this.renderStateSummary(snapshot)),
            this.writeTextAtomic(this.paths.retrievalAwarenessFile, this.renderRetrievalAwareness(snapshot.retrievalAwareness)),
            this.writeTextAtomic(this.paths.alignmentScorecardFile, this.renderAlignmentScorecard(snapshot.alignment)),
        ]);
    }

    private renderVisionDossier(insights: ImprovementInsightRecord[]): string {
        const sections = INSIGHT_KINDS.map((kind) => {
            const title = {
                principle: 'Principles',
                preference: 'Preferences',
                constraint: 'Constraints',
                system_fact: 'System Facts',
                lesson: 'Lessons',
            }[kind];

            const rows = sortByUpdatedDesc(insights)
                .filter((item) => item.kind === kind)
                .map((item) => [
                    `### ${item.title}`,
                    '',
                    item.content,
                    '',
                    `- Topics: ${item.topics.join(', ')}`,
                    `- Source: ${item.source}`,
                    `- Confidence: ${item.confidence.toFixed(2)}`,
                    `- Updated: ${item.updatedAt}`,
                ].join('\n'))
                .join('\n\n');

            return `## ${title}\n\n${rows || '_None yet._'}`;
        });

        return [
            '# Vision Dossier',
            '',
            DEFAULT_DOSSIER_OVERVIEW,
            '',
            '## Operating Mode',
            '',
            '- Modes: explicit-task and audit only.',
            `- Codex thread prefix: \`${DEFAULT_CODEX_THREAD_PREFIX}\`.`,
            `- Codex working directory: \`${DEFAULT_CODEX_WORKING_DIRECTORY}\`.`,
            '- Daily audit heartbeat exists at 09:00 and is disabled by default.',
            '',
            ...sections,
            '',
        ].join('\n');
    }

    private renderBacklog(initiatives: ImprovementInitiativeRecord[]): string {
        const ordered = sortByUpdatedDesc(initiatives);
        const body = ordered.map((initiative) => [
            `## ${initiative.title}`,
            '',
            `- ID: ${initiative.id}`,
            `- Status: ${initiative.status}`,
            `- Origin: ${initiative.origin}`,
            `- Mode: ${initiative.mode}`,
            `- Approval: ${initiative.approval.state}${initiative.approval.required ? ' (required)' : ' (not required)'}`,
            `- Updated: ${initiative.updatedAt}`,
            '',
            initiative.summary,
            '',
            `Rationale: ${initiative.rationale}`,
            '',
            `Impact: ${initiative.impact}`,
            ...(initiative.blockers.length ? ['', 'Blockers:', ...initiative.blockers.map((item) => `- ${item}`)] : []),
            ...(initiative.codexThreads.length
                ? ['', 'Codex threads:', ...initiative.codexThreads.map((thread) =>
                    `- ${thread.name} [${thread.phase}] ${thread.model}/${thread.modelReasoningEffort} @ ${thread.workingDirectory}`,
                )]
                : []),
            ...(initiative.testResults.length
                ? ['', 'Test results:', ...initiative.testResults.map((test) =>
                    `- ${test.status.toUpperCase()}: ${test.name}${test.details ? ` - ${test.details}` : ''}`,
                )]
                : []),
            ...(initiative.finalOutcome ? ['', `Final outcome: ${initiative.finalOutcome}`] : []),
            '',
        ].join('\n')).join('\n');

        return ['# Backlog', '', body || '_No initiatives recorded yet._'].join('\n');
    }

    private renderAuditLog(audits: ImprovementAuditRecord[]): string {
        const ordered = sortByUpdatedDesc(audits);
        const body = ordered.map((audit) => [
            `## ${audit.title}`,
            '',
            `- ID: ${audit.id}`,
            `- Mode: ${audit.mode}`,
            `- Triggered by: ${audit.triggeredBy}`,
            `- Updated: ${audit.updatedAt}`,
            '',
            audit.summary,
            ...(audit.findings.length ? ['', 'Findings:', ...audit.findings.map((finding) => `- ${finding}`)] : []),
            ...(audit.proposedInitiativeIds.length ? ['', `Proposed initiatives: ${audit.proposedInitiativeIds.join(', ')}`] : []),
            ...(audit.relatedInitiativeIds.length ? [`Related initiatives: ${audit.relatedInitiativeIds.join(', ')}`] : []),
            '',
        ].join('\n')).join('\n');

        return ['# Audit Log', '', body || '_No audits recorded yet._'].join('\n');
    }

    private renderStateSummary(snapshot: ImprovementStateSnapshot): string {
        const backlogTable = snapshot.backlogItems.map((initiative) =>
            `| ${markdownEscapeInline(initiative.id)} | ${markdownEscapeInline(initiative.status)} | ${markdownEscapeInline(initiative.origin)} | ${markdownEscapeInline(initiative.title)} |`,
        );
        const alignmentScore = snapshot.alignment.current ? snapshot.alignment.current.overallScore.toFixed(2) : 'n/a';
        const driftLabel = snapshot.alignment.latestDrift === null ? 'n/a' : snapshot.alignment.latestDrift.toFixed(2);

        return [
            '# State Summary',
            '',
            `Generated: ${snapshot.generatedAt}`,
            '',
            `- Total insights: ${snapshot.dossierSummary.principles.length + snapshot.dossierSummary.preferences.length + snapshot.dossierSummary.constraints.length + snapshot.dossierSummary.systemFacts.length + snapshot.dossierSummary.lessons.length}`,
            `- Total initiatives: ${snapshot.backlogItems.length}`,
            `- Pending approvals: ${snapshot.pendingApprovals.length}`,
            `- Linked Codex threads: ${snapshot.linkedCodexThreadRefs.length}`,
            `- Alignment score: ${alignmentScore}`,
            `- Alignment drift: ${driftLabel} (${snapshot.alignment.driftStatus})`,
            `- Retrieval awareness queries: ${snapshot.retrievalAwareness.bootQueries.length}`,
            '',
            '## Backlog',
            '',
            '| ID | Status | Origin | Title |',
            '| --- | --- | --- | --- |',
            ...(backlogTable.length ? backlogTable : ['| _none_ | _none_ | _none_ | _none_ |']),
            '',
            '## Retrieval Awareness',
            '',
            ...snapshot.retrievalAwareness.bootQueries.slice(0, 6).map((entry) =>
                `- ${entry.source}: ${entry.query}`,
            ),
            '',
        ].join('\n');
    }

    private renderRetrievalAwareness(manifest: ImprovementRetrievalAwarenessManifest): string {
        const sources = manifest.sources.map((source) => [
            `## ${source.source[0]?.toUpperCase()}${source.source.slice(1)}`,
            '',
            source.summary,
            '',
            `- Key topics: ${source.keyTopics.join(', ') || '_none_'}`,
            ...(source.awarenessTitles.length ? ['', 'Known titles:', ...source.awarenessTitles.map((title) => `- ${title}`)] : []),
            ...(source.recommendedQueries.length ? ['', 'Recommended queries:', ...source.recommendedQueries.map((query) => `- ${query}`)] : []),
            '',
        ].join('\n')).join('\n');

        return [
            '# Retrieval Awareness',
            '',
            `Generated: ${manifest.generatedAt}`,
            '',
            manifest.overview,
            '',
            `- Canonical topics: ${manifest.canonicalTopics.join(', ') || '_none_'}`,
            ...(manifest.hiddenMisalignmentWatchpoints.length
                ? ['', '## Hidden Misalignment Watchpoints', '', ...manifest.hiddenMisalignmentWatchpoints.map((item) => `- ${item}`)]
                : []),
            '',
            '## Boot Sequence',
            '',
            ...manifest.bootSequence.map((step, index) => `${index + 1}. ${step}`),
            '',
            '## Boot Queries',
            '',
            ...manifest.bootQueries.map((query) => `- ${query.source}: ${query.query} (${query.rationale})`),
            '',
            sources,
        ].join('\n');
    }

    private renderAlignmentScorecard(snapshot: ImprovementAlignmentSnapshot): string {
        if (!snapshot.current) {
            return [
                '# Alignment Scorecard',
                '',
                'No alignment assessments recorded yet.',
                '',
                'Use `improvement.recordAlignmentAssessment(...)` after audits, interviews, or explicit corrections so drift becomes visible.',
                '',
            ].join('\n');
        }

        const current = snapshot.current;
        const historyTable = snapshot.history.map((record) =>
            `| ${markdownEscapeInline(record.createdAt.slice(0, 10))} | ${record.overallScore.toFixed(2)} | ${record.driftFromPrevious === undefined ? 'n/a' : record.driftFromPrevious.toFixed(2)} | ${markdownEscapeInline(record.title)} |`,
        );

        return [
            '# Alignment Scorecard',
            '',
            `Current overall score: ${current.overallScore.toFixed(2)}`,
            `Current drift: ${snapshot.latestDrift === null ? 'n/a' : snapshot.latestDrift.toFixed(2)} (${snapshot.driftStatus})`,
            '',
            current.summary,
            '',
            '## Dimensions',
            '',
            ...current.dimensions.map((dimension) =>
                `- ${dimension.label}: ${dimension.score.toFixed(2)} | ${dimension.rationale}`,
            ),
            ...(snapshot.visibleGaps.length ? ['', '## Visible Gaps', '', ...snapshot.visibleGaps.map((gap) => `- ${gap}`)] : []),
            '',
            '## History',
            '',
            '| Date | Overall | Drift | Title |',
            '| --- | --- | --- | --- |',
            ...(historyTable.length ? historyTable : ['| _none_ | _none_ | _none_ | _none_ |']),
            '',
        ].join('\n');
    }

    private normalizeThreadRefs(records: ImprovementThreadRef[] | undefined): ImprovementThreadRef[] {
        if (!Array.isArray(records)) {
            return [];
        }

        return records
            .filter((record) => isObject(record))
            .map((record) => ({
                name: ensureNonEmptyString(record.name, 'thread.name'),
                phase: ensureNonEmptyString(record.phase, 'thread.phase'),
                summary: ensureNonEmptyString(record.summary, 'thread.summary'),
                workingDirectory: ensureNonEmptyString(record.workingDirectory, 'thread.workingDirectory'),
                model: ensureNonEmptyString(record.model, 'thread.model'),
                modelReasoningEffort: ensureArrayValue(record.modelReasoningEffort, CODEX_REASONING_EFFORTS, 'thread.modelReasoningEffort'),
                threadId: typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : undefined,
                sdkThreadId: typeof record.sdkThreadId === 'string' && record.sdkThreadId.trim() ? record.sdkThreadId.trim() : undefined,
                status: typeof record.status === 'string' && record.status.trim()
                    ? ensureArrayValue(record.status, ['planned', 'running', 'completed', 'failed'] as const, 'thread.status')
                    : undefined,
                linkedAt: typeof record.linkedAt === 'string' && record.linkedAt.trim() ? record.linkedAt.trim() : this.nowIso(),
            }));
    }

    private normalizeTestResults(records: ImprovementTestResult[] | undefined): ImprovementTestResult[] {
        if (!Array.isArray(records)) {
            return [];
        }

        return records
            .filter((record) => isObject(record))
            .map((record) => ({
                name: ensureNonEmptyString(record.name, 'test.name'),
                status: ensureArrayValue(record.status, TEST_RESULT_STATUSES, 'test.status'),
                details: typeof record.details === 'string' && record.details.trim() ? record.details.trim() : undefined,
                recordedAt: typeof record.recordedAt === 'string' && record.recordedAt.trim() ? record.recordedAt.trim() : this.nowIso(),
            }));
    }

    private normalizeAlignmentDimensions(
        records: ImprovementAlignmentAssessmentInput['dimensions'],
    ): ImprovementAlignmentDimensionScore[] {
        if (!Array.isArray(records) || records.length === 0) {
            throw new Error('dimensions must contain one score for each canonical alignment dimension.');
        }

        const byKey = new Map<AlignmentDimensionKey, ImprovementAlignmentDimensionScore>();
        for (const record of records) {
            if (!isObject(record)) {
                continue;
            }
            const key = ensureArrayValue(record.key, ALIGNMENT_DIMENSION_KEYS, 'dimension.key');
            byKey.set(key, {
                key,
                label: (typeof record.label === 'string' && record.label.trim())
                    ? record.label.trim()
                    : ALIGNMENT_DIMENSION_LABELS[key],
                score: ensureUnitScore(record.score, `dimension.score.${key}`),
                rationale: ensureNonEmptyString(record.rationale, `dimension.rationale.${key}`),
                evidence: normalizeStringArray(record.evidence),
            });
        }

        const missing = ALIGNMENT_DIMENSION_KEYS.filter((key) => !byKey.has(key));
        if (missing.length > 0) {
            throw new Error(`dimensions missing canonical keys: ${missing.join(', ')}.`);
        }

        return ALIGNMENT_DIMENSION_KEYS.map((key) => byKey.get(key)!);
    }

    private buildInsightExamples(title: string, kind: InsightKind, topics: string[], inputExamples?: string[]): string[] {
        const defaults = [
            title,
            `self-improver ${kind}`,
            `TELOS ${topics[0] || 'architecture'} guidance`,
        ];
        return mergeUniqueStrings(defaults, normalizeStringArray(inputExamples)).slice(0, 8);
    }

    private createInitiativeId(
        existing: ImprovementInitiativeRecord[],
        explicitId: string | undefined,
        title: string,
        origin: InitiativeOrigin,
    ): string {
        const base = explicitId?.trim() || `${origin === 'self' ? 'si' : 'task'}-${slugify(title)}`;
        let candidate = base;
        let counter = 2;
        const used = new Set(existing.map((record) => record.id));

        while (used.has(candidate)) {
            candidate = `${base}-${counter}`;
            counter += 1;
        }

        return candidate;
    }

    private mergeApproval(
        current: ImprovementApproval,
        patch: Partial<ImprovementApproval> | undefined,
        status: InitiativeStatus,
        now: string,
    ): ImprovementApproval {
        const next: ImprovementApproval = {
            ...current,
            ...(patch || {}),
        };

        if (patch?.state) {
            next.state = ensureArrayValue(patch.state, APPROVAL_STATES, 'patch.approval.state');
        }

        if (status === 'approved' && next.required && next.state === 'pending') {
            next.state = 'approved';
            next.approvedAt = now;
        }
        if (status === 'rejected') {
            next.state = 'rejected';
        }
        if (!next.required) {
            next.state = 'not_required';
            next.approvedAt = undefined;
            next.approvedBy = undefined;
        }

        return next;
    }

    private async syncInsightToMemory(record: ImprovementInsightRecord): Promise<ImprovementSyncOutcome> {
        try {
            const service = new MemoryService({
                table: this.defaultMemoryConfig?.table || process.env.MEMORY_TABLE || 'global_memory_v2',
                ...this.defaultMemoryConfig,
            });
            await service.initialize();
            const result = await service.ingestText({
                text: `${record.title}: ${record.content}`,
                retrievalHints: mergeUniqueStrings(record.examples, record.topics, ['self-improver', `insight:${record.kind}`]),
            });
            return {
                target: 'memory',
                status: 'synced',
                detail: `Stored insight in memory table "${service.getRuntimeConfig().table}".`,
                id: result.factIds[0],
            };
        } catch (error) {
            return {
                target: 'memory',
                status: 'failed',
                detail: error instanceof Error ? error.message : String(error),
            };
        }
    }
}

let singleton: SelfImproverStateService | null = null;

export function getSelfImproverStateService(): SelfImproverStateService {
    if (!singleton) {
        singleton = new SelfImproverStateService({
            projectRoot: PROJECT_ROOT,
            stateDir: DEFAULT_STATE_DIR,
            defaultMemoryConfig: { table: process.env.MEMORY_TABLE || 'global_memory_v2' },
        });
    }
    return singleton;
}
