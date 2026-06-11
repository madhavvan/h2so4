// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ANTHROPIC SUPPORT-BOT CHAT LOOP
//
//  Replacement for the OpenAI Responses-API loop that used to live
//  inline in routes/support.js. Same SSE event surface (delta /
//  tool_call / tool_result / step_up_required / done / error) so the
//  renderer doesn't change. We switch to Claude because:
//    1. Tool-call accuracy on smaller / cheaper OpenAI models was
//       weak — model kept calling search_user with empty args, etc.
//    2. Admin needs the full ~475K-char engineering docs corpus
//       inline; OpenAI's prompt cache is automatic but its discount
//       is smaller than Anthropic's. Claude with `cache_control:
//       ephemeral` brings cached-token cost to ~10% of full price.
//    3. The same ANTHROPIC_API_KEY is already in .env and proven by
//       routes/ai.js (interview model path).
//
//  Tool-use protocol differences vs OpenAI Responses API:
//    OpenAI: function_call output items + function_call_output in
//            next input
//    Anthropic: tool_use blocks inside the assistant message +
//               tool_result blocks inside the NEXT user message
//
//  Streaming differences:
//    OpenAI: delta events for text + function-call arg buffers
//    Anthropic: content_block_delta (text_delta) + tool_use blocks
//               complete arrive as one shape via .stream().finalMessage()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

// Lazy SDK load — same pattern as routes/ai.js. Lets the server boot
// even if the SDK is missing (e.g. partial install) so other routes
// keep working; only the support /chat endpoint degrades.
const _AnthropicMod = (() => {
  try { return require('@anthropic-ai/sdk'); } catch { return null; }
})();
const Anthropic = _AnthropicMod && (_AnthropicMod.default || _AnthropicMod);

const MODEL = process.env.SUPPORT_ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOOL_ITERATIONS = 8;
const MAX_TOKENS_PER_TURN = 16000;

function getClient() {
  if (!Anthropic) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

// Convert our internal OpenAI-style tool definitions to Anthropic's
// input_schema shape. botTools.js defines `parameters` (matches OpenAI
// function-calling spec). Anthropic uses identical JSON Schema but
// nests it as `input_schema`.
function convertToolsToAnthropic(tools) {
  const out = [];
  for (const t of tools || []) {
    // Skip OpenAI's hosted web_search shim — Anthropic has its own
    // hosted web_search tool we add separately below.
    if (t.type === 'web_search') continue;
    out.push({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} },
    });
  }
  return out;
}

// ── Main chat loop ───────────────────────────────────────────
// Mirrors the OpenAI loop's contract:
//   - systemPrompt: the static text the model sees before the chat
//   - toolCatalog: OpenAI-shape tool defs from botTools.js
//   - callerMessages: sanitized chat history (role + content strings)
//   - ctx: tool execution context (user, tier, role, ip, userAgent)
//   - executeTool: botTools.executeTool fn
//   - getToolMeta: botTools.getToolMeta fn
//   - sse(event, data): SSE emitter
//   - emitToolCallToClient(id, name, payload): wraps `sse('tool_call', ...)`
//   - abortSignal: AbortController.signal so client disconnect kills
//                  the upstream stream too
//
// Returns when:
//   - model emits a non-tool-use stop_reason (normal end)
//   - destructive admin tool needs step-up → emits step_up_required + done
//   - max iterations hit → emits soft closing delta + done
//   - abortSignal fires → just returns silently
async function runAnthropicChatLoop({
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

  // Split the system prompt into a cached prefix (stable across
  // requests — the huge knowledge-base + eng-docs block) and a
  // non-cached tail (today's date — changes daily, would invalidate
  // the cache key). Anthropic's cache requires ≥1024 input tokens to
  // activate; our admin prompt is ~130K tokens so this trivially
  // qualifies. After the first request lands, subsequent prompts hit
  // cache at ~10% input price.
  const today = new Date().toISOString().slice(0, 10);
  const system = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Today is ${today}.` },
  ];

  // Anthropic-shape tools. We INCLUDE Anthropic's hosted web_search
  // for parity with the previous OpenAI Responses + web_search setup
  // — admin asks "what's the current Stripe API version?" and the
  // model can answer authoritatively without us paying for a search
  // partner. max_uses=3 caps cost per turn.
  const anthropicTools = convertToolsToAnthropic(toolCatalog);
  anthropicTools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });

  // Convert caller messages to Anthropic format. Both APIs use
  // {role, content} with role ∈ {user, assistant}; content can be a
  // string OR an array of blocks. We keep strings here — only tool
  // turns mid-loop use the block form.
  let messages = (callerMessages || []).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));

  let stepUpHaltIntent = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    if (abortSignal?.aborted) return;

    // Stream the assistant turn. Text deltas flow as SSE; tool_use
    // blocks accumulate until message_stop, then we execute and loop.
    let assistantContent = null;
    let stopReason = 'end_turn';

    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS_PER_TURN,
        system,
        messages,
        tools: anthropicTools,
      }, { signal: abortSignal });

      // Surface text deltas to the user in real time. We DON'T
      // forward tool_use partial JSON — that's noise.
      stream.on('text', (textDelta) => {
        try { sse('delta', { text: String(textDelta) }); }
        catch { /* SSE socket gone */ }
      });

      // The stream emits a `streamEvent` for everything, including
      // server_tool_use (web_search) and server_tool_result events.
      // We surface a single "searching" / "searched" status so the
      // client UI can show the "Searching the web…" indicator like
      // the old OpenAI flow did.
      stream.on('streamEvent', (evt) => {
        try {
          if (evt?.type === 'content_block_start' && evt?.content_block?.type === 'server_tool_use') {
            sse('status', { phase: 'searching' });
          } else if (evt?.type === 'content_block_start' && evt?.content_block?.type === 'web_search_tool_result') {
            sse('status', { phase: 'searched' });
          }
        } catch { /* SSE socket gone */ }
      });

      const finalMessage = await stream.finalMessage();
      assistantContent = finalMessage.content || [];
      stopReason = finalMessage.stop_reason || 'end_turn';
    } catch (err) {
      // Client disconnect — abortSignal propagated through SDK.
      // Bail silently rather than streaming an error.
      if (err?.name === 'AbortError' || abortSignal?.aborted) return;
      console.error('[anthropic-support] stream failed:', err && err.message);
      sse('delta', { text: '\n\nSorry — I\'m having trouble reaching the model right now. Try again in a moment, or use "Talk to a human" below.' });
      sse('done', { ok: true });
      return;
    }

    if (stopReason !== 'tool_use') {
      // Normal end — text already streamed. Close out.
      sse('done', { ok: true });
      return;
    }

    // The assistant requested tool calls. Push the full assistant
    // message (text + tool_use blocks) into the conversation, then
    // build a single user-role response carrying tool_result blocks.
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResultBlocks = [];
    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;
      // Anthropic's hosted web_search server-side tool is named
      // 'web_search' but executes inside Anthropic — we never see
      // it as a tool_use to run locally. If we did somehow, skip.
      if (block.name === 'web_search') continue;

      console.log(`[support/chat:anthropic] tool=${block.name} args=${JSON.stringify(block.input)} iter=${iter}`);

      let result;
      try {
        result = await executeTool(block.name, block.input || {}, ctx);
      } catch (toolErr) {
        result = { ok: false, reason: `Tool wrapper threw: ${toolErr.message}` };
      }

      const meta = getToolMeta(block.name);
      console.log(`[support/chat:anthropic] tool=${block.name} result.ok=${!!(result && result.ok)} emit=${!!(result && result.emit_to_client)} code=${result?.code || ''}`);

      // Destructive admin tool needs a fresh step-up password
      // confirmation. Stop the loop and hand control to the client's
      // inline reauth flow.
      if (result && result.code === 'needs_step_up' && result.intent) {
        stepUpHaltIntent = {
          reason: result.reason || 'This action needs you to confirm your password.',
          intent: result.intent,
        };
        break;
      }

      // Client-side tool — forward the directive to the renderer
      // and synthesize an ok:true result for the model loop.
      if (result && result.ok && result.emit_to_client) {
        emitToolCallToClient(block.id, block.name, result.emit_to_client);
      }

      // Light telemetry the renderer may or may not surface.
      sse('tool_result', {
        name: block.name,
        ok: !!(result && result.ok),
        destructive: !!(meta && meta.destructive),
      });

      // Strip emit_to_client from the model-visible result — the
      // model doesn't need to know renderer plumbing, just whether
      // the action succeeded.
      const modelView = result && typeof result === 'object'
        ? Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'emit_to_client'))
        : { ok: false, reason: 'no result' };

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(modelView),
      });
    }

    if (stepUpHaltIntent) {
      sse('step_up_required', stepUpHaltIntent);
      sse('done', { ok: true });
      return;
    }

    // Hand the tool results back to Claude as the next user turn.
    messages.push({ role: 'user', content: toolResultBlocks });
  }

  // Hit the iteration cap. Stream a graceful close.
  sse('delta', { text: '\n\n(I made a few attempts here — let me know if you\'d like to try a different approach.)' });
  sse('done', { ok: true });
}

module.exports = {
  runAnthropicChatLoop,
  getClient,
  convertToolsToAnthropic,
  MODEL,
};
