export interface CapturedAPICall {
  id: string;
  timestamp: number;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  requestHeaders: Record<string, string>;
  requestPayload?: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: unknown;
  responseSchema?: JSONSchema;
  uiContext?: UIContext;
  inferredDBTables?: DBTableMapping[];
}

export type TriggerAction = 'click' | 'scroll' | 'load' | 'input' | 'unknown';

export interface UIContext {
  pageUrl: string;
  pageTitle?: string;
  activeComponent?: string;
  triggerElement?: string;
  triggerAction?: TriggerAction;
  domPath?: string;
}

export interface DBTableMapping {
  fieldPath: string;
  inferredTable: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  description?: string;
  required?: string[];
  example?: unknown;
}
