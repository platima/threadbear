// A thread's events as the rows the transcript draws. Rows are the shape
// web/src/turns.ts folds (TurnMessage), carrying what the desktop needs on
// top: tool output, diffs, cards. Events come in `seq` order; an older page
// of them means building again from the start.

import type { AnyEvent, ApprovalDecision, ApprovalOption, AskAnswer, DesignReview, Hunk, ImageRef, NeedsWho, PersistedEvent, PlanEntry, Question, ReviewDraft, ToolKind, TurnOutcome } from './types.ts';
import type { TurnMessage } from '../../../web/src/turns.ts';

export type ToolData = {
  itemId: string;
  name: string;
  kind: ToolKind;
  input: Record<string, unknown>;
  result?: { ok: boolean; text: string; truncated: boolean; images: ImageRef[] };
  diffs: Map<string, Hunk[]>;
};

export type CardData =
  | { type: 'approval'; approvalId: string; name: string; title: string; input: Record<string, unknown>; options: ApprovalOption[]; decision?: ApprovalDecision; message?: string }
  | { type: 'question'; approvalId: string; questions: Question[]; decision?: ApprovalDecision; message?: string }
  | { type: 'secret'; approvalId: string; label: string; reason: string; placeholder?: string; decision?: ApprovalDecision };

export type Row = TurnMessage & {
  id: string;
  rev?: number; // up by one each time the row changes, so a drawn row knows to draw again
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'card' | 'note' | 'error' | 'action' | 'turnEnd' | 'rewound' | 'review';
  images?: ImageRef[];
  answers?: AskAnswer[]; // a user message that answered a card of asks
  reviewId?: string; // a user message that answered a design review, or a review's row
  reviewResponse?: ReviewDraft;
  startsTurn?: boolean; // a user message that began its own turn: the ones that can be edited
  tool?: ToolData;
  card?: CardData;
  itemId?: string;
  narration?: boolean;
  outcome?: TurnOutcome;
  durationMs?: number;
  costUsd?: number;
  ok?: boolean;
  detail?: string; // an action's command, a turn's error
};

export type Streaming = { itemId: string; type: 'assistant.text' | 'reasoning'; text: string };

// How the latest turn ended, until something new happens: what the done card
// and the Needs you card read.
export type TurnEnd = { seq: number; outcome: TurnOutcome; needs?: NeedsWho; next?: string[] };

export class TranscriptModel {
  rows: Row[] = [];
  streaming = new Map<string, Streaming>();
  plan: PlanEntry[] = [];
  busy = false;
  turnId?: string;
  lastSeq = 0;
  private byItem = new Map<string, Row>();
  private byApproval = new Map<string, Row>();
  version = 0;
  // The latest snapshot of each design review the thread has, by id.
  reviews = new Map<string, DesignReview>();
  private reviewRows = new Map<string, Row>();
  private reviewFirstSeq = new Map<string, number>();
  // The ticks on each card of asks, by the card's asksSeq (asks.ticked).
  ticks = new Map<number, Set<number>>();
  lastEnd?: TurnEnd;
  // A user message begins its own turn when its turn.started follows it; one
  // sent into a running turn shares that turn's id and comes after it.
  private waiting = new Map<string, Row>();
  private started = new Set<string>();

  reset(): void {
    this.rows = [];
    this.streaming.clear();
    this.plan = [];
    this.busy = false;
    this.turnId = undefined;
    this.lastSeq = 0;
    this.byItem.clear();
    this.byApproval.clear();
    this.reviews.clear();
    this.reviewRows.clear();
    this.reviewFirstSeq.clear();
    this.ticks.clear();
    this.lastEnd = undefined;
    this.waiting.clear();
    this.started.clear();
    this.version++;
  }

  // Builds the rows again from a whole list of persisted events.
  build(events: PersistedEvent[], inProgress: Streaming[] = []): void {
    this.reset();
    for (const e of events) this.apply(e);
    for (const s of inProgress) this.streaming.set(s.itemId, s);
  }

  setInProgress(items: Streaming[]): void {
    for (const s of items) this.streaming.set(s.itemId, s);
    this.version++;
  }

  apply(e: AnyEvent): void {
    this.version++;
    const base = { seq: e.seq, at: e.ts, turn: e.turnId };
    switch (e.type) {
      case 'assistant.text.delta':
      case 'reasoning.delta': {
        const type = e.type === 'reasoning.delta' ? 'reasoning' : 'assistant.text';
        const s = this.streaming.get(e.itemId) ?? { itemId: e.itemId, type, text: '' };
        s.text += e.text;
        this.streaming.set(e.itemId, s);
        return;
      }
      case 'tool.output.delta': {
        const r = this.byItem.get(e.itemId);
        if (r?.tool) {
          r.tool.result = { ok: true, text: (r.tool.result?.text ?? '') + e.text, truncated: false, images: [] };
          this.touch(r);
        }
        return;
      }
    }
    if (e.seq > this.lastSeq) this.lastSeq = e.seq;
    switch (e.type) {
      case 'user.message': {
        const row: Row = { ...base, id: `u${e.seq}`, kind: 'user', role: 'user', text: e.text, images: e.images, origin: e.origin, answers: e.answers, reviewId: e.reviewId, reviewResponse: e.reviewResponse };
        if (e.turnId && !this.started.has(e.turnId) && !this.waiting.has(e.turnId)) this.waiting.set(e.turnId, row);
        this.lastEnd = undefined;
        this.push(row);
        break;
      }
      case 'assistant.text': {
        this.streaming.delete(e.itemId);
        const old = this.byItem.get(e.itemId);
        if (old && old.kind === 'assistant') {
          old.text = e.text;
          old.summary = e.summary;
          old.narration = e.narration;
          this.touch(old);
        } else {
          this.push({ ...base, id: `a${e.seq}`, kind: 'assistant', role: 'assistant', text: e.text, summary: e.summary, narration: e.narration, itemId: e.itemId });
        }
        break;
      }
      case 'reasoning':
        this.streaming.delete(e.itemId);
        this.push({ ...base, id: `r${e.seq}`, kind: 'reasoning', role: 'tool', text: e.text, itemId: e.itemId });
        break;
      case 'tool.call':
        this.push({
          ...base,
          id: `t${e.seq}`,
          kind: 'tool',
          role: 'tool',
          text: e.title,
          toolKind: e.kind,
          itemId: e.itemId,
          tool: { itemId: e.itemId, name: e.name, kind: e.kind, input: e.input, diffs: new Map() },
        });
        break;
      case 'tool.result': {
        const r = this.byItem.get(e.itemId);
        if (r?.tool) {
          r.tool.result = { ok: e.ok, text: e.text, truncated: e.truncated, images: e.images };
          this.touch(r);
        }
        break;
      }
      case 'edit.diff': {
        const r = this.byItem.get(e.itemId);
        if (r?.tool) {
          r.tool.diffs.set(e.path, e.hunks);
          this.touch(r);
        }
        break;
      }
      case 'approval.requested':
        this.card(base, `p${e.seq}`, { type: 'approval', approvalId: e.approvalId, name: e.name, title: e.title, input: e.input, options: e.options }, e.title);
        break;
      case 'question.requested':
        this.card(base, `q${e.seq}`, { type: 'question', approvalId: e.approvalId, questions: e.questions }, e.questions[0]?.question ?? 'A question');
        break;
      case 'secret.requested':
        this.card(base, `s${e.seq}`, { type: 'secret', approvalId: e.approvalId, label: e.label, reason: e.reason, placeholder: e.placeholder }, e.label);
        break;
      case 'approval.resolved': {
        const r = this.byApproval.get(e.approvalId);
        if (r?.card) {
          r.card.decision = e.decision;
          (r.card as { message?: string }).message = e.message;
          this.touch(r);
        }
        break;
      }
      case 'plan.updated':
        this.plan = e.entries;
        break;
      case 'turn.started': {
        this.busy = true;
        this.turnId = e.turnId;
        this.lastEnd = undefined;
        const first = this.waiting.get(e.turnId);
        this.started.add(e.turnId);
        if (first) {
          this.waiting.delete(e.turnId);
          first.startsTurn = true;
          this.touch(first);
        }
        break;
      }
      case 'turn.completed':
        this.busy = false;
        this.turnId = undefined;
        this.streaming.clear();
        this.lastEnd = { seq: e.seq, outcome: e.outcome, needs: e.needs, next: e.next };
        if (e.outcome !== 'completed' || e.error) {
          this.push({ ...base, id: `e${e.seq}`, kind: 'turnEnd', role: 'tool', text: e.error ?? (e.outcome === 'interrupted' ? 'Stopped' : 'Failed'), outcome: e.outcome, durationMs: e.durationMs, detail: e.error });
        }
        break;
      case 'system.note':
        this.push({ ...base, id: `n${e.seq}`, kind: 'note', role: 'tool', text: e.text });
        break;
      case 'error':
        this.push({ ...base, id: `x${e.seq}`, kind: 'error', role: 'tool', text: e.message });
        break;
      case 'action.run':
        this.push({ ...base, id: `c${e.seq}`, kind: 'action', role: 'tool', text: e.title, ok: e.ok, detail: e.text, durationMs: e.durationMs });
        break;
      case 'thread.rewound':
        this.rows = this.rows.filter((r) => r.seq < e.fromSeq || r.seq > e.toSeq);
        for (const [id, first] of this.reviewFirstSeq) {
          if (first >= e.fromSeq && first <= e.toSeq) {
            this.reviews.delete(id);
            this.reviewRows.delete(id);
            this.reviewFirstSeq.delete(id);
          }
        }
        for (const [turn, row] of this.waiting) if (row.seq >= e.fromSeq && row.seq <= e.toSeq) this.waiting.delete(turn);
        this.lastEnd = undefined;
        break;
      case 'review.updated': {
        const review = e.review;
        this.reviews.set(review.id, review);
        const row = this.reviewRows.get(review.id);
        if (row) this.touch(row);
        else {
          this.reviewFirstSeq.set(review.id, e.seq);
          this.reviewRows.set(review.id, this.pushRow({ ...base, id: `rv${e.seq}`, kind: 'review', role: 'tool', text: `threadbear: ${review.title}`, reviewId: review.id }));
        }
        break;
      }
      case 'asks.ticked':
        this.ticks.set(e.asksSeq, new Set(e.ticked));
        break;
      default:
        break;
    }
  }

  // A review the runner lists as pending that the loaded events don't cover
  // (older than the page): it has no row, but the card at the bottom shows it.
  mergeReview(review: DesignReview): void {
    const have = this.reviews.get(review.id);
    if (have && have.revision >= review.revision) return;
    this.reviews.set(review.id, review);
    const row = this.reviewRows.get(review.id);
    if (row) this.touch(row);
    this.version++;
  }

  pendingReviews(): DesignReview[] {
    return [...this.reviews.values()].filter((r) => r.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private touch(r: Row): void {
    r.rev = (r.rev ?? 0) + 1;
  }

  private push(r: Row): void {
    this.pushRow(r);
  }

  private pushRow(r: Row): Row {
    this.rows.push(r);
    if (r.itemId) this.byItem.set(r.itemId, r);
    return r;
  }

  private card(base: { seq: number; at: string; turn?: string }, id: string, card: CardData, text: string): void {
    const row: Row = { ...base, id, kind: 'card', role: 'tool', text: `threadbear: ${text}`, card };
    this.push(row);
    this.byApproval.set(card.approvalId, row);
  }

  // The card still waiting for an answer, if any.
  pending(): Row | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (r.card && !r.card.decision) return r;
    }
    return undefined;
  }
}
