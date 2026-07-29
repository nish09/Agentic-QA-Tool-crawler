import Anthropic from '@anthropic-ai/sdk';
import type { CapturedAPICall, DBTableMapping } from '@qalens/shared/types';

const SYSTEM_PROMPT = `You are a database schema inference expert.
Given an API endpoint URL and its JSON response body,
infer the likely database tables and fields this data comes from.
Return JSON only. No explanation. No markdown.
Confidence levels: high (obvious naming), medium (reasonable guess), low (speculative).`;

export async function inferDBMappings(call: CapturedAPICall): Promise<DBTableMapping[]> {
  if (!call.responseBody) return [];

  const prompt = buildPrompt(call);

  if (process.env['ANTHROPIC_API_KEY']) {
    return inferWithClaude(prompt);
  }

  if (process.env['OLLAMA_URL']) {
    return inferWithOllama(prompt);
  }

  return [];
}

function buildPrompt(call: CapturedAPICall): string {
  const body = JSON.stringify(call.responseBody, null, 2).slice(0, 2_000);
  return `URL: ${call.url}
Method: ${call.method}
Response: ${body}

Return a JSON array of DBTableMapping objects:
[{"fieldPath": "string", "inferredTable": "string", "confidence": "high|medium|low", "reasoning": "string"}]`;
}

// Models sometimes wrap JSON in a ```json fence despite the "no markdown"
// instruction — strip it before parsing rather than let a fence fail JSON.parse
// and silently fall back to an empty result.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

async function inferWithClaude(prompt: string): Promise<DBTableMapping[]> {
  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1_024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
    return JSON.parse(stripCodeFence(text)) as DBTableMapping[];
  } catch (e) {
    console.error('[inference] Claude call failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

async function inferWithOllama(prompt: string): Promise<DBTableMapping[]> {
  const ollamaUrl = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt: `${SYSTEM_PROMPT}\n\n${prompt}`, stream: false }),
    });
    const data = (await res.json()) as { response: string };
    return JSON.parse(stripCodeFence(data.response)) as DBTableMapping[];
  } catch (e) {
    console.error('[inference] Ollama call failed:', e instanceof Error ? e.message : e);
    return [];
  }
}
