# INTAKE — Tracking & Metrics Parameter Package

## Summary
The quantitative backbone of the Journaling Protocol: what is tracked (consistency, emotional granularity, self-compassion ratio), how it is measured, feedback loop frequency, dashboard/visualization approach, and red-flag thresholds. This package turns journaling from a qualitative practice into a measurable system that feeds the strategy engine's keep/kill decisions.

## Question this route answers
"What specific metrics are tracked from Maxim's journaling, how are they measured, and what feedback loops and red-flag thresholds govern the protocol?"

Position in family: Depth 5, parameter package 4 of 4 under Journaling Protocol. Siblings: Prompt Parameter Package, Format & Delivery, Obsolescence & Transition.

## Assumptions
- Maxim is a systems thinker who responds to data and proof ("I can change, I am changing") — tracking provides the evidence he needs for motivation.
- Tracking should be LOW friction — ideally automatic (metadata extraction) or near-automatic (single self-report rating). Never manual data entry.
- Content privacy is paramount (GOAL.md, parent intake). Tracking is metadata-only unless Maxim explicitly shares content.
- Primary metric: Journaling Consistency (days/week) — directly from GOAL.md primary metric table.
- Secondary metrics: Emotional Granularity (emotion word count / variety), Self-Compassion Ratio (self-compassionate vs self-critical statements), Entry Length (chars/words), Session Time (minutes).
- Feedback should be weekly, not daily — daily feedback creates performance anxiety (perfectionism risk).
- Red-flag thresholds trigger human check-in (or at minimum, protocol pause), not automated correction.

## Dependencies and permissions
- Permission to track journaling consistency (did Maxim write today? yes/no + timestamp). NO content access by default.
- If Maxim opts in, permission to run automated text analysis on entry content for emotional granularity and self-compassion metrics.
- Permission to present weekly metric summaries to Maxim (dashboard).
- Permission to trigger alerts if red-flag thresholds are crossed (to Maxim himself, not to third parties).
- Integration with the delivery channel (to capture timestamps automatically).

## What this route enables
- **Journaling Consistency metric:** Directly enables GOAL.md primary metric (>5 days/week). Tracked as simple binary: entry logged on day Y/N.
- **Emotional Granularity score:** If content analysis is opted-in, tracks the diversity and precision of emotion vocabulary in entries. Moving from "bad/good" to "disappointed/hopeful/frustrated" increases score.
- **Self-Compassion Ratio:** If content analysis is opted-in, tracks ratio of self-compassionate statements ("I'm learning") to self-critical statements ("I'm a failure"). Directly maps to GOAL.md Self-Compassion Index (>1:2 ratio target).
- **Entry Length tracking:** Screens for over-intellectualization (entries >500 words = potential analysis paralysis) and under-engagement (entries <10 words = potential checking-the-box).
- **Streak tracking:** Longest consecutive days, streak history, and streak recovery rate (how quickly Maxim returns after a miss).
- **Weekly feedback dashboard:** One-minute view of the week's metrics, trends, and a single "on track / needs attention / red flag" status.
- **Red-flag thresholds:** Configurable alerts (e.g., 0 entries for 5+ days during a period when Maxim is not on break) that trigger protocol pause or check-in.

## What could break it
- **Surveillance perception:** Even metadata tracking may feel like surveillance. Must be transparent and Maxim-opt-in.
- **Metric gaming:** Maxim may write minimal entries just to "hit the metric" without genuine reflection (GOAL.md failure state: intellectualization loop).
- **Over-optimization:** The strategy engine may over-optimize for easily measured metrics (consistency) at the cost of harder-to-measure ones (genuine emotional processing).
- **Feedback as pressure:** Weekly dashboards may feel like performance reviews, triggering perfectionism or shame.
- **Cold-start problem:** Without content analysis opt-in, the only trackable metric is consistency — limiting the richness of evaluation.
- **Privacy blowback:** If Maxim feels tracked, he may disengage entirely.

## Main unknowns
1. Whether Maxim will opt in to content analysis for emotional granularity and self-compassion tracking. This fundamentally changes what is measurable.
2. The optimal weekly dashboard format — would Maxim prefer Telegram message, in-app view, or a simple text summary?
3. Whether Maxim finds metric feedback motivating or anxiety-producing.
4. The correct red-flag thresholds for a 15-year-old with known motivation volatility (normal lows vs. crisis lows).

## Evidence that matters most
- **GOAL.md (Journaling Consistency):** >5 days/week — primary metric. Trackable as binary Y/N per day.
- **GOAL.md (Self-Compassion Index):** Ratio >1:2 self-compassionate vs self-critical — measurable via content analysis if opted in.
- **GOAL.md (AI Dependency Score):** <2 prompts/day by month 6 — journaling prompt count tracked as secondary metric.
- **GOAL.md (Failure signals):** "Journaling becomes obsessive or avoidance-based" — entry length and time spent are red-flag indicators.
- **Web (SCS-Youth, Neff 2021):** Validated 17-item Self-Compassion Scale for ages 12-17. Subscales: self-kindness, common humanity, mindfulness (positive); self-judgment, isolation, over-identification (negative). Can be adapted as periodic journaling prompts (not daily). Reliability α ≥ 0.82.
- **Web (emotional granularity):** Moving from broad to precise emotion words improves regulation. Trackable via vocabulary diversity in entries.
- **Web (mood tracking):** Rating valence (1-10) and arousal (1-10) plus naming the emotion is the simplest evidence-based mood tracking method.
- **Memory (proof-driven motivation):** Maxim needs proof of change. Weekly metrics provide that proof.
- **Parent intake (obsolescence):** Tracking frequency should decrease as protocol matures — from weekly (active phase) to biweekly (transition phase) to monthly (independence phase) to zero (obsolescence).

## Next planned question if kept
"What is the exact metric dashboard template, calculation formulas, feedback schedule, and red-flag threshold definitions for the Tracking & Metrics Parameter Package?"

(Depth 6, utility kit — dashboard template, tracking automation, threshold configuration)
