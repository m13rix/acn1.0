export interface Agent {
  id: string;
  name: string;
  description: string;
}

export interface Todo {
  task: string;
  completed: boolean;
}

export interface LogEntry {
  message: string;
  type: 'info' | 'error' | 'warning' | 'system' | 'executor';
  timestamp: string;
}

// --- Attachments ---

export interface Attachment {
  name: string;
  type: string; // mime type
  base64: string; // base64 data without prefix (sometimes) or with? Let's store full data URI or separate.
  // Provider usually wants pure base64 for inlineData, but dataURI for image_url.
  // Let's store pure base64 and reconstruction if needed, or just DataURL.
  // Let's store DataURL for ease of display, and strip for API if needed.
  dataUrl: string; 
}

// --- New Sequence Architecture Types ---

export type BlockType = 'plan' | 'thought' | 'action' | 'text' | 'switch' | 'context' | 'toolUI';

export interface BaseBlock {
  id: string;
  type: BlockType;
  timestamp: string;
}

// === Tool Custom UI Types ===

export interface ToolUIState {
  id: string;
  label: string;           // Current label text (e.g., "Searching the web...")
  labelFinished?: string;  // Label when finished (e.g., "Searched the web")
  html: string;            // Custom HTML content for rendering
  height?: number;         // Optional height in pixels (default: auto)
  data?: Record<string, any>; // Custom data for the UI
}

export interface PlanBlock extends BaseBlock {
  type: 'plan';
  todos: Todo[];
}

export interface ThoughtBlock extends BaseBlock {
  type: 'thought';
  content: string; // e.g. "Thinking..."
  isFinished: boolean;
  duration?: number;
  reasoning?: string; // Chain-of-thought content from model
}

export interface ActionBlock extends BaseBlock {
  type: 'action';
  content: string; // e.g. "Executing code..." or code snippet
  output?: string;
  isFinished: boolean;
  duration?: number;
}

export interface SwitchBlock extends BaseBlock {
  type: 'switch';
  content: string; // "Switching Model..."
  reason?: string; // "For deep reasoning..."
  modelName?: string; 
  isFinished: boolean;
}

export interface ContextBlock extends BaseBlock {
  type: 'context';
  content: string; // "Context Updated"
  mode?: string;
  details?: any;
  isFinished: boolean;
}

export interface TextBlock extends BaseBlock {
  type: 'text';
  content: string;
}

// Tool Custom UI Block - for tools with custom visual interfaces
export interface ToolUIBlock extends BaseBlock {
  type: 'toolUI';
  content: string;         // Main label shown in collapsed state
  isFinished: boolean;
  duration?: number;
  // Multiple UI states for multiple tool calls in one action
  uis: ToolUIState[];
  currentUIIndex: number;  // Which UI is currently shown (for navigation)
}

export type Block = PlanBlock | ThoughtBlock | ActionBlock | TextBlock | SwitchBlock | ContextBlock | ToolUIBlock;

export interface SessionItem {
  id: string;
  role: 'user' | 'assistant';
  content: string; // For user messages, just string. For assistant, we ignore this in favor of blocks
  blocks?: Block[]; // Only for assistant
  attachments?: Attachment[]; // User attachments
  timestamp: string;
}

// Legacy type support if needed
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

// ==========================================
// CHAT STORAGE TYPES
// ==========================================

export interface ChatMeta {
  id: string;
  title: string;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface Chat extends ChatMeta {
  items: SessionItem[];
}

// ==========================================
// BILLING / SUBSCRIPTION TYPES (Client)
// ==========================================

export type PlanType = 'standard' | 'trial' | 'custom';

export interface Subscription {
  planType: PlanType;
  priceRub: number;
  periodDays: number;
  profitShare?: number;
  totalCreditsUsd: number;
  startDate: string; // ISO
  nextPaymentDate: string; // ISO
  isActive: boolean;
  // Server may include extra fields; we only type the ones we need in UI.
  period?: {
    day?: {
      dailySoftCapBypass?: boolean;
    };
  };
}

export interface UsageLimitsResponse {
  ok: boolean;
  reason?: 'no_subscription' | 'payment_due' | string;
  remainingUsd?: number;
  dailyLimitUsd?: number;
  dailySpentUsd?: number;
  dailyPct?: number;
  totalPctLeft?: number;
  daysLeft?: number;
  subscription?: Subscription | null;
}