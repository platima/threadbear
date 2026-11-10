// What peer.ts reads on Windows (peer-windows.ts). The parsers run on any system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetstat, parseProcessTable } from '../../src/peer-windows.ts';

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1092
  TCP    127.0.0.1:8797         0.0.0.0:0              LISTENING       4120
  TCP    127.0.0.1:8797         127.0.0.1:50412        ESTABLISHED     4120
  TCP    127.0.0.1:50412        127.0.0.1:8797         ESTABLISHED     7788
  TCP    [::1]:50413            [::1]:8797             ESTABLISHED     9001
  TCP    [::1]:8797             [::1]:50413            ESTABLISHED     4120
  TCP    192.168.1.5:50499      93.184.216.34:443      TIME_WAIT       0
  UDP    0.0.0.0:5353           *:*                                    1234
`;

test('netstat: the process whose own end of the connection is the client port', () => {
  // The server's row for the same connection has the port as its REMOTE end, and is not the client.
  assert.deepEqual(parseNetstat(NETSTAT, 50412), [7788]);
  assert.deepEqual(parseNetstat(NETSTAT, 50413), [9001]);
  // The server's own port is its LISTENING row and its end of each connection: a client port only.
  assert.deepEqual(parseNetstat(NETSTAT, 8797).sort(), [4120]);
  assert.deepEqual(parseNetstat(NETSTAT, 50499), [0]);
  assert.deepEqual(parseNetstat(NETSTAT, 12345), []);
});

test('netstat: the state is not read, so a system in another language still works', () => {
  const de = '  TCP    127.0.0.1:50412        127.0.0.1:8797         HERGESTELLT     7788\r\n  TCP    127.0.0.1:50413        127.0.0.1:8797         ETABLIE         7790\r\n';
  assert.deepEqual(parseNetstat(de, 50412), [7788]);
  assert.deepEqual(parseNetstat(de, 50413), [7790]);
});

test('netstat: nothing else on a line is taken for a row', () => {
  assert.deepEqual(parseNetstat('', 50412), []);
  assert.deepEqual(parseNetstat('garbage 50412\n  TCP 127.0.0.1:50412', 50412), []);
  assert.deepEqual(parseNetstat('  UDP    127.0.0.1:50412        *:*                                    7788\n', 50412), []);
});

test('the process table: one "pid ppid" a line, and anything else is left out', () => {
  assert.deepEqual(parseProcessTable('4 0\r\n 100 4 \r\n\r\nnot a row\r\n7788 100\n'), [
    { pid: 4, ppid: 0 },
    { pid: 100, ppid: 4 },
    { pid: 7788, ppid: 100 },
  ]);
  assert.deepEqual(parseProcessTable(''), []);
  assert.deepEqual(parseProcessTable('a b\n1\n1 2 3\n'), []);
});
