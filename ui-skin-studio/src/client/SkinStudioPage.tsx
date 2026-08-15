/**
 * Skin studio settings page: gallery of available skins (official + custom)
 * and a custom skin editor with per-region background image, opacity, border,
 * radius, shadow, and backdrop filter controls. Registered as a
 * `settings.section` entry.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import clsx from 'clsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SkinStudioService } from './SkinStudioService.ts'
import {
  defaultCustomSkin, OFFICIAL_SKIN_ID, SKIN_REGIONS, type CustomSkin, type RegionConfig, type SkinRegion,
} from '../skin-settings.ts'
import { compressImage } from './image-utils.ts'
import type { SkinStudioKey } from './locales.ts'
import css from './SkinStudioPage.module.css'

/** Injected business face. */
export interface SkinStudioPageInjected {
  /** Skin studio service. */
  service: SkinStudioService
  /** Bound translate function. */
  t: Translate<SkinStudioKey>
}

/** Full composed props. */
export type SkinStudioPageProps = SettingsSectionOwnerProps & SkinStudioPageInjected

/** One skin card in the gallery. */
interface SkinCardData {
  id: string
  name: string
  desc: string | undefined
  isOfficial: boolean
  previewUrl: string | undefined
}

/** Editor draft state. */
interface EditorDraft {
  id: string
  skin: CustomSkin
}

/**
 * Render the skin studio settings page.
 * @param props - composed slot props.
 * @returns the page element tree.
 */
export function SkinStudioPage({ service, t, close: _close }: SkinStudioPageProps): React.ReactNode {
  const snapshot = useSyncExternalStore(service.subscribe.bind(service), service.getSnapshot.bind(service))
  const [editing, setEditing] = useState<EditorDraft | null>(null)
  const [activeRegion, setActiveRegion] = useState<SkinRegion>('global')
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { setToast(null) }, 2000)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
  }, [])

  const cards: SkinCardData[] = [
    { id: OFFICIAL_SKIN_ID, name: t('gallery.official'), desc: t('gallery.official.desc'), isOfficial: true, previewUrl: undefined },
    ...Object.entries(snapshot.customSkins).map(([id, skin]) => ({
      id, name: skin.name, desc: undefined, isOfficial: false,
      previewUrl: skin.regions.global.image || undefined,
    })),
  ]

  const handleApply = useCallback((id: string): void => {
    service.setActiveSkin(id)
    showToast(t('toast.applied'))
  }, [service, showToast, t])

  const handleDelete = useCallback((id: string): void => {
    service.deleteCustomSkin(id)
    showToast(t('toast.deleted'))
  }, [service, showToast, t])

  const handleNewSkin = useCallback((): void => {
    const id = service.createCustomSkin(t('gallery.new'))
    const skin = service.getSnapshot().customSkins[id] ?? defaultCustomSkin(t('gallery.new'))
    setEditing({ id, skin })
  }, [service, t])

  const handleEdit = useCallback((id: string): void => {
    const skin = service.getSnapshot().customSkins[id]
    if (skin !== undefined) setEditing({ id, skin: JSON.parse(JSON.stringify(skin)) as CustomSkin })
  }, [service])

  const handleSave = useCallback((): void => {
    if (editing === null) return
    service.saveCustomSkin(editing.id, editing.skin)
    service.setActiveSkin(editing.id)
    setEditing(null)
    showToast(t('toast.saved'))
  }, [editing, service, showToast, t])

  const handleCancel = useCallback((): void => {
    setEditing(null)
  }, [])

  const updateRegion = useCallback((region: SkinRegion, patch: Partial<RegionConfig>): void => {
    if (editing === null) return
    const nextSkin: CustomSkin = {
      ...editing.skin,
      regions: {
        ...editing.skin.regions,
        [region]: { ...editing.skin.regions[region], ...patch },
      },
    }
    setEditing({ ...editing, skin: nextSkin })
  }, [editing])

  const handleImageUpload = useCallback(async (region: SkinRegion, e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (file === undefined) return
    const compressed = await compressImage(file)
    updateRegion(region, { image: compressed })
    if (file.size > 500 * 1024) showToast(t('toast.imageTooLarge'))
  }, [updateRegion, showToast, t])

  const handleImageClear = useCallback((region: SkinRegion): void => {
    updateRegion(region, { image: '' })
  }, [updateRegion])

  if (editing !== null) {
    const regionCfg = editing.skin.regions[activeRegion]
    return (
      <div className={css.page}>
        <div className={css.header}>
          <h2 className={css.title}>{t('editor.title')}</h2>
        </div>
        <div className={css.editor}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('editor.name')}</span>
            <input
              type="text"
              className={css.textInput}
              value={editing.skin.name}
              placeholder={t('editor.name.placeholder')}
              onChange={(e) => setEditing({ ...editing, skin: { ...editing.skin, name: e.target.value } })}
            />
          </label>
          <div className={css.regionTabs}>
            {SKIN_REGIONS.map((region) => (
              <button
                key={region}
                type="button"
                className={clsx(css.regionTab, activeRegion === region && css.regionTabActive)}
                onClick={() => { setActiveRegion(region) }}
              >
                {t(`editor.regions.${region}` as SkinStudioKey)}
              </button>
            ))}
          </div>
          <div className={css.regionConfig}>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('editor.image')}</span>
              <div className={css.imageRow}>
                {regionCfg.image ? (
                  <img src={regionCfg.image} alt="" className={css.imagePreview} />
                ) : (
                  <div className={css.imagePlaceholder}>{t('editor.noImage')}</div>
                )}
                <label className={css.uploadButton}>
                  <span>{t('editor.image.upload')}</span>
                  <input
                    type="file"
                    accept="image/*"
                    className={css.fileInput}
                    onChange={(e) => { void handleImageUpload(activeRegion, e) }}
                  />
                </label>
                {regionCfg.image && (
                  <button type="button" className={css.clearButton} onClick={() => { handleImageClear(activeRegion) }}>
                    {t('editor.image.clear')}
                  </button>
                )}
              </div>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('editor.opacity')}: {regionCfg.opacity}%</span>
              <input
                type="range"
                min="0"
                max="100"
                value={regionCfg.opacity}
                onChange={(e) => { updateRegion(activeRegion, { opacity: Number(e.target.value) }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('editor.borderRadius')}: {regionCfg.borderRadius}px</span>
              <input
                type="range"
                min="0"
                max="30"
                value={regionCfg.borderRadius}
                onChange={(e) => { updateRegion(activeRegion, { borderRadius: Number(e.target.value) }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('editor.border')}</span>
              <input
                type="text"
                className={css.textInput}
                value={regionCfg.border}
                placeholder={t('editor.border.placeholder')}
                onChange={(e) => { updateRegion(activeRegion, { border: e.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('editor.shadow')}</span>
              <input
                type="text"
                className={css.textInput}
                value={regionCfg.shadow}
                placeholder={t('editor.shadow.placeholder')}
                onChange={(e) => { updateRegion(activeRegion, { shadow: e.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('editor.backdropFilter')}</span>
              <input
                type="text"
                className={css.textInput}
                value={regionCfg.backdropFilter}
                placeholder={t('editor.backdropFilter.placeholder')}
                onChange={(e) => { updateRegion(activeRegion, { backdropFilter: e.target.value }) }}
              />
            </label>
          </div>
          <div className={css.editorActions}>
            <button type="button" className={css.primaryButton} onClick={handleSave}>{t('editor.save')}</button>
            <button type="button" className={css.secondaryButton} onClick={handleCancel}>{t('editor.cancel')}</button>
          </div>
        </div>
        {toast && <div className={css.toast}>{toast}</div>}
      </div>
    )
  }

  return (
    <div className={css.page}>
      <div className={css.header}>
        <h2 className={css.title}>{t('gallery.title')}</h2>
      </div>
      <div className={css.gallery}>
        {cards.map((card) => (
          <div
            key={card.id}
            className={clsx(css.skinCard, snapshot.activeSkin === card.id && css.skinCardActive)}
          >
            <div className={css.skinCardPreview}>
              {card.previewUrl && <img src={card.previewUrl} alt="" className={css.skinCardImage} />}
              {!card.previewUrl && <div className={css.skinCardPlaceholder} />}
            </div>
            <div className={css.skinCardInfo}>
              <span className={css.skinCardName}>{card.name}</span>
              {card.desc && <span className={css.skinCardDesc}>{card.desc}</span>}
              {snapshot.activeSkin === card.id && <span className={css.skinCardBadge}>{t('gallery.applied')}</span>}
            </div>
            <div className={css.skinCardActions}>
              <button type="button" className={css.smallButton} onClick={() => { handleApply(card.id) }}>
                {t('gallery.apply')}
              </button>
              {!card.isOfficial && (
                <>
                  <button type="button" className={css.smallButton} onClick={() => { handleEdit(card.id) }}>
                    {t('gallery.edit')}
                  </button>
                  <button type="button" className={css.smallButtonDanger} onClick={() => { handleDelete(card.id) }}>
                    {t('gallery.delete')}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        <button type="button" className={css.newSkinCard} onClick={handleNewSkin}>
          <span className={css.newSkinPlus}>+</span>
          <span>{t('gallery.new')}</span>
        </button>
      </div>
      {toast && <div className={css.toast}>{toast}</div>}
    </div>
  )
}
