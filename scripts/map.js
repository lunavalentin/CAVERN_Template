let img;
let canvas;
let locationElemnt;
let mainName;

// Wait for DOM to be ready before accessing elements
function initMapElements() {
    locationElemnt = document.getElementById("location-select");
    mainName = document.getElementById("location-display");
    // Ensure mainName exists (fallback to dummy object)
    if (!mainName) mainName = { innerHTML: "" };
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMapElements);
} else {
    initMapElements();
}

let xmin = 812727.103;
let xmax = 812833.709;
let ymin = 6366452.372;
let ymax = 6366688.656;
let w, h;

// Map bounds come from config.json (map.bounds). The values above are only used until
// window.config is available. The canvas aspect ratio (height / width) follows the bounds.
function applyConfigBounds() {
    const b = window.config && window.config.map && window.config.map.bounds;
    if (!b) return;
    const v = [b.xmin, b.xmax, b.ymin, b.ymax].map(Number);
    if (v.every(Number.isFinite) && v[1] > v[0] && v[3] > v[2]) {
        xmin = v[0]; xmax = v[1]; ymin = v[2]; ymax = v[3];
    }
}

function mapAspect() {
    applyConfigBounds();
    return (ymax - ymin) / (xmax - xmin);
}

// Dot sizes in canvas pixels, from the canvas width with pixel minimums: fractions of the height
// made tiny dots on a wide map, and the hit size stays usable with a finger.
function mapDotSizes() {
    const ww = w || 300;
    return { dot: Math.max(10, ww * 0.032), selected: Math.max(13, ww * 0.044),
        ring: Math.max(22, ww * 0.075), hit: Math.max(12, ww * 0.045) };
}

// The location whose dot is nearest to (mx, my) within the hit radius, or null.
function mapKeyAt(mx, my) {
    if (!(mx >= 0 && my >= 0 && mx <= w && my <= h) || !window.json) return null;
    const r = mapDotSizes().hit;
    let best = null, bestD = Infinity;
    for (const [key, value] of window.json.entries()) {
        if (value.x_abs === undefined) continue;
        const px = (value.x_abs - xmin) / (xmax - xmin) * w;
        const py = (ymax - value.y_abs) / (ymax - ymin) * h;
        const d = Math.hypot(mx - px, my - py);
        if (d <= r && d < bestD) { best = key; bestD = d; }
    }
    return best;
}

function selectMapLocation(key) {
    if (!key || key === window.currentValue || !locationElemnt) return;
    window.currentValue = key;
    locationElemnt.value = key;
    locationElemnt.dispatchEvent(new Event('change'));
}

// Selection on release (p5 calls these for mouse and, without touch handlers, for touch too): a
// location is chosen when the press is released on the same dot. Polling mouseIsPressed in draw()
// missed a click or tap released within one frame.
let mapPressKey = null;
function mousePressed() {
    mapPressKey = mapKeyAt(mouseX, mouseY);
}
function mouseReleased() {
    const k = mapKeyAt(mouseX, mouseY);
    if (k && k === mapPressKey) selectMapLocation(k);
    mapPressKey = null;
}

var mouseToLocation = '';
let newLocation = '';

// Removed 'menu' and 'menuState' dependency for resizing, as layout is now static sidebar
// let menu = document.querySelector('.controls-panel');

window.loadMapImage = function (url) {
    // Wait for p5.js to be loaded before attempting to load the map
    if (typeof loadImage === 'undefined') {
        console.warn('⏳ p5.js not loaded yet, retrying map image load...');
        setTimeout(() => window.loadMapImage(url), 100);
        return;
    }

    if (!url) {
        // Fallback or Config check
        if (window.config && window.config.map && window.config.map.imagePath) {
            url = window.config.map.imagePath;
        } else {
            url = 'assets/plotting_website.svg';
        }
    }

    console.log(`🗺️ Loading Map Image: ${url}`);
    img = loadImage(url,
        () => {
            console.log("✅ Map image loaded successfully");
            resizeMapCanvas();
        },
        () => {
            console.warn(`⚠️ Map image failed to load at ${url}`);
        }
    );
};

function setup() {
    console.log("Map Setup Starting...");
    // Initial size - will be updated by resizeMapCanvas immediately in draw or via resize handler
    let container = document.getElementById("mapContainer");
    if (container) {
        w = container.clientWidth;
    } else {
        w = 300; // Fallback
    }
    h = w * mapAspect(); // aspect ratio from the map bounds
    canvas = createCanvas(w, h);
    canvas.parent("mapContainer");

    // Refresh element references if setup ran after DOM load
    locationElemnt = document.getElementById("location-select");
    mainName = document.getElementById("location-display");
}

function draw() {

    // We check if size changed significantly to avoid constant resizing? 
    // Or just rely on sidebar transitions triggering explicit resize calls.
    // For now, let's just ensure it matches container width
    let container = document.getElementById("mapContainer");
    // Also resize when the bounds (and so the aspect ratio) arrive after setup()
    if (container && (Math.abs(container.clientWidth - w) > 1 || Math.abs(container.clientWidth * mapAspect() - h) > 1)) {
        resizeMapCanvas();
    }

    clear();
    // tint(255, 130); // Transparent map?
    // Let's keep it fully opaque or slightly transparent based on new UI
    tint(255, 200);

    if (img) {
        image(img, 0, 0, w, h);
    } else {
        // Fallback: Solid background if image is missing
        background(30, 30, 30);
        // Optional: Draw a grid or placeholder text
        stroke(255, 50);
        strokeWeight(1);
        for (let i = 0; i < w; i += 50) line(i, 0, i, h);
        for (let i = 0; i < h; i += 50) line(0, i, w, i);
    }

    // Safety check for location element
    if (locationElemnt) {
        let v = locationElemnt.value;
        if (v !== window.currentValue && v !== "") {
            window.currentValue = v;
        }
    }

    if (typeof window.json === 'undefined' || window.json.size === 0) {
        // Data not loaded yet
    } else {

        for (const [key, value] of window.json.entries()) {
            let x, y;
            // Handle data format differences if any
            if (value.x_abs !== undefined) {
                x = value.x_abs;
                y = value.y_abs;
            } else {
                continue;
            }

            let px = (x - xmin) / (xmax - xmin) * w
            let py = (ymax - y) / (ymax - ymin) * h;

            // Always interactive (hover); sizes from the canvas width with pixel minimums
            const ds = mapDotSizes();
            navigateMap(px, py, ds.hit, key);

            noStroke();
            if (key === window.currentValue) {
                fill(224, 192, 151); // --accent color #E0C097
                circle(px, py, ds.selected);
                // Ring
                noFill();
                stroke(224, 192, 151);
                strokeWeight(2);
                circle(px, py, ds.ring);
            } else {
                fill(255, 255, 255, 190);
                stroke(20, 20, 20, 200);
                strokeWeight(1);
                circle(px, py, ds.dot);
            }
        }
    }

    // Tooltip logic
    if (mouseToLocation !== '') {
        fill(255);
        noStroke();
        textSize(12);
        // Ensure json access is safe
        let locData = window.json ? window.json.get(mouseToLocation) : null;
        let label = locData ? locData.Label : "";
        text(mouseToLocation + ": " + label, 10, 20);
    }

    mouseToLocation = '';
}

function doubleClicked() {
    // Removed old menu state toggling logic
    return false;
}

function windowResized() {
    resizeMapCanvas();
}

function resizeMapCanvas() {
    let container = document.getElementById("mapContainer");
    if (container) {
        w = container.clientWidth;
        // Keep aspect ratio (from the map bounds)
        h = w * mapAspect();
        resizeCanvas(w, h, true); // true = no redraw immediatly
    }
}

function navigateMap(px, py, r, key) {
    if (mouseX >= px - r && mouseX <= px + r && mouseY >= py - r && mouseY <= py + r) {
        mouseToLocation = key;

        // Change cursor to pointer
        cursor(HAND);
        // A location is selected on release, in mouseReleased()
    } else {
        // cursor(ARROW); 
    }
}