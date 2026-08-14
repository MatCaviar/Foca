/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-blockade-sim`.
 * @module @deepseek-ai/dsh-blockade-sim/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-blockade-sim'

/** Cordis companion plugin name. */
export const name = 'blockade-sim-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the worlds are in-memory test doubles whose state is
 * private to the registering plugin and surfaces only through ordinary tool
 * executions, leaving no package-owned stream for a companion to observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
