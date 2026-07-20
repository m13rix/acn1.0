$ErrorActionPreference = "Stop"

$baseUrl = $env:VLLM_BASE_URL
if (-not $baseUrl) {
  $baseUrl = "http://localhost:8000/v1"
}
$baseUrl = $baseUrl.TrimEnd("/")

$model = $env:VLLM_MODEL_ID
if (-not $model) {
  $model = "cyankiwi/Qwen3.6-27B-AWQ-INT4"
}

$enableThinking = $true
if ($env:VLLM_TEST_ENABLE_THINKING -and $env:VLLM_TEST_ENABLE_THINKING.ToLowerInvariant() -in @("0", "false", "no")) {
  $enableThinking = $false
}

$maxTokens = 1600
if ($env:VLLM_TEST_MAX_TOKENS) {
  $maxTokens = [int]$env:VLLM_TEST_MAX_TOKENS
}

$task = @"
You are testing a local coding model. Solve this task carefully but concisely.

Find the bug in this TypeScript function, explain why it happens, and provide a corrected implementation:

```ts
export function latestById<T extends { id: string; updatedAt: string }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const previous = result.get(item.id);
    if (!previous || previous.updatedAt > item.updatedAt) {
      result.set(item.id, item);
    }
  }
  return result;
}
```

Return:
1. The bug.
2. A fixed implementation.
3. One minimal test case that would catch it.
"@

$body = @{
  model = $model
  messages = @(
    @{
      role = "system"
      content = "You are a senior TypeScript engineer. Always include the final answer. Keep the final answer practical and compact."
    },
    @{
      role = "user"
      content = $task
    }
  )
  max_tokens = $maxTokens
  temperature = 0.6
  chat_template_kwargs = @{
    enable_thinking = $enableThinking
  }
} | ConvertTo-Json -Depth 20

Write-Host "Testing vLLM model: $model"
Write-Host "Endpoint: $baseUrl/chat/completions"
Write-Host "Thinking enabled: $enableThinking"
Write-Host ""

$started = Get-Date
$response = Invoke-RestMethod `
  -Uri "$baseUrl/chat/completions" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body `
  -TimeoutSec 300
$elapsed = ((Get-Date) - $started).TotalSeconds

$choice = $response.choices[0]
$message = $choice.message
$usage = $response.usage
$completionTokens = 0.0
$promptTokens = 0.0
$totalTokens = 0.0
if ($null -ne $usage.completion_tokens) {
  $completionTokens = [double]$usage.completion_tokens
}
if ($null -ne $usage.prompt_tokens) {
  $promptTokens = [double]$usage.prompt_tokens
}
if ($null -ne $usage.total_tokens) {
  $totalTokens = [double]$usage.total_tokens
}
$tokensPerSecond = if ($elapsed -gt 0 -and $completionTokens -gt 0) {
  $completionTokens / $elapsed
} else {
  0
}

Write-Host "=== Timing ==="
Write-Host ("Elapsed: {0:n2}s" -f $elapsed)
Write-Host ("Prompt tokens: {0}" -f $promptTokens)
Write-Host ("Completion tokens: {0}" -f $completionTokens)
Write-Host ("Total tokens: {0}" -f $totalTokens)
Write-Host ("Approx completion tok/s: {0:n2}" -f $tokensPerSecond)
Write-Host ("Finish reason: {0}" -f $choice.finish_reason)
Write-Host ""

if ($message.reasoning) {
  Write-Host "=== Reasoning ==="
  Write-Host $message.reasoning
  Write-Host ""
}

Write-Host "=== Answer ==="
Write-Host $message.content
