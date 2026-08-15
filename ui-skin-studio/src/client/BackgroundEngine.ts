/**
 * Background engine: applies a custom skin's CSS to the DOM and retracts on
 * dispose. Writes CSS variables to `document.body`, injects a scoped
 * `<style>` element, and overrides `--dsw-alias-bg-*` tokens to translucent
 * rgba() so the background image shows through the panels.
 *
 * The engine never touches `backdrop-filter` on `body` or `#root` (an
 * ancestor backdrop-filter traps fixed-position overlays); per-panel
 * backdrop-filter is applied only on `[data-pane]` columns whose overlays
 * are React-portal'd to `document.body`.
 */
import type { CustomSkin, SkinRegion } from '../skin-settings.ts'
import { SKIN_REGIONS } from '../skin-settings.ts'

/** Body attribute scoping all skin studio CSS rules. */
const SKIN_BODY_ATTR = 'data-dsh-skin-studio-active'

/** Style element id for the injected skin stylesheet. */
const STYLE_ID = 'dsh-skin-studio-styles'

/** Known dsh-web-ui skin body attributes to retract during our application. */
const KNOWN_DSH_WEB_UI_ATTRS = [
  'data-dsh-blue-fantasy', 'data-dsh-whale-song', 'data-dsh-minecraft',
  'data-dsh-xp', 'data-dsh-qq98', 'data-dsh-ths', 'data-dsh-dragon-heir',
  'data-dsh-trading', 'data-dsh-miku',
]

/** Body-level backdrop properties to save/restore. */
const BACKDROP_PROPS = [
  'background-image', 'background-position', 'background-size',
  'background-attachment', 'background-repeat',
] as const

/** CSS variable prefix per region. */
function regionVar(region: SkinRegion, suffix: string): string {
  return `--dsh-skin-${region}-${suffix}`
}

/** Build the injected stylesheet text. */
function buildStylesheet(): string {
  const rules: string[] = []

  rules.push(`body[${SKIN_BODY_ATTR}] [id='root'] { background: transparent !important; }`)

  const gOp = regionVar('global', 'opacity')
  const sOp = regionVar('sidebar', 'opacity')
  rules.push(`body[${SKIN_BODY_ATTR}] {
    --dsw-alias-bg-base: rgba(255, 255, 255, calc(1 - var(${gOp}, 0) * 0.85));
    --dsw-alias-bg-layer-1: rgba(243, 245, 251, calc(1 - var(${gOp}, 0) * 0.8));
    --dsw-alias-bg-layer-2: rgba(233, 237, 247, calc(1 - var(${gOp}, 0) * 0.75));
    --dsw-alias-bg-overlay: rgba(238, 241, 249, calc(1 - var(${gOp}, 0) * 0.92));
    --dsw-alias-bg-module-platform: rgba(233, 237, 247, calc(1 - var(${gOp}, 0) * 0.8));
    --dsw-specific-sidebar-fill: rgba(242, 245, 250, calc(1 - var(${sOp}, 0) * 0.8));
    --dsw-specific-input-major: rgba(255, 255, 255, calc(1 - var(${gOp}, 0) * 0.7));
    --dsw-specific-menu: rgba(243, 245, 251, calc(1 - var(${gOp}, 0) * 0.92));
    --dsw-specific-tip: rgba(243, 245, 251, calc(1 - var(${gOp}, 0) * 0.85));
    --dsw-specific-selector: rgba(228, 234, 247, calc(1 - var(${gOp}, 0) * 0.8));
    --dsw-specific-bubble: rgba(220, 227, 247, calc(1 - var(${gOp}, 0) * 0.85));
  }`)

  rules.push(`body[${SKIN_BODY_ATTR}][data-ds-dark-theme] {
    --dsw-alias-bg-base: rgba(16, 22, 42, calc(1 - var(${gOp}, 0) * 0.85));
    --dsw-alias-bg-layer-1: rgba(26, 34, 56, calc(1 - var(${gOp}, 0) * 0.8));
    --dsw-alias-bg-layer-2: rgba(32, 42, 68, calc(1 - var(${gOp}, 0) * 0.75));
    --dsw-alias-bg-overlay: rgba(26, 34, 56, calc(1 - var(${gOp}, 0) * 0.92));
    --dsw-alias-bg-module-platform: rgba(32, 42, 68, calc(1 - var(${gOp}, 0) * 0.8));
    --dsw-specific-sidebar-fill: rgba(29, 37, 57, calc(1 - var(${sOp}, 0) * 0.82));
    --dsw-specific-input-major: rgba(26, 34, 56, calc(1 - var(${gOp}, 0) * 0.7));
    --dsw-specific-menu: rgba(26, 34, 56, calc(1 - var(${gOp}, 0) * 0.94));
    --dsw-specific-tip: rgba(26, 34, 56, calc(1 - var(${gOp}, 0) * 0.87));
    --dsw-specific-selector: rgba(30, 39, 64, calc(1 - var(${gOp}, 0) * 0.82));
    --dsw-specific-bubble: rgba(44, 55, 101, calc(1 - var(${gOp}, 0) * 0.85));
  }`)

  for (const region of SKIN_REGIONS) {
    if (region === 'global') {
      rules.push(`body[${SKIN_BODY_ATTR}] {
        background-image: var(${regionVar(region, 'image')}, none) !important;
        background-position: center !important;
        background-size: cover !important;
        background-attachment: fixed !important;
        background-repeat: no-repeat !important;
      }`)
    } else {
      const selector = region === 'sidebar'
        ? `[data-pane='sidebar']`
        : region === 'conversation'
          ? `[data-pane='conversation']`
          : `[data-pane='details']`
      rules.push(`body[${SKIN_BODY_ATTR}] ${selector} {
        background-image: var(${regionVar(region, 'image')}, none);
        background-position: center;
        background-size: cover;
        background-repeat: no-repeat;
        border-radius: var(${regionVar(region, 'radius')}, 0);
        border: var(${regionVar(region, 'border')}, none);
        box-shadow: var(${regionVar(region, 'shadow')}, none);
        -webkit-backdrop-filter: var(${regionVar(region, 'backdrop')}, none);
        backdrop-filter: var(${regionVar(region, 'backdrop')}, none);
      }`)
    }
  }

  return rules.join('\n')
}

/**
 * Applies a custom skin to the DOM and retracts on dispose. One instance per
 * active skin application; constructing a new engine first disposes the
 * previous one.
 */
export class BackgroundEngine {
  private readonly styleEl: HTMLStyleElement
  private readonly savedBodyAttrs: string[] = []
  private readonly savedBackdrop = new Map<string, string>()

  /**
   * @param skin - the custom skin to apply.
   */
  constructor(skin: CustomSkin) {
    const body = document.body

    for (const prop of BACKDROP_PROPS) {
      this.savedBackdrop.set(prop, body.style.getPropertyValue(prop))
    }

    for (const attr of KNOWN_DSH_WEB_UI_ATTRS) {
      if (body.hasAttribute(attr)) {
        this.savedBodyAttrs.push(attr)
        body.removeAttribute(attr)
      }
    }

    body.setAttribute(SKIN_BODY_ATTR, '')

    for (const region of SKIN_REGIONS) {
      const cfg = skin.regions[region]
      body.style.setProperty(regionVar(region, 'image'), cfg.image ? `url(${cfg.image})` : 'none')
      body.style.setProperty(regionVar(region, 'opacity'), String(cfg.opacity / 100))
      body.style.setProperty(regionVar(region, 'radius'), `${cfg.borderRadius}px`)
      body.style.setProperty(regionVar(region, 'border'), cfg.border || 'none')
      body.style.setProperty(regionVar(region, 'shadow'), cfg.shadow || 'none')
      body.style.setProperty(regionVar(region, 'backdrop'), cfg.backdropFilter || 'none')
    }

    this.styleEl = document.createElement('style')
    this.styleEl.id = STYLE_ID
    this.styleEl.textContent = buildStylesheet()
    document.head.append(this.styleEl)
  }

  /** Retract all DOM writes, restoring the previous state. */
  dispose(): void {
    const body = document.body
    body.removeAttribute(SKIN_BODY_ATTR)
    for (const attr of this.savedBodyAttrs) {
      body.setAttribute(attr, '')
    }
    for (const [prop, value] of this.savedBackdrop) {
      body.style.setProperty(prop, value)
    }
    for (const region of SKIN_REGIONS) {
      body.style.removeProperty(regionVar(region, 'image'))
      body.style.removeProperty(regionVar(region, 'opacity'))
      body.style.removeProperty(regionVar(region, 'radius'))
      body.style.removeProperty(regionVar(region, 'border'))
      body.style.removeProperty(regionVar(region, 'shadow'))
      body.style.removeProperty(regionVar(region, 'backdrop'))
    }
    this.styleEl.remove()
  }
}
