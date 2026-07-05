#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const sourcePng = path.join(projectRoot, "build", "icon.png");
const rasterizedPng = path.join(projectRoot, "build", "icon.mac-source.png");
const outputIcns = path.join(projectRoot, "build", "icon.icns");
const iconsetDir = path.join(projectRoot, "build", "icon.iconset");

if (os.platform() !== "darwin") {
  console.log("Skipping macOS icon generation on non-macOS platform.");
  process.exit(0);
}

if (!fs.existsSync(sourcePng)) {
  console.error(`Source icon not found: ${sourcePng}`);
  process.exit(1);
}

const pythonScript = `
from PIL import Image

source = Image.open(${JSON.stringify(sourcePng)}).convert("RGBA")
canvas_size = 1024
target_size = 820
scale = min(target_size / source.width, target_size / source.height)
resized = source.resize((round(source.width * scale), round(source.height * scale)), Image.Resampling.LANCZOS)
canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
offset = ((canvas_size - resized.width) // 2, (canvas_size - resized.height) // 2)
canvas.paste(resized, offset, resized)
canvas.save(${JSON.stringify(rasterizedPng)})
`;

const pythonResult = spawnSync("python3", ["-c", pythonScript], { stdio: "inherit" });
if (pythonResult.status !== 0) {
  process.exit(pythonResult.status ?? 1);
}

fs.rmSync(iconsetDir, { recursive: true, force: true });
fs.mkdirSync(iconsetDir, { recursive: true });

const sizes = [16, 32, 128, 256, 512];

for (const size of sizes) {
  const normal = path.join(iconsetDir, `icon_${size}x${size}.png`);
  const retina = path.join(iconsetDir, `icon_${size}x${size}@2x.png`);

  execFileSync("sips", ["-z", String(size), String(size), rasterizedPng, "--out", normal], {
    stdio: "inherit",
  });

  execFileSync("sips", ["-z", String(size * 2), String(size * 2), rasterizedPng, "--out", retina], {
    stdio: "inherit",
  });
}

execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", outputIcns], {
  stdio: "inherit",
});

fs.rmSync(iconsetDir, { recursive: true, force: true });
console.log(`Generated ${path.relative(projectRoot, outputIcns)} and ${path.relative(projectRoot, rasterizedPng)}`);
