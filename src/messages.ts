import * as vscode from 'vscode';

/** Rough estimate: code and prose average ~3 characters per token for this model. Deliberately conservative. */
export const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Flattens message parts to plain text. Tool calls/results are rendered as text (v1 has no native tool calling). */
export function partsToText(content: ReadonlyArray<unknown>): string {
  const out: string[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      out.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      out.push(`[tool result]\n${partsToText(part.content)}`);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      out.push(`[tool call ${part.name}(${JSON.stringify(part.input)})]`);
    }
  }
  return out.join('\n');
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
  droppedTurns: number;
  truncated: boolean;
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const marker = '\n…[truncated]…\n';
  const room = Math.max(0, max - marker.length);
  const head = Math.floor(room * 0.4);
  return text.slice(0, head) + marker + text.slice(text.length - (room - head));
}

// vscode.LanguageModelChatMessageRole has User=1 and Assistant=2; newer hosts may send 3 for system.
const SYSTEM_ROLE = 3;

function tagContent(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1].trim() : undefined;
}

/**
 * Copilot's agent prompts wrap what the user typed in <userRequest> (or <user_query>) alongside
 * reminders and workspace context. Keep only the request and any attached files.
 * Returns undefined for messages that carry no user request (pure context messages).
 */
function extractAgentUserText(text: string): string | undefined {
  const request = tagContent(text, 'userRequest') ?? tagContent(text, 'user_query');
  if (request === undefined) {
    return undefined;
  }
  const attachments = tagContent(text, 'attachments');
  return attachments ? `${attachments}\n\n${request}` : request;
}

/**
 * Turns VS Code chat messages into (instructions, prompt) that fit the 4096-token window.
 * Always keeps the newest message; drops the oldest turns first.
 *
 * `agentPrompt`: the request comes from a tool-enabled Copilot agent (Agent/Ask modes). Its system
 * prompt and context messages are far larger than the model's window, so only our own instructions,
 * the user's requests and prior assistant replies are kept.
 */
export function buildPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  opts: { defaultSystem: string; maxInputChars: number; agentPrompt?: boolean }
): BuiltPrompt {
  let system = opts.defaultSystem.trim();
  const turns: { role: 'User' | 'Assistant'; text: string }[] = [];
  const agentTagged =
    !!opts.agentPrompt &&
    messages.some(
      (m) => m.role === vscode.LanguageModelChatMessageRole.User && extractAgentUserText(partsToText(m.content)) !== undefined
    );

  for (const m of messages) {
    let text = partsToText(m.content).trim();
    if (!text) {
      continue;
    }
    if ((m.role as number) === SYSTEM_ROLE) {
      if (!opts.agentPrompt) {
        system = system ? `${system}\n\n${text}` : text;
      }
      continue;
    }
    if (agentTagged && m.role === vscode.LanguageModelChatMessageRole.User) {
      const extracted = extractAgentUserText(text);
      if (extracted === undefined) {
        continue; // environment/workspace context message
      }
      text = extracted;
    }
    turns.push({
      role: m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'Assistant' : 'User',
      text
    });
  }

  system = clipMiddle(system, Math.floor(opts.maxInputChars * 0.3));
  let budget = opts.maxInputChars - system.length;

  const multi = turns.length > 1;
  const kept: string[] = [];
  let droppedTurns = 0;
  let truncated = false;

  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const isLatest = i === turns.length - 1;
    const label = multi ? `${t.role}: ` : '';
    const room = budget - label.length - 2;
    let body = t.text;

    if (body.length > room) {
      if (isLatest) {
        body = clipMiddle(body, Math.max(room, 500));
        truncated = true;
      } else {
        droppedTurns = i + 1;
        break;
      }
    }
    kept.unshift(label + body);
    budget -= label.length + body.length + 2;
  }

  let prompt = kept.join('\n\n');
  if (multi && kept.length > 1) {
    prompt =
      'Conversation so far (older messages may be omitted):\n\n' +
      prompt +
      '\n\nReply as the Assistant to the last User message.';
  }
  return { system, prompt, droppedTurns, truncated };
}
