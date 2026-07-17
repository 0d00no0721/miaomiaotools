#!/usr/bin/env python3
"""
QuickPaste - 快捷粘贴工具
全局热键触发预设文本粘贴
支持自定义快捷键、多组内容、图形界面、托盘最小化
"""

import json
import os
import sys
import time
import threading
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

import pyperclip
import keyboard
import pystray
from PIL import Image, ImageDraw, ImageFont

# Windows API for reliable keybd_event
import ctypes

user32 = ctypes.windll.user32
# Extra delay for clipboard propagation (increase if paste fails)
CLIPBOARD_DELAY = 0.15


# ============================================================
# Paths — handle PyInstaller frozen mode correctly
# ============================================================
def get_app_dir():
    """Return the directory where the exe or script lives.

    When frozen by PyInstaller, __file__ points to a temp extraction dir.
    sys.executable points to the actual exe path.
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


APP_DIR = get_app_dir()
CONFIG_FILE = os.path.join(APP_DIR, "presets.json")


# ============================================================
# Paste — release modifiers first, then send clean Ctrl+V
# ============================================================
def release_all_modifiers():
    """Release all modifier keys that the user might still be holding.

    When a hotkey like Ctrl+Alt+G fires the callback, the user is still
    physically holding Ctrl and Alt. If we simulate Ctrl+V without
    releasing them first, the target window sees Ctrl+Alt+V and ignores it.
    """
    for key in ("ctrl", "alt", "shift", "left windows", "right windows"):
        try:
            keyboard.release(key)
        except Exception:
            pass


def simulate_paste():
    """Send a clean Ctrl+V to the system.

    1. Release all modifiers (user may still be holding the hotkey combo)
    2. Small delay for the release to propagate
    3. Use keyboard.send() which internally uses SendInput on Windows
    """
    release_all_modifiers()
    time.sleep(0.05)
    keyboard.send("ctrl+v", suppress=False)


# ============================================================
# Main Application
# ============================================================
class QuickPasteApp:
    """Main application class"""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("QuickPaste - 快捷粘贴工具")
        self.root.geometry("780x560")
        self.root.minsize(650, 450)

        # Center on screen
        self.root.update_idletasks()
        w, h = 780, 560
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        x = (sw - w) // 2
        y = (sh - h) // 2
        self.root.geometry(f"{w}x{h}+{x}+{y}")

        # Set window icon
        icon_path = os.path.join(APP_DIR, "icon.ico")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(get_script_dir(), "icon.ico")
        if os.path.exists(icon_path):
            try:
                self.root.iconbitmap(default=icon_path)
            except Exception:
                pass

        self.presets = []
        self.registered_hotkeys = {}  # hotkey_str -> callback
        self.tray_icon = None
        self.tray_thread = None
        self.app_focused = False

        # Track focus to prevent self-paste
        self.root.bind("<FocusIn>", lambda e: setattr(self, "app_focused", True))
        self.root.bind("<FocusOut>", lambda e: setattr(self, "app_focused", False))

        # Intercept window close → minimize to tray
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        self.load_presets()
        self.setup_gui()
        self.setup_tray()
        self.register_all_hotkeys()

    # ============================================================
    # Tray Icon
    # ============================================================

    def create_tray_image(self):
        """Create a clipboard icon for the system tray"""
        size = 64
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle([14, 12, 50, 58], radius=4, fill="#2196F3", outline="#1565C0", width=2)
        draw.rounded_rectangle([14, 12, 50, 30], radius=4, fill="#1565C0")
        draw.rounded_rectangle([24, 4, 40, 16], radius=2, fill="#64B5F6", outline="#1565C0", width=2)
        try:
            font = ImageFont.truetype("arial.ttf", 26)
            draw.text((25, 32), "P", fill="white", font=font)
        except Exception:
            draw.text((26, 34), "P", fill="white")
        return image

    def setup_tray(self):
        image = self.create_tray_image()

        def on_show(_icon, _item):
            self.root.after(0, self.show_window)

        def on_exit(_icon, _item):
            self.root.after(0, self.quit_app)

        menu = pystray.Menu(
            pystray.MenuItem("显示窗口", on_show, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", on_exit),
        )
        self.tray_icon = pystray.Icon("QuickPaste", image, "QuickPaste - 快捷粘贴工具", menu)
        self.tray_thread = threading.Thread(target=self.tray_icon.run, daemon=True)
        self.tray_thread.start()

    def show_window(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def on_close(self):
        """X button → minimize to tray"""
        self.root.withdraw()
        try:
            if self.tray_icon:
                self.tray_icon.notify("QuickPaste 正在后台运行", "点击托盘图标可重新显示窗口")
        except Exception:
            pass

    def quit_app(self):
        """Actually exit"""
        self.save_presets()
        self.unregister_all_hotkeys()
        if self.tray_icon:
            self.tray_icon.stop()
            time.sleep(0.15)
        self.root.quit()
        self.root.destroy()
        os._exit(0)

    # ============================================================
    # Config Load / Save
    # ============================================================

    def load_presets(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    self.presets = json.load(f)
            except Exception:
                self.presets = []
        if not self.presets:
            # Default examples
            self.presets = [
                {
                    "id": "1",
                    "label": "问候语",
                    "hotkey": "ctrl+alt+g",
                    "text": "您好，感谢您的来信！\n\n祝好！",
                    "enabled": True,
                },
                {
                    "id": "2",
                    "label": "邮箱地址",
                    "hotkey": "ctrl+alt+e",
                    "text": "contact@example.com",
                    "enabled": True,
                },
            ]
            self.save_presets()

    def save_presets(self):
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(self.presets, f, ensure_ascii=False, indent=2)
        except Exception as e:
            messagebox.showerror("保存失败", f"无法保存配置文件:\n{e}")

    # ============================================================
    # Hotkey Registration (using `keyboard` library)
    # ============================================================

    def register_all_hotkeys(self):
        """Unregister all, then re-register from presets."""
        self.unregister_all_hotkeys()

        for preset in self.presets:
            if not preset.get("enabled", True):
                continue
            hk = preset["hotkey"]
            text = preset["text"]
            label = preset["label"]
            try:
                callback = lambda t=text, l=label: self.do_paste(t, l)
                keyboard.add_hotkey(hk, callback, suppress=False)
                self.registered_hotkeys[hk] = callback
            except Exception as e:
                print(f"[QuickPaste] 注册热键失败 '{label}' ({hk}): {e}")

        self.update_status()

    def unregister_all_hotkeys(self):
        for hk in list(self.registered_hotkeys.keys()):
            try:
                keyboard.remove_hotkey(hk)
            except Exception:
                pass
        self.registered_hotkeys.clear()

    def do_paste(self, text, label):
        """Triggered by global hotkey — paste text at cursor."""
        # Skip if our own window is focused
        if self.app_focused:
            return

        try:
            # Save old clipboard
            old_clip = pyperclip.paste()

            # Write new content
            pyperclip.copy(text)
            time.sleep(CLIPBOARD_DELAY)

            # Simulate Ctrl+V
            simulate_paste()

            # Restore old clipboard after paste completes
            time.sleep(0.3)
            pyperclip.copy(old_clip)

        except Exception as e:
            print(f"[QuickPaste] 粘贴失败 '{label}': {e}")

    # ============================================================
    # GUI
    # ============================================================

    def setup_gui(self):
        style = ttk.Style()
        try:
            style.theme_use("vista")
        except Exception:
            pass

        main_frame = ttk.Frame(self.root, padding=10)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # ---- Toolbar ----
        toolbar = ttk.Frame(main_frame)
        toolbar.pack(fill=tk.X, pady=(0, 8))

        ttk.Button(toolbar, text="➕ 添加", command=self.add_preset).pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(toolbar, text="✏️ 编辑", command=self.edit_preset).pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(toolbar, text="🗑️ 删除", command=self.delete_preset).pack(side=tk.LEFT, padx=(0, 4))

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=8)

        ttk.Button(toolbar, text="💾 保存配置", command=self.save_and_refresh).pack(side=tk.LEFT, padx=(0, 4))

        # ---- Treeview ----
        tree_frame = ttk.Frame(main_frame)
        tree_frame.pack(fill=tk.BOTH, expand=True)

        columns = ("label", "hotkey", "text", "enabled")
        self.tree = ttk.Treeview(
            tree_frame, columns=columns, show="headings", selectmode="browse"
        )
        self.tree.heading("label", text="标签")
        self.tree.heading("hotkey", text="快捷键")
        self.tree.heading("text", text="内容预览")
        self.tree.heading("enabled", text="状态")

        self.tree.column("label", width=120, minwidth=80)
        self.tree.column("hotkey", width=160, minwidth=100)
        self.tree.column("text", width=380, minwidth=200)
        self.tree.column("enabled", width=60, minwidth=50, anchor="center")

        vsb = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)

        self.tree.bind("<Double-1>", lambda _e: self.edit_preset())

        # ---- Bottom buttons ----
        bottom = ttk.Frame(main_frame)
        bottom.pack(fill=tk.X, pady=(8, 0))

        self.enable_all_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            bottom, text="全部启用", variable=self.enable_all_var, command=self.toggle_all
        ).pack(side=tk.LEFT)

        ttk.Label(bottom, text=f"配置文件: {CONFIG_FILE}", foreground="gray", font=("", 8)).pack(
            side=tk.RIGHT
        )

        # ---- Status bar ----
        self.status_var = tk.StringVar()
        ttk.Label(
            self.root, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W
        ).pack(side=tk.BOTTOM, fill=tk.X, padx=2, pady=2)

        self.refresh_tree()
        self.update_status()

    def refresh_tree(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        for preset in self.presets:
            preview = preset["text"].replace("\n", "↵ ")
            if len(preview) > 60:
                preview = preview[:60] + "…"
            status = "✅" if preset.get("enabled", True) else "❌"
            self.tree.insert("", tk.END, iid=preset["id"], values=(
                preset["label"], preset["hotkey"], preview, status
            ))

    def get_selected_preset(self):
        sel = self.tree.selection()
        if not sel:
            return None
        pid = sel[0]
        for p in self.presets:
            if p["id"] == pid:
                return p
        return None

    def add_preset(self):
        dlg = PresetEditDialog(self.root, "添加快捷项")
        if dlg.result:
            self.presets.append(dlg.result)
            self.save_presets()
            self.refresh_tree()
            self.register_all_hotkeys()

    def edit_preset(self):
        preset = self.get_selected_preset()
        if not preset:
            messagebox.showwarning("未选择", "请先选择一个快捷项", parent=self.root)
            return
        dlg = PresetEditDialog(self.root, "编辑快捷项", preset)
        if dlg.result:
            idx = self.presets.index(preset)
            self.presets[idx] = dlg.result
            self.save_presets()
            self.refresh_tree()
            self.register_all_hotkeys()

    def delete_preset(self):
        preset = self.get_selected_preset()
        if not preset:
            messagebox.showwarning("未选择", "请先选择一个快捷项", parent=self.root)
            return
        if messagebox.askyesno("确认删除", f"确定要删除「{preset['label']}」吗？", parent=self.root):
            self.presets.remove(preset)
            self.save_presets()
            self.refresh_tree()
            self.register_all_hotkeys()

    def toggle_all(self):
        val = self.enable_all_var.get()
        for p in self.presets:
            p["enabled"] = val
        self.save_presets()
        self.refresh_tree()
        self.register_all_hotkeys()

    def save_and_refresh(self):
        self.save_presets()
        self.register_all_hotkeys()
        messagebox.showinfo("已保存", f"配置已保存到:\n{CONFIG_FILE}", parent=self.root)

    def update_status(self):
        enabled = sum(1 for p in self.presets if p.get("enabled", True))
        total = len(self.presets)
        self.status_var.set(f"运行中 ｜ 已注册 {enabled}/{total} 个热键")

    def run(self):
        self.root.mainloop()


def get_script_dir():
    """Return dir of this .py file (for dev mode icon lookup)."""
    return os.path.dirname(os.path.abspath(__file__))


# ============================================================
# Edit Dialog
# ============================================================
class PresetEditDialog:
    """Modal dialog for adding/editing a preset."""

    MODIFIER_ORDER = {"ctrl": 0, "alt": 1, "shift": 2, "win": 3}

    def __init__(self, parent, title, preset=None):
        self.result = None
        self.capturing = False
        self.capture_keys = []

        self.dialog = tk.Toplevel(parent)
        self.dialog.title(title)
        self.dialog.geometry("540x460")
        self.dialog.minsize(480, 380)
        self.dialog.transient(parent)
        self.dialog.grab_set()
        if parent.winfo_viewable():
            self.dialog.wait_visibility()
            self.dialog.lift()

        self.label_var = tk.StringVar(value=preset["label"] if preset else "")
        self.hotkey_var = tk.StringVar(value=preset["hotkey"] if preset else "")
        self.enabled_var = tk.BooleanVar(value=preset.get("enabled", True) if preset else True)

        self._build_gui(preset)
        self.original_id = preset["id"] if preset else None
        parent.wait_window(self.dialog)

    def _build_gui(self, preset):
        d = self.dialog
        f = ttk.Frame(d, padding=15)
        f.pack(fill=tk.BOTH, expand=True)

        # Label
        ttk.Label(f, text="标签:").grid(row=0, column=0, sticky=tk.W, pady=(0, 6))
        e_label = ttk.Entry(f, textvariable=self.label_var, width=42)
        e_label.grid(row=0, column=1, sticky=tk.EW, pady=(0, 6), padx=(6, 0))

        # Hotkey
        ttk.Label(f, text="快捷键:").grid(row=1, column=0, sticky=tk.W, pady=(0, 6))
        hk_frame = ttk.Frame(f)
        hk_frame.grid(row=1, column=1, sticky=tk.EW, pady=(0, 6), padx=(6, 0))
        self.hk_entry = ttk.Entry(hk_frame, textvariable=self.hotkey_var, width=32, state="readonly")
        self.hk_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.capture_btn = ttk.Button(hk_frame, text="🎯 录入", command=self.toggle_capture, width=8)
        self.capture_btn.pack(side=tk.RIGHT, padx=(5, 0))

        ttk.Label(
            f,
            text="支持: ctrl, shift, alt, win + 字母/数字/F键\n示例: ctrl+shift+e, win+v, ctrl+alt+g",
            foreground="gray", font=("", 9),
        ).grid(row=2, column=1, sticky=tk.W, pady=(0, 8))

        # Text
        ttk.Label(f, text="文本内容:").grid(row=3, column=0, sticky=tk.NW, pady=(0, 6))
        tf = ttk.Frame(f)
        tf.grid(row=3, column=1, sticky=tk.NSEW, pady=(0, 8), padx=(6, 0))
        self.text_widget = scrolledtext.ScrolledText(tf, wrap=tk.WORD, height=10, font=("Consolas", 10))
        self.text_widget.pack(fill=tk.BOTH, expand=True)
        if preset and "text" in preset:
            self.text_widget.insert("1.0", preset["text"])

        # Enabled
        ttk.Checkbutton(f, text="启用此快捷项", variable=self.enabled_var).grid(
            row=4, column=1, sticky=tk.W, pady=(0, 8)
        )

        # Buttons
        bf = ttk.Frame(f)
        bf.grid(row=5, column=0, columnspan=2, sticky=tk.E, pady=(8, 0))
        ttk.Button(bf, text="💾 保存", command=self.save, width=10).pack(side=tk.RIGHT, padx=(5, 0))
        ttk.Button(bf, text="取消", command=self.cancel, width=10).pack(side=tk.RIGHT)

        f.columnconfigure(1, weight=1)
        f.rowconfigure(3, weight=1)
        e_label.focus_set()

        d.bind("<Control-Return>", lambda _e: self.save())
        d.bind("<Escape>", lambda _e: self.cancel())

    def toggle_capture(self):
        if self.capturing:
            self.stop_capture()
        else:
            self.start_capture()

    def start_capture(self):
        self.capturing = True
        self.capture_keys = []
        self.hotkey_var.set("⌨ 按下快捷键组合...")
        self.capture_btn.config(text="⏹ 停止")
        self.dialog.bind("<KeyPress>", self._on_key_press)

    def stop_capture(self):
        self.capturing = False
        self.capture_btn.config(text="🎯 录入")
        self.dialog.unbind("<KeyPress>")
        if self.capture_keys:
            hk = "+".join(self.capture_keys)
            self.hotkey_var.set(hk)

    def _on_key_press(self, event):
        """Capture key presses using tkinter events (works within dialog)."""
        if not self.capturing:
            return

        keysym = event.keysym.lower()
        keycode = event.keycode

        # Map modifiers
        mod = None
        if keycode == 17 or keysym in ("control_l", "control_r"):
            mod = "ctrl"
        elif keycode == 16 or keysym in ("shift_l", "shift_r"):
            mod = "shift"
        elif keycode == 18 or keysym in ("alt_l", "alt_r"):
            mod = "alt"
        elif keycode == 91 or keycode == 92 or keysym in ("win_l", "win_r", "super_l", "super_r"):
            mod = "win"

        if mod:
            if mod not in self.capture_keys:
                self.capture_keys.append(mod)
            # Update display
            self.hotkey_var.set("⌨ " + "+".join(self.capture_keys) + "+...")
            return

        # Non-modifier key → finalize
        key_name = None
        if keysym.startswith("f") and keysym[1:].isdigit():
            key_name = keysym
        elif len(keysym) == 1 and keysym.isalpha():
            key_name = keysym
        elif len(keysym) == 1 and keysym.isdigit():
            key_name = keysym
        elif keysym in ("space", "tab", "enter", "return"):
            key_name = "space" if keysym == "space" else ("tab" if keysym == "tab" else "enter")
        else:
            # Try to get a printable char
            ch = event.char
            if ch and len(ch) == 1 and ch.isprintable():
                key_name = ch.lower()

        if key_name:
            self.capture_keys.append(key_name)
            # Sort: modifiers first (in order), then key
            mods = [k for k in self.capture_keys if k in ("ctrl", "alt", "shift", "win")]
            mods.sort(key=lambda x: self.MODIFIER_ORDER.get(x, 99))
            rest = [k for k in self.capture_keys if k not in ("ctrl", "alt", "shift", "win")]
            self.capture_keys = mods + rest
            self.hotkey_var.set("+".join(self.capture_keys))
            self.stop_capture()

    def save(self):
        label = self.label_var.get().strip()
        hotkey = self.hotkey_var.get().strip()
        text = self.text_widget.get("1.0", tk.END).strip()
        enabled = self.enabled_var.get()

        if not label:
            messagebox.showwarning("输入错误", "请输入标签名称", parent=self.dialog)
            return
        if not hotkey or hotkey.startswith("⌨"):
            messagebox.showwarning("输入错误", "请设置快捷键", parent=self.dialog)
            return
        if not text:
            messagebox.showwarning("输入错误", "请输入要粘贴的文本内容", parent=self.dialog)
            return

        self.result = {
            "id": self.original_id or str(int(time.time() * 1000)),
            "label": label,
            "hotkey": hotkey,
            "text": text,
            "enabled": enabled,
        }
        self.dialog.destroy()

    def cancel(self):
        self.stop_capture()
        self.dialog.destroy()


# ============================================================
# Entry Point
# ============================================================

def main():
    app = QuickPasteApp()
    app.run()


if __name__ == "__main__":
    main()