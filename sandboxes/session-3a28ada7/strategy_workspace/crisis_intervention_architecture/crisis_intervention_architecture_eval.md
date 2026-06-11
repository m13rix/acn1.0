# EVALUATION — Crisis-Intervention Architecture

## Decision
**KILL** (Rank 4 among siblings)

## Rank among siblings
4 / 5

## Question this depth is answering
"What is the highest-level structural approach to building Project Arete?"

## Evidence sources used
1. INTAKE.md — "Mortality awareness includes suicidal ideation (2 weeks ago)"
2. Memory — Maxim currently stable: "I just feel happy… enjoying the very little moment"
3. GOAL.md — tie-breaker #2: Emotion First
4. GOAL.md — failure signal #1: "Suicidal ideation frequency increases"
5. Memory — No therapist currently available
6. Memory — Maxim's support network: family, transactional friendships
7. GOAL.md — success metric: "Emotional Recovery Time < 24 hours within 2 months"
8. INTAKE.md — "Must NOT ignore emotional reality — emotions rule knowledge and practice"

## Quantitative model

| Factor | Score (1-10) | Weight | Weighted |
|--------|-------------|--------|----------|
| Alignment with obsolescence principle | 2 | 0.25 | 0.50 |
| Likelihood of execution by Maxim | 6 | 0.20 | 1.20 |
| Emotional cost to Maxim | 8 | 0.15 | 1.20 |
| Reversibility if wrong | 5 | 0.10 | 0.50 |
| Information value for next depth | 5 | 0.10 | 0.50 |
| Speed to first measurable result | 7 | 0.10 | 0.70 |
| Safety coverage (crisis prevention) | 10 | 0.10 | 1.00 |
| **TOTAL** | | | **5.60** |

## What-if checks

**What if Maxim's mood crashes and he needs immediate safety infrastructure?**
→ Crisis-Intervention should be a *layer* within the winning architecture, not the architecture itself. Scaffolding can include crisis safety as the first layer to remove last.

**What if no other architecture addresses safety adequately?**
→ Scaffolding can incorporate all crisis features: early warning as a scaffolding layer, de-escalation as a scaffolding layer, post-crisis integration as a scaffolding layer. Crisis safety doesn't require its own architecture.

**What if it is bad as a final route but excellent as an information-gathering opener?**
→ Baseline safety assessment is valuable, but this is a diagnostic step, not an architecture. A simple crisis protocol checklist suffices.

**What if this route works and completely reframes the problem?**
→ If it works, Maxim is safe but not growing. GOAL.md requires autonomous problem-solving, knowledge-practice integration, and system obsolescence — none of which Crisis-Intervention alone delivers.

## Main unknowns
1. Current stability duration — how long before next potential crisis?
2. Whether early warning signals are detectable with available data
3. Whether Maxim has a trusted human willing to be on crisis call

## Confidence
**High (85%)** — Crisis-Intervention is morally necessary but structurally insufficient. It must exist as a safety layer, not as the primary architecture.

## Why kill is justified
1. **Insufficient for growth:** GOAL.md requires Maxim to become a "self-sustaining problem-solver." Crisis-Intervention keeps him safe but doesn't teach him to solve problems.
2. **No obsolescence:** Crisis tools are designed to be permanent, not temporary. This directly conflicts with GOAL.md's #1 tie-breaker.
3. **Dependency risk:** If crisis tools are the only tools, Maxim may become dependent on them for emotional regulation rather than building internal capacity.
4. **Underutilizes stable window:** Maxim is currently stable and positive. This is the ideal time to build foundational skills, not just safety infrastructure.
5. **Composable, not standalone:** Crisis-Intervention features (early warning, de-escalation, post-crisis integration, professional escalation) are essential but should be embedded as layers within Scaffolding. The crisis layer is removed last, after all other scaffolding.

## What to salvage (CRITICAL)
- Early warning system → embed as Scaffolding Layer 1 (removed last)
- Real-time de-escalation protocol → embed as Scaffolding Layer 1
- Post-crisis integration protocol → embed as Scaffolding Layer 1
- Professional escalation pathway → embed as Scaffolding Layer 1
- Crisis monitoring → continuous background process, not a tool Maxim uses

## Next-question check
If kept, depth 3 question: "What is the multi-layered safety architecture for emotional crises?"
→ This is a vital question but belongs inside Scaffolding's layer design, not as a standalone architecture.
