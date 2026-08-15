/** Durable settings schema for the skin studio: active skin + custom skin definitions. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the skin studio plugin (the plain string; the Host half wraps it with `settingsNamespace()`). */
export const SKIN_STUDIO_NAMESPACE = 'ui-skin-studio'

/** Field carrying the active skin id ("official" or a custom skin id). */
export const ACTIVE_SKIN_FIELD = 'activeSkin'

/** Field carrying the custom skin definitions map. */
export const CUSTOM_SKINS_FIELD = 'customSkins'

/** The four independently configurable UI regions. */
export const SKIN_REGIONS = ['global', 'sidebar', 'conversation', 'details'] as const

/** One configurable region. */
export type SkinRegion = typeof SKIN_REGIONS[number]

/** Per-region style configuration. */
export interface RegionConfig {
  /** Background image as a data URL (empty string = no image). */
  image: string
  /** Background opacity 0-100 (0 = invisible, 100 = fully opaque). */
  opacity: number
  /** Border radius in px. */
  borderRadius: number
  /** CSS border shorthand string (empty = no border). */
  border: string
  /** CSS box-shadow string (empty = no shadow). */
  shadow: string
  /** CSS backdrop-filter string (empty = no filter). */
  backdropFilter: string
}

/** One custom skin definition. */
export interface CustomSkin {
  /** User-facing skin name. */
  name: string
  /** Per-region configuration. */
  regions: Record<SkinRegion, RegionConfig>
}

/** Default region config: no image, moderate opacity, no decorations. */
export function defaultRegionConfig(): RegionConfig {
  return { image: '', opacity: 50, borderRadius: 0, border: '', shadow: '', backdropFilter: '' }
}

/** Default custom skin with all four regions at defaults. */
export function defaultCustomSkin(name: string): CustomSkin {
  return {
    name,
    regions: {
      global: defaultRegionConfig(),
      sidebar: defaultRegionConfig(),
      conversation: defaultRegionConfig(),
      details: defaultRegionConfig(),
    },
  }
}

/** The "official" skin id — reverts to the stock UI. */
export const OFFICIAL_SKIN_ID = 'official'

/** Durable skin studio settings stored in the user-settings document. */
export interface SkinStudioSettings {
  /** Active skin id ("official" or a custom skin id). */
  activeSkin: string
  /** Custom skin definitions keyed by id. */
  customSkins: Record<string, CustomSkin>
}

/** Runtime schema for the skin studio settings section. */
export const SkinStudioSettingsSchema: z<SkinStudioSettings> = z.object({
  [ACTIVE_SKIN_FIELD]: z.string().default(OFFICIAL_SKIN_ID),
  [CUSTOM_SKINS_FIELD]: z.any().default({}),
})
