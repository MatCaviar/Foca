/**
 * Simulated car head unit world, faithful to the recorded bridge-cockpit
 * blockade: standard Android write APIs succeed vocally while the vendor
 * layer swallows them; input injection is denied to the app identity but
 * allowed to a local shell identity once the adbd socket is prepared; the
 * imaudio vendor AIDL really controls the microphone while its sound-stage
 * writes mutate only the service's own store.
 *
 * Probe tools implement the guard's verification contract: they accept
 * optional `expect*` arguments and return `{ observed, agrees? }`.
 * @module @deepseek-ai/dsh-blockade-sim
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Mutable state of the simulated head unit. */
export class CarWorld {
  /** True media volume index (what the audio service get returns). */
  volume = 25
  /** HVAC temperature in Celsius; vendor layer swallows app writes. */
  hvacTemperature = 22
  /** Active track index; SmartLink never forwards transport controls. */
  trackIndex = 3
  /** imaudio service store for the mic level (shares state with the writer). */
  micVocal = 3
  /** Independent audio-policy mirror of the mic level. */
  micVocalPolicy = 3
  /** imaudio service store for the sound stage (the same-store lie). */
  soundStageService = 0
  /** DSP-applied sound-stage mode (ground truth). */
  soundStageDsp = 0
  /** Whether the local adbd socket preparation enabled the shell identity. */
  localShellEnabled = false

  /**
   * Ground truth for the volume scenario.
   * @param target - the intended volume index.
   * @returns whether the true volume reached the target.
   */
  volumeSatisfied(target: number): boolean {
    return this.volume === target
  }

  /**
   * Register the world's tools on the tool registry.
   * @param ctx - registrant context carrying `ctx.tools`.
   */
  register(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'car_audio_adjust_volume',
      description: 'Adjust the media volume through the standard AudioManager API.',
      parameters: {
        volume: { type: 'integer', required: true, description: 'Target volume index (0-39).' },
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
        // The vendor layer swallows app-originated writes: the call reports
        // SUCCESS while the volume index never moves.
        return Promise.resolve({ status: 'SUCCESS', observed: `adjustVolume returned SUCCESS (requested ${args.volume})` })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_hvac_set',
      description: 'Set the HVAC temperature through CarPropertyManager.',
      parameters: {
        temperature: { type: 'number', required: true, description: 'Target temperature in Celsius.' },
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
        return Promise.resolve({ status: 'SUCCESS', observed: `setProperty(${args.temperature}) returned SUCCESS` })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_media_next',
      description: 'Skip to the next track through MediaController.transportControls.',
      parameters: {
        targetTrackIndex: { type: 'integer', description: 'Expected resulting track index (for verification).' },
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
      execute: () => {
        // SmartLink phone-projection sessions do not forward transport
        // controls: the call succeeds, the queue never moves.
        return Promise.resolve({ status: 'SUCCESS', observed: 'skipToNext() returned SUCCESS' })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_input_keyevent',
      description: 'Inject a key event exactly as the physical key would (the user-equivalent path). Requires the shell identity.',
      parameters: {
        key: { type: 'string', required: true, enum: ['VOLUME_UP', 'VOLUME_DOWN', 'MEDIA_NEXT'], description: 'Which key to press.' },
        times: { type: 'integer', required: true, description: 'How many times to press it.' },
        targetVolume: { type: 'integer', description: 'Expected resulting volume index when the key is a volume key.' },
        identity: { type: 'string', enum: ['shell'], description: 'Identity to inject under; omitting it uses the app identity.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            injected: { type: 'boolean', required: true },
            observed: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.observed }],
      },
      execute: (args) => {
        if (args.identity !== 'shell') {
          throw new Error('SecurityException: injecting input events requires the input group (INJECT_EVENTS is signature-level; the app identity is not in gid 1004)')
        }
        if (!this.localShellEnabled) {
          throw new Error('SecurityException: the local adb route to the shell identity is not prepared (run car_setup_adbd_socket once)')
        }
        if (args.key === 'VOLUME_UP') this.volume = Math.min(39, this.volume + args.times)
        else if (args.key === 'VOLUME_DOWN') this.volume = Math.max(0, this.volume - args.times)
        // MEDIA_NEXT injects fine; the SmartLink session still ignores it.
        return Promise.resolve({ injected: true, observed: `injected ${args.key} × ${args.times} as shell` })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_setup_adbd_socket',
      description: 'One-time environment preparation: open the local adbd socket so the app can reach the shell identity (the recorded breakthrough).',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ready: { type: 'boolean', required: true },
            observed: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.observed }],
      },
      execute: () => {
        this.localShellEnabled = true
        return Promise.resolve({ ready: true, observed: 'chmod 666 /dev/socket/adbd done; local adb can now reach the shell identity (uid 2000, gid 1004)' })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_su_exec',
      description: 'Run a command as root through su.',
      parameters: {
        command: { type: 'string', required: true, description: 'The command to run as root.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stdout: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.stdout }],
      },
      execute: () => {
        throw new Error('su: permission denied — uid is not root and not in the su allowlist')
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_set_mic_vocal',
      description: 'Set the microphone vocal level through the imaudio vendor AIDL.',
      parameters: {
        level: { type: 'integer', required: true, description: 'Target level (0-9).' },
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
        this.micVocal = args.level
        this.micVocalPolicy = args.level
        return Promise.resolve({ status: 'SUCCESS', observed: `set_mic_vocal(${args.level}) accepted by the vendor AIDL` })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_set_sound_stage',
      description: 'Set the sound-stage mode through the imaudio vendor AIDL.',
      parameters: {
        mode: { type: 'integer', required: true, description: 'Target mode (0-4).' },
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
        // The service accepts and stores the write; the DSP never applies it
        // — the same-store lie that only a ground-truth channel exposes.
        this.soundStageService = args.mode
        return Promise.resolve({ status: 'SUCCESS', observed: `set_sound_stage(${args.mode}) accepted by the vendor AIDL` })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_get_volume',
      description: 'Read the media volume through the audio service public get (independent of any write path).',
      parameters: {
        expectVolume: { type: 'integer', description: 'Expected volume when verifying a write.' },
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
        const observed = `volume index = ${this.volume}`
        return Promise.resolve({
          observed,
          ...(args.expectVolume === undefined ? {} : { agrees: this.volume === args.expectVolume }),
        })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_get_hvac',
      description: 'Read the HVAC temperature (independent readback).',
      parameters: {
        expectTemperature: { type: 'number', description: 'Expected temperature when verifying a write.' },
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
        const observed = `hvac temperature = ${this.hvacTemperature}`
        return Promise.resolve({
          observed,
          ...(args.expectTemperature === undefined ? {} : { agrees: this.hvacTemperature === args.expectTemperature }),
        })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_get_media',
      description: 'Read the active media queue position (independent readback).',
      parameters: {
        expectTrackIndex: { type: 'integer', description: 'Expected track index when verifying a write.' },
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
        const observed = `track index = ${this.trackIndex}`
        return Promise.resolve({
          observed,
          ...(args.expectTrackIndex === undefined ? {} : { agrees: this.trackIndex === args.expectTrackIndex }),
        })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_imaudio_service_get',
      description: 'Read the imaudio service own store (shares state with the writer — weak evidence).',
      parameters: {
        expectSoundStage: { type: 'integer', description: 'Expected sound-stage mode when verifying a write.' },
        expectMicVocal: { type: 'integer', description: 'Expected mic level when verifying a write.' },
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
        const observed = `service store: soundStage=${this.soundStageService} micVocal=${this.micVocal}`
        const expectations: boolean[] = []
        if (args.expectSoundStage !== undefined) expectations.push(this.soundStageService === args.expectSoundStage)
        if (args.expectMicVocal !== undefined) expectations.push(this.micVocal === args.expectMicVocal)
        return Promise.resolve({
          observed,
          ...(expectations.length === 0 ? {} : { agrees: expectations.every(Boolean) }),
        })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_dsp_dump',
      description: 'Dump the DSP applied sound-stage mode (ground truth).',
      parameters: {
        expectMode: { type: 'integer', description: 'Expected applied mode when verifying a write.' },
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
        const observed = `dsp applied mode = ${this.soundStageDsp}`
        return Promise.resolve({
          observed,
          ...(args.expectMode === undefined ? {} : { agrees: this.soundStageDsp === args.expectMode }),
        })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'car_audio_policy_dump',
      description: 'Read the audio policy mirror of the microphone level (independent channel).',
      parameters: {
        expectMicVocal: { type: 'integer', description: 'Expected mic level when verifying a write.' },
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
        const observed = `audio policy mic level = ${this.micVocalPolicy}`
        return Promise.resolve({
          observed,
          ...(args.expectMicVocal === undefined ? {} : { agrees: this.micVocalPolicy === args.expectMicVocal }),
        })
      },
    }))
  }
}
