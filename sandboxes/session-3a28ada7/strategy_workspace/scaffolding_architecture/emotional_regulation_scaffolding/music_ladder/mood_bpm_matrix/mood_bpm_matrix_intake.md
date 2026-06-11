# INTAKE — Mood-BPM Parameter Matrix

## Summary
A lookup table mapping each of 6 emotional states (anger, anxiety, sadness, calm, happiness, focus) to specific BPM ranges, recommended genres, key/mode characteristics, tempo characteristics, and 5-8 song archetypes. This is the fundamental vocabulary of the Music Ladder — without it, no playlist can be constructed.

## Question this route answers
"What are the exact BPM ranges, genre preferences, key/mode characteristics, and song archetypes for each emotional state in the Music Ladder?"

Position in family: Depth 5, sub-component 1 of 4 under Music Ladder (route_13f7e0499801). Sibling routes: Iso-Principle Transition Protocol, Delivery & Feedback Loop, Obsolescence Fade Schedule.

## Assumptions
- Maxim listens to music regularly through headphones or phone speakers.
- Maxim can distinguish between emotional states along the arousal (energy) and valence (positivity) axes.
- BPM is a meaningful parameter for Maxim — he will appreciate the structure.
- Maxim does NOT already have a formal mood-mapped playlist system (memory search found no evidence).
- The 6 emotional states (anger, anxiety, sadness, calm, happiness, focus) cover the majority of Maxim's regulation-relevant states.
- Genre preferences will need personalization after initial playlists are built — the archetypes serve as starting templates.

## Dependencies and permissions
- Music platform API access to query BPM, key, mode, energy, valence for songs (Spotify Web API Audio Features, Apple Music API, or manual tagging).
- Access to Maxim's existing listening history or at least 20-30 songs he currently listens to for preference mapping.
- Confirmation of the 6 emotional states from Maxim (is this the right categorization for his experience?).
- Permission to build initial "seed playlists" from genre archetypes (to be replaced by Maxim-curated content).
- Weekly check-in slot (5 min) for Maxim to flag songs that don't fit their mood assignment.

## What this route enables
- **Structured mood identification:** Maxim learns to map his internal state to a defined parameter space (arousal + valence), which is the first step toward self-regulation.
- **Playlist construction at scale:** Once the matrix exists, any mood-to-mood transition can be programmed by selecting tracks from the appropriate BPM/gene ranges.
- **Personalization foundation:** The matrix starts as evidence-based defaults and evolves toward Maxim's personal music taste — this transfer is the obsolescence mechanism.
- **Data-driven iteration:** Song effectiveness ratings feed back into the matrix, refining BPM boundaries for Maxim's personal physiology.
- **Reduced cognitive load during dysregulation:** When Maxim is emotional, he doesn't need to "figure out what to listen to" — the matrix tells him.

## What could break it
- **Genre mismatch:** If the archetypes don't match Maxim's actual preferences, he will reject the entire matrix. Mitigation: start with 2-3 songs per mood and iterate fast.
- **Over-engineering:** Maxim may spend more time optimizing the matrix than using it. The matrix must be "good enough" at launch and improved through use, not analysis.
- **State granularity mismatch:** Maxim may find 6 states too coarse ("I don't just feel 'angry', I feel 'frustrated-betrayal-fatigue'") or too fine ("just pick a song, this is analysis paralysis").
- **BPM as sole parameter:** BPM alone doesn't capture timbre, key, lyrical content, or cultural associations. A song at 120 BPM could be euphoric or aggressive depending on mode and instrumentation.

## Main unknowns
1. Maxim's specific genre preferences (unknown — needs playlist history or explicit input).
2. Whether the 6-state categorization resonates with Maxim's felt experience.
3. Whether BPM is a parameter Maxim can meaningfully engage with (he may prefer "this song just feels right").
4. Which music platform Maxim uses (Spotify, Apple Music, YouTube Music — affects API accessibility).
5. Whether Maxim's existing library contains enough variety across all 6 mood states.

## Evidence that matters most
- **Web research (BPM ranges):** Evidence-based ranges for anger (120-150), anxiety (90-120), sadness (40-60), calm (50-70), happiness (120-140), focus (80-100). These are validated in music therapy literature.
- **Web research (genre-mood effectiveness):** Specific genres proven effective for each regulation goal (ambient for anxiety, lo-fi for focus, hip-hop for motivation).
- **Memory (sensual overexcitability):** Music is a known strong channel for Maxim — this matrix leverages his existing engagement.
- **Memory (intellectualization):** The structured parameter approach matches Maxim's cognitive style — he will engage more because it feels like "debugging" rather than "therapy."

## Next planned question if kept
"Does the Mood-BPM Parameter Matrix actually map to Maxim's personal music taste, and which states need refinement after the first week of ratings?"

(Depth 6, utility kit — initial seed playlist generation script.)
