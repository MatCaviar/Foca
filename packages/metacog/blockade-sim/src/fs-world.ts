/**
 * Simulated managed-filesystem world: direct writes to the managed banner
 * succeed and are then re-materialized from the config daemon's master copy
 * at the next sync cycle; only the official importer changes the master.
 * The `fs_read_after_sync` probe forces a sync before reading, which is what
 * turns the transient disk write into a detected swallow.
 * @module @deepseek-ai/dsh-blockade-sim
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Mutable state of the simulated managed filesystem. */
export class FsWorld {
  /** The config daemon's master copy (what survives sync cycles). */
  bannerMaster = 'Welcome'
  /** What is currently on disk (re-materialized from master on sync). */
  bannerDisk = 'Welcome'

  /**
   * Register the world's tools on the tool registry.
   * @param ctx - registrant context carrying `ctx.tools`.
   */
  register(ctx: Context): void {
    const writeTool = (name: string, description: string): void => {
      ctx.tools.register(defineTool({
        name,
        description,
        parameters: {
          content: { type: 'string', required: true, description: 'Full banner text to write.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              observed: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `${value.status}: ${value.observed}` }],
        },
        execute: (args) => {
          // The write lands on disk and reports success; the daemon owns the
          // master copy and re-materializes it at every sync cycle.
          this.bannerDisk = args.content
          return Promise.resolve({ status: 'SUCCESS', observed: `wrote ${args.content.length} bytes to banner.conf` })
        },
      }))
    }

    writeTool('fs_write_file', 'Write the banner file directly.')
    writeTool('fs_write_atomic', 'Write the banner file atomically (temp file plus rename).')

    ctx.tools.register(defineTool({
      name: 'fs_configctl_import',
      description: 'Import the banner through the official config importer the administrator uses (changes the master copy).',
      parameters: {
        content: { type: 'string', required: true, description: 'Full banner text to import.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            observed: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `${value.status}: ${value.observed}` }],
      },
      execute: (args) => {
        this.bannerMaster = args.content
        this.bannerDisk = args.content
        return Promise.resolve({ status: 'SUCCESS', observed: `configctl imported banner (${args.content.length} bytes)` })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'fs_read_after_sync',
      description: 'Force one config-daemon sync cycle, then read the banner (ground truth after re-materialization).',
      parameters: {
        expectContent: { type: 'string', description: 'Expected banner when verifying a write.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            observed: { type: 'string', required: true },
            agrees: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.observed }],
      },
      execute: (args) => {
        this.bannerDisk = this.bannerMaster
        const observed = `banner after sync = ${this.bannerDisk}`
        return Promise.resolve({
          observed,
          ...(args.expectContent === undefined ? {} : { agrees: this.bannerDisk === args.expectContent }),
        })
      },
    }))
  }
}
