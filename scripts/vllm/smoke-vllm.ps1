$ErrorActionPreference = "Stop"

$baseUrl = $env:VLLM_BASE_URL
if (-not $baseUrl) {
  $baseUrl = "http://localhost:8000/v1"
}
$baseUrl = $baseUrl.TrimEnd("/")

$model = $env:VLLM_MODEL_ID
if (-not $model) {
  $models = Invoke-RestMethod -Uri "$baseUrl/models" -Method Get
  $model = $models.data[0].id
}

Write-Host "Checking vLLM model list..."
Invoke-RestMethod -Uri "$baseUrl/models" -Method Get | ConvertTo-Json -Depth 8

Write-Host "Checking basic chat..."
$chatBody = @{
  model = $model
  messages = @(
    @{ role = "user"; content = "Say ready in one short sentence." }
  )
  max_tokens = 64
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri "$baseUrl/chat/completions" -Method Post -ContentType "application/json" -Body $chatBody | ConvertTo-Json -Depth 12

Write-Host "Checking action tool call..."
$toolBody = @{
  model = $model
  messages = @(
    @{ role = "user"; content = "Call the action tool with JavaScript that logs the current directory. Do not answer in prose." }
  )
  tools = @(
    @{
      type = "function"
      function = @{
        name = "action"
        description = "Execute TypeScript or JavaScript code."
        parameters = @{
          type = "object"
          properties = @{
            content = @{ type = "string" }
          }
          required = @("content")
          additionalProperties = $false
        }
      }
    }
  )
  tool_choice = "auto"
  max_tokens = 512
} | ConvertTo-Json -Depth 12
Invoke-RestMethod -Uri "$baseUrl/chat/completions" -Method Post -ContentType "application/json" -Body $toolBody | ConvertTo-Json -Depth 16

Write-Host "Checking required TASK_DONE tool call..."
$finishBody = @{
  model = $model
  messages = @(
    @{ role = "user"; content = "Finish now by calling TASK_DONE with message set to done. Do not answer in prose." }
  )
  tools = @(
    @{
      type = "function"
      function = @{
        name = "TASK_DONE"
        description = "Finish the task with a final message."
        parameters = @{
          type = "object"
          properties = @{
            message = @{ type = "string" }
          }
          required = @("message")
          additionalProperties = $false
        }
      }
    }
  )
  tool_choice = @{
    type = "function"
    function = @{ name = "TASK_DONE" }
  }
  max_tokens = 512
} | ConvertTo-Json -Depth 12
Invoke-RestMethod -Uri "$baseUrl/chat/completions" -Method Post -ContentType "application/json" -Body $finishBody | ConvertTo-Json -Depth 16
