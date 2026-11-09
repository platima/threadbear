// What a spec can do to an app and read back. Both apps take the same JSON
// commands (app/README.md, "Seeing and driving it from a script") and give the
// same `dump`, so the steps never ask which app they're driving. Only the
// handful of things one app can't name the same way are methods here.
export type Row = {
  id: string;
  kind: string;
  text: string;
  expanded?: boolean;
  seq?: number;
  turn?: string;
  inGroup?: boolean;
  /** What the row's buttons say, on the apps that report them. */
  buttons?: string[];
};

export type Thread = {
  id: string;
  title: string;
  status: string;
  needsYou: boolean;
  unread: boolean;
};

export type Dump = {
  connection: string;
  selection?: Thread | null;
  sidebar: {
    mode: string;
    sections: { name: string; collapsed?: boolean; threads: Thread[] }[];
    snoozed: number;
    archived: number;
  };
  composer: { draft: string; text: string };
  transcript: {
    threadId?: string;
    state?: string;
    atBottom?: boolean;
    hasMoreAbove?: boolean;
    rows: Row[];
  };
  banner?: { style: string; text: string; detail?: string } | null;
};

export interface Driver {
  readonly name: 'swift' | 'gpui';
  start(): Promise<void>;
  /** Runs one command and returns its result line. Throws if it failed. */
  do(cmd: Record<string, unknown>, timeoutSeconds?: number): Promise<string>;
  dump(): Promise<Dump>;
  /** Saves a picture of the window, for a failed scenario. */
  shot(file: string): Promise<void>;
  stop(): Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
