/**
 * Skin studio client plugin: provides the {@link SkinStudioService} and
 * registers the "Skin Studio" settings section. The service binds the
 * durable settings scope, manages the active skin and custom skin
 * definitions, and applies the active skin to the DOM through
 * {@link BackgroundEngine}.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the settings slot declarations plus the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { SkinStudioService } from './SkinStudioService.ts'
import { SkinStudioPage, type SkinStudioPageInjected } from './SkinStudioPage.tsx'
import { en, zh, type SkinStudioKey } from './locales.ts'
import { SKIN_STUDIO_NAMESPACE } from '../skin-settings.ts'

export type { SkinStudioPageInjected, SkinStudioPageProps } from './SkinStudioPage.tsx'
export type { SkinStudioKey } from './locales.ts'
export type { SkinStudioService, SkinStudioSnapshot } from './SkinStudioService.ts'

/** Locale namespace owned by this plugin. */
const NS = 'skin-studio'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The skin studio settings page copy. */
    'skin-studio': SkinStudioKey
  }
}

/** Required services: slots + locale for the page, settingsScope + transport for the durable state. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Register the skin studio dictionaries, provide the service, and register
 * the settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skin-studio: copy dictionaries')

  const scope = ctx.settingsScope.bind<{ activeSkin: string; customSkins: Record<string, unknown> }>({
    namespace: SKIN_STUDIO_NAMESPACE,
  })
  const service = new SkinStudioService(ctx, scope as never)
  ctx.provide('skinStudio', service)

  const t = ctx.locale.bind(NS) as SkinStudioPageInjected['t']
  const injected = (): SkinStudioPageInjected => ({ service, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skin-studio',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, SkinStudioPage))
}
