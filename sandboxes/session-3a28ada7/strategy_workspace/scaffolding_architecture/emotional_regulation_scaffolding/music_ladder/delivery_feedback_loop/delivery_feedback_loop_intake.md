# INTAKE — Delivery & Feedback Loop

## Summary
Technical specifications for delivering Music Ladder playlists to Maxim via smartwatch or phone, collecting before/after mood ratings, and iterating song effectiveness. Covers MVP delivery paths (phone playlist links → smartwatch control), mood check-in UI (2-question rating: arousal 1-10, valence 1-10), song effectiveness rating (1-5 stars), and the weekly iteration cycle.

## Question this route answers
"What are the technical specifications for delivering Music Ladder playlists via smartwatch/phone, collecting before/after mood ratings, and iterating song effectiveness based on feedback?"

Position in family: Depth 5, sub-component 3 of 4 under Music Ladder (route_13f7e0499801). Sibling routes: Mood-BPM Parameter Matrix, Iso-Principle Transition Protocol, Obsolescence Fade Schedule.

## Assumptions
- Maxim has a smartphone capable of playing music (phone is the primary music device; smartwatch controls it).
- At minimum, a simple playlist link (Spotify/Apple Music/YouTube) delivered via Telos prompt is sufficient for MVP.
- Maxim is willing to provide 2-question mood ratings (10 seconds) before and after each listening block.
- Maxim is willing to rate individual songs for effectiveness (1-5 stars) after the first playback.
- The feedback loop operates on a weekly cycle: Monday = new playlist iteration based on previous week's ratings.
- Maxim will engage with a Telegram/Telos-based prompt system for check-ins (already established pattern).

## Dependencies and permissions
- Music platform subscription (Spotify Premium, Apple Music, or YouTube Music) for playlist creation.
- Notification permission on smartwatch (for prompt delivery) or phone.
- Telos integration: the strategy engine must be able to send prompts, receive mood ratings, and store feedback data.
- Maxim's commitment to 2-question mood rating before and after each listening block (baseline + result).
- Song effectiveness ratings: optional but encouraged (1-5 stars after each song or end-of-block summary).
- Weekly feedback review: 5-minute session where Maxim reviews which songs worked and which didn't.

## What this route enables
- **Continuous improvement:** Each week's playlists are more effective than the previous, based on real feedback data.
- **Personalization at scale:** Song ratings reveal Maxim's specific preferences — the matrix becomes Maxim's matrix.
- **Accountability via measurement:** Before/after mood ratings provide objective evidence of the protocol's effectiveness.
- **Low-friction engagement:** A 2-question rating takes 10 seconds; a playlist link takes 1 tap. Minimal effort for high-value data.
- **Data for obsolescence:** When Maxim can self-curate without feedback, that's measurable (self-curation frequency, no-edit playlists, etc.).

## What could break it
- **Rating fatigue:** Maxim may stop providing ratings after the first week. Mitigation: drop ratings to once-daily block (pick one block to rate), or gamify the feedback (show improvement graphs).
- **Smartwatch limitations:** If the watch cannot control music or display rating prompts effectively, phone dependency reduces convenience.
- **Notification overload:** If prompts feel like spam, Maxim will silence them. Mitigation: 1 prompt per listening block, never more than 3 per day.
- **Technical integration failure:** If Telos cannot reliably send playlist links or store ratings, the loop breaks. Mitigation: manual fallback (Maxim types ratings into journal entry).
- **Data quality issues:** Maxim may game the ratings (always 5 stars, always same numbers). Mitigation: occasional spot-check with a "why this rating?" prompt.

## Main unknowns
1. Smartwatch model (Apple Watch vs Wear OS vs other) — determines notification and music control capabilities.
2. Whether Maxim's phone supports SMS/messaging for Telos prompt delivery during school hours.
3. Maxim's willingness to rate songs after listening (is he a "rating person"?).
4. Whether the before/after mood rating feels intrusive or valuable to Maxim.
5. Music platform Maxim uses (Spotify, Apple Music, YouTube Music — affects API integration path).

## Evidence that matters most
- **Web research (smartwatch music control):** Apple Watch can control Spotify via Now Playing app (play/pause/skip). Wear OS supports Spotify Remote SDK (start/pause/skip/queue). Both require Bluetooth range and Spotify Premium.
- **Web research (adolescent feedback protocols):** Self-report mood ratings (1-10) are standard in adolescent music intervention studies. 10-second rating is feasible.
- **Web research (playlist delivery):** Simple playlist links are the most reliable delivery mechanism — no custom app needed for MVP.
- **Memory (Telos integration):** Maxim already uses Telos for prompts, check-ins, and journaling. Adding playlist delivery + mood rating to existing patterns lowers adoption friction.
- **Memory (school schedule):** Maxim is home by ~14:40-15:10. Best delivery windows: transit (headphones), pre-study (15:10 start), evening wind-down.

## Next planned question if killed
"The delivery & feedback functions should be embedded within the parent Music Ladder route's implementation instructions, not a standalone route. However, if kept, the depth-6 question would be: 'What is the exact Telos prompt template for daily music block delivery and mood check-in?'"
