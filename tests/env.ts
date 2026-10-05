/**
 * Loaded before every test file (package.json "test"). Tests must never reach a real provider,
 * so provider keys from the machine running them are cleared first: a developer's own
 * OPENROUTER_API_KEY or GEMINI_API_KEY would otherwise turn a test into a paid network call.
 * A test that needs a key sets one of its own and stubs the call.
 */
for (const name of [
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'OPENAI_API_KEY',
  'INNOVISTA_SETUP_TOKEN',
])
  delete process.env[name];
