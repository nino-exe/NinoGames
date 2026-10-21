# GTA V Loading Screen Clone

A standalone recreation of the Grand Theft Auto V loading screen, running entirely in the browser with no dependencies.

![Loading Screen](screenshot.jpg)

## Features

- Slideshow of GTA V loading screen artwork (38 images)
- Authentic GTA V logo and spinner
- "Loading Story Mode" label
- Loading music that plays automatically (or on first click if autoplay is blocked)
- Chalet London font matching the original UI

## Usage

Serve the folder over HTTP (required for audio):

```bash
python -m http.server
```

Then open `http://localhost:8000` in your browser. Opening `index.html` directly via `file://` may block audio in some browsers.

## Contents

```
loading-screen/
├── index.html
└── assets/
    ├── art/        (38 .webp loading screen images)
    ├── logo.png
    ├── spinner.png
    ├── chalet.woff
    └── loading_music.m4a
```
