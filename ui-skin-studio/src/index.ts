/**
 * Host registration for the skin studio settings namespace.
 * @module @deepseek-ai/dsh-client-ui-skin-studio
 */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  SKIN_STUDIO_NAMESPACE, SkinStudioSettingsSchema,
} from './skin-settings.ts'

export {
  ACTIVE_SKIN_FIELD, CUSTOM_SKINS_FIELD, OFFICIAL_SKIN_ID, SKIN_REGIONS,
  SKIN_STUDIO_NAMESPACE, type CustomSkin, type RegionConfig, type SkinRegion,
  type SkinStudioSettings, defaultCustomSkin, defaultRegionConfig,
} from './skin-settings.ts'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'ui-skin-studio'

/** Services required before the skin studio can register its settings. */
export const inject = ['settings']

/** The namespaced settings key the Host registers and the client binds. */
const NAMESPACED_KEY = settingsNamespace(SKIN_STUDIO_NAMESPACE)

/**
 * Register the durable skin studio settings section.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACED_KEY, SkinStudioSettingsSchema)
  })
}
