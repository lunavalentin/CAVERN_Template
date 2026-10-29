
# CAVERN Template

This is a ready-to-use template for creating your own **Virtual Acoustics Tour**. It lets you build an interactive web experience where users can explore a map, view 360° images, and listen to spatialized audio at different locations.

---

## Getting Started

1. **Download or copy the template folder.**
2. **Add your own files:**
    - Map image (SVG/PNG)
    - 360° photos (JPG/PNG)
    - Ambisonic impulse responses (WAV)
    - Audio samples (WAV/MP3)
3. **Edit `config.json` and `DataSet.csv`** to match your project.
4. **Start a local web server:**
    - In VS Code: Right-click `index.html` → "Open with Live Server"
    - In Terminal: Run `python3 -m http.server` in this folder
5. **Open your browser** and go to the address shown (usually `http://127.0.0.1:5500` or `http://localhost:8000`).

---

## Folder Structure

* `index.html` — The main webpage.
* `config.json` — Project settings (title, map, audio, etc.).
* `DataSet.csv` — List of locations and their data (images, coordinates, audio).
* `assets/` — All your images, impulse responses, audio samples, and map files.
* `scripts/` — The code that runs the app (usually no need to edit).
* `JSAmbisonics/` — Library for spatial audio processing.
* `sw.js` — Service worker for offline support (optional).

---

## Project Configuration (`config.json`)

Open `config.json` in a text editor. Here’s what each section means:

* `project`: Set your project’s name, subtitle, and about link.
* `map`: Path to your map image and real-world bounds (for correct dot placement).
* `data`: Paths to your location data and asset folders.
* `audio`: Ambisonic order, default volume, and sample list. Optional: `irSampleRate`, the sample rate of your IR files, needed only for IRs that are not WAV files (the rate of a WAV file is read from its header). Each IR is scaled by its own rate over the device's audio rate, which compensates the convolution gain for the playback sample rate.

---

## Location Data (`DataSet.csv`)

Open `DataSet.csv` in Excel or a text editor. Each row is a location (spot) on your map.

**Required Columns:**
* `Loc_name`: Unique ID for the spot (e.g., `E5`, `Spot1`).
* `Label`: Name shown to users (e.g., "Main Entrance").
* `Order`: Number for navigation (1, 2, 3...)
* `x_abs`, `y_abs`: X/Y coordinates (in meters, matching your map bounds).
* `Photo_Name`: Filename of the 360° image (must be in `assets/images/`).
* `Photo_Rotation`: Starting angle for the photo (0 = North).

**Audio Columns (Impulse Responses):**
You can add multiple impulse responses per location (for different distances or conditions):
* `IR_Name_1`: Filename of the first IR (e.g., `spot1_colocated.wav`).
* `IR_Rotation_1`: Rotation offset for the IR (if needed). Since October 2026 the sound field turns with the picture (the yaw sign was inverted before), so offsets tuned with an earlier version of the template need to be checked again.
* `IR_Label_1`: Text shown in the dropdown (e.g., "Co-location").
Repeat for `_2`, `_3`, etc. to add more IRs.

---

## Assets

Put your files in the correct folders:

* `assets/images/`: 360° panoramas (JPG/PNG). Keep under 4K resolution for best performance.
* `assets/irs/`: Ambisonic impulse responses (WAV, AmbiX format: ACN channel order, SN3D normalization, 4 channels for 1st Order).
* `assets/audio/`: Dry audio samples (WAV/MP3).
* `assets/`: Your map file (SVG/PNG).

---

## Map Bounds

To make the dots appear in the right place:
1. Find the real-world coordinates for the left, right, top, and bottom edges of your map.
2. Update `config.json` → `map` → `bounds` with these values.

---

## Customization

* **UI Text:** Edit `config.json` for project name, labels, etc.
* **Colors/Style:** Edit the `<style>` block in `index.html` for colors and layout.
* **Logic:** Advanced users can edit `scripts/main.js` for app behavior.

---

## Advanced Features

* **Offline Support:** The `sw.js` file enables offline access.
* **Spatial Audio:** Uses Ambisonics for immersive sound. Make sure your IRs are in AmbiX format.
* **Map Interactivity:** The map is drawn using p5.js and can be customized in `scripts/map.js`.

---

## Troubleshooting

* If images or audio don’t load, check the file paths in `config.json` and `DataSet.csv`.
* If dots don’t appear on the map, check your coordinates and map bounds.
* If you see errors in the browser, try reloading or check the console for hints.

---

## Credits & License

Created by Luna Leila Valentin & Celeste Betancur Gutierrez.

### License: Luna Leila Valentin & Celeste Betancur Gutierrez Proprietary Non-Commercial License

This repository contains the CAVERN template, a framework developed for research-creation, immersive audio-visual presentation, and artistic experimentation. The template is shared to support learning, adaptation, and academic or creative use.

You are welcome to use, modify and publish this template for non-commercial projects, including research, teaching, installations and artistic work. This includes hosting your own tour built on it, for example on GitHub Pages; you do not need to ask us. Please credit it as "CAVERN Template by Luna Leila Valentin and Celeste Betancur Gutierrez" with a link to this repository.

Commercial use of this template or of works built on it requires prior written permission from the authors. Your own panoramas, impulse responses and data are not covered by this license. See the LICENSE file for details.

---

## 🎧 Happy Virtual Acoustics!

If you have questions or need help, contact the authors or open an issue in your project repository.
