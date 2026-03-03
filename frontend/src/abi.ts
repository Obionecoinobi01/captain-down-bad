export const CDB_ABI = [
  // ── Views ────────────────────────────────────────────────────────────────
  {
    name: 'nextRunId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'runs',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'runId', type: 'uint256' }],
    outputs: [
      { name: 'player',      type: 'address' },
      { name: 'levelId',     type: 'uint256' },
      { name: 'bet',         type: 'uint256' },
      { name: 'tick',        type: 'uint256' },
      { name: 'playerState', type: 'uint256' },
      { name: 'active',      type: 'bool'    },
      { name: 'finalScore',  type: 'uint256' },
    ],
  },
  {
    name: 'sessionKeys',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'runId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'getTile',
    type: 'function',
    stateMutability: 'pure',
    inputs: [
      { name: 'x', type: 'uint8' },
      { name: 'y', type: 'uint8' },
    ],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'GEM_SCORE',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'HOUSE_FEE_BPS',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── Writes ───────────────────────────────────────────────────────────────
  {
    name: 'startRun',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'bet',     type: 'uint256' },
      { name: 'levelId', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'authorizeSessionKey',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'uint256' },
      { name: 'key',   type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'submitMove',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'uint256' },
      { name: 'move',  type: 'uint8'   },
    ],
    outputs: [],
  },
  // ── Events ───────────────────────────────────────────────────────────────
  {
    name: 'RunStarted',
    type: 'event',
    inputs: [
      { name: 'runId',   type: 'uint256', indexed: true  },
      { name: 'player',  type: 'address', indexed: true  },
      { name: 'bet',     type: 'uint256', indexed: false },
      { name: 'levelId', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'SessionKeySet',
    type: 'event',
    inputs: [
      { name: 'runId', type: 'uint256', indexed: true  },
      { name: 'key',   type: 'address', indexed: true  },
    ],
  },
  {
    name: 'MovePlayed',
    type: 'event',
    inputs: [
      { name: 'runId', type: 'uint256', indexed: true  },
      { name: 'tick',  type: 'uint256', indexed: false },
      { name: 'move',  type: 'uint8',   indexed: false },
    ],
  },
  {
    name: 'TickAdvanced',
    type: 'event',
    inputs: [
      { name: 'runId',       type: 'uint256', indexed: true  },
      { name: 'tick',        type: 'uint256', indexed: false },
      { name: 'playerState', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'GemCollected',
    type: 'event',
    inputs: [
      { name: 'runId',    type: 'uint256', indexed: true  },
      { name: 'posX',     type: 'uint8',   indexed: false },
      { name: 'posY',     type: 'uint8',   indexed: false },
      { name: 'newScore', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'RunEnded',
    type: 'event',
    inputs: [
      { name: 'runId',      type: 'uint256', indexed: true  },
      { name: 'player',     type: 'address', indexed: true  },
      { name: 'payout',     type: 'uint256', indexed: false },
      { name: 'finalScore', type: 'uint256', indexed: false },
      { name: 'won',        type: 'bool',    indexed: false },
    ],
  },
] as const

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
