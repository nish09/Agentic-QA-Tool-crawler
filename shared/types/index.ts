/**
 * Shared TypeScript types for API Mapper Tool
 * Used across Chrome Extension, Agent, and Dashboard
 */

// ─── Core API Call ───────────────────────────────────────────────────────────

export interface CapturedAPICall {
  id: string;
  timestamp: number;
  url: string;
  method: HTTPMethod;
  requestHeaders: Record<string, string>;
  requestPayload?: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: unknown;
  responseSchema?: JSONSchema;
  uiContext?: UIContext;
  inferredDBTables?: DBTableMapping[];
  tags?: string[];
}

export type HTTPMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD';

// ─── UI Context ───────────────────────────────────────────────────────────────

export interface UIContext {
  pageUrl: string;
  pageTitle?: string;
  activeComponent?: string;
  triggerElement?: string;
  triggerAction?: TriggerAction;
  domPath?: string;
}

export type TriggerAction =
  | 'click'
  | 'scroll'
  | 'load'
  | 'input'
  | 'hover'
  | 'unknown';

// ─── Schema Inference ─────────────────────────────────────────────────────────

export interface JSONSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  example?: unknown;
}

export interface DBTableMapping {
  fieldPath: string;
  inferredTable: string;
  inferredColumn?: string;
  confidence: ConfidenceLevel;
  reasoning: string;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

// ─── Report / Document ────────────────────────────────────────────────────────

export interface MappingReport {
  id: string;
  generatedAt: number;
  targetUrl: string;
  totalAPIsFound: number;
  apiCalls: CapturedAPICall[];
  summary: ReportSummary;
}

export interface ReportSummary {
  totalEndpoints: number;
  uniqueHosts: string[];
  methodBreakdown: Record<HTTPMethod, number>;
  inferredTables: string[];
  uiSections: string[];
}

// ─── Extension Storage ────────────────────────────────────────────────────────

export interface ExtensionStorage {
  capturedCalls: CapturedAPICall[];
  isCapturing: boolean;
  filterText: string;
  selectedCall?: string;
}
