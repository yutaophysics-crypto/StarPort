"""Use MAGI host destinations and install only this application's managed skill."""
import json
import os
from pathlib import Path
import shutil
import sys

root = Path(__file__).resolve().parents[1]
home = Path.home()
catalog = json.loads((root / "src/magi-hosts.json").read_text(encoding="utf-8"))
destinations = set()
for host in catalog["hosts"].values():
    for drop in host["drops"]:
        if drop["kind"] == "skill" and drop["global_dir"]:
            destinations.add(Path(drop["global_dir"].format(home=home, config=home / ".config")))
destinations.add(home / ".gemini/antigravity-cli/skills")
destinations.add(Path(os.environ.get("DSH_HOME", home / ".dsh")) / "skills")
source = root / "skill/harness-hub"
for base in sorted(destinations):
    target = base / "harness-hub"
    marker = target / "app-location.json"
    if target.exists() and not marker.exists():
        raise SystemExit(f"未覆盖已有的非托管技能：{target}")
    target.mkdir(parents=True, exist_ok=True)
    for file in source.rglob("*"):
        if file.is_file() and "__pycache__" not in file.parts:
            output = target / file.relative_to(source)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, output)
    marker.write_text(json.dumps({"root": str(root), "app": "harness-hub"}, ensure_ascii=False), encoding="utf-8")
    print(target)
