// VNC Server management and WebSocket-to-TCP RFB bridge for noVNC.
// Spawns x11vnc on demand on DISPLAY=:0 and proxies WebSocket traffic to 127.0.0.1:5900.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { MOCK, run } from './sys.js';
import * as auth from './auth.js';

const VNC_PORT = 5900;
let vncProcess = null;
let clientCount = 0;
let idleTimer = null;
const IDLE_TIMEOUT_MS = 60_000; // Stop x11vnc after 60s without clients

function findXauth() {
  if (process.env.XAUTHORITY && existsSync(process.env.XAUTHORITY)) {
    return process.env.XAUTHORITY;
  }
  const candidates = [
    '/home/ramtech/.Xauthority',
    '/root/.Xauthority',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function checkPortOpen(port, host = '127.0.0.1', timeout = 1000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

export async function ensureVncServer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (MOCK) {
    return { ok: true, mock: true, port: VNC_PORT };
  }

  const alreadyRunning = await checkPortOpen(VNC_PORT);
  if (alreadyRunning) {
    return { ok: true, port: VNC_PORT, alreadyRunning: true };
  }

  if (vncProcess) {
    try { vncProcess.kill(); } catch {}
    vncProcess = null;
  }

  const display = process.env.DISPLAY || ':0';
  const xauth = findXauth();

  const args = [
    '-display', display,
    '-forever',
    '-shared',
    '-nopw',
    '-listen', '127.0.0.1',
    '-rfbport', String(VNC_PORT),
    '-bg',
    '-o', '/tmp/x11vnc.log',
  ];
  if (xauth) args.push('-auth', xauth);

  try {
    const env = { ...process.env, DISPLAY: display };
    if (xauth) env.XAUTHORITY = xauth;

    const child = spawn('x11vnc', args, {
      env,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    vncProcess = child;

    // Wait up to 3s for port to start listening
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await checkPortOpen(VNC_PORT)) {
        return { ok: true, port: VNC_PORT };
      }
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return { ok: false, error: 'x11vnc failed to start on port ' + VNC_PORT };
}

export function stopVncServer() {
  if (vncProcess) {
    try { vncProcess.kill(); } catch {}
    vncProcess = null;
  }
  if (!MOCK && process.platform === 'linux') {
    run('pkill', ['-f', 'x11vnc.*5900']).catch(() => {});
  }
}

export function vncStatus() {
  return {
    ok: true,
    active: clientCount > 0,
    clients: clientCount,
    port: VNC_PORT,
    mock: MOCK,
  };
}

export function setupVncWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/vnc') return;

      // Authentication check for VNC access
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

  wss.on('connection', async (ws) => {
    clientCount++;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (MOCK) {
      // In mock mode, inform client or handle gracefully
      ws.send(JSON.stringify({ type: 'mock', message: 'VNC running in mock mode on Windows/development' }));
      ws.on('close', () => {
        clientCount = Math.max(0, clientCount - 1);
      });
      return;
    }

    await ensureVncServer();

    const tcpSocket = net.createConnection({ port: VNC_PORT, host: '127.0.0.1' }, () => {
      // Direct raw binary piping between noVNC (WebSocket) and x11vnc (TCP)
      ws.on('message', (msg) => {
        try { tcpSocket.write(msg); } catch {}
      });

      tcpSocket.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(chunk); } catch {}
        }
      });
    });

    const cleanup = () => {
      try { tcpSocket.destroy(); } catch {}
      try { ws.close(); } catch {}
      clientCount = Math.max(0, clientCount - 1);
      if (clientCount === 0) {
        idleTimer = setTimeout(() => {
          if (clientCount === 0) stopVncServer();
        }, IDLE_TIMEOUT_MS);
      }
    };

    tcpSocket.on('error', cleanup);
    tcpSocket.on('close', cleanup);
    ws.on('error', cleanup);
    ws.on('close', cleanup);
  });
}
