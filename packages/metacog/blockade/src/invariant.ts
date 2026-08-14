/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-blockade`.
 * @module @deepseek-ai/dsh-blockade/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-blockade'

/** Cordis companion plugin name. */
export const name = 'blockade-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the ledger is private to the guard's listeners and its
 * model-visible effects are all logged `user/message` facts the session log
 * already owns, leaving no package-owned stream for a companion to observe.
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
