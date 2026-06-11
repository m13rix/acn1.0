# Worker Step 2: Gather Evidence And High-Upside Seeds

Gather enough evidence before route generation and ranking.

You have **three information channels**. Use ALL of them — not just one:

---

## Channel 1: Memory (personal context about Subject 13)

Memory is your **first and best** source. It contains personal facts about Subject 13: history, preferences, constraints, psychology, energy profile, prior strategy results, and doctrine.

Always start here. Search memory with specific queries about the user's situation.

```typescript
// Search for personal context relevant to the problem
const profile = await memory.search("Subject 13 personality constraints energy profile");
const history = await memory.search("what has worked or failed for Subject 13 in similar situations");
const resources = await memory.search("Subject 13 available resources tools skills");
```

Memory answers: *What do we already know about THIS person and their situation?*

**But memory has limits.** It stores personal knowledge — it does NOT contain:
- professional domain expertise, scientific studies, or best practices;
- methods, frameworks, and precedents from the broader field;
- current market data, statistics, or recent developments;
- how other people have solved similar problems.

When memory returns thin results or the problem requires domain expertise → move to Channel 2.

---

## Channel 2: Web Search (professional knowledge, methods, precedents)

The web is your source for **domain expertise and real-world evidence**. Use it to find:
- how actual professionals and researchers solve this type of problem;
- studies, frameworks, proven methods, and best practices;
- statistics, benchmarks, and real-world outcomes;
- creative approaches, case studies, and unconventional solutions;
- current information that memory cannot contain.

**Use `search.answer()` for focused questions:**

```typescript
// Get a grounded answer with source URLs
const methods = await search.answer(
  "most effective evidence-based methods for [specific problem domain]",
  { searchDepth: "advanced", output: "answerAndUrls" }
);

// Find real-world case studies and precedents
const cases = await search.answer(
  "case studies of people successfully solving [specific challenge] under [specific constraints]",
  { searchDepth: "advanced", output: "answerAndSources" }
);

// Research specific techniques or frameworks
const frameworks = await search.answer(
  "[domain] best frameworks for [specific sub-problem] 2024 2025",
  { output: "answerAndUrls" }
);
```

**Use `search.search()` when you need raw URLs to crawl deeper:**

```typescript
// Find detailed guides and research
const urls = await search.search(
  "research paper practical guide [specific method] effectiveness",
  { maxResults: 5, searchDepth: "advanced", output: "full" }
);
```

**Use `search.research()` for deep multi-source investigation:**

```typescript
// Deep research on a complex topic — Exa will search and synthesize multiple sources
const deep = await search.research(
  "Comprehensive analysis of [specific approach] for [specific situation]: effectiveness rates, common pitfalls, optimal implementation strategies, and comparison with alternatives"
);
```

**When to search the web:**
- ALWAYS search when the problem involves a professional domain (health, finance, law, engineering, psychology, business, etc.);
- ALWAYS search when you need to know what methods actually work in practice;
- ALWAYS search when memory has gaps in domain knowledge;
- Search when you want high-upside creative ideas that memory wouldn't contain;
- Search when you need current data or recent developments.

**Personalize your search queries.** Don't search generically — use Subject 13's constraints:

```typescript
// ❌ Generic — useless
await search.answer("how to get better at studying");

// ✅ Personalized — useful
await search.answer(
  "effective study methods for someone with ADHD and limited evening energy who needs to learn [specific subject] in [timeframe]",
  { searchDepth: "advanced", output: "answerAndSources" }
);
```

---

## Channel 3: Ask Subject 13 (clarifications, permissions, personal facts)

When you need information that is **personal to Subject 13 but not in memory**, ASK THEM.

Use `message.ask()` — it sends a Telegram message and waits for a reply.

**Ask when:**
- memory doesn't have a personal fact you need (schedule, preferences, budget, current state);
- you need permission or buy-in for a specific direction;
- there's ambiguity about what the user actually wants;
- you need to verify an assumption before building a strategy around it;
- you need context that only the user can provide (relationships, obligations, access to resources).

```typescript
// Ask about constraints not found in memory
const budget = await message.ask(
  "For this strategy I need to understand your budget constraints. How much can you realistically allocate to this per month?"
);

// Clarify ambiguous goals
const priority = await message.ask(
  "I see two possible directions: [A] optimizes for speed but is higher risk, [B] is slower but more reliable. Which matters more to you right now — speed or safety?"
);

// Get missing personal context
const schedule = await message.ask(
  "What does your typical weekday look like? When are your high-energy hours, and when do you usually feel drained?"
);

// Verify assumptions
const confirm = await message.ask(
  "I'm assuming you have access to [X] and that [Y constraint] still applies. Is that correct, or has anything changed?"
);
```

**Do NOT ask for things you can find yourself.** Don't waste Subject 13's time on questions that memory or web search can answer. Ask only for genuinely personal, permission-based, or ambiguous information.

---

## Evidence Gathering Flow

Follow this sequence:

1. **Memory first** — search for personal context, prior results, doctrine, and known constraints. Run 2–4 targeted memory searches minimum.

2. **Web search for domain knowledge** — search for professional methods, studies, and precedents relevant to the problem. Run at least 1–3 web searches. More for complex or unfamiliar domains.

3. **Identify gaps** — after memory + web, ask: *What critical information is still missing?*

4. **Ask Subject 13** — if gaps are personal or require permission, use `message.ask()`. Batch your questions — don't ask one thing at a time if you can ask 2–3 things in one message.

5. **Label everything:**
   - **FACT** — confirmed from memory, web source, or user response;
   - **ASSUMPTION** — reasonable inference, state what it depends on;
   - **INFERENCE** — derived from combining facts, show the chain;
   - **UNKNOWN** — could flip ranking if resolved, flag for follow-up.

---

## High-Upside Candidate Rule

While gathering evidence, actively collect candidates that could be transformative:
- include indirect, weird, preparatory, information-gathering, hybrid, and leverage routes;
- web search is especially good for finding creative solutions others have used;
- do not kill candidates during evidence gathering just because they are unusual;
- label them and carry them forward to generation.

---

## Output

Write useful findings to `RESEARCH.md` or the relevant route folder.

Advance when you have enough raw material from **all relevant channels** to generate a non-generic sibling set. If your evidence comes only from memory, you have NOT gathered enough — go search the web.
