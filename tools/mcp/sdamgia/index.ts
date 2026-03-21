import { invokeImportedMethod, isImportedInputObject } from '../../../src/imported-tools/runtime.js';



/** **Retrieves a complete problem from the СДАМ ГИА database by its unique identifier.**

**When to use:**
- You have a specific problem ID and need its full details
- You need to see the problem statement, solution, answer, and similar problems
- You want to reference an exact problem from the СДАМ ГИА database

**Parameters:**
- `subject` (required): Subject code (e.g., 'math', 'phys', 'inf', 'rus', 'chem', 'bio', 'geo', 'hist', 'soc', 'en', 'de', 'fr', 'sp', 'lit')
- `problem_id` (required): Numeric problem ID as a string (e.g., "12345")
- `response_format` (optional): Output format - 'markdown' (default, human-readable) or 'json' (structured data)

**Returns:**
A complete problem object containing:
- **condition**: The problem statement (text and optional HTML/images)
- **solution**: Step-by-step solution with explanations
- **answer**: The correct answer
- **similar_problems**: List of related problem IDs for further practice
- **metadata**: Problem ID, subject, difficulty level where available

**Response format:**
- **Markdown**: Formatted text with sections for condition, solution, answer, and similar problems
- **JSON**: Structured object with all problem data as nested objects/arrays

**Example:**
Getting a specific math problem:
```json
{
  "subject": "math",
  "problem_id": "54321",
  "response_format": "markdown"
}
```

**Notes:**
- Problem IDs must be numeric strings (digits only)
- The problem_id must exist in the specified subject database
- Some problems may not have solutions available
- Similar problems are automatically included for practice
- Use this tool when you need exact problem details, not for searching */
export async function getProblem(inputOrFirst: { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "problem_id": string; "response_format"?: "json" | "markdown"; } | "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit" = {} as { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "problem_id": string; "response_format"?: "json" | "markdown"; }, problem_id: string, response_format?: "json" | "markdown"): Promise<unknown> {
  const input = isImportedInputObject(inputOrFirst)
    ? inputOrFirst
    : {
        "subject": inputOrFirst,
        "problem_id": problem_id,
        "response_format": response_format,
      };
  return invokeImportedMethod(new URL('./import.manifest.json', import.meta.url), "getProblem", input);
}

/** **Searches for problems in the СДАМ ГИА database using a text-based query.**

**When to use:**
- You want to find problems related to a specific topic (e.g., "quadratic equations", "Newton's laws")
- You're exploring available problems in a subject area
- You need to discover problem IDs before fetching full details
- You want to browse problems by keywords or concepts

**Parameters:**
- `subject` (required): Subject code to search within (e.g., 'math', 'phys', 'inf')
- `query` (required): Search text - minimum 3 characters, maximum 500 characters. Use descriptive terms like "triangle area", "oxidation reactions", "grammar rules"
- `limit` (optional): Maximum number of results (1-50, default: 20)
- `response_format` (optional): 'markdown' (default) or 'json'

**Returns:**
A list of matching problems with:
- **problem_ids**: Array of problem IDs matching the search query
- **total**: Count of results returned
- In markdown format: numbered list with clickable links to each problem

**Search behavior:**
- Performs text-based matching against problem descriptions and metadata
- Results are ranked by relevance to your query
- Search is optimized for subject-specific terminology
- Broad search that returns problem IDs only (not full problem details)

**Response format:**
- **Markdown**: Formatted list with problem IDs and subject context
- **JSON**: Object with problem_ids array and total count

**Example usage:**
```json
{
  "subject": "math",
  "query": "derivative of trigonometric functions",
  "limit": 10,
  "response_format": "markdown"
}
```

**Follow-up workflow:**
1. Use this tool to find relevant problem IDs
2. Use `sdamgia_get_problem` or `sdamgia_batch_get_problems` to fetch full details

**Notes:**
- Query must be at least 3 characters for meaningful results
- Maximum 50 results per search (use limit parameter)
- Search returns IDs only - follow up with get_problem for details
- For exact text matching with problem conditions, use `sdamgia_search_by_text` instead
- Subject-specific terminology works best for quality results */
export async function searchProblems(input: { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "query": string; "limit"?: number; "response_format"?: "json" | "markdown"; } = {} as { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "query": string; "limit"?: number; "response_format"?: "json" | "markdown"; }): Promise<unknown> {
  const normalizedInput = isImportedInputObject(input) ? input : {};
  return invokeImportedMethod(new URL('./import.manifest.json', import.meta.url), "searchProblems", normalizedInput);
}

/** **Finds problems by matching against their full condition text using fuzzy text similarity algorithms.**

**When to use:**
- You have a problem's exact condition text but don't know its ID
- You're looking for problems similar to one you've seen before
- You want to find problems with nearly identical wording
- You need to detect duplicate or similar problems across the database
- You have partial problem text and want to find the closest matches

**How it works:**
1. Performs a broad search to find candidate problems
2. Fetches the full condition text for each candidate
3. Applies fuzzy text matching to calculate similarity scores
4. Returns problems that exceed the similarity threshold

**Parameters:**
- `subject` (required): Subject code to search within
- `condition_text` (required): The problem condition text to match against (10-1000 characters). Provide as much of the original problem text as possible for best results.
- `threshold` (optional): Similarity threshold from 0.0 to 1.0 (default: 0.6). Higher values = stricter matching. Recommended: 0.5-0.7 for approximate matches, 0.8+ for exact matches.
- `limit` (optional): Maximum number of matches to return (1-50, default: 20)
- `response_format` (optional): 'markdown' (default) or 'json'

**Returns:**
- **matches**: Array of matching problems, each containing:
  - `problem_id`: The matched problem's ID
  - `similarity`: Score from 0-1 indicating how closely the text matches (higher = better match)
- **total**: Number of matches found

**Similarity scores:**
- 1.0: Exact match (identical text)
- 0.8-0.99: Very close match (minor differences in wording)
- 0.6-0.79: Similar problem (same concept, different phrasing)
- 0.4-0.59: Somewhat related (loosely connected)
- <0.4: Poor match (not recommended)

**Example usage:**
```json
{
  "subject": "math",
  "condition_text": "Find the area of a triangle with sides 3, 4, and 5 units.",
  "threshold": 0.7,
  "limit": 5,
  "response_format": "markdown"
}
```

**Best practices:**
- Include the complete problem condition for best matching
- For exact duplicates, set threshold to 0.9 or higher
- For similar problems, use threshold around 0.6-0.7
- If you get too many results, increase the threshold
- If you get no results, decrease the threshold

**Notes:**
- Condition text must be at least 10 characters
- Fuzzy matching is computationally intensive - results may take longer
- Searches broader than the limit, then applies fuzzy filtering
- Some results may have lower similarity than expected due to formatting differences
- For keyword-based searches, use `sdamgia_search_problems` instead
- Follow up with `sdamgia_get_problem` to see full problem details */
export async function searchByText(input: { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "condition_text": string; "threshold"?: number; "limit"?: number; "response_format"?: "json" | "markdown"; } = {} as { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "condition_text": string; "threshold"?: number; "limit"?: number; "response_format"?: "json" | "markdown"; }): Promise<unknown> {
  const normalizedInput = isImportedInputObject(input) ? input : {};
  return invokeImportedMethod(new URL('./import.manifest.json', import.meta.url), "searchByText", normalizedInput);
}

/** **Efficiently retrieves multiple complete problems from the СДАМ ГИА database in a single request.**

**When to use:**
- You have multiple problem IDs and need all their details
- You want to compare several problems side-by-side
- You're building a problem set or practice collection
- You need to fetch related problems after a search
- You want to reduce API calls compared to individual get_problem requests

**Parameters:**
- `subject` (required): Subject code for all problems (all IDs must belong to this subject)
- `problem_ids` (required): Array of problem IDs to fetch. Must include 1-10 problem IDs as numeric strings (e.g., ["12345", "67890", "54321"])
- `response_format` (optional): 'markdown' (default) or 'json'

**Returns:**
- **problems**: Array of complete problem objects, each containing:
  - **condition**: Full problem statement with text and optional HTML/images
  - **solution**: Detailed step-by-step solution
  - **answer**: The correct answer
  - **similar_problems**: Related problem IDs
  - **metadata**: Problem ID, subject, difficulty level
- **total**: Number of problems successfully fetched

**Response format:**
- **Markdown**: Formatted text with each problem in a separate section, clearly delineated with problem IDs
- **JSON**: Structured object with problems array and metadata

**Example usage:**
```json
{
  "subject": "math",
  "problem_ids": ["12345", "67890", "54321", "11111", "22222"],
  "response_format": "markdown"
}
```

**Typical workflow:**
1. Use `sdamgia_search_problems` to find relevant problem IDs
2. Pass the IDs to this tool for batch retrieval
3. Review all problems together for comparison or practice

**Performance benefits:**
- Single API call instead of multiple individual calls
- Faster than sequential `sdamgia_get_problem` requests
- Ideal for fetching 2-10 problems at once
- Reduces network overhead and latency

**Constraints:**
- Maximum 10 problems per batch request
- All problem IDs must be valid numeric strings
- All problems must be from the same subject
- Invalid IDs will cause the entire batch to fail
- Fetching many problems may return large responses

**Error handling:**
- If any problem ID is invalid or not found, the entire batch fails
- Make sure all IDs exist in the subject before batching
- Consider splitting into smaller batches if you encounter errors

**Notes:**
- Batch size is limited to 10 to prevent excessive response sizes
- Use when you need full problem details, not just IDs
- For searching, use `sdamgia_search_problems` first
- Each problem includes similar problems for extended practice
- All problems in batch are fetched in parallel for speed */
export async function batchGetProblems(input: { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "problem_ids": string[]; "response_format"?: "json" | "markdown"; } = {} as { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "problem_ids": string[]; "response_format"?: "json" | "markdown"; }): Promise<unknown> {
  const normalizedInput = isImportedInputObject(input) ? input : {};
  return invokeImportedMethod(new URL('./import.manifest.json', import.meta.url), "batchGetProblems", normalizedInput);
}

/** Retrieves the complete hierarchical catalog structure for a specified subject, including all topics, subtopics, and problem categories with their unique identifiers.

**PURPOSE:**
This is the primary discovery tool for exploring what problem content is available on the platform. It returns the full taxonomy of problem categories organized by topics, enabling you to navigate and find specific types of problems.

**WHEN TO USE:**
- Always use this FIRST when exploring a new subject to understand its structure
- Use when you need to find category IDs for other tools (required prerequisite for sdamgia_get_category_problems)
- Use when you need to understand the organization and topics available for a subject
- Use when building problem sets and need to browse available content
- Essential for discovering what problem types exist before querying specific categories

**KEY PARAMETERS:**
- subject (required): The subject identifier (e.g., 'ege', 'oge', 'math')
- response_format (optional): Output format - 'json' for structured data, 'markdown' for formatted text (default: 'json')

**RESPONSE FORMAT:**
Returns an array of catalog entries, where each entry contains:
- name: Human-readable topic/category name
- id: Unique category identifier (required for other tools)
- children: Optional array of subcategories (nested hierarchy)

The response is hierarchical - categories may contain subcategories, and leaf nodes represent actual problem categories you can query.

**IMPORTANT NOTES:**
- This tool ONLY returns category structure and IDs, NOT actual problems
- Must be called before using sdamgia_get_category_problems to obtain valid category_id values
- Category IDs are specific to each subject - the same ID may mean different things across subjects
- The catalog structure can change over time as new content is added
- Response size can be large for comprehensive subjects

**EXAMPLE WORKFLOW:**
1. Call sdamgia_get_catalog(subject='ege') to get all EGE categories
2. Parse response to find desired category (e.g., "Quadratic Equations" with id='12345')
3. Use category_id='12345' with sdamgia_get_category_problems to get actual problems

**TYPICAL USE CASES:**
- "Show me all available topics for EGE mathematics"
- "What categories exist under 'Algebra' for OGE?"
- "Find the category ID for trigonometry problems"
- "Browse the complete problem catalog structure" */
export async function getCatalog(inputOrFirst: { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "response_format"?: "json" | "markdown"; } | "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit" = {} as { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "response_format"?: "json" | "markdown"; }, response_format?: "json" | "markdown"): Promise<unknown> {
  const input = isImportedInputObject(inputOrFirst)
    ? inputOrFirst
    : {
        "subject": inputOrFirst,
        "response_format": response_format,
      };
  return invokeImportedMethod(new URL('./import.manifest.json', import.meta.url), "getCatalog", input);
}

/** Retrieves all problem identifiers belonging to a specific problem category within a subject.

**PURPOSE:**
Fetches the complete list of unique problem IDs for problems classified under a specific category. This enables you to identify exactly which problems exist in a category before retrieving their full details or solutions.

**WHEN TO USE:**
- Use AFTER obtaining a category_id from sdamgia_get_catalog (required prerequisite)
- Use when you need to see all available problems in a specific category
- Use when building problem sets from particular topics
- Use when you need to count how many problems exist in a category
- Use when selecting specific problems before fetching their full content
- Essential for batch operations on category-level problem sets

**KEY PARAMETERS:**
- subject (required): The subject identifier (e.g., 'ege', 'oge', 'math')
- category_id (required): Unique category identifier obtained from sdamgia_get_catalog
- limit (optional): Maximum number of problem IDs to return (for pagination or sampling)
- response_format (optional): Output format - 'json' for structured data, 'markdown' for formatted text (default: 'json')

**PARAMETER CONSTRAINTS:**
- category_id MUST be a valid ID from the catalog - invalid IDs will return errors
- If category has no problems, returns empty array
- limit parameter truncates results if specified; otherwise returns all problems
- Category IDs are subject-specific - same ID may exist in multiple subjects but refer to different content

**RESPONSE FORMAT:**
Returns an array of problem ID strings/numbers:
- Each ID represents a unique problem that can be fetched with other tools
- IDs are typically numeric but returned as strings
- Order of IDs may not be sequential or sorted
- Array may be empty for new or unused categories
- Total count of problems is included in response metadata

**IMPORTANT NOTES:**
- This tool ONLY returns problem IDs, NOT problem content, statements, or solutions
- You MUST call sdamgia_get_catalog first to obtain valid category_id values
- category_id values are case-sensitive and must match exactly from catalog
- Large categories may return hundreds or thousands of IDs
- The same problem ID may appear in multiple categories (cross-categorized content)
- Invalid or expired category IDs will cause the request to fail

**EXAMPLE WORKFLOW:**
1. Call sdamgia_get_catalog(subject='ege') to browse categories
2. Find desired category (e.g., id='12345' for "Derivatives")
3. Call sdamgia_get_category_problems(subject='ege', category_id='12345')
4. Receive array: [1001, 1002, 1005, 1102, ...]
5. Use individual problem IDs with sdamgia_get_problem to get full content

**TYPICAL USE CASES:**
- "Get all problems in the 'Quadratic Equations' category for EGE"
- "List first 50 problems from category ID 54321"
- "How many practice problems exist for this topic?"
- "Collect all problem IDs for a specific category to analyze difficulty distribution"
- "Build a randomized problem set from category 67890" */
export async function getCategoryProblems(input: { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "category_id": string; "limit"?: number; "response_format"?: "json" | "markdown"; } = {} as { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "category_id": string; "limit"?: number; "response_format"?: "json" | "markdown"; }): Promise<unknown> {
  const normalizedInput = isImportedInputObject(input) ? input : {};
  return invokeImportedMethod(new URL('./import.manifest.json', import.meta.url), "getCategoryProblems", normalizedInput);
}

/** Retrieves all problem identifiers that comprise a specific test or examination variant.

**PURPOSE:**
Fetches the complete list of problem IDs that make up a predefined test or exam variant. Tests are curated collections of problems designed to simulate actual exam conditions or assess specific skill sets.

**WHEN TO USE:**
- Use when you need to see all problems in a specific test variant or exam
- Use when working with practice tests or mock exams
- Use when you need the complete problem set for timed test simulations
- Use when analyzing test composition or difficulty distribution
- Use when preparing for real exams by reviewing official test variants
- Essential for accessing complete, ready-made problem collections

**KEY PARAMETERS:**
- subject (required): The subject identifier (e.g., 'ege', 'oge', 'math')
- test_id (required): Unique identifier for the specific test/variant to retrieve
- response_format (optional): Output format - 'json' for structured data, 'markdown' for formatted text (default: 'json')

**PARAMETER CONSTRAINTS:**
- test_id must be a valid, existing test identifier for the specified subject
- Invalid test IDs will result in errors or empty results
- Test IDs are typically numeric but may include alphanumeric codes
- Not all test IDs may be publicly accessible or available
- Test availability may vary by subject and time period

**RESPONSE FORMAT:**
Returns an array of problem ID strings/numbers:
- Each ID represents a problem in the test sequence
- IDs are returned in test order (first problem to last)
- Tests typically contain 5-25 problems depending on exam type
- Total count of problems is included in response metadata
- Problems are already curated and balanced by difficulty/topic

**IMPORTANT NOTES:**
- This tool ONLY returns problem IDs, NOT problem content, statements, or solutions
- Test IDs are different from category IDs - they reference specific exam variants
- Test composition is fixed and determined by test creators
- The same problem may appear in multiple tests
- Tests are designed to be completed within specific time limits
- Some tests may include special instructions or sections not visible in ID list
- Test availability may be limited by region, year, or exam board

**DISTINCTION FROM CATEGORY QUERIES:**
Unlike sdamgia_get_category_problems which fetches all problems from a topic, this tool fetches problems from a specific, curated test variant. Tests are pre-assembled problem sets, while categories are thematic collections.

**EXAMPLE WORKFLOW:**
1. Obtain test_id from external source (e.g., 'ege-2023-variant-123' or numeric ID)
2. Call sdamgia_get_test(subject='ege', test_id='12345')
3. Receive ordered array: [5001, 5002, 5003, 5004, 5005, ...]
4. Use individual problem IDs with sdamgia_get_problem for full content
5. Present problems in order to simulate actual exam experience

**TYPICAL USE CASES:**
- "Get all problems from EGE 2023 variant 15"
- "Show me the complete problem list for OGE practice test 7"
- "Retrieve all problems in diagnostic test variant 42"
- "What problems are included in the final exam simulation test?"
- "Fetch the problem IDs for yesterday's practice test"

**PRACTICAL APPLICATIONS:**
- Creating timed practice sessions with real exam variants
- Analyzing difficulty patterns in official tests
- Comparing problem distributions across different test years
- Building test preparation schedules using official variants
- Reviewing complete test content before exam day */
export async function getTest(inputOrFirst: { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "test_id": string; "response_format"?: "json" | "markdown"; } | "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit" = {} as { "subject": "math" | "mathb" | "rus" | "phys" | "chem" | "bio" | "geo" | "hist" | "soc" | "inf" | "en" | "de" | "fr" | "sp" | "lit"; "test_id": string; "response_format"?: "json" | "markdown"; }, test_id: string, response_format?: "json" | "markdown"): Promise<unknown> {
  const input = isImportedInputObject(inputOrFirst)
    ? inputOrFirst
    : {
        "subject": inputOrFirst,
        "test_id": test_id,
        "response_format": response_format,
      };
  return invokeImportedMethod(new URL('./import.manifest.json', import.meta.url), "getTest", input);
}

