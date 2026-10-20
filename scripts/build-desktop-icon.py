"""Package the generated artwork as a multi-resolution Windows ICO, without retouching it."""
from pathlib import Path
from PIL import Image
import json
import argparse

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--version", choices=("v1", "v2"), default="v2")
version = parser.parse_args().version
source = root / ("public/assets/starport-desktop.png" if version == "v1" else "public/assets/starport-desktop-v2.png")
target = root / f"public/assets/starport-desktop-{version}.ico"
sizes = [(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)]
with Image.open(source) as image:
    if image.mode != "RGBA" or image.width != image.height:
        raise ValueError("Expected square RGBA generated artwork")
    if image.getchannel("A").getextrema() != (0, 255):
        raise ValueError("Expected real transparent corners")
    image.save(target, format="ICO", sizes=sizes)
with Image.open(target) as icon:
    if icon.ico.sizes() != set(sizes):
        raise ValueError("Missing ICO resolutions")
    for size in sizes:
        frame = icon.ico.getimage(size)
        # Lanczos can leave one alpha level at a 16px corner; retain that antialiasing.
        if frame.mode != "RGBA" or frame.getchannel("A").getextrema() != (0, 255) or frame.getpixel((0, 0))[3] > 1:
            raise ValueError("Lost icon transparency")
    preview = "starport-desktop-preview.png" if version == "v1" else "starport-desktop-v2-preview.png"
    icon.ico.getimage((256, 256)).save(root / "public/assets" / preview)
print(json.dumps({"icon": str(target), "sizes": [size[0] for size in sizes], "transparent": True}))
