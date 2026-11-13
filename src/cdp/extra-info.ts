//
// Copyright (c) 2026 AI-Dico
//

/// Pairs `*ExtraInfo` events with the records they describe.
///
/// The protocol sends them on their own, before or after the event they belong to, and
/// a redirect chain shares one request id across hops. So pairing is done by position
/// within an id: the n-th ExtraInfo that arrives for an id belongs to the n-th slot
/// claimed for it. A slot is claimed by the event that expects an ExtraInfo, whether or
/// not its record still exists, so a record dropped from the list leaves an empty slot
/// rather than shifting every later pair by one. (A first-in-first-out queue did shift,
/// and three reviews in a row found a different way to make it.)
///
/// Positions only stay aligned while an id's state is kept. It is kept for as long as the
/// request runs; finished requests are forgotten oldest first, and an ExtraInfo for an id
/// that has no state yet waits among a bounded set of early arrivals.
export class ExtraInfoSlots<Info, Item> {
  private readonly states = new Map<string, SlotState<Info, Item>>();
  private readonly finished = new Set<string>();
  private readonly early = new Map<string, Info[]>();
  private readonly maxFinished: number;
  private readonly maxEarly: number;

  constructor(maxFinished = 500, maxEarly = 200) {
    this.maxFinished = maxFinished;
    this.maxEarly = maxEarly;
  }

  /// An ExtraInfo arrived. Returns the record of its slot when that slot was already
  /// claimed and its record is still known, otherwise null.
  arrive(id: string, info: Info): Item | null {
    const state = this.states.get(id);
    if (!state) {
      const queue = this.early.get(id) ?? [];
      queue.push(info);
      this.early.delete(id);
      this.early.set(id, queue);
      while (this.early.size > this.maxEarly) {
        const oldest = this.early.keys().next().value;
        if (oldest === undefined) break;
        this.early.delete(oldest);
      }
      return null;
    }

    const index = state.arrived++;
    if (index < state.slots.length) {
      const item = state.slots[index];
      state.slots[index] = FILLED;
      return item === FILLED || item === EMPTY ? null : (item as Item);
    }
    // Not claimed yet. A failed request without a response takes the next one if it
    // asked to (see `claimIfArrives`).
    if (state.optional && state.optional.index === index && state.slots.length === index) {
      const item = state.optional.item;
      state.optional = undefined;
      state.slots.push(FILLED);
      return item;
    }
    state.pending.set(index, info);
    return null;
  }

  /// Claims the next slot for `item`. Returns its ExtraInfo if it already arrived;
  /// otherwise `arrive` hands the item back later. Pass `null` for a slot whose record
  /// is gone, so the positions after it stay right.
  claim(id: string, item: Item | null): Info | null {
    const state = this.open(id);
    // A later event claims the position an optional failure was holding out for.
    state.optional = undefined;
    const index = state.slots.length;
    const info = state.pending.get(index);
    if (info !== undefined) {
      state.pending.delete(index);
      state.slots.push(FILLED);
      return info;
    }
    state.slots.push(item === null ? EMPTY : item);
    return null;
  }

  /// Like `claim`, for an event that may or may not get an ExtraInfo (a failure: a CORS
  /// block had a response on the wire, a DNS error did not). The slot is only taken
  /// when one arrives, so a failure without one shifts nothing.
  claimIfArrives(id: string, item: Item): Info | null {
    const state = this.open(id);
    const index = state.slots.length;
    const info = state.pending.get(index);
    if (info !== undefined) {
      state.pending.delete(index);
      state.slots.push(FILLED);
      return info;
    }
    state.optional = { index, item };
    return null;
  }

  /// The request is over. Its state stays a while for ExtraInfo still on the way, and
  /// the oldest finished ids go first. Running requests are never forgotten.
  finish(id: string): void {
    if (!this.states.has(id)) return;
    this.finished.delete(id);
    this.finished.add(id);
    while (this.finished.size > this.maxFinished) {
      const oldest = this.finished.values().next().value;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
      this.states.delete(oldest);
    }
  }

  clear(): void {
    this.states.clear();
    this.finished.clear();
    this.early.clear();
  }

  get size(): number {
    return this.states.size + this.early.size;
  }

  private open(id: string): SlotState<Info, Item> {
    let state = this.states.get(id);
    if (state) {
      // A new hop of a finished id (a redirect seen after the finish) is running again.
      this.finished.delete(id);
      return state;
    }
    state = { slots: [], arrived: 0, pending: new Map() };
    this.states.set(id, state);
    // ExtraInfo that came before the request takes the first positions, in order.
    for (const info of this.early.get(id) ?? []) state.pending.set(state.arrived++, info);
    this.early.delete(id);
    return state;
  }
}

const FILLED = Symbol("filled");
const EMPTY = Symbol("empty");

interface SlotState<Info, Item> {
  /// One entry per claimed slot: the record waiting, EMPTY when its record is gone, or
  /// FILLED once paired.
  slots: (Item | typeof FILLED | typeof EMPTY)[];
  /// How many ExtraInfo events have arrived for the id.
  arrived: number;
  /// Arrivals whose slot is not claimed yet, by position.
  pending: Map<number, Info>;
  /// A failure that takes the next arrival if it comes before anything else claims it.
  optional?: { index: number; item: Item };
}
