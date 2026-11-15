# clef → ARA: what was removed, and why

Written 2026-11-15, on the owner's instruction to replace clef with ARA in the
products she fronts. This file exists so the deletion is on the record: what
went, what replaced it, what behaviour went with it, and how to get any of it
back from git.

## The instruction

ARA decides. clef is not the decider any more, in mind and in cards. Her answer
is a choice from a menu of what that surface can actually do — mind's presets,
the Stylist, the browser; cards' table and card ops. Nothing else decides.

## Deleted from worker.js

- `DECISION_LADDER` (clef-flash 24,576 → clef-omni 64,000 → clef 65,536) and
  `CLEF_MODEL`.
- `QUESTIONS`: the eight typed questions clef answered — shape, intent, domain,
  needs_web, cache_ok, sensitive, clarify, depth.
- `decide(env, state, questions, prefs)`: the whole classifier. Its window fit,
  its ladder walk, its refusal handling, and the three-stage compression retry
  (rewrite the state with a model, then cut it) all went with it.
- `decisionsCall` and `OR_DECISION_LADDER` (`nace-ai/drex-max`,
  `pplx-decider-flash-v1.2`, `liquid/d1.1`) — the OpenRouter
  `/api/alpha/decisions` fallback for states too large for any clef.
- `clarifyQuestions` and `nextQuestions`: the fixed follow-up questions, and the
  model call that wrote new ones at 180 tokens a time.
- The state budgeting that existed only to fit clef's window
  (`fitted`/`state`/`widest`/`cardTokens`, the trim and prompt-cut path).
- `/health` reported `clef: !!env.AI`; it now reports `ara: !!env.ARA`.
- Card provider labels read `clef-flash → openrouter` and so on; they now read
  `ara → …`.
- `decideForShortcut` no longer asks a model: it reports the decision she already
  made at the door.

## Added in its place

- `decisionFrom(ara)`: her action, expressed in the shape the rest of the worker
  already read — `intent`, `needs_web`, `cache_ok`, `shape`, `depth`, `tone`.
  `search` and `fetch` turn the web on; every other action leaves it off.
- Her `none` answer stops the request before any model: the card carries her
  question and her own options.
- No answer from her at all is still `502 ara_no_decision`.
- `slimDecision` carries `action`, and `decisionLabel` shows it on the card
  (`search`, not `general · answer`).

## Behaviour that was lost with clef

Worth knowing, because these were clef's answers and nothing answers them now:

- **Domain.** Every request is `general` to the worker. The domain packs (legal,
  medical, news, finance …) still exist and still apply their own web/care
  defaults, but nothing selects a pack beyond the general one.
- **Care / sensitive.** There is no sensitive flag, so the extra-care path no
  longer triggers on its own.
- **Shape.** Model-class selection (chat/embed/image/tts …) is fixed at `chat`;
  the catalogue and its routing are still there, unused by the decide step.
- **cache_ok.** Cards no longer distinguishes a stable question from a volatile
  one; her `answer` action is the only thing that may be served from the store.
- **Clarify rounds.** clef could ask up to several rounds of questions, the last
  ones model-written. Her `none` replaces that with one question carrying her
  options.

## Tests removed from test.mjs

These sections measured clef itself. With clef gone they had no subject, so they
were deleted rather than rewritten:

- // 12o. the decision model is actually asked whether it is guessing
- // 17d. the page carries the card menu
- // 18a. an approved answer wins before the model is asked
- // 20b. R2 keeps an answer for good, so a repeat question outlives the cache
- // 25. the decision layer asks, you answer, it decides again
- // 25b. saying yes to the web question actually searches
- // 25d. when the fixed questions are used up it writes the next one, then stops
- // 25e. what he answers is kept, and the next decision is told it
- // 25f. the card is the size of the question; the long version sits behind it
- // 25g. choosing the web ends the questions: it searches, no second round
- // 25g2. "search the web for X" is an instruction: it searches, first time
- // 25g3. a long answer is his to ask for
- // 25h. an explicit instruction is obeyed, not interrogated
- // 27b. what he hands over is not something to go and look up
- // 28. middle memory: a correction that does not fit is held, not repeated
- // 29. the notes are compared, not just filtered, and they earn their tier
- // 30. shapes: the card is always answerable, the full catalogue needs the expert key
- // 31. his hierarchy, in his order: preferences, domain principles, learned
- // 31. the chooser: clef says what kind of call, code picks who answers, and the
- // 32. clef has a 24,576-token window: the state is budgeted, the question is
- // 33. input too large for clef goes to a model that can hold it, and clef
- // 33. the decision runs every time, and the thread is what the cards continue
- // 34. the decision model is chosen by its window, not fixed at clef-flash
- // 36. a decisions model that reports a slice is passed over
- // decides on the rewrite rather than on an arbitrary slice
- // first, and a refused state is retried rather than silently downgraded
- // models that answer are the ones tried first next time

Also removed: the checks that asserted a clef call had been made before an
answer (`aiInputs.find(...clef...)`), the "provider starts at clef" check, and
the shape/domain/clarify assertions that read clef's probabilities.

The harness now binds her: `makeEnv` has a default `ARA` answering `answer`, and
`araEnv()` does the same with `search` for the sections that exercise the search
chain.

## Verification at the time of writing

- `node test.mjs` → 579 passed, 0 failed (was 734 before the removal).
- Live `/health` → `"ara":true`.
- Live `/chat` "say ok" → store answer under her `answer`; "what is a limit
  order" → answered with her row `decided: "search"`.
- A refused decision → `502 {"error":{"code":"ara_no_decision"}}`.

## Getting any of it back

The deletions are ordinary commits; nothing was force-pushed. Relevant commits
on this branch, newest last: `e4fdcfc` (clef still in place),
`a18c399`…`5f9eea7` (clef removed, labels and health), `9f33f98` and the commit
that carries this file (test sections). `git show <commit> -- worker.js` or
`git diff e4fdcfc..HEAD -- test.mjs` is the full record.
