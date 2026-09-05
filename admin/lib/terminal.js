// Interactive web console terminal service for RAMTECH OS device manager.
// Provides both real-time streaming WebSocket terminal (/ws/terminal) and one-shot command execution.
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import * as auth from './auth.js';
import { MOCK, ROOT } from './sys.js';

const activeSessions = new Set();

function getShell() {
  if (process.platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoLogo'] };
  }
  const bash = '/bin/bash';
  return { cmd: bash, args: ['-i'] };
}

export function execCommand(command, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    if (!command || typeof command !== 'string') {
      return resolve({ ok: false, error: 'Command required' });
    }

    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin ? ['-NoLogo', '-Command', command] : ['-c', command];

    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      RAMTECH_ROOT: ROOT,
    };

    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(shellCmd, shellArgs, {
      env,
      cwd: MOCK ? process.cwd() : ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !killed,
        code: code ?? (killed ? 124 : 1),
        stdout,
        stderr: killed ? `${stderr}\n[Command timed out after ${timeout / 1000}s]` : stderr,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 1, stdout: '', stderr: err.message });
    });
  });
}

export function setupTerminalWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/terminal') return;

      if (!auth.isAuthed(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    const { cmd, args } = getShell();
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      RAMTECH_ROOT: ROOT,
    };

    let child;
    try {
      child = spawn(cmd, args, {
        env,
        cwd: MOCK ? process.cwd() : ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      ws.send(`\r\n\x1b[31mFailed to start shell: ${e.message}\x1b[0m\r\n`);
      ws.close();
      return;
    }

    activeSessions.add(child);

    // Initial greeting / banner
    const banner = [
      '\r\n\x1b[1;36m====================================================\x1b[0m',
      '\x1b[1;36m  RAMTECH OS Console Terminal                       \x1b[0m',
      `\x1b[90m  Connected to ${MOCK ? 'Development Host' : 'RAMTECH Appliance'} (${process.platform})\x1b[0m`,
      '\x1b[1;36m====================================================\x1b[0m\r\n\r\n',
    ].join('\r\n');
    ws.send(banner);

    child.stdout.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString('utf8'));
      }
    });

    child.stderr.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString('utf8'));
      }
    });

    ws.on('message', (data) => {
      const str = data.toString('utf8');
      try {
        // Check for JSON control messages
        if (str.startsWith('{') && str.endsWith('}')) {
          const parsed = JSON.parse(str);
          if (parsed.type === 'signal' && parsed.signal === 'SIGINT') {
            if (process.platform !== 'win32') {
              try { child.kill('SIGINT'); } catch {}
            } else {
              try { child.stdin.write('\x03'); } catch {}
            }
            return;
          }
        }
      } catch {}

      try {
        child.stdin.write(str);
      } catch {}
    });

    const cleanup = () => {
      activeSessions.delete(child);
      try { child.kill(); } catch {}
    };

    child.on('close', (code) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
        ws.close();
      }
      cleanup();
    });

    child.on('error', (err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\x1b[31m[Process error: ${err.message}]\x1b[0m\r\n`);
      }
      cleanup();
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}
