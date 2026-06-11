# OPERATIONS MANUAL

## How Project Arete Runs Day-to-Day

This document contains the practical specifications for tools, delivery channels, time budgets, privacy protocols, and integration mechanics. It is the "user manual" for the system Maxim is building.

---

## 1. DAILY TIME BUDGET

**Total Project Arete Budget: 30-60 minutes per day**

### Phase 1 (Weeks 1-4): Emotional Regulation Focus

| Activity | Time | Tool | Delivery |
|----------|------|------|----------|
| Music Ladder | 15 min | Phone + headphones | Spotify/Apple Music/Youtube |
| Journaling Protocol | 5 min | Phone or notebook | Telegram prompt |
| Breathing (embedded) | 3 min | Smartwatch or phone | Haptic or visual pacer |
| **Total** | **23 min** | | |

### Phase 2 (Weeks 5-8): Dual Focus

| Activity | Time | Tool | Delivery |
|----------|------|------|----------|
| Music Ladder (reducing) | 10 min | Phone + headphones | Self-curated playlists |
| Journaling Protocol | 5 min | Phone or notebook | Telegram prompt or self-prompt |
| Action planning (embedded) | 2 min | Journal or smartwatch | One-line if-then plan |
| **Total** | **17 min** | | |

### Phase 3 (Months 3-4): Practice Focus

| Activity | Time | Tool | Delivery |
|----------|------|------|----------|
| Music Ladder (independent) | 10 min | Phone | No AI involvement |
| Journaling Protocol | 5 min | Any medium | Self-prompted or independent |
| Knowledge prompts (embedded) | 5 min | Journal | Self-generated Socratic questions |
| **Total** | **20 min** | | |

### Phase 4 (Months 5-6): Obsolescence

| Activity | Time | Tool | Delivery |
|----------|------|------|----------|
| Music | Variable | Phone | Fully independent |
| Journaling | Variable | Any medium | Fully independent |
| Monthly check-in | 5 min | Telegram | "Still journaling?" |
| **Total** | **<10 min** | | |

**Sleep Protection:** No Project Arete activities after 22:00 unless crisis protocol is active.

---

## 2. SMARTWATCH SPECIFICATIONS

### Required Capabilities

| Feature | Use Case | Minimum Viable Fallback |
|---------|----------|------------------------|
| Text notification display | Daily prompt delivery | Phone notification |
| Vibration/haptic motor | Breathing guidance | Phone screen pulse |
| Music control (play/pause/skip) | Music Ladder | Phone direct control |
| Heart rate monitoring | Biometric early warning | Phone camera HR (less accurate) |
| Sleep tracking | Pattern detection | Self-report in journal |

### If Smartwatch Is Limited

**Scenario A: Basic notification-only watch**
- Prompts delivered as vibration + short text
- Music controlled via phone
- Breathing via phone visual pacer
- **Viability:** HIGH. Phone handles all core functions.

**Scenario B: No smartwatch**
- All delivery via phone (Telegram, alarm apps)
- Breathing via free app (Breathwrk, Box Breathing, or simple timer)
- Music via phone + headphones
- **Viability:** MEDIUM-HIGH. Adds minor friction.

**Scenario C: Full-featured smartwatch (Apple Watch, Wear OS)**
- Native haptic breathing
- Complication displaying today's "one action"
- Music control from wrist
- HR variability tracking for early warning
- **Viability:** OPTIMAL. Enables all features.

---

## 3. MUSIC PLATFORM SETUP

### Platform Requirements

| Requirement | Why | Options |
|-------------|-----|---------|
| Playlist creation | Build mood-mapped playlists | Spotify, Apple Music, YouTube Music |
| BPM information | Matrix construction | Spotify Web API (Premium), manual tagging |
| Offline playback | School/no-data scenarios | Premium subscription required |
| Cross-device sync | Phone + watch + computer | All major platforms |

### Recommended Setup

**Primary:** Spotify Premium
- Spotify Web API provides BPM, key, mode, energy, valence for programmatic playlist building
- Wear OS / Apple Watch control supported
- Largest catalog for personalization

**Alternative:** Apple Music
- Native Apple Watch integration
- No free API for BPM, but manual tagging works

**Free Alternative:** YouTube Music + local files
- No API, fully manual
- Sufficient for MVP

### Initial Playlist Construction (Week 1)

1. **Identify 3-5 songs Maxim already listens to for each mood state**
2. **Use those as seeds to find 5-10 more per state**
3. **Build 6 starter playlists (one per mood state)**
4. **Test each playlist: listen for 5 minutes, rate effectiveness 1-5**
5. **Iterate: remove low-rated songs, add new candidates**

**Personalization Rule:** The matrix is evidence-based defaults. Maxim's actual preferences override defaults. If Maxim's favorite songs fall outside stated BPM ranges, the ranges are adjusted for him.

---

## 4. DELIVERY CHANNEL SPECIFICATIONS

### Primary Channel: Telegram

**Why Telegram:**
- Maxim already uses it for Telos
- Cross-platform (phone, computer, web)
- Supports bots/automation
- Message history serves as lightweight log

**Delivery Schedule:**

| Time | Content | Channel |
|------|---------|---------|
| Morning (optional) | "What is your ONE action today?" | Smartwatch or Telegram |
| Afternoon (optional) | Check-in: "Did you do the ONE action?" | Telegram |
| Evening (pre-20:00) | Journaling prompt | Telegram |
| Evening (optional) | Music Ladder suggestion | Telegram |
| Crisis (any time) | De-escalation protocol | Telegram or phone call |

### Message Style Rules

1. **Maximum length:** 2-3 sentences for prompts. Longer content is linked, not inlined.
2. **Tone:** Peer, not authority. "What if..." not "You should..."
3. **Transparency:** Every recommendation includes why: "I'm suggesting this because..."
4. **Imperfection permission:** "Skip if this doesn't fit today" is always implied.
5. **No guilt:** Missed days are never framed as failure.

---

## 5. PRIVACY AND DATA PROTOCOL

### What Is Tracked

| Data | Tracking Level | Access |
|------|---------------|--------|
| Journal entry timestamp | Automatic | System |
| Journal entry length (chars) | Automatic | System |
| Binary completion (Y/N) | Automatic | System |
| Music listening timestamp | Manual self-report | System (if reported) |
| Mood ratings | Manual self-report | System (if reported) |
| Smartwatch biometrics | Automatic (if available) | System |

### What Is NOT Tracked (Without Explicit Opt-In)

| Data | Default Status |
|------|---------------|
| Journal content | NEVER tracked without explicit opt-in |
| Conversation transcripts | NEVER tracked without explicit opt-in |
| Location data | NOT tracked |
| Screen time / app usage | NOT tracked |
| Social media activity | NOT tracked |

### Opt-In Tiers

**Tier 0 (Default):** Metadata only. Timestamp + length + completion.
**Tier 1 (Optional):** Content analysis for emotional granularity and self-compassion metrics.
**Tier 2 (Optional):** Full content access for personalized coaching and pattern detection.

**Rule:** Maxim can upgrade or downgrade tiers at any time. No penalty for downgrading.

---

## 6. METRICS DASHBOARD

### Weekly Summary (Delivered Sundays)

```
PROJECT ARETE — WEEK [X] SUMMARY

Journaling: [X]/7 days  [=====>    ]  Target: 5+ ✓/✗
Music Ladder: [X] sessions  [====>     ]  Target: 5+ ✓/✗
Emotional Recovery: [X] hours  [<24? ✓/✗]

This Week's Pattern:
- Most common emotion: [___]
- Best regulation tool: [___]
- One thing that worked: [___]

Next Week Focus: [Auto-suggested based on data]
```

### Monthly Review

- Journaling consistency trend
- AI dependency score (prompts per day)
- Emotional recovery time trend
- Self-compassion ratio (if content analysis opted in)
- Existential resilience score (self-report)
- Human connection check-in

**Dashboard Rules:**
- Positive-only framing when possible ("You journaled 6 days!" not "You missed 1 day.")
- No comparisons to others.
- No "performance grades."
- Trends matter more than single-week numbers.

---

## 7. INTEGRATION WITH EXISTING SYSTEMS

### Telos Strategy Engine

Project Arete uses the existing Telos infrastructure:
- Prompt delivery via existing Telegram bot
- Strategy engine available for problem decomposition when needed
- Memory system stores context about Maxim's state, preferences, progress

**Boundary:** Telos handles strategy. Project Arete handles scaffolding. They overlap in Journaling Protocol (reflection on strategy) and Crisis Protocol (escalation).

### School Systems

- Submission tracking (if active) is lightweight — one journal entry per week
- No integration with school portals required for MVP
- School schedule informs timing (no prompts during exams unless crisis)

### Future Systems

**Transcription system (when ready):**
- Conversation analysis for pattern detection
- Real-time emotional state inference
- Automatic journaling suggestions: "You mentioned feeling [X] during your conversation. Want to explore that?"
- **Privacy:** Transcripts are analyzed, then deleted. No permanent storage.

---

## 8. TROUBLESHOOTING GUIDE

| Problem | Likely Cause | Solution |
|---------|-------------|----------|
| Missing prompts | Telegram notification off | Check notification settings; switch to alarm + sticky note |
| Music doesn't shift mood | Wrong genre/BPM match | Adjust matrix; test new songs; try different state category |
| Journaling feels like homework | Too structured / wrong time | Switch to open prompt; change time; reduce to 1 sentence |
| Smartwatch haptics too weak | Watch model limitation | Switch to phone visual pacer; use audio breathing guide |
| Forgetting to journal | No habit anchor | Habit-stack to existing routine (after dinner, before bed) |
| Journaling becomes obsessive | Perfectionism + no time cap | Enforce 5-minute hard cap; add "messiest version" prompt |
| Feeling tracked/surveilled | Metadata tracking visible | Show exactly what is tracked; offer opt-out; reduce tracking |
| Crisis protocol not accessible during crisis | Too many steps | Simplify to ONE step: "Breathe for 3 minutes. Then decide." |
| Music Ladder boring | Same playlists | Accelerate personalization; let Maxim add new songs weekly |
| Skipping both music and journaling | Motivation collapse | Activate crisis safety protocol; reduce to minimum viable contact |

---

## 9. TOOL GOVERNANCE RULES

From the killed Ecosystem Architecture, these governance rules are salvaged and applied:

1. **Maximum 3 active tools at any time.** (Music Ladder, Journaling Protocol, Crisis Safety)
2. **Every tool has an obsolescence date.** No indefinite tools.
3. **Tool retirement is celebrated, not mourned.** "You outgrew this" is the frame.
4. **No new tools without killing an old one.** Prevents ecosystem creep.
5. **Tools must justify their existence weekly.** If a tool isn't being used, it enters retirement.

---

## 10. PHASE TRANSITION CHECKLIST

### From Phase 1 to Phase 2 (Week 4)

- [ ] Emotional Recovery Time <24 hours for 2 consecutive weeks
- [ ] Music Ladder self-curation rate >50%
- [ ] Journaling consistency >5 days/week for 2 consecutive weeks
- [ ] No crisis episodes in past 2 weeks
- [ ] Maxim reports feeling "stable enough to add more"

### From Phase 2 to Phase 3 (Week 8)

- [ ] Journaling prompt independence >50% (self-prompted entries)
- [ ] Music Ladder AI prompts <2/week
- [ ] Action planning happening without AI prompt
- [ ] Emotional regulation techniques used without AI prompt

### From Phase 3 to Phase 4 (Month 4)

- [ ] Journaling fully independent for 4+ weeks
- [ ] Music Ladder fully independent
- [ ] Socratic self-questioning spontaneous
- [ ] Existential resilience score >7/10
- [ ] Human connection metric positive

---

*This manual is a living document. As tools change, platforms evolve, and Maxim's needs shift, the operations update. But the principles — privacy, obsolescence, emotion first — remain constant.*

**Next Document:** `08_EVALUATION_APPENDIX.md`
