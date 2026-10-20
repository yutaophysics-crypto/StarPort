"""Read MAGI's host registry without installing its research dependencies."""
import dataclasses
import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
source = root / "vendor/magi/src/magi/core/hosts.py"
spec = importlib.util.spec_from_file_location("magi_hosts", source)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
hosts = {h.key: dataclasses.asdict(h) for h in module.BUILTIN
         if h.key in {"codex", "claude", "antigravity"}}
output = root / "src/magi-hosts.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"source": "MAGI", "version": "2.8.0", "hosts": hosts},
                             ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Imported {len(hosts)} MAGI host records.")
