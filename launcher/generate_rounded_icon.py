from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "deepseek-mobile-app-icon-1024.png"
MASTER = ROOT / "deepseek-app-rounded-1024.png"
ICON = ROOT / "deepseek-app-rounded.ico"

CANVAS_SIZE = 1024
MARGIN = 40
CARD_SIZE = CANVAS_SIZE - 2 * MARGIN
CORNER_RADIUS = 208
SUPERSAMPLE = 4
ICON_SIZES = (16, 20, 24, 32, 40, 48, 64, 72, 80, 96, 128, 144, 192, 256)


def rounded_mask() -> Image.Image:
    large_size = CARD_SIZE * SUPERSAMPLE
    mask = Image.new("L", (large_size, large_size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (0, 0, large_size - 1, large_size - 1),
        radius=CORNER_RADIUS * SUPERSAMPLE,
        fill=255,
    )
    return mask.resize((CARD_SIZE, CARD_SIZE), Image.Resampling.LANCZOS)


def build_master() -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA")
    card = source.resize((CARD_SIZE, CARD_SIZE), Image.Resampling.LANCZOS)
    card.putalpha(rounded_mask())

    # White RGB values under transparent pixels avoid dark resampling fringes.
    master = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (255, 255, 255, 0))
    master.alpha_composite(card, (MARGIN, MARGIN))
    return master


def resize_layer(master: Image.Image, size: int) -> Image.Image:
    layer = master.resize((size, size), Image.Resampling.LANCZOS)
    if size <= 48:
        red, green, blue, alpha = layer.split()
        rgb = Image.merge("RGB", (red, green, blue)).filter(
            ImageFilter.UnsharpMask(radius=0.35, percent=35, threshold=2)
        )
        layer = Image.merge("RGBA", (*rgb.split(), alpha))
    return layer


def main() -> None:
    master = build_master()
    master.save(MASTER, format="PNG", optimize=True)

    layers = [resize_layer(master, size) for size in reversed(ICON_SIZES)]
    layers[0].save(
        ICON,
        format="ICO",
        append_images=layers[1:],
        sizes=[(size, size) for size in ICON_SIZES],
        bitmap_format="png",
    )

    with Image.open(ICON) as icon:
        actual_sizes = sorted(size[0] for size in icon.ico.sizes())
        if actual_sizes != list(ICON_SIZES):
            raise RuntimeError(f"Unexpected ICO layers: {actual_sizes}")
        largest = icon.ico.getimage((256, 256)).convert("RGBA")
        if largest.getpixel((0, 0))[3] != 0:
            raise RuntimeError("ICO corners are not transparent")

    print(f"master={MASTER} ({master.width}x{master.height})")
    print(f"ico={ICON}")
    print("sizes=" + ",".join(str(size) for size in ICON_SIZES))


if __name__ == "__main__":
    main()
