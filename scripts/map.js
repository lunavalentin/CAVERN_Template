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
    h = w * 2.2175; // aspect ratio
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
    if (container && Math.abs(container.clientWidth - w) > 1) {
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

            // Always interactive
            navigateMap(px, py, h * 0.02, key);

            noStroke();
            if (key === window.currentValue) {
                fill(224, 192, 151); // --accent color #E0C097
                circle(px, py, h * 0.03);
                // Ring
                noFill();
                stroke(224, 192, 151);
                strokeWeight(2);
                circle(px, py, h * 0.05);
            } else {
                fill(255, 255, 255, 150);
                circle(px, py, h * 0.015);
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
        // Keep aspect ratio
        h = w * 2.2175;
        resizeCanvas(w, h, true); // true = no redraw immediatly
    }
}

function navigateMap(px, py, r, key) {
    if (mouseX >= px - r && mouseX <= px + r && mouseY >= py - r && mouseY <= py + r) {
        mouseToLocation = key;

        // Change cursor to pointer
        cursor(HAND);

        if (mouseIsPressed) {
            newLocation = mouseToLocation;
            if (newLocation !== '' && newLocation !== window.currentValue) {

                if (locationElemnt) {
                    locationElemnt.value = window.currentValue; // Use explicit window global

                    // Update global
                    window.currentValue = newLocation;
                    locationElemnt.value = window.currentValue;

                    // Trigger change event manually because setting .value doesn't fire it
                    locationElemnt.dispatchEvent(new Event('change'));
                }

                // Call global functions if they exist (compatibility)
                if (typeof changeIr === 'function') changeIr();
                if (typeof updateImage === 'function') updateImage();
            }
        }
    } else {
        // cursor(ARROW); 
    }
}