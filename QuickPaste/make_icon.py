from PIL import Image, ImageDraw, ImageFont

size = 64
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# Clipboard body
draw.rounded_rectangle([14, 12, 50, 58], radius=4, fill="#2196F3", outline="#1565C0", width=2)
# Top bar
draw.rounded_rectangle([14, 12, 50, 30], radius=4, fill="#1565C0")
# Clip
draw.rounded_rectangle([24, 4, 40, 16], radius=2, fill="#64B5F6", outline="#1565C0", width=2)
# Letter P
try:
    font = ImageFont.truetype("arial.ttf", 26)
    draw.text((25, 32), "P", fill="white", font=font)
except:
    draw.text((26, 34), "P", fill="white")

# Save as .ico
image.save("icon.ico", format="ICO", sizes=[(64, 64)])
print("icon.ico created")