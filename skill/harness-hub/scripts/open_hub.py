import json
from pathlib import Path
import subprocess
import sys

skill = Path(__file__).resolve().parents[1]
location = skill / "app-location.json"
if location.exists():
    root = Path(json.loads(location.read_text(encoding="utf-8"))["root"])
else:
    root = skill.parents[1]
launcher = root / "scripts/launch.py"
if not launcher.is_file():
    raise SystemExit("找不到 Starport / Starport not found. 请从应用的新目录运行 scripts/install-skills.py 更新入口。")
result = subprocess.run([sys.executable, str(launcher), *sys.argv[1:]],
                        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
raise SystemExit(result.returncode)
