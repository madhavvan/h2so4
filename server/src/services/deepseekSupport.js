// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DEEPSEEK SUPPORT-BOT CHAT LOOP  (user / Basic+ role)
//
//  Sibling of services/anthropicSupport.js. The admin role stays on
//  Claude (claude-sonnet-5) because it needs the full ~475K-char
//  engineering-docs corpus inline + the destructive-tool step-up flow,
//  where Claude's tool-call accuracy earns its price. The USER role
//  (Basic/Pro/Max) is a lighter surface — the 17 USER_CLIENT/USER_SERVER
//  tools, no eng-docs — so it runs on DeepSeek V4 Flash: fast, cheap,
//  and OpenAI-compatible.
//
//  This replaces the previously-deferred "Kimi 2.6 for user role" plan.
//
//  CONTRACT: identical to runAnthropicChatLoop — same argument object,
//  same SSE event surface (delta / tool_call / tool_result /
//  step_up_required / done). The renderer does not change and does not
//  know which model answered. routes/support.js picks the loop by role.
//
//  DeepSeek is OpenAI-compatible, so we drive it with the `openai` SDK
//  (already a dependency, proven by routes/ai.js) pointed at DeepSeek's
//  base URL. Tool-calling + streaming follow the OpenAI Chat Completions
//  shape (delta.tool_calls accumulate by index; finish_reason='tool_calls'
//  signals a tool turn), NOT Anthropic's tool_use blocks.
//
//  NOTE ON WEB SEARCH: Anthropic's loop adds a hosted web_search tool.
//  DeepSeek has no hosted search, so the user loop drops the
//  {type:'web_search'} shim — the function tools are what matter for
//  user support. (If live search for user chat is ever needed, wire a
//  search-partner tool into botTools as a USER_SERVER function.)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

// Lazy SDK load — same pattern as anthropicSupport.js / routes/ai.js.
// Lets the server boot even if the SDK is missing; only this loop
// degrades to the "not configured" message.
const _OpenAIMod = (() => {
  try { return require('openai'); } catch { return null; }
})();
const OpenAI = _OpenAIMod && (_OpenAIMod.default || _OpenAIMod);

// DeepSeek V4 Flash — fast/economical, 1M context, tool-calling. The old
// deepseek-chat / deepseek-reasoner aliases deprecate 2026-07-24, so we
// name the V4 model explicitly. Override with DEEPSEEK_MODEL if needed
// (e.g. 'deepseek-v4-pro' for harder reasoning).
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MAX_TOOL_ITERATIONS = 8;
const MAX_TOKENS_PER_TURN = 8000;

function getClient() {
  if (!OpenAI) return null;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL: BASE_URL });
}

// Convert our internal tool schemas to OpenAI Chat-Completions shape.
// botTools.getToolSchemasForRole() returns {type:'function', name,
// description, parameters}; Chat Completions nests those under a
// `function` key. Skip the {type:'web_search'} hosted shim (see header).
function convertToolsToOpenAI(tools) {
  const out = [];
  for (const t of tools || []) {
    if (t.type === 'web_search') continue;
    const name = t.name || (t.function && t.function.name);
    if (!name) continue;
    out.push({
      type: 'function',
      function: {
        name,
        description: t.description || (t.function && t.function.description) || '',
        parameters: t.parameters || (t.function && t.function.parameters) || { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

// ── Main chat loop ───────────────────────────────────────────
// Same signature + return semantics as runAnthropicChatLoop. Returns when:
//   - model finishes without tool calls (normal end)
//   - a tool needs step-up → emits step_up_required + done
//   - iteration cap hit → soft closing delta + done
//   - abortSignal fires → returns silently (client disconnect)
async function runDeepSeekChatLoop({
  systemPrompt,
  toolCatalog,
  callerMessages,
  ctx,
  executeTool,
  getToolMeta,
  sse,
  emitToolCallToClient,
  abortSignal,
}) {
  const client = getClient();
  if (!client) {
    sse('delta', { text: 'Sorry — the support model isn\'t configured on this server. Try again later or use Talk to a human below.' });
    sse('done', { ok: true });
    return;
  }

  // OpenAI-style messages: a single system message (today's date appended
  // so the model isn't stale), then the sanitized chat history.
  const today = new Date().toISOString().slice(0, 10);
  const messages = [
    { role: 'system', content: `${systemPrompt}\n\nToday is ${today}.` },
    ...(callerMessages || []).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    })),
  ];

  const tools = convertToolsToOpenAI(toolCatalog);

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    if (abortSignal?.aborted) return;

    let assistantText = '';
    const toolCallsAcc = []; // indexed accumulator: [{ id, name, args }]
    let finishReason = 'stop';

    try {
      const stream = await client.chat.completions.create({
        model: MODEL,
        max_tokens: MAX_TOKENS_PER_TURN,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
        stream: true,
      }, { signal: abortSignal });

      for await (const chunk of stream) {
        if (abortSignal?.aborted) return;
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        // Text deltas → stream to the user in real time.
        if (delta.content) {
          assistantText += delta.content;
          try { sse('delta', { text: String(delta.content) }); }
          catch { /* SSE socket gone */ }
        }

        // Tool-call fragments arrive across chunks, keyed by .index.
        // Accumulate id + name + partial argument JSON per slot.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', name: '', args: '' };
            if (tc.id) toolCallsAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].args += tc.function.arguments;
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      // Client disconnect — abortSignal propagated through the SDK.
      if (err?.name === 'AbortError' || abortSignal?.aborted) return;
      console.error('[deepseek-support] stream failed:', err && err.message);
      sse('delta', { text: '\n\nSorry — I\'m having trouble reaching the model right now. Try again in a moment, or use "Talk to a human" below.' });
      sse('done', { ok: true });
      return;
    }

    const realToolCalls = toolCallsAcc.filter(t => t && t.name);
    if (realToolCalls.length === 0) {
      // No tool calls — text already streamed. Normal close.
      sse('done', { ok: true });
      return;
    }

    // Push the assistant turn carrying the tool_calls, then a `tool`
    // message per call. OpenAI requires every tool_call in the assistant
    // message to be answered before the next completion.
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: realToolCalls.map(t => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    });

    let stepUpHaltIntent = null;
    for (const tc of realToolCalls) {
      let args = {};
      try { args = tc.args ? JSON.parse(tc.args) : {}; }
      catch { args = {}; } // model emitted malformed JSON — run with empty args, tool soft-fails

      console.log(`[support/chat:deepseek] tool=${tc.name} args=${JSON.stringify(args)} iter=${iter}`);

      let result;
      try { result = await executeTool(tc.name, args, ctx); }
      catch (toolErr) { result = { ok: false, reason: `Tool wrapper threw: ${toolErr.message}` }; }

      const meta = getToolMeta(tc.name);
      console.log(`[support/chat:deepseek] tool=${tc.name} result.ok=${!!(result && result.ok)} emit=${!!(result && result.emit_to_client)} code=${result?.code || ''}`);

      // Destructive tool needs a fresh step-up password confirm — halt the
      // loop and hand control to the client's inline reauth flow. (Rare for
      // user role, which only has non-destructive tools, but mirror the
      // Anthropic loop for safety.)
      if (result && result.code === 'needs_step_up' && result.intent) {
        stepUpHaltIntent = {
          reason: result.reason || 'This action needs you to confirm your password.',
          intent: result.intent,
        };
        break;
      }

      // Client-side tool — forward the renderer directive.
      if (result && result.ok && result.emit_to_client) {
        emitToolCallToClient(tc.id, tc.name, result.emit_to_client);
      }

      sse('tool_result', {
        name: tc.name,
        ok: !!(result && result.ok),
        destructive: !!(meta && meta.destructive),
      });

      // Strip emit_to_client from the model-visible result (renderer
      // plumbing the model doesn't need).
      const modelView = result && typeof result === 'object'
        ? Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'emit_to_client'))
        : { ok: false, reason: 'no result' };

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(modelView),
      });
    }

    if (stepUpHaltIntent) {
      sse('step_up_required', stepUpHaltIntent);
      sse('done', { ok: true });
      return;
    }
  }

  // Iteration cap — graceful close, same copy as the Anthropic loop.
  sse('delta', { text: '\n\n(I made a few attempts here — let me know if you\'d like to try a different approach.)' });
  sse('done', { ok: true });
}

module.exports = {
  runDeepSeekChatLoop,
  getClient,
  convertToolsToOpenAI,
  MODEL,
};
