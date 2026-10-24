// One structured-output call to Claude, shared by the vendor matcher and the recap writer.
// Returns the parsed JSON, or null when there is no client, Claude declines, or anything fails,
// so callers fall back to their non-AI answer.
const Anthropic = require('@anthropic-ai/sdk');
const { MODEL } = require('./assistant');

const clientFor = (apiKey = process.env.ANTHROPIC_API_KEY) => (apiKey ? new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 }) : null);

async function askJson(client, { label, system, content, schema, effort = 'low', maxTokens = 4096 }) {
  if (!client) return null;
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    const block = response.content.find((b) => b.type === 'text');
    return block ? JSON.parse(block.text) : null;
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.warn(`${label}: Claude API error`, err.status, err.message);
    else console.warn(`${label} failed:`, err.message);
    return null;
  }
}

module.exports = { askJson, clientFor };
