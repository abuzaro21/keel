# Two-year thesis: adaptive agents will be judged by what they refuse to redo

Today's agents adapt by re-prompting: something looks off, so the model is asked again with more context. That fails in production for one reason — the second answer does not know which parts of the first answer already happened. A truck that left cannot be un-dispatched; a customer told "on time" cannot be untold. Re-planning from scratch quietly assumes a reversible world.

By 2028 I expect production agents to carry three things most frameworks treat as optional today.

**Assumptions as data.** Every step declares what must be true for it to run and what must stay true afterwards, in a form a machine can check. Then "the world changed" becomes a computable contradiction with an exact cause — and irrelevant news can be ignored on purpose.

**Commitments as constraints.** Completed effects become facts with identities, receipts and obligations. A repair is scored first on what it keeps. Plan stability — the smallest valid change wins — becomes a product requirement, because people and systems have already acted on the old plan.

**Containment as a feature.** The most valuable adaptive behaviour is often not adapting: noticing a flapping signal, refusing to return to a plan just abandoned, or stopping with a clear reason when no safe continuation exists.

Models will keep getting better at proposing plans. The durable advantage sits around them: a replayable event log, a validator the model cannot talk past, and a ledger that applies each side effect at most once. KEEL is a small working version of that bet.
