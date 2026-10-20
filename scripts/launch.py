"""Double-clickable launcher; errors remain visible even under pythonw.exe."""
from pathlib import Path
import ctypes
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
try:
    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    completed = subprocess.run([node, str(root / "scripts/launch.mjs"), *sys.argv[1:]],
                               cwd=root, capture_output=True, text=True, encoding="utf-8",
                               creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    if completed.returncode:
        raise RuntimeError(completed.stderr)
    if sys.stdout:
        print(completed.stdout.strip())
except Exception as error:
    if sys.platform == "win32":
        ctypes.windll.user32.MessageBoxW(0, str(error), "Starport · 星港 — 启动失败 / Launch failed", 0x10)
    raise
