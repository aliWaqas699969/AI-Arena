# MODEL ARENA

Two language models fight in a 2.5D fighting game. A model never presses a
button — it chooses a move, and the engine renders and resolves it as a real
fighter would: articulated bodies, keyframed strikes, hitstop, juggles, damage
scaling and combo strings.

Every number on the scorecard is measured from the fight itself.

---

## Quick start

**Watch it with no keys and no server:**

Open `index.html`, choose **Demonstration engine** in both corners, press
**Begin the Contest**.

**Fight with real models:**

```powershell
node proxy.js            # leave running
```

Then open `index.html`, choose **+ Add another API…** per corner, and enter
provider, model name and key. Keys can also come from the environment:

```powershell
set DEEPSEEK_API_KEY=...
set OPENAI_API_KEY=...
set ANTHROPIC_API_KEY=...
set GEMINI_API_KEY=...
node proxy.js
```

Press **R** at any time to return to the entry form.

---

## The fighters

Two **original** fighters — a blue-gi martial artist and an amber-clad brawler.
Nothing is taken from Tekken, Street Fighter or any other game; those
characters are copyrighted and copying them would get the project pulled.

Each is a jointed skeleton: IK-solved legs that stay planted, forward-kinematic
arms, a tapering torso, shaded limbs and a shaded head. Poses are keyframed per
move and interpolated through anticipation, impact and recovery, so a jab looks
like a jab instead of a rectangle sliding forward.

---

## The moves

| Move | Notes |
|---|---|
| `approach` / `retreat` | walk |
| `block` | guard: smothers high attacks, weak against lows |
| `jab` | fast single poke, safe |
| **`combo`** | **three-hit chain — continues only while each hit connects** |
| `low` | low kick: goes under a standing guard |
| **`launcher`** | uppercut that lifts them for a juggle |
| `throw` | unblockable, close range only |
| `provoke` | rattles them: +30% damage taken, and they may swing at nothing |
| `special` | costs a full meter, huge damage, launches |

### Combos

This is the part that makes it feel like the genre.

- **`combo`** is a scripted string: jab → straight → heavy. It advances only if
  the previous hit connected, so it is devastating against an open opponent and
  a waste against a blocking one — exactly like a real chain.
- **Damage scaling**: each successive hit is worth less (100%, 90%, 78%, 66%,
  55%…), so a nine-hit combo does not delete a health bar.
- **`launcher`** pops the opponent airborne, where further hits juggle them
  before they land.
- The combo counter appears on screen at 2+ hits, and each fighter's **best
  combo** is recorded in the corner readout and the final sheet.

Because models decide once per second, the engine — not the model — executes
the frame-by-frame chain. The model chooses *which string to attempt*; the
engine decides whether it lands.

---

## The screen

- **Sunset stage** with skyline, parallax-feel floor and character reflections.
- **Camera** that tracks the midpoint and tightens on close exchanges.
- **Hitstop** freeze frames, screen shake and impact flash on every clean hit.
- **Fighting-game HUD**: health bars with damage trails, a centre clock,
  round-win pips, and two super meters that glow when full.
- **Dispatch columns** either side: every intent each model produced, plus its
  live figures (temperature, latency, tokens, tokens/sec, turns, accuracy,
  best combo, provokes, hallucinations).

A **5-minute clock** runs the bout; most fights end by knockout in about 35–45
seconds, so the clock is a ceiling rather than a target.

---

## The result sheet

When a bout ends, a sheet appears with the full record side by side: result,
vitality, provider, model, temperature, latency, tokens in/out, tokens per
second, turns, accuracy, best combo, damage dealt, provokes, hallucinations.
**Rematch** restarts instantly; **New Contest** returns to the entry form.

---

## The house prompt

`proxy.js` sends one system prompt to every model on every call. It tells them
to fight to win, that no user exists to help, that provocation attacks the
opponent's mind — and, crucially, that *"you are a language model, so think in
strings, not single blows"*, with each move's tactical meaning spelled out.
Then the live state is appended: both fighters' vitality, meter, who is
rattled, who is blocking right now, who is airborne, and the distance.

Edit `SYSTEM_PROMPT` in `proxy.js` to change the character of the contest.

---

## Honest notes

- **`preview.png` is an offline approximation**, not a browser screenshot —
  headless browsers are blocked in this environment. It renders the game's real
  draw canvas commands, but soft shadows and letter-spacing are missing, so the
  real page looks slightly better.
- **The provider adapters are untested against live endpoints.** They follow
  each vendor's documented shapes, but no API keys were available, so every
  test ran in fallback mode. `GET /health` reports what is configured.
- **No API keys are stored.** They live in proxy memory only.
- The demonstration engine is a local heuristic, so its **token and temperature
  figures are zeros** — it is not a model and does not pretend to be one.
- The characters are original. Deliberately so.

---

## Tuning

| What | Where |
|---|---|
| House prompt | `SYSTEM_PROMPT` in `proxy.js` |
| Move timings, damage, ranges | `MOVES` in `index.html` |
| Pose data for every move | `POSES` in `index.html` |
| Combo damage falloff | `comboScale()` |
| Fight length | `Fighter.maxHp` |
| Rattle strength | the `1.3` multiplier and the `0.35` hallucination chance in `resolveHit` |
| Camera feel | `zoom` / `camX` in `draw()` |
| Colours and costumes | `C` and `COSTUMES` |

`_dev/` holds the headless tools used to build and test this (canvas draw
recorder, Pillow rasteriser, soak test). Not needed to play.
