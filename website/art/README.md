# Baked artwork sources

`public/hero-art.jpg` is rendered from `hero-art.html` — a standalone
composition (emerald light shards echoing the mark's stacked triangles,
layered turbulence-displaced SVG). To regenerate after editing:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --screenshot=hero-art.png --window-size=1200,800 \
  --force-device-scale-factor=2 --hide-scrollbars "file://$PWD/hero-art.html"
sips -s format jpeg -s formatOptions 84 hero-art.png --out ../public/hero-art.jpg
```

Grain is deliberately NOT baked in — the site's page-wide `.grain` overlay
adds it far cheaper than JPEG-encoding noise.
