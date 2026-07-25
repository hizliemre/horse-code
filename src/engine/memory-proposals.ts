// Review agents see the most: fifteen code lenses, fourteen plan lenses and a council read every artifact in
// the project. They are also the agents whose models we trust LEAST — they are narrow, single-angle finders,
// and several of them run on cheaper tiers. So they get a voice, not a pen: they PROPOSE, and a single trusted
// curator decides what (if anything) is actually written.
//
// Nothing in this file touches the store. A proposal is a raw signal that lives in memory for the length of one
// job and is then either rewritten into a real memory by the curator, or discarded.

/** One raw signal from an agent, awaiting curation. */
export interface MemoryProposal {
  text: string;
  kind: "fact" | "lesson";
  /** The role that proposed it — provenance the curator weighs, and the audience hint if it survives. */
  proposedBy: string;
}

/**
 * Hard cap. Fifteen lenses across several review rounds could otherwise flood the curator with hundreds of
 * proposals, which both costs tokens and drowns the few good ones. Past the cap, later proposals are dropped.
 */
export const MAX_PROPOSALS = 60;
/** A proposal longer than this is an essay, not a memory — the curator would only have to cut it down anyway. */
export const MAX_PROPOSAL_CHARS = 400;

/** Same claim, differently punctuated → one proposal. */
function key(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Per-job queue of proposed memories. Purely in-process: a proposal never outlives the run that made it. */
export class ProposalQueue {
  private readonly items: MemoryProposal[] = [];
  private readonly seen = new Set<string>();
  private dropped = 0;

  /** Returns false when the proposal was rejected outright (empty, duplicate, or past the cap). */
  add(text: string, kind: "fact" | "lesson", proposedBy: string): boolean {
    const t = text.trim().slice(0, MAX_PROPOSAL_CHARS);
    if (!t) return false;
    const k = key(t);
    if (this.seen.has(k)) return false; // five lenses noticing the same thing is one signal, not five
    if (this.items.length >= MAX_PROPOSALS) { this.dropped++; return false; }
    this.seen.add(k);
    this.items.push({ text: t, kind, proposedBy });
    return true;
  }

  list(): MemoryProposal[] {
    return [...this.items];
  }

  /** How many proposals were refused because the queue was already full (reported, never silent). */
  overflow(): number {
    return this.dropped;
  }

  size(): number {
    return this.items.length;
  }

  /** Empties the queue — called once the curator has ruled on its contents. */
  drain(): MemoryProposal[] {
    const out = this.list();
    this.items.length = 0;
    this.seen.clear();
    this.dropped = 0;
    return out;
  }
}
