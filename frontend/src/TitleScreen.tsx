import { useEffect, useRef } from 'react'

// ── Config ────────────────────────────────────────────────────────────────────
const SCALE      = 5          // 1 logical pixel → 5 screen pixels (40×40 sprite)
const CANVAS_W   = 480
const CANVAS_H   = 56
const GROUND_Y   = 8          // y offset to draw sprites
const WALK_SPEED = 0.9        // px per animation frame

// ── Types ─────────────────────────────────────────────────────────────────────
type Px     = string | null
type Frame  = Px[][]

// ── Palette ───────────────────────────────────────────────────────────────────
const K = '#111111'  // outline
const _ = null       // transparent

// Captain Down Bad
const CB = '#4499ff' // cape blue
const CS = '#ffcc99' // skin
const CG = '#ffdd00' // gold D emblem
const CL = '#1155cc' // dark blue legs

// Pink Troll
const TP = '#ff55aa' // pink body
const TE = '#440022' // dark angry eyes
const TK = '#cc2266' // dark pink accent

// Hooded Demon
const DV = '#9944ff' // violet robe
const DD = '#5500aa' // dark violet shadow
const DR = '#ff2200' // red glowing eyes

// ── Sprite frames ─────────────────────────────────────────────────────────────
// 8 wide × 8 tall, row-major

const CAPTAIN_FRAMES: Frame[] = [
  // frame 0 — left foot forward
  [
    [_,_,K ,K ,K ,K ,_,_],
    [_,K ,CS,CS,CS,K ,_,_],
    [K ,CB,CS,CS,CS,CB,K ,_],
    [K ,CB,K ,CG,K ,CB,K ,_],
    [K ,CB,CB,CB,CB,CB,K ,_],
    [_,K ,CL,CL,CL,K ,_,_],
    [_,K ,CL,_,CL,K ,_,_],
    [_,K ,K ,_,K ,K ,_,_],
  ],
  // frame 1 — right foot forward
  [
    [_,_,K ,K ,K ,K ,_,_],
    [_,K ,CS,CS,CS,K ,_,_],
    [K ,CB,CS,CS,CS,CB,K ,_],
    [K ,CB,K ,CG,K ,CB,K ,_],
    [K ,CB,CB,CB,CB,CB,K ,_],
    [_,K ,CL,CL,CL,K ,_,_],
    [_,_,K ,CL,CL,K ,_,_],
    [_,_,K ,K ,K ,K ,_,_],
  ],
]

const TROLL_FRAMES: Frame[] = [
  // frame 0 — left foot
  [
    [_,K ,TP,TP,TP,K ,_,_],
    [_,K ,TE,TP,TE,K ,_,_],
    [K ,TP,TP,TP,TP,TP,K ,_],
    [K ,TK,TP,TP,TP,TK,K ,_],
    [_,K ,TP,TP,TP,K ,_,_],
    [_,K ,TK,_,TK,K ,_,_],
    [_,K ,K ,_,K ,K ,_,_],
    [_,_,_,_,_,_,_,_],
  ],
  // frame 1 — right foot
  [
    [_,K ,TP,TP,TP,K ,_,_],
    [_,K ,TE,TP,TE,K ,_,_],
    [K ,TP,TP,TP,TP,TP,K ,_],
    [K ,TK,TP,TP,TP,TK,K ,_],
    [_,K ,TP,TP,TP,K ,_,_],
    [_,_,K ,TK,K ,_,_,_],
    [_,_,K ,K ,_,_,_,_],
    [_,_,_,_,_,_,_,_],
  ],
]

// Demon shifts 1 row up/down to create floating effect
const DEMON_FRAMES: Frame[] = [
  // frame 0 — float low
  [
    [_,K ,DV,DV,DV,DV,K ,_],
    [K ,DV,DV,DV,DV,DV,DV,K],
    [K ,DV,DR,_,DR,DV,DV,K],
    [K ,DV,DD,DV,DD,DV,K ,_],
    [_,K ,DV,DV,DV,K ,_,_],
    [_,_,K ,DV,K ,_,_,_],
    [_,_,_,K ,_,_,_,_],
    [_,_,_,_,_,_,_,_],
  ],
  // frame 1 — float high (shifted up 1 row)
  [
    [_,_,_,_,_,_,_,_],
    [_,K ,DV,DV,DV,DV,K ,_],
    [K ,DV,DV,DV,DV,DV,DV,K],
    [K ,DV,DR,_,DR,DV,DV,K],
    [K ,DV,DD,DV,DD,DV,K ,_],
    [_,K ,DV,DV,DV,K ,_,_],
    [_,_,K ,DV,K ,_,_,_],
    [_,_,_,K ,_,_,_,_],
  ],
]

// ── Draw helper ───────────────────────────────────────────────────────────────
function drawSprite(ctx: CanvasRenderingContext2D, frame: Frame, x: number, y: number) {
  for (let row = 0; row < frame.length; row++) {
    for (let col = 0; col < frame[row].length; col++) {
      const color = frame[row][col]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(
        Math.round(x) + col * SCALE,
        y + row * SCALE,
        SCALE,
        SCALE,
      )
    }
  }
}

// ── Walker state ──────────────────────────────────────────────────────────────
interface Walker {
  x: number
  frameIdx: number
  frameTick: number
  ticksPerFrame: number
  frames: Frame[]
  glow: string
}

// ── Component ─────────────────────────────────────────────────────────────────
export function TitleScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false

    const walkers: Walker[] = [
      { x: 40,  frameIdx: 0, frameTick: 0, ticksPerFrame: 8,  frames: CAPTAIN_FRAMES, glow: '#4499ff' },
      { x: 200, frameIdx: 0, frameTick: 0, ticksPerFrame: 7,  frames: TROLL_FRAMES,   glow: '#ff55aa' },
      { x: 360, frameIdx: 1, frameTick: 0, ticksPerFrame: 10, frames: DEMON_FRAMES,   glow: '#9944ff' },
    ]

    let rafId: number

    function tick() {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

      // Ground line
      ctx.fillStyle = '#00ffcc14'
      ctx.fillRect(0, CANVAS_H - 4, CANVAS_W, 1)

      for (const w of walkers) {
        // Advance animation frame
        w.frameTick++
        if (w.frameTick >= w.ticksPerFrame) {
          w.frameTick = 0
          w.frameIdx = (w.frameIdx + 1) % w.frames.length
        }

        // Move right, wrap around
        w.x += WALK_SPEED
        if (w.x > CANVAS_W + 48) w.x = -48

        // Draw with colour glow
        ctx.shadowColor = w.glow
        ctx.shadowBlur  = 10
        drawSprite(ctx, w.frames[w.frameIdx], w.x, GROUND_Y)
        ctx.shadowBlur  = 0
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_W}
      height={CANVAS_H}
      className="title-canvas"
    />
  )
}
