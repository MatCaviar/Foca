/**
 * Blockade simulation plugin: mounts the three deterministic worlds (car
 * head unit, web backend, managed filesystem) as model-facing tools. Used by
 * the keyless experiment runner and usable live with a real model through the
 * `blockade-lab` example leaf.
 * @module @deepseek-ai/dsh-blockade-sim
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CarWorld } from './car-world.ts'
import { WebWorld } from './web-world.ts'
import { FsWorld } from './fs-world.ts'
import type { WorldId } from './scenarios.ts'

/** Plugin configuration: which simulated worlds to mount. */
export interface Config {
  /** Which worlds to mount (default: all three). */
  worlds?: WorldId[]
}

export const Config: z<Config> = z.object({
  worlds: z.array(z.union(['car', 'web', 'fs'] as const)).default(['car', 'web', 'fs']),
})

export const name = 'blockade-sim'
export const inject = ['tools']

export { CarWorld } from './car-world.ts'
export { WebWorld } from './web-world.ts'
export { FsWorld } from './fs-world.ts'
export type { WorldId, Scenario } from './scenarios.ts'
export { SCENARIOS, blockadeConfigFor, scenarioById } from './scenarios.ts'
export { PolicyAdapter } from './policy.ts'
export type { PolicyMode, Candidate, ScenarioScript, IdentityUnlock } from './policy.ts'

/**
 * Mount the selected simulated worlds on the tool registry.
 * @param ctx - plugin context carrying `ctx.tools`.
 * @param config - which worlds to mount.
 * @returns the mounted world instances, keyed by id, for ground-truth scoring.
 */
export function apply(ctx: Context, config: Config): { car: CarWorld; web: WebWorld; fs: FsWorld } {
  const worlds = config.worlds ?? ['car', 'web', 'fs']
  const car = new CarWorld()
  const web = new WebWorld()
  const fs = new FsWorld()
  if (worlds.includes('car')) car.register(ctx)
  if (worlds.includes('web')) web.register(ctx)
  if (worlds.includes('fs')) fs.register(ctx)
  return { car, web, fs }
}
