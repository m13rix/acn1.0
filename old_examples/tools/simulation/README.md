# Simulation Tool

LLM-based human behavior simulation and prediction using Gemini 2.5 Pro.

## Environment
- GEMINI_API_KEY must be set.

## Files
- `system_prompt.txt` — system instructions.
- `models/{id}.json` — per-individual conversation history, newline-friendly JSON.

## API
```js
await simulation.run(13, "detailed Scenario description", "Initial SystemState");
```

The tool streams output to console with colored, readable formatting and returns the final concatenated string.
