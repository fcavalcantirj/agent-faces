'use client'

// TEMPORARY demo mount for the ported EIDOLON particle face + HUD.
// Lets a human confirm the face renders and all 12 emotions cycle via the
// 1-0/Q/W keys or the on-screen controls. Replaced by the full conversation
// orchestrator UI in the "Wire the full conversation orchestrator" task.
import dynamic from 'next/dynamic'
import { useState } from 'react'
import { FaceHud } from '@/components/face-hud'
import type { Emotion } from '@/lib/face-points'

// The R3F renderer touches browser-only APIs (canvas 2D sprite, WebGL), so
// load it client-only to avoid running document.createElement during SSR.
const AgentFace = dynamic(
  () => import('@/components/agent-face').then((m) => m.AgentFace),
  { ssr: false },
)

export default function Home() {
  const [emotion, setEmotion] = useState<Emotion>('neutral')

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background">
      <AgentFace emotion={emotion} />
      <FaceHud emotion={emotion} onEmotionChange={setEmotion} />
    </main>
  )
}
