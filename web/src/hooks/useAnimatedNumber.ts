import { useEffect, useRef, useState } from 'react'

export function useAnimatedNumber(value: number | null | undefined, duration = 700): number {
  const target = typeof value === 'number' && Number.isFinite(value) ? value : 0
  const [shown, setShown] = useState(target)
  const fromRef = useRef(target)

  useEffect(() => {
    const from = fromRef.current
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - t) ** 3
      const next = from + (target - from) * eased
      setShown(next)
      if (t < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  return shown
}
