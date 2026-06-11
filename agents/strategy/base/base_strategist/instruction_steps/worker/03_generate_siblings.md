# Worker Step 3: Generate Coherent Sibling Set

Generate sibling routes for the current parent question.

Rules:
- one sibling set answers one question;
- all siblings share one abstraction level;
- routes are controllable action branches, not environment outcomes;
- do not mix broad families with tactics, parameters, gear, or contingencies.

Bad sibling set:
- `branch-mine-y-58`
- `deep-cave-rush`
- `loot-scout-hybrid`
- `fortune-prep`

Good ladder:
- depth 1: `Mining`, `Structures`, `Trading`, `Hybrid`
- under `Mining`: `Tunnel Mining`, `Cave Exploration`, `Quarry/Excavation`
- under `Tunnel Mining`: `Branch`, `Straight-Line`, `Grid`, `Strip`
- under `Branch`: spacing, speed package, utility kit, contingency doctrine

For life/problem strategies, the same principle applies:
- broad route families first;
- then mechanism families;
- then concrete designs;
- then parameters and scripts;
- then contingencies.

Create the routes with `strategy.routes.createBatch(...)` or equivalent route calls.
Every route needs a clear name, theme/category, summary, and correct parent.

Do not evaluate yet except for quick sanity checks. Generation should be ambitious.

Advance when the sibling set is complete and same-level.


# Superhuman Candidate Generation Doctrine

Suggested memory category: `base_strategist_doctrine`

Suggested retrieval hints:
- strategy engine creative route generation
- generate superhuman strategy candidates
- research based on personal context
- high upside candidate seeds before evaluation
- perfect solution route search

## Principle

Before evaluation, the strategy engine should deliberately generate candidates that could be transformative if they work.

Do not restrict candidate generation to normal, socially obvious, or first-order solutions. The point of Telos is to discover routes that a human under pressure would not naturally search.

## Personalized Research First

Research should be shaped by the user's actual context:
- personality;
- constraints;
- resources;
- current emotional and cognitive state;
- historical failures;
- known strengths;
- trusted tools;
- social environment;
- time and energy profile.

Do not perform generic domain research and then casually personalize it at the end. Search for methods, precedents, and tactics that specifically fit Subject 13's real situation.

## Candidate Types To Seek

Actively look for:
- direct conventional routes;
- indirect leverage routes;
- preparation routes that change the game before the main action;
- information routes that reveal the true bottleneck;
- social, institutional, technical, or environmental routes;
- hybrid routes that combine weak methods into one strong system;
- route designs that reduce execution burden for Subject 13 specifically;
- routes that would be weird but legal, ethical, and high-upside.

## Evaluation Separation

Generation and evaluation must be separate.

During generation, include candidates with extreme upside even if they might fail. During evaluation, kill them honestly if the evidence does not support them.

The phrase to remember:

> If this route works, could it completely change the problem?

If yes, it deserves at least enough evaluation to avoid missing a super-human solution.

## Specialist Use

Call `CORE`, `researcher`, or another specialist when they can improve candidate quality:
- `CORE` for broad contextual synthesis and memory-aware research;
- `researcher` for deep hypothesis destruction and hidden-variable analysis;
- domain agents for narrow expertise;
- probabilistic specialists for uncertainty modeling.

Do not call specialists as ritual. Call them with narrow tasks and exact output files.
