/** Panel stylesheet: mirror of the Settings shell tokens (ui-settings-general SettingsRoot.module.css). */

export const PANEL_CSS = [
  /* Trigger row copies Settings.trigger (34px compact / 36px rail circle). */
  '.ra-trigger{flex:none;display:flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px 4px;padding:6px 2px 6px 10px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}',
  '.ra-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ra-trigger.ra-rail{width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0;border-radius:50%}',
  '.ra-trigger.ra-rail .ra-trigger-label{display:none}',
  '.ra-trigger-label{overflow:hidden;white-space:nowrap}',
  /* Full-viewport mask + centered panel, same tokens as Settings. */
  '.ra-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}',
  '.ra-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
  '.ra-panel{position:relative;z-index:1;display:flex;flex-direction:column;width:800px;height:min(640px,calc(100vh - 48px));max-width:calc(100vw - 48px);border-radius:24px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}',
  '.ra-header{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;height:54px;padding:20px 14px 8px 10px;box-sizing:border-box}',
  '.ra-header-title{font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.ra-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:28px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-primary)}',
  '.ra-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ra-close-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  '.ra-error{color:var(--dsw-alias-label-danger, #c62828);font-size:12px;padding:0 24px}',
  '.ra-empty{padding:32px 12px;color:var(--dsw-alias-label-secondary);text-align:center}',
  /* Options area scrolls like Settings .options. */
  '.ra-options{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto}',
  '.ra-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
  '.ra-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.15));border-radius:8px}',
  '.ra-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.ra-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.ra-row-meta{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center}',
  '.ra-time{margin-left:auto}',
  '.ra-restore{background:transparent;border:1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.15));border-radius:6px;padding:4px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px}',
  '.ra-restore:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ra-restore:disabled{opacity:.6;cursor:default}',
].join('\n')

export const STYLE_ID = 'ra-panel-style'
