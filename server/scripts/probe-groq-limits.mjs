// What are this org's per-model Groq limits, exactly? The interview route
// 413s on every request; the cover route on the same key never does. The
// difference has to be visible in the rate-limit headers.
const KEY = process.env.GROQ_API_KEY;
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b'];

for (const model of MODELS) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    });
    const h = res.headers;
    console.log(`${model.padEnd(32)} status=${res.status} TPM=${h.get('x-ratelimit-limit-tokens')} remaining=${h.get('x-ratelimit-remaining-tokens')} RPM=${h.get('x-ratelimit-limit-requests')}`);
    if (!res.ok) console.log('   ', (await res.text()).slice(0, 200));
  } catch (e) {
    console.log(`${model.padEnd(32)} ERROR ${e.message}`);
  }
}
