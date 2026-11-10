// What peer.ts asks the system on Windows, where there is no lsof and no /bin/ps: which
// process holds the far end of a loopback connection (netstat, which prints the owning
// pid of every TCP connection) and the table of processes and their parents (PowerShell's
// CIM view of Win32_Process). Without them the RPC server cannot tell which thread a
// connection belongs to, and anything a thread's shell runs would count as the owner
// (docs/protocol.md, "Who's really calling").
//
// The parsers are separate from the calls so they can be tested on any system.
import { execFile } from 'node:child_process';

// A row of the process table as peer.ts reads it; Windows has no process groups, so no pgid.
export type ProcessRow = { pid: number; ppid: number; pgid?: number };

const LOOKUP_MS = 3000;
const BIG = 16 * 1024 * 1024;

// The pids of the processes whose own end of a TCP connection is this local port, from
// `netstat -ano -p tcp`:
//   TCP    127.0.0.1:50412        127.0.0.1:8797         ESTABLISHED     1234
//   TCP    [::1]:50413            [::1]:8797             ESTABLISHED     1234
// The state's name is in the system's language (HERGESTELLT, ETABLIE), so it is not
// read: a row whose local port is the client's is the client's end, whatever it says.
export function parseNetstat(stdout: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+:\d+\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[1]) === port) pids.push(Number(m[2]));
  }
  return [...new Set(pids)];
}

// "pid ppid" a line, from the PowerShell command below.
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

export function netstatPids(port: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile('netstat.exe', ['-ano', '-p', 'tcp'], { timeout: LOOKUP_MS, windowsHide: true, maxBuffer: BIG, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseNetstat(stdout, port));
    });
  });
}

export function windowsProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
      { timeout: LOOKUP_MS, windowsHide: true, maxBuffer: BIG, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(err);
        const rows = parseProcessTable(stdout);
        // An empty table is a lookup that failed, not a system with no processes.
        if (!rows.length) return reject(new Error('the process table came back empty'));
        resolve(rows);
      },
    );
  });
}
