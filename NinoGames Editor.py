"""
NinoGames Editor
────────────────
Edit NinoGames source files and build a new portable EXE.
Requires Python 3.8+ (tkinter included). Node/npm must be installed to build.
"""

import json
import os
import re
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk

# ── Theme colours ─────────────────────────────────────────────
BG        = "#1a1a1a"
BG2       = "#242424"
BG3       = "#2e2e2e"
ACCENT    = "#7c6af7"
ACCENT2   = "#5b4fd4"
FG        = "#e8e8e8"
FG2       = "#a0a0a0"
GREEN     = "#4caf82"
RED       = "#e05c5c"
BORDER    = "#383838"

FONT      = ("Segoe UI", 10)
FONT_BOLD = ("Segoe UI", 10, "bold")
FONT_H    = ("Segoe UI", 13, "bold")
FONT_MONO = ("Consolas", 9)


# ══════════════════════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════════════════════

def styled_entry(parent, textvariable=None, width=30, **kw):
    e = tk.Entry(
        parent, textvariable=textvariable, width=width,
        bg=BG3, fg=FG, insertbackground=FG,
        relief="flat", highlightthickness=1,
        highlightbackground=BORDER, highlightcolor=ACCENT,
        font=FONT, **kw
    )
    return e


def styled_btn(parent, text, command, color=ACCENT, fg=FG, **kw):
    btn = tk.Button(
        parent, text=text, command=command,
        bg=color, fg=fg, activebackground=ACCENT2, activeforeground=FG,
        relief="flat", cursor="hand2", font=FONT_BOLD,
        padx=14, pady=6, bd=0, **kw
    )
    return btn


def section_label(parent, text):
    f = tk.Frame(parent, bg=BG)
    tk.Label(f, text=text, bg=BG, fg=ACCENT, font=FONT_H).pack(side="left")
    tk.Frame(f, bg=BORDER, height=1).pack(side="left", fill="x", expand=True, padx=(10, 0), pady=6)
    return f


def row(parent, label, widget_factory, pady=4):
    """Label + widget in a two-column grid row."""
    f = tk.Frame(parent, bg=BG2)
    tk.Label(f, text=label, bg=BG2, fg=FG2, font=FONT, width=26, anchor="w").pack(side="left", padx=(10, 6))
    w = widget_factory(f)
    w.pack(side="left", fill="x", expand=True, padx=(0, 10))
    f.pack(fill="x", pady=pady, padx=2)
    return w


def check_row(parent, label, var, pady=4):
    f = tk.Frame(parent, bg=BG2)
    cb = tk.Checkbutton(
        f, text=label, variable=var,
        bg=BG2, fg=FG, selectcolor=BG3,
        activebackground=BG2, activeforeground=FG,
        font=FONT, cursor="hand2"
    )
    cb.pack(side="left", padx=10)
    f.pack(fill="x", pady=pady, padx=2)
    return cb


# ══════════════════════════════════════════════════════════════
#  File I/O
# ══════════════════════════════════════════════════════════════

def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def write_text(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

def patch_store_defaults(store_src, defaults: dict) -> str:
    """Rewrite the DEFAULT_SETTINGS block in store.js."""
    new_block = "const DEFAULT_SETTINGS = {\n"
    new_block += f"  sevenZipEnabled: {'true' if defaults.get('sevenZipEnabled', True) else 'false'},\n"
    new_block += f"  aria2Enabled:    {'true' if defaults.get('aria2Enabled', True) else 'false'},\n"
    src_val = defaults.get('source', 'ankergames')
    new_block += f"  source:          '{src_val}',\n"
    new_block += "};"
    patched = re.sub(
        r"const DEFAULT_SETTINGS = \{[\s\S]*?\};",
        new_block,
        store_src
    )
    return patched

def patch_rpc_client_id(main_src, client_id: str) -> str:
    return re.sub(
        r"const DEFAULT_RPC_CLIENT_ID = '[^']+'",
        f"const DEFAULT_RPC_CLIENT_ID = '{client_id}'",
        main_src
    )

def patch_version_url(main_src, url: str) -> str:
    return re.sub(
        r"const VERSION_JSON_URL = '[^']+'",
        f"const VERSION_JSON_URL = '{url}'",
        main_src
    )

def patch_rpc_retry_interval(main_src, seconds: int) -> str:
    return re.sub(
        r"}, (\d+)_000\);(\s*// retry loop)",
        f"}}, {seconds}_000);\\2",
        main_src
    )


# ══════════════════════════════════════════════════════════════
#  Main App
# ══════════════════════════════════════════════════════════════

class NinoEditor(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("NinoGames Editor")
        self.configure(bg=BG)
        self.resizable(True, True)
        self.minsize(760, 680)

        # State
        self.project_dir = tk.StringVar()
        self.loaded      = False

        # ── package.json fields
        self.v_version    = tk.StringVar()
        self.v_name       = tk.StringVar()
        self.v_product    = tk.StringVar()
        self.v_app_id     = tk.StringVar()
        self.v_author     = tk.StringVar()
        self.v_desc       = tk.StringVar()
        self.v_electron   = tk.StringVar()

        # ── store.js defaults
        self.v_seven_zip  = tk.BooleanVar(value=True)
        self.v_aria2      = tk.BooleanVar(value=True)
        self.v_source     = tk.StringVar(value="ankergames")

        # ── main.js fields
        self.v_rpc_id     = tk.StringVar()
        self.v_ver_url    = tk.StringVar()
        self.v_rpc_retry  = tk.StringVar(value="15")

        self._build_ui()
        self.geometry("820x780")
        self._center()

    def _center(self):
        self.update_idletasks()
        x = (self.winfo_screenwidth()  - self.winfo_width())  // 2
        y = (self.winfo_screenheight() - self.winfo_height()) // 2
        self.geometry(f"+{x}+{y}")

    # ── UI ────────────────────────────────────────────────────

    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg="#111111", pady=14)
        hdr.pack(fill="x")
        tk.Label(hdr, text="🎮  NinoGames Editor", bg="#111111", fg=FG,
                 font=("Segoe UI", 16, "bold")).pack(side="left", padx=20)
        tk.Label(hdr, text="Edit · Build · Ship", bg="#111111", fg=FG2,
                 font=("Segoe UI", 10)).pack(side="left")

        # Folder picker
        top = tk.Frame(self, bg=BG, pady=10, padx=16)
        top.pack(fill="x")
        tk.Label(top, text="Project folder:", bg=BG, fg=FG2, font=FONT).pack(side="left")
        styled_entry(top, textvariable=self.project_dir, width=52).pack(side="left", padx=8)
        styled_btn(top, "Browse…", self._browse).pack(side="left", padx=2)
        styled_btn(top, "Load", self._load, color=GREEN).pack(side="left", padx=4)

        # Notebook
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TNotebook",       background=BG,  borderwidth=0)
        style.configure("TNotebook.Tab",   background=BG3, foreground=FG2,
                        padding=[14, 6],   font=FONT_BOLD)
        style.map("TNotebook.Tab",
                  background=[("selected", ACCENT)],
                  foreground=[("selected", "#ffffff")])
        style.configure("TFrame", background=BG)

        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True, padx=10, pady=6)

        self.tab_pkg   = ttk.Frame(self.nb)
        self.tab_def   = ttk.Frame(self.nb)
        self.tab_adv   = ttk.Frame(self.nb)
        self.tab_build = ttk.Frame(self.nb)

        self.nb.add(self.tab_pkg,   text="  📦  Package  ")
        self.nb.add(self.tab_def,   text="  ⚙️  Defaults  ")
        self.nb.add(self.tab_adv,   text="  🔧  Advanced  ")
        self.nb.add(self.tab_build, text="  🔨  Build     ")

        self._build_tab_pkg()
        self._build_tab_defaults()
        self._build_tab_advanced()
        self._build_tab_build()

        # Bottom bar
        bot = tk.Frame(self, bg="#111111", pady=10)
        bot.pack(fill="x", side="bottom")
        self.status = tk.Label(bot, text="Open a NinoGames project folder to begin.",
                               bg="#111111", fg=FG2, font=FONT)
        self.status.pack(side="left", padx=16)
        styled_btn(bot, "💾  Save All Changes", self._save_all, color=ACCENT).pack(side="right", padx=12)

    def _card(self, parent):
        f = tk.Frame(parent, bg=BG2, bd=0, pady=8, padx=0,
                     highlightthickness=1, highlightbackground=BORDER)
        f.pack(fill="x", padx=12, pady=6)
        return f

    # ── Tab: Package ─────────────────────────────────────────

    def _build_tab_pkg(self):
        p = self.tab_pkg
        tk.Frame(p, bg=BG, height=8).pack()

        section_label(p, "App Identity").pack(fill="x", padx=12, pady=(0,4))
        c = self._card(p)
        self.e_version = row(c, "Version",        lambda f: styled_entry(f, self.v_version, 20))
        self.e_name    = row(c, "Package name",   lambda f: styled_entry(f, self.v_name, 30))
        self.e_product = row(c, "Product name",   lambda f: styled_entry(f, self.v_product, 30))
        self.e_app_id  = row(c, "App ID",         lambda f: styled_entry(f, self.v_app_id, 36))
        self.e_author  = row(c, "Author",         lambda f: styled_entry(f, self.v_author, 30))
        self.e_desc    = row(c, "Description",    lambda f: styled_entry(f, self.v_desc, 46))

        section_label(p, "Dependencies").pack(fill="x", padx=12, pady=(10,4))
        c2 = self._card(p)
        self.e_electron = row(c2, "Electron version", lambda f: styled_entry(f, self.v_electron, 20))
        tk.Label(c2, text="  e.g.  ^29.4.6  — changes devDependencies in package.json",
                 bg=BG2, fg=FG2, font=("Segoe UI", 9)).pack(anchor="w", padx=10, pady=(0,4))

    # ── Tab: Defaults ────────────────────────────────────────

    def _build_tab_defaults(self):
        p = self.tab_def
        tk.Frame(p, bg=BG, height=8).pack()

        section_label(p, "First-Run Default Settings  (store.js)").pack(fill="x", padx=12, pady=(0,4))
        tk.Label(p, text="  These are applied the first time NinoGames is launched on a new machine.",
                 bg=BG, fg=FG2, font=("Segoe UI", 9)).pack(anchor="w", padx=12, pady=(0,6))

        c = self._card(p)
        check_row(c, "7-Zip enabled by default",   self.v_seven_zip)
        check_row(c, "Aria2 enabled by default",   self.v_aria2)

        row(c, "Default download source",
            lambda f: self._source_combo(f))

    def _source_combo(self, parent):
        style = ttk.Style()
        style.configure("Dark.TCombobox",
                        fieldbackground=BG3, background=BG3,
                        foreground=FG, arrowcolor=FG,
                        selectbackground=ACCENT, selectforeground=FG)
        cb = ttk.Combobox(parent, textvariable=self.v_source,
                          values=["ankergames", "steamunlocked"],
                          state="readonly", width=22, font=FONT)
        cb.configure(style="Dark.TCombobox")
        return cb

    # ── Tab: Advanced ────────────────────────────────────────

    def _build_tab_adv(self):
        pass  # alias below

    def _build_tab_advanced(self):
        p = self.tab_adv
        tk.Frame(p, bg=BG, height=8).pack()

        section_label(p, "Discord RPC  (main.js)").pack(fill="x", padx=12, pady=(0,4))
        c = self._card(p)
        self.e_rpc_id    = row(c, "Default RPC Client ID",  lambda f: styled_entry(f, self.v_rpc_id, 24))
        self.e_rpc_retry = row(c, "Retry interval (seconds)", lambda f: styled_entry(f, self.v_rpc_retry, 6))
        tk.Label(c, text="  How often NinoGames retries connecting to Discord (default 15s).",
                 bg=BG2, fg=FG2, font=("Segoe UI", 9)).pack(anchor="w", padx=10, pady=(0,4))

        section_label(p, "Auto-Updater  (main.js)").pack(fill="x", padx=12, pady=(10,4))
        c2 = self._card(p)
        self.e_ver_url = row(c2, "Version JSON URL", lambda f: styled_entry(f, self.v_ver_url, 54))
        tk.Label(c2, text="  Raw URL to version.json on GitHub (or any static host).",
                 bg=BG2, fg=FG2, font=("Segoe UI", 9)).pack(anchor="w", padx=10, pady=(0,4))

    # ── Tab: Build ───────────────────────────────────────────

    def _build_tab_build(self):
        p = self.tab_build
        tk.Frame(p, bg=BG, height=8).pack()

        section_label(p, "Build Portable EXE").pack(fill="x", padx=12, pady=(0,4))

        info = tk.Frame(p, bg=BG2, highlightthickness=1, highlightbackground=BORDER)
        info.pack(fill="x", padx=12, pady=6)
        tk.Label(info, bg=BG2, fg=FG2, font=("Segoe UI", 9), justify="left",
                 text=("  Requirements:\n"
                       "  • Node.js + npm installed and on PATH\n"
                       "  • electron-builder installed (npm install in project first)\n"
                       "  • Run as Administrator if writing to Program Files\n\n"
                       "  The editor will:\n"
                       "  1. Save all changes\n"
                       "  2. Run  npm install  in the project folder\n"
                       "  3. Run  npm run dist  (electron-builder --win portable)\n"
                       "  4. Open the  dist/  folder when done")
                 ).pack(anchor="w", padx=10, pady=10)

        btn_row = tk.Frame(p, bg=BG)
        btn_row.pack(pady=10)
        styled_btn(btn_row, "💾  Save Changes",
                   self._save_all, color=BG3).pack(side="left", padx=6)
        styled_btn(btn_row, "🔨  Save + Build EXE",
                   self._build, color=ACCENT).pack(side="left", padx=6)
        styled_btn(btn_row, "📂  Open dist/ folder",
                   self._open_dist, color=BG3).pack(side="left", padx=6)

        tk.Label(p, text="Build output:", bg=BG, fg=FG2, font=FONT).pack(anchor="w", padx=14, pady=(10,2))
        self.build_log = scrolledtext.ScrolledText(
            p, bg="#0d0d0d", fg="#c8ffc8", font=FONT_MONO,
            height=14, relief="flat", state="disabled",
            highlightthickness=1, highlightbackground=BORDER
        )
        self.build_log.pack(fill="both", expand=True, padx=12, pady=(0,10))

    # ── Actions ───────────────────────────────────────────────

    def _browse(self):
        d = filedialog.askdirectory(title="Select NinoGames project folder")
        if d:
            self.project_dir.set(d)
            self._load()

    def _load(self):
        d = self.project_dir.get().strip()
        if not d or not os.path.isdir(d):
            messagebox.showerror("Error", "Please select a valid project folder.")
            return

        pkg_path   = os.path.join(d, "package.json")
        store_path = os.path.join(d, "store.js")
        main_path  = os.path.join(d, "main.js")

        missing = [p for p in [pkg_path, store_path, main_path] if not os.path.exists(p)]
        if missing:
            messagebox.showerror("Error", "Missing files:\n" + "\n".join(missing))
            return

        try:
            # package.json
            pkg = read_json(pkg_path)
            self.v_version.set(pkg.get("version", ""))
            self.v_name.set(pkg.get("name", ""))
            self.v_desc.set(pkg.get("description", ""))
            self.v_author.set(pkg.get("author", ""))
            self.v_product.set(pkg.get("build", {}).get("productName", ""))
            self.v_app_id.set(pkg.get("build", {}).get("appId", ""))
            self.v_electron.set(pkg.get("devDependencies", {}).get("electron", ""))

            # store.js — parse DEFAULT_SETTINGS
            store_src = read_text(store_path)
            m7  = re.search(r"sevenZipEnabled:\s*(true|false)", store_src)
            ma  = re.search(r"aria2Enabled:\s*(true|false)", store_src)
            ms  = re.search(r"source:\s*'([^']+)'", store_src)
            self.v_seven_zip.set(m7.group(1) == "true" if m7 else True)
            self.v_aria2.set(ma.group(1) == "true" if ma else True)
            self.v_source.set(ms.group(1) if ms else "ankergames")

            # main.js
            main_src = read_text(main_path)
            mr = re.search(r"const DEFAULT_RPC_CLIENT_ID = '([^']+)'", main_src)
            mv = re.search(r"const VERSION_JSON_URL = '([^']+)'", main_src)
            # retry interval: }, 15_000);
            mrt = re.search(r"\}, (\d+)_000\);\s*// retry loop", main_src)
            self.v_rpc_id.set(mr.group(1) if mr else "")
            self.v_ver_url.set(mv.group(1) if mv else "")
            self.v_rpc_retry.set(mrt.group(1) if mrt else "15")

            self.loaded = True
            self._set_status(f"✅  Loaded — {d}", GREEN)

        except Exception as ex:
            messagebox.showerror("Load error", str(ex))

    def _save_all(self):
        if not self.loaded:
            messagebox.showwarning("Not loaded", "Load a project first.")
            return
        d = self.project_dir.get().strip()
        try:
            # ── package.json ──────────────────────────────
            pkg_path = os.path.join(d, "package.json")
            pkg = read_json(pkg_path)
            pkg["version"]     = self.v_version.get().strip()
            pkg["name"]        = self.v_name.get().strip()
            pkg["description"] = self.v_desc.get().strip()
            pkg["author"]      = self.v_author.get().strip()
            if "build" not in pkg:
                pkg["build"] = {}
            pkg["build"]["productName"] = self.v_product.get().strip()
            pkg["build"]["appId"]       = self.v_app_id.get().strip()
            if "devDependencies" not in pkg:
                pkg["devDependencies"] = {}
            pkg["devDependencies"]["electron"] = self.v_electron.get().strip()
            write_json(pkg_path, pkg)

            # ── store.js ──────────────────────────────────
            store_path = os.path.join(d, "store.js")
            store_src  = read_text(store_path)
            defaults = {
                "sevenZipEnabled": self.v_seven_zip.get(),
                "aria2Enabled":    self.v_aria2.get(),
                "source":          self.v_source.get(),
            }
            store_src = patch_store_defaults(store_src, defaults)
            write_text(store_path, store_src)

            # ── main.js ───────────────────────────────────
            main_path = os.path.join(d, "main.js")
            main_src  = read_text(main_path)
            main_src = patch_rpc_client_id(main_src, self.v_rpc_id.get().strip())
            main_src = patch_version_url(main_src, self.v_ver_url.get().strip())
            try:
                retry = int(self.v_rpc_retry.get().strip())
            except ValueError:
                retry = 15
            main_src = patch_rpc_retry_interval(main_src, retry)
            write_text(main_path, main_src)

            self._set_status(f"✅  Saved all changes  —  v{self.v_version.get()}", GREEN)
            messagebox.showinfo("Saved", "All changes saved successfully.")

        except Exception as ex:
            messagebox.showerror("Save error", str(ex))

    def _build(self):
        if not self.loaded:
            messagebox.showwarning("Not loaded", "Load a project first.")
            return
        self._save_all()
        self.nb.select(self.tab_build)
        self._log_clear()
        self._log("Starting build…\n")
        threading.Thread(target=self._run_build, daemon=True).start()

    def _run_build(self):
        d = self.project_dir.get().strip()
        try:
            # npm install
            self._log("▶ npm install\n")
            proc = subprocess.Popen(
                ["npm", "install"],
                cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, shell=(sys.platform == "win32")
            )
            for line in proc.stdout:
                self._log(line)
            proc.wait()
            if proc.returncode != 0:
                self._log(f"\n❌ npm install failed (exit {proc.returncode})\n", RED)
                self._set_status("Build failed.", RED)
                return

            # npm run dist
            self._log("\n▶ npm run dist\n")
            proc2 = subprocess.Popen(
                ["npm", "run", "dist"],
                cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, shell=(sys.platform == "win32")
            )
            for line in proc2.stdout:
                self._log(line)
            proc2.wait()
            if proc2.returncode != 0:
                self._log(f"\n❌ Build failed (exit {proc2.returncode})\n", RED)
                self._set_status("Build failed.", RED)
                return

            self._log(f"\n✅  Build complete! Check the dist/ folder.\n", GREEN)
            self._set_status("✅  Build complete!", GREEN)
            self._open_dist()

        except FileNotFoundError:
            self._log("\n❌  npm not found. Make sure Node.js is installed and on PATH.\n", RED)
            self._set_status("npm not found.", RED)
        except Exception as ex:
            self._log(f"\n❌  Error: {ex}\n", RED)
            self._set_status("Build error.", RED)

    def _open_dist(self):
        d = self.project_dir.get().strip()
        dist = os.path.join(d, "dist")
        if not os.path.isdir(dist):
            messagebox.showinfo("dist/ not found", "No dist/ folder yet — run a build first.")
            return
        if sys.platform == "win32":
            os.startfile(dist)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", dist])
        else:
            subprocess.Popen(["xdg-open", dist])

    # ── Log helpers ───────────────────────────────────────────

    def _log(self, text, color=None):
        def _do():
            self.build_log.configure(state="normal")
            if color:
                tag = f"col_{color.replace('#','')}"
                self.build_log.tag_configure(tag, foreground=color)
                self.build_log.insert("end", text, tag)
            else:
                self.build_log.insert("end", text)
            self.build_log.see("end")
            self.build_log.configure(state="disabled")
        self.after(0, _do)

    def _log_clear(self):
        self.build_log.configure(state="normal")
        self.build_log.delete("1.0", "end")
        self.build_log.configure(state="disabled")

    def _set_status(self, msg, color=FG2):
        self.after(0, lambda: self.status.configure(text=msg, fg=color))


# ══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = NinoEditor()
    app.mainloop()
