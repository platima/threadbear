// The runner's own protocol types and constants, shared with the runner.
// They are plain TypeScript with no imports (runner/src/protocol.ts).
export * from '../../../runner/src/protocol.ts';
import type { Account, CliStatus, Pool, RunnerDefaults } from '../../../runner/src/protocol.ts';

export type HelloResult = {
  runnerVersion: string;
  protocol: number;
  accounts: Account[];
  pools?: Pool[];
  defaults: RunnerDefaults;
  clis?: CliStatus[];
};
