<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/605dfa38-23c4-4f4a-9b2e-536f389cc1f0

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Add an AI key in the Settings tab, or set one in [.env.local](.env.local). Gemini is supported, but you can also use OpenRouter, DeepSeek, Kimi/Moonshot, GLM/Z.AI, or any OpenAI-compatible endpoint via `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`.
3. Run the app:
   `npm run dev`
