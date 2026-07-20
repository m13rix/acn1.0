$ErrorActionPreference = "Stop"

$BaseUrl = "http://127.0.0.1:5001/v1"
$Model = "qwen3.6-27b-autoround"

$headers = @{
  "Content-Type" = "application/json"
  "Authorization" = "Bearer EMPTY"
}

$chatBody = @{
  model = $Model
  messages = @(
    @{ role = "user"; content = "Give a concise three-step plan for debugging a failing unit test." }
  )
  max_tokens = 800
} | ConvertTo-Json -Depth 10

$chat = Invoke-RestMethod -Method Post -Uri "$BaseUrl/chat/completions" -Headers $headers -Body $chatBody -TimeoutSec 300
Write-Host "Chat answer:"
Write-Host $chat.choices[0].message.content
Write-Host ""
Write-Host "Usage:"
$chat.usage | ConvertTo-Json -Depth 5

$toolBody = @{
  model = $Model
  messages = @(
    @{ role = "user"; content = "Use the action tool to inspect the current directory with a safe command. Do not answer normally." }
  )
  tools = @(
    @{
      type = "function"
      function = @{
        name = "action"
        description = "Run one local shell command."
        parameters = @{
          type = "object"
          properties = @{
            command = @{ type = "string" }
            reason = @{ type = "string" }
          }
          required = @("command", "reason")
        }
      }
    },
    @{
      type = "function"
      function = @{
        name = "TASK_DONE"
        description = "Finish the task."
        parameters = @{
          type = "object"
          properties = @{
            message = @{ type = "string" }
          }
          required = @("message")
        }
      }
    }
  )
  tool_choice = "auto"
  max_tokens = 800
} | ConvertTo-Json -Depth 20

$tool = Invoke-RestMethod -Method Post -Uri "$BaseUrl/chat/completions" -Headers $headers -Body $toolBody -TimeoutSec 300
Write-Host ""
Write-Host "Tool-call response:"
$tool.choices[0].message | ConvertTo-Json -Depth 20

