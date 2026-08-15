/**
 * Skin studio service: owns the live skin state (active skin + custom skin
 * definitions), reads/writes the durable settings scope, and applies the
 * active skin to the DOM through {@link BackgroundEngine}. Emits `skin/change`
 * when the active skin or custom skin definitions change.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  ACTIVE_SKIN_FIELD, CUSTOM_SKINS_FIELD, defaultCustomSkin, OFFICIAL_SKIN_ID,
  type CustomSkin, type SkinStudioSettings,
} from '../skin-settings.ts'
import { BackgroundEngine } from './BackgroundEngine.ts'

/** Immutable snapshot published on every skin state change. */
export interface SkinStudioSnapshot {
  /** Active skin id ("official" or a custom skin id). */
  activeSkin: string
  /** Custom skin definitions keyed by id. */
  customSkins: Record<string, CustomSkin>
  /** Monotonic change counter. */
  revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Skin studio service (optional — only when the plugin is mounted). */
    skinStudio?: SkinStudioService
  }
  interface Events {
    /**
     * Skin studio state changed (active skin switched or custom skins updated).
     * @param snapshot - Current immutable snapshot.
     * @mode emit
     */
    'skin/change'(snapshot: SkinStudioSnapshot): void
  }
}

/**
 * Manages skin state, settings persistence, and DOM application.
 */
export class SkinStudioService {
  private readonly ctx: Context
  private readonly scope: SettingsScope<SkinStudioSettings>
  private activeSkin = OFFICIAL_SKIN_ID
  private customSkins: Record<string, CustomSkin> = {}
  private revision = 0
  private snapshot: SkinStudioSnapshot
  private engine: BackgroundEngine | null = null

  /**
   * @param ctx - owning context (events emitted on it; scope listener released through ctx.effect).
   * @param scope - durable settings scope for the skin studio namespace.
   */
  constructor(ctx: Context, scope: SettingsScope<SkinStudioSettings>) {
    this.ctx = ctx
    this.scope = scope
    this.snapshot = this.buildSnapshot()
    ctx.effect(() => scope.subscribe(() => { this.adopt() }), 'ui-skin-studio: settings scope adoption')
    this.adopt()
  }

  /** Read the current immutable snapshot. */
  getSnapshot(): SkinStudioSnapshot {
    return this.snapshot
  }

  /** Observe skin state changes (useSyncExternalStore compatible). */
  subscribe(listener: () => void): () => void {
    return this.ctx.on('skin/change', listener)
  }

  /** Set the active skin by id. */
  setActiveSkin(id: string): void {
    if (id === this.activeSkin) return
    this.activeSkin = id
    void this.scope.set(ACTIVE_SKIN_FIELD, id)
    this.apply()
    this.publish()
  }

  /** Save a custom skin definition (creates or replaces). */
  saveCustomSkin(id: string, skin: CustomSkin): void {
    this.customSkins = { ...this.customSkins, [id]: skin }
    void this.scope.set(CUSTOM_SKINS_FIELD, this.customSkins)
    if (this.activeSkin === id) this.apply()
    this.publish()
  }

  /** Delete a custom skin by id. */
  deleteCustomSkin(id: string): void {
    if (this.customSkins[id] === undefined) return
    const next = { ...this.customSkins }
    delete next[id]
    this.customSkins = next
    void this.scope.set(CUSTOM_SKINS_FIELD, this.customSkins)
    if (this.activeSkin === id) {
      this.activeSkin = OFFICIAL_SKIN_ID
      void this.scope.set(ACTIVE_SKIN_FIELD, OFFICIAL_SKIN_ID)
      this.apply()
    }
    this.publish()
  }

  /** Create a new custom skin with a unique id and default config. */
  createCustomSkin(name: string): string {
    const id = `custom-${Date.now()}`
    this.saveCustomSkin(id, defaultCustomSkin(name))
    return id
  }

  /** Adopt the scope's durable values without writing back. */
  private adopt(): void {
    const section = this.scope.getSnapshot().value
    if (section === undefined) return
    const changed = section.activeSkin !== this.activeSkin
      || JSON.stringify(section.customSkins) !== JSON.stringify(this.customSkins)
    if (!changed) return
    this.activeSkin = section.activeSkin
    this.customSkins = section.customSkins ?? {}
    this.apply()
    this.publish()
  }

  /** Apply the active skin to the DOM. */
  private apply(): void {
    this.engine?.dispose()
    this.engine = null
    if (this.activeSkin === OFFICIAL_SKIN_ID) return
    const skin = this.customSkins[this.activeSkin]
    if (skin === undefined) {
      this.activeSkin = OFFICIAL_SKIN_ID
      return
    }
    this.engine = new BackgroundEngine(skin)
  }

  private buildSnapshot(): SkinStudioSnapshot {
    return Object.freeze({
      activeSkin: this.activeSkin,
      customSkins: Object.freeze({ ...this.customSkins }),
      revision: this.revision,
    })
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    this.ctx.emit('skin/change', this.snapshot)
  }

  /** Dispose the engine and release resources. */
  dispose(): void {
    this.engine?.dispose()
    this.engine = null
  }
}
