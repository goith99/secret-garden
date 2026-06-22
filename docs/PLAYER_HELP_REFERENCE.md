# Secret Garden — Player Help Reference

Short, plain-language answers to common player questions, written in the game's voice.
This is **reference copy for the Stage 6 frontend** (not a full FAQ and not UI itself) and
reuses the established player vocabulary — "Preparing Seed", "Bloom Failed. Try again.",
"The garden is resting." Mechanics here are accurate to the current program; for the exact
status/timestamp logic behind each answer, frontend devs should see
[`docs/ERROR_AND_STATUS_REFERENCE.md`](./ERROR_AND_STATUS_REFERENCE.md).

---

**Why is my flower locked?**
A flower is **busy** (locked) while it's a parent in a cross you started — it's in the
greenhouse helping make a new bloom. It frees up automatically the moment the cross
finishes. If a cross gets stuck, your flowers are released after about **10 minutes** so
you never lose them.

**What does "waiting in the greenhouse" mean? / It says "Preparing Seed…"**
Your cross is being grown privately and fairly — the outcome is decided by secure
computation that no one (not even you) can peek at or rig. This usually takes only a few
seconds; the very first cross after a quiet spell can take a little longer. Just wait for
the bloom.

**I closed my browser during breeding — what happens?**
Nothing is lost. Breeding finishes on its own in the background; your new bloom and your
freed-up parent flowers will be there when you come back. If something went wrong on the
network, your parent flowers are automatically released after about 10 minutes so you can
try again. (A cross that didn't finish just says **"Bloom Failed. Try again."** — no harm
done.)

**How does the daily challenge work?**
Each day a competition round opens with a set of **public target traits** — you can see
exactly what the judges are looking for, and picking which flower to enter is the strategy.
Submit one of your **active** flowers before the deadline (rounds last 24 hours and hold up
to 16 entries). After the round closes, every entry is judged privately and the **top 3
winners** are revealed. Your flower's exact score stays secret unless it lands in the top 3.

**Is my breeding strategy private?**
Your secret cultivation choices (the private light/water/soil you breed with) are
**encrypted and never revealed**, and your flowers' actual genes are kept hidden and
tamper-proof — they're only ever used inside secure computation. What *is* public, by
design, is the ordinary stuff: which flowers you own, their species/generation/rarity, who
you bred with what, and each round's target traits. So your **genetics are hidden and your
outcomes are provably fair**, but the game itself (your collection, the daily targets) is
open for everyone to strategize around.

**The game won't let me do anything — it says "The garden is resting."**
The garden is temporarily paused by the keeper (usually for maintenance or safety). Normal
actions resume once it reopens. Anything already in progress still finishes, and stuck
flowers can still be recovered.

**My competition score never showed up.**
Judging is also done by secure computation and is normally quick. If a judging gets stuck,
it's automatically reset after about **10 minutes** and can be re-judged — your flower is
never scored twice and never loses its place.
