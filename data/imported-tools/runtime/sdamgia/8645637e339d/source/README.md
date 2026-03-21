# СДАМ ГИА MCP Server

MCP (Model Context Protocol) server for interacting with the **СДАМ ГИА** educational platform. This server enables LLMs to search and retrieve exam problems, solutions, and answers across multiple subjects.

## Features

### 🔍 Smart Search
- **Text Search**: Search problems by keywords
- **Fuzzy Text Matching**: Find problems by condition text with approximate matching
- **Catalog Browsing**: Explore problems by topics and categories

### 📚 Problem Retrieval
- **Single Problem**: Get complete problem details including condition, solution, and answer
- **Batch Fetch**: Retrieve multiple problems efficiently in one request
- **Analog Problems**: Discover similar problems automatically

### 📊 Structured Data
- **Multiple Formats**: Output in JSON or Markdown
- **Rich Metadata**: Access images, topics, and problem relationships
- **Type Safety**: Full TypeScript support with Zod validation

## Supported Subjects

- `math` - Mathematics (профильная)
- `mathb` - Mathematics (базовая)
- `rus` - Russian Language
- `phys` - Physics
- `chem` - Chemistry
- `bio` - Biology
- `geo` - Geography
- `hist` - History
- `soc` - Social Studies
- `inf` - Informatics
- `en` - English
- `de` - German
- `fr` - French
- `sp` - Spanish
- `lit` - Literature

## Installation

### Prerequisites
- Node.js 18+ or 20+
- npm or yarn

### Install

```bash
npm install
npm run build
```

## Installation

### Via npm (Recommended)

```bash
npm install -g sdamgia-mcp-server
```

Or use without installation via npx:

```bash
npx sdamgia-mcp-server
```

### From Source

```bash
git clone https://github.com/art22017/sdamgia-mcp-server.git
cd sdamgia-mcp-server
npm install
npm run build
```

## Configuration

The server can be configured with any MCP-compatible client. Below are instructions for popular platforms:

### Claude Code

**Config file locations:**
- **User scope**: `~/.claude.json` (available across all projects)
- **Project scope**: `.mcp.json` in project root (shared with team)

```json
{
  "mcpServers": {
    "sdamgia": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sdamgia-mcp-server"]
    }
  }
}
```

**Alternative: Via CLI**
```bash
claude mcp add sdamgia --scope user npx -y sdamgia-mcp-server
```

### Cursor

**Config file locations:**
- **Project**: `.cursor/mcp.json` (in project directory)
- **Global**: `~/.cursor/mcp.json` (home directory)

```json
{
  "mcpServers": {
    "sdamgia": {
      "command": "npx",
      "args": ["-y", "sdamgia-mcp-server"]
    }
  }
}
```

**Or via UI:** Settings → Tools & Integrations → MCP Servers → Add New MCP Server

### Kilocode

**Config file locations:**
- **Project**: `.kilocode/mcp.json`
- **Global**: Via Settings → MCP Servers → Edit Global MCP

```json
{
  "mcpServers": {
    "sdamgia": {
      "command": "npx",
      "args": ["-y", "sdamgia-mcp-server"],
      "disabled": false
    }
  }
}
```

**Note:** VS Code and CLI configurations are separate in Kilocode.

### Google Antigravity

**Config file locations:**
- **macOS/Linux**: `~/.config/antigravity/mcp.json` or `~/.gemini/antigravity/mcp_config.json`
- **Windows**: `%APPDATA%\antigravity\mcp.json`

```json
{
  "mcpServers": {
    "sdamgia": {
      "command": "npx",
      "args": ["-y", "sdamgia-mcp-server"],
      "trust": false
    }
  }
}
```

**Or via UI:** Agent panel → Three-dot menu → MCP Servers → Manage MCP Servers

### Gemini CLI

**Config file location:** `~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "sdamgia": {
      "command": "npx",
      "args": ["-y", "sdamgia-mcp-server"]
    }
  }
}
```

### MCP Inspector (for testing)

```bash
npx @modelcontextprotocol/inspector npx -y sdamgia-mcp-server
```

## Usage

Once configured, restart your AI assistant and the server will be available. Use the tools described below.

## Available Tools

### 1. `sdamgia_get_problem`
Retrieve a specific problem by ID.

**Parameters:**
- `subject` (required): Subject code (e.g., "math", "phys")
- `problem_id` (required): Problem ID (numeric string)
- `response_format` (optional): "json" or "markdown" (default: "markdown")

**Example:**
```typescript
{
  "subject": "math",
  "problem_id": "1001",
  "response_format": "markdown"
}
```

### 2. `sdamgia_search_problems`
Search for problems using text query.

**Parameters:**
- `subject` (required): Subject code
- `query` (required): Search query text (3-500 characters)
- `limit` (optional): Max results (1-50, default: 20)
- `response_format` (optional): Output format

**Example:**
```typescript
{
  "subject": "math",
  "query": "вероятность",
  "limit": 10
}
```

### 3. `sdamgia_search_by_text`
Find problems by condition text with fuzzy matching.

**Parameters:**
- `subject` (required): Subject code
- `condition_text` (required): Problem text to search (10-1000 characters)
- `threshold` (optional): Similarity threshold 0-1 (default: 0.6)
- `limit` (optional): Max results (1-50, default: 20)
- `response_format` (optional): Output format

**Example:**
```typescript
{
  "subject": "phys",
  "condition_text": "Найдите силу тока в цепи если сопротивление",
  "threshold": 0.7,
  "limit": 5
}
```

**Use Cases:**
- User has a photo/text of a problem but doesn't know the ID
- Finding similar problems to a given condition
- Matching slight variations in problem wording

### 4. `sdamgia_batch_get_problems`
Retrieve multiple problems at once.

**Parameters:**
- `subject` (required): Subject code
- `problem_ids` (required): Array of problem IDs (1-10 items)
- `response_format` (optional): Output format

**Example:**
```typescript
{
  "subject": "inf",
  "problem_ids": ["1001", "1002", "1003"]
}
```

### 5. `sdamgia_get_catalog`
Get complete catalog structure for a subject.

**Parameters:**
- `subject` (required): Subject code
- `response_format` (optional): Output format

**Example:**
```typescript
{
  "subject": "math",
  "response_format": "json"
}
```

### 6. `sdamgia_get_category_problems`
Get all problems from a specific category.

**Parameters:**
- `subject` (required): Subject code
- `category_id` (required): Category ID (from catalog)
- `limit` (optional): Max results (1-50, default: 20)
- `response_format` (optional): Output format

**Example:**
```typescript
{
  "subject": "math",
  "category_id": "174",
  "limit": 30
}
```

### 7. `sdamgia_get_test`
Get all problems from a test.

**Parameters:**
- `subject` (required): Subject code
- `test_id` (required): Test ID (numeric string)
- `response_format` (optional): Output format

**Example:**
```typescript
{
  "subject": "math",
  "test_id": "1770"
}
```

## Architecture

```
sdamgia-mcp-server/
├── src/
│   ├── index.ts              # Main entry point
│   ├── types.ts              # TypeScript type definitions
│   ├── constants.ts          # Configuration constants
│   ├── services/
│   │   ├── sdamgia-client.ts # API client (web scraping)
│   │   ├── text-utils.ts     # Fuzzy text matching utilities
│   │   └── formatters.ts     # Output formatters
│   ├── schemas/
│   │   └── input-schemas.ts  # Zod validation schemas
│   └── tools/
│       ├── problem-tools.ts  # Problem-related tools
│       └── catalog-tools.ts  # Catalog-related tools
└── dist/                     # Compiled JavaScript
```

## Design Decisions

### 1. **Comprehensive API Coverage**
All major endpoints are exposed as separate tools, giving LLMs maximum flexibility to compose complex workflows.

### 2. **Fuzzy Text Matching**
The `sdamgia_search_by_text` tool uses:
- **Levenshtein distance** for character-level similarity
- **Keyword overlap** for semantic matching
- **Combined scoring** for robust results

This solves the problem of finding problems when text is slightly different (OCR errors, typos, reformatting).

### 3. **Efficient Batch Operations**
Batch tool reduces request overhead when multiple problems are needed, improving performance for LLM agents.

### 4. **Response Format Flexibility**
Both JSON and Markdown outputs:
- **JSON**: For programmatic processing and data extraction
- **Markdown**: For human-readable presentation

### 5. **Request Economy**
- **Caching**: Client could cache frequently accessed data
- **Pagination**: Limits prevent over-fetching
- **Smart Search**: Fuzzy search does broad search first, then filters locally

### 6. **Type Safety**
Full TypeScript + Zod validation ensures:
- Runtime input validation
- Clear error messages
- IDE autocomplete support

## API Endpoints Used

Based on reverse-engineered СДАМ ГИА API:

- `GET /{subject}-ege.sdamgia.ru/problem?id={id}` - Get problem
- `GET /{subject}-ege.sdamgia.ru/search?search={query}` - Search
- `GET /{subject}-ege.sdamgia.ru/test` - Get catalog
- `GET /{subject}-ege.sdamgia.ru/test?id={id}` - Get test
- `GET /{subject}-ege.sdamgia.ru/prob_catalog?category={id}` - Get category

**Note**: This is an unofficial API based on web scraping. No official API exists.

## Limitations

1. **No Official API**: Uses web scraping, may break if site structure changes
2. **Rate Limiting**: No built-in rate limiting (could be added)
3. **No Caching**: Each request hits the server (could add Redis/file cache)
4. **Russian Only**: Platform is in Russian language
5. **Network Required**: Requires internet connection to СДАМ ГИА servers

## Future Enhancements

- [ ] Add request caching layer
- [ ] Implement rate limiting
- [ ] Add support for PDF generation
- [ ] Add image OCR for problem text extraction
- [ ] Add test generation tool
- [ ] Add progress tracking across problems
- [ ] Add HTTP transport for remote deployment

## Contributing

Contributions welcome! Please:
1. Follow existing code style
2. Add tests for new features
3. Update documentation
4. Keep tools focused and composable

## License

MIT License - See LICENSE file for details

## Credits

Based on research from:
- [sdamgia-api](https://github.com/anijackich/sdamgia-api) - Python implementation
- СДАМ ГИА platform - Educational resources

## Disclaimer

This is an unofficial tool for educational purposes. Not affiliated with СДАМ ГИА.
