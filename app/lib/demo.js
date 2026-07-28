// lib/demo.js — fake state so you can preview the TV look with no credentials.
// Enable by setting DEMO=true in .env (or DEMO=1).
const IMG = (seed) => `https://picsum.photos/seed/${seed}/600/600`;
const AV = (seed) => `https://i.pravatar.cc/80?img=${seed}`;

let start = Date.now();
const DUR = 214000;

export function demoState() {
  const progress = (Date.now() - start) % DUR;
  return {
    isPlaying: true,
    progressMs: progress,
    nowPlaying: {
      id: 'demo1', name: 'Midnight City', artists: 'M83',
      album: 'Hurry Up, We\'re Dreaming', image: IMG('midnight'),
      durationMs: DUR, uri: 'spotify:track:demo1', addedBy: 'Alex',
    },
    queue: [
      { id: 'q1', name: 'Instant Crush', artists: 'Daft Punk, Julian Casablancas', image: IMG('daft'), durationMs: 337000, uri: 'u1', addedBy: 'Sam' },
      { id: 'q2', name: 'The Less I Know The Better', artists: 'Tame Impala', image: IMG('tame'), durationMs: 216000, uri: 'u2', addedBy: 'Jordan' },
      { id: 'q3', name: 'Redbone', artists: 'Childish Gambino', image: IMG('redbone'), durationMs: 327000, uri: 'u3', addedBy: 'Alex' },
      { id: 'q4', name: 'Electric Feel', artists: 'MGMT', image: IMG('mgmt'), durationMs: 229000, uri: 'u4', addedBy: 'Priya' },
      { id: 'q5', name: 'Dreams', artists: 'Fleetwood Mac', image: IMG('dreams'), durationMs: 257000, uri: 'u5', addedBy: 'Sam' },
      { id: 'q6', name: 'Passionfruit', artists: 'Drake', image: IMG('pf'), durationMs: 298000, uri: 'u6', addedBy: null },
    ],
    jam: {
      active: true,
      joinUrl: 'https://open.spotify.com/socialsession/DEMOtoken1234567890',
      usingFallback: false,
      members: [
        { name: 'Alex', image: AV(12), isOwner: true },
        { name: 'Sam', image: AV(5), isOwner: false },
        { name: 'Jordan', image: AV(33), isOwner: false },
        { name: 'Priya', image: AV(45), isOwner: false },
      ],
    },
    ts: Date.now(),
  };
}
