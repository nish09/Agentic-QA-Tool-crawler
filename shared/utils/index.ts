/**
 * shared/utils/index.ts
 * Utility functions shared across all phases of the API Mapper tool.
 */

import type { JSONSchema } from '../types';

// ─── ID Generation ────────────────────────────────────────────────────────────

/**
 * Generates a unique ID for each captured API call.
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ─── Schema Extraction ────────────────────────────────────────────────────────

/**
 * Recursively infers a JSON schema from a response body value.
 */
export function extractSchema(value: unknown): JSONSchema {
  if (value === null) return { type: 'null' };

  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? extractSchema(value[0]) : { type: 'null' },
    };
  }

  if (typeof value === 'object') {
    const properties: Record<string, JSONSchema> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = extractSchema(val);
    }
    return {
      type: 'object',
      properties,
      required: Object.keys(properties),
      example: value,
    };
  }

  if (typeof value === 'string') return { type: 'string', example: value };
  if (typeof value === 'number') return { type: 'number', example: value };
  if (typeof value === 'boolean') return { type: 'boolean', example: value };

  return { type: 'null' };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Formats a response status code with an emoji indicator.
 */
export function formatStatus(status: number): string {
  if (status >= 500) return `🔴 ${status}`;
  if (status >= 400) return `🟡 ${status}`;
  if (status >= 200 && status < 300) return `🟢 ${status}`;
  return `⚪ ${status}`;
}

/**
 * Formats bytes into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Truncates a string to a max length with ellipsis.
 */
export function truncate(str: string, max = 60): string {
  return str.length > max ? str.substring(0, max) + '...' : str;
}

/**
 * Extracts the host from a URL string safely.
 */
export function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
