
// Configuration (loaded from config.json)
let config = null;
let audio = null; // Will be initialized in initApp

// Global State
const appState = {
    locations: [], // Array of parsed location objects
    samples: [], // Array of sample objects
    currentLocIndex: 0,
    currentIrIndex: 0, // Maps to distance-select index
    currentSourceType: 'sample', // 'sample', 'mic', 'upload'
    isLoading: true,
    loadingProgress: 0,
    isNavigating: false, // Navigation Lock
};

// UI DOM Elements (Populated in initApp)
let ui = {};

// --- Global Variables for map.js Compatibility ---
// The original map.js relies on these globals to function.
window.json = new Map(); // Stores location data: Key=Loc_Name, Value=Object
window.currentValue = ''; // Current Location Name (string)
window.menuState = 2; // Arbitrary state integer used by map.js for resizing logic
window.locationElemnt = ui.locSelect; // map.js reads .value from this element
window.config = null; // Global config access for map.js and other scripts

// --- Initialization ---

async function initApp() {
    console.log("🚀 CAVERN App Starting...");

    // Safety Timeout: Force hide overlay after 10s if something hangs
    setTimeout(() => {
        if (appState.isLoading) {
            console.warn("⚠️ Loading took too long, forcing start.");
            appState.isLoading = false;
            hideLoadingOverlay();
        }
    }, 10000);

    // 0. Initialize Audio Engine & UI Refs
    audio = new AudioEngine();
    window.audio = audio; // Expose for debugging/map.js if needed

    // Initialize UI References
    ui = {
        // Sidebar
        sidebar: document.getElementById('sidebar'),
        toggleBtn: document.getElementById('btn-toggle-sidebar'),
        // Top Bar Navigation
        prevBtn: document.getElementById('btn-prev'),
        nextBtn: document.getElementById('btn-next'),
        locDisplay: document.getElementById('location-display'),
        // Settings Controls
        locSelect: document.getElementById('location-select'),
        distSelect: document.getElementById('distance-select'),
        // Audio Controls
        sampleSelect: document.getElementById('sample-select'),
        fileInput: document.getElementById('file-upload'),
        playBtn: document.getElementById('btn-play'),
        stopBtn: document.getElementById('btn-stop'),
        wetToggle: document.getElementById('toggle-wet'),
        volumeSlider: document.getElementById('volume-slider'),
        volumeValue: document.getElementById('volume-value'),
        sourceRadios: document.querySelectorAll('input[name="source-type"]'),
        ctrlSample: document.getElementById('ctrl-sample'),
        ctrlUpload: document.getElementById('ctrl-upload'),
        // A-Frame Elements
        sky: document.getElementById('sky'),
        camera: document.getElementById('cameraVR'),
        // Map Container (New)
        mapContainer: document.getElementById('mapContainer')
    };

    try {
        // 0. Load Configuration
        updateLoadingText('Loading configuration...');
        await loadConfig();
        applyProjectConfig();

        // 1. Load Data
        updateLoadingText('Loading location data...');
        await loadData();

        // 2. Setup DOM Event Listeners
        setupListeners();

        // 3. Initial Location Load (WAIT for texture)
        updateLoadingText('Loading first location...');

        // Force initial index to -1
        appState.currentLocIndex = -1;

        if (appState.locations.length > 0) {
            let startIdx = appState.locations.findIndex(l => l.Loc_name === 'E5');
            if (startIdx === -1) startIdx = 0;
            await performLocationChange(startIdx);
        } else {
            updateUI();
        }

        // 4. Mark as ready & Hide Overlay
        appState.isLoading = false;
        hideLoadingOverlay();
        console.log("✅ CAVERN Ready (First Content Paint)");

        // 5. Initialize Map System
        if (typeof window.loadMapImage === 'function') {
            window.loadMapImage();
        }



        // 5c. Start Background Loader for other scenes
        const bgLoader = new BackgroundLoader(appState.locations);
        bgLoader.start();

        // 5d. Register Service Worker
        registerServiceWorker();

        // 6. Start Animation Loop
        requestAnimationFrame(animate);

    } catch (error) {
        console.error('❌ Failed to initialize app:', error);
        updateLoadingText('Error loading application. Please refresh.');
        // Force unlock if error
        appState.isLoading = false;
        hideLoadingOverlay();
    }
}

// Robust Entry Point
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

function updateLoadingText(text) {
    const loadingText = document.querySelector('.loading-text');
    if (loadingText) {
        loadingText.textContent = text;
    }
    console.log(`📍 ${text}`);
}

function showLoadingOverlay(text = 'Loading...') {
    // Safety check: Only show if explicitly allowed or during init
    // For now, simple log
    console.log(`Overlay Request: ${text}`);

    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        const loadingText = overlay.querySelector('.loading-text');
        if (loadingText) loadingText.textContent = text;

        overlay.style.display = 'flex';
        // Force reflow/repaint
        overlay.offsetHeight;
        overlay.classList.remove('hidden');
    }
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
        // Remove from DOM after transition
        setTimeout(() => {
            if (overlay.classList.contains('hidden')) {
                overlay.style.display = 'none';
            }
        }, 500);
    }
}

// --- Configuration Loading ---

async function loadConfig() {
    try {
        const response = await fetch('config.json');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        config = await response.json();
        window.config = config; // Make available globally
        console.log('✅ Configuration loaded:', config.project.name);

        // Update page title if config is loaded
        document.title = `${config.project.title} - ${config.project.name}`;
    } catch (e) {
        console.error('Failed to load config.json, using defaults:', e);
        // Fallback to default config
        config = {
            project: {
                name: "Chauvet Cave",
                title: "CAVERN",
                subtitle: "Chauvet Cave · Archaeoacoustics Research",
                aboutUrl: "https://ccrma.stanford.edu/chauvet/"
            },
            map: {
                imagePath: "assets/plotting_website.svg",
                bounds: {
                    xmin: 812727.103,
                    xmax: 812833.709,
                    ymin: 6366452.372,
                    ymax: 6366688.656
                }
            },
            data: {
                imagesPath: "assets/images/",
                irsPath: "assets/irs/",
                audioPath: "assets/audio/"
            },
            audio: {
                ambisonicOrder: 1,
                defaultVolume: 100,
                samples: [
                    { "name": "Bear", "filename": "bear.wav" },
                    { "name": "Fire", "filename": "fire.wav" },
                    { "name": "Footsteps", "filename": "footsteps.mp3" }
                ]
            }
        };
        window.config = config; // Make fallback available globally too
    }

    // --- Trigger Map Image Load ---
    if (typeof window.loadMapImage === 'function') {
        const mapPath = config?.map?.imagePath || 'assets/plotting_website.png';
        window.loadMapImage(mapPath);
    }
}

function applyProjectConfig() {
    if (!config || !config.project) return;

    const p = config.project;

    // Title
    const titleEl = document.getElementById('app-title');
    if (titleEl && p.title) titleEl.textContent = p.title;

    // Subtitle
    const subEl = document.getElementById('app-subtitle');
    if (subEl && p.subtitle) subEl.textContent = p.subtitle;

    // About Link
    const aboutEl = document.getElementById('btn-about');
    if (aboutEl && p.aboutUrl) aboutEl.href = p.aboutUrl;

    console.log("🎨 Project Config Applied to UI");
}

// --- Data Loading ---

async function loadData() {
    console.log("Loading data from CSV...");

    // 1. Load Location Data (CSV)
    try {
        const csvPath = config?.data?.csvPath || 'DataSet.csv';
        const response = await fetch(csvPath);

        if (!response.ok) {
            throw new Error(`Failed to load CSV: ${response.status} ${response.statusText}`);
        }

        const csvText = await response.text();
        appState.locations = parseCSV(csvText);

        // Populate global 'json' Map for map.js
        appState.locations.forEach(loc => {
            if (loc.Loc_name) {
                window.json.set(loc.Loc_name, loc);
            }
        });

        // Initialize 'currentValue' for map.js
        if (appState.locations.length > 0) {
            window.currentValue = appState.locations[0].Loc_name;
        }
        console.log(`✅ Locations loaded: ${appState.locations.length} locations`);
    } catch (e) {
        console.error("❌ Error loading CSV:", e);
        // Do not throw, allow app to load with empty state to avoid "stuck" loading screen
        appState.locations = [];
    }

    // 2. Load Audio Samples from config
    try {
        appState.samples = config?.audio?.samples || [];
        console.log(`✅ Audio samples loaded: ${appState.samples.length} samples`);
    } catch (e) {
        console.error("❌ Error loading audio data:", e);
        appState.samples = [];
    }
}

function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim());
    const data = [];

    for (let i = 1; i < lines.length; i++) {
        // Handle CSV lines that might have commas inside quotes (basic handling, or split by simple comma)
        // For this template, we assume simple CSV.
        const values = lines[i].split(',').map(v => v.trim());

        // Skip empty lines
        if (values.length < 2) continue;

        const entry = {};

        headers.forEach((h, idx) => {
            entry[h] = values[idx] || "";
        });

        // Parse IRs - Dynamic Approach
        // Instead of hardcoding IR_Name_1, we look for columns starting with IR_Name_
        const irs = [];

        // Helper to find IR pairs
        // We scan for keys like "IR_Name_X"
        Object.keys(entry).forEach(key => {
            if (key.startsWith('IR_Name_')) {
                const suffix = key.replace('IR_Name_', '');
                const name = entry[key];
                const rotKey = `IR_Rotation_${suffix}`;
                const labelKey = `IR_Label_${suffix}`;
                const rotation = entry[rotKey];
                const label = entry[labelKey];

                if (name && name.length > 0) {
                    irs.push({
                        file: name,
                        label: label || name, // Fallback to name if label missing
                        rotation: parseFloat(rotation) || 0
                    });
                }
            }
        });

        // Sort IRs to maintain order if needed, though usually order depends on column order.
        // If no IR columns found, check for legacy hardcoded indices
        if (irs.length === 0) {
            const addIr = (name, rotation, label) => {
                if (name && name.length > 0) {
                    irs.push({ file: name, rotation: parseFloat(rotation) || 0, label: label || name });
                }
            };
            addIr(entry.IR_Name_1, entry.IR_Rotation_1, entry.IR_Label_1);
            addIr(entry.IR_Name_2, entry.IR_Rotation_2, entry.IR_Label_2);
            addIr(entry.IR_Name_3, entry.IR_Rotation_3, entry.IR_Label_3);
        }

        entry.IRs = irs;

        if (entry.Loc_name) {
            data.push(entry);
        }
    }
    return data;
}

// --- UI Logic ---

function setupListeners() {

    // Sidebar Toggle
    ui.toggleBtn.onclick = () => {
        ui.sidebar.classList.toggle('collapsed');

        // Trigger map resize if map.js is loaded
        if (typeof resizeMapCanvas === 'function') {
            // Delay slightly to match CSS transition or call immediately/repeatedly
            setTimeout(resizeMapCanvas, 310);
        }
    };

    // Navigation Buttons (Prev/Next)
    ui.prevBtn.onclick = () => navigate(-1);
    ui.nextBtn.onclick = () => navigate(1);

    // Location Dropdown Change
    ui.locSelect.onchange = async (e) => {
        const id = e.target.value;
        const index = appState.locations.findIndex(l => l.Loc_name === id);
        if (index !== -1) {
            await performLocationChange(index);
        }
    };

    // Distance Dropdown Change
    ui.distSelect.onchange = (e) => {
        appState.currentIrIndex = parseInt(e.target.value);

        if (audio.isPlaying) {
            // Just reloading IR might be enough, but stopping ensures clean state
            handleStop();
            // Wait slightly for audio graph cleanup if needed, but loadCurrentIR is async
            loadCurrentIR().then(() => {
                handlePlay();
            });
        } else {
            loadCurrentIR();
        }
    };

    // Source Type Radio
    ui.sourceRadios.forEach(radio => {
        radio.onchange = (e) => {
            if (e.target.checked) {
                appState.currentSourceType = e.target.id.replace('src-', '');
                updateSourceUI();
            }
        };
    });

    // Audio Transport
    ui.playBtn.onclick = handlePlay;
    ui.stopBtn.onclick = handleStop;

    // Wet/Dry Toggle
    ui.wetToggle.onchange = (e) => {
        const isWet = e.target.checked;
        audio.setDryWet(isWet);

        // Apply grayscale filter when dry (not wet)
        if (ui.sky) {
            if (isWet) {
                // Wet mode: full color
                ui.sky.setAttribute('material', 'shader: flat; color: #FFFFFF');
            } else {
                // Dry mode: grayscale
                ui.sky.setAttribute('material', 'shader: flat; color: #888888');
            }
        }
    };

    // Volume Slider
    ui.volumeSlider.oninput = (e) => {
        const value = parseInt(e.target.value);
        ui.volumeValue.textContent = `${value}%`;
        audio.setVolume(value);
    };
}

// --- Combined Loading Logic ---

// --- Combined Loading Logic ---

// --- Combined Loading Logic ---

// function populateImageAssets() removed for lazy loading

function loadImageAsync(loc) {
    return new Promise((resolve) => {
        const imagesPath = config?.data?.imagesPath || 'assets/images/';
        const url = `${imagesPath}${loc.Photo_Name}`;

        const img = new Image();
        img.onload = () => {
            console.log(`🖼️ Image preloaded: ${loc.Photo_Name}`);
            resolve(url);
        };
        img.onerror = () => {
            console.warn(`⚠️ Failed to preload image: ${url}`);
            resolve(url); // Proceed anyway to let A-Frame try or fail gracefully
        };
        img.src = url;
    });
}

function preloadAdjacentAssets(currentIndex) {
    // Legacy strategy populates ALL assets at start. 
    // We don't need manual preloading anymore.
}


async function navigate(direction) {
    if (appState.locations.length === 0) return;

    let newIndex = appState.currentLocIndex + direction;
    if (newIndex < 0) newIndex = appState.locations.length - 1;
    if (newIndex >= appState.locations.length) newIndex = 0;

    await performLocationChange(newIndex);
}

function updateUI() {
    const loc = appState.locations[appState.currentLocIndex];
    if (!loc) return;

    // 1. Update Top Bar Display
    ui.locDisplay.textContent = `${loc.Loc_name} - ${loc.Label}`;

    // 2. Populate Location Dropdown (if needed)
    if (ui.locSelect.options.length === 0) {
        appState.locations.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l.Loc_name;
            opt.textContent = `${l.Loc_name} - ${l.Label}`;
            ui.locSelect.appendChild(opt);
        });
    }
    // Sync Location Dropdown Value
    ui.locSelect.value = loc.Loc_name;

    // 3. Populate Sample Dropdown (if needed)
    if (ui.sampleSelect.options.length === 0) {
        appState.samples.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.filename;
            opt.textContent = s.name;
            ui.sampleSelect.appendChild(opt);
        });
    }

    // 4. Update Distance Dropdown
    ui.distSelect.innerHTML = '';
    if (loc.IRs) {
        loc.IRs.forEach((ir, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            // Use Label from CSV if available, otherwise fallback (though migration ensures labels exist)
            opt.textContent = ir.label || ir.file;
            ui.distSelect.appendChild(opt);
        });
    }
    ui.distSelect.value = appState.currentIrIndex;

    // 5. Update Sky (360 Image) - Handled by swapSkybox (Double Buffering)
    // We do NOT touch the sky element here to prevent conflict with the swap logic.
    // const imagesPath = config?.data?.imagesPath || 'assets/images/';
    // const bgUrl = `${imagesPath}${loc.Photo_Name}`;
    // ui.sky.setAttribute('src', bgUrl); 

    // Logging for debug
    console.log(`ℹ️ UI Updated for ${loc.Loc_name}`);
}

function updateSourceUI() {
    ui.ctrlSample.style.display = 'none';
    ui.ctrlUpload.style.display = 'none';

    if (appState.currentSourceType === 'sample') {
        ui.ctrlSample.style.display = 'block';
    } else if (appState.currentSourceType === 'upload') {
        ui.ctrlUpload.style.display = 'block';
    }
}

// --- Double Buffering Logic ---

let currentSkyId = 'sky';

// Helper to get active/inactive elements
function getSkyElements() {
    const s1 = document.getElementById('sky');
    const s2 = document.getElementById('sky-buffer');
    if (currentSkyId === 'sky') return { active: s1, inactive: s2 };
    return { active: s2, inactive: s1 };
}

function prepareSkybox(loc) {
    return new Promise((resolve) => {
        const { active, inactive } = getSkyElements();
        const imagesPath = config?.data?.imagesPath || 'assets/images/';
        const url = `${imagesPath}${loc.Photo_Name}`;

        // 1. Setup the INACTIVE sky (Hidden)
        inactive.setAttribute('src', url);
        // We do NOT rotate the sky anymore. We rotate the camera instead.
        inactive.setAttribute('rotation', `0 0 0`);

        const onLoaded = () => {
            // Just resolve, do NOT swap yet
            resolve(inactive);
        };

        inactive.addEventListener('materialtextureloaded', onLoaded, { once: true });

        // Fallback safety
        setTimeout(() => {
            inactive.removeEventListener('materialtextureloaded', onLoaded);
            onLoaded();
        }, 2000);
    });
}

function revealSkybox() {
    const { active, inactive } = getSkyElements();

    // Swap Visibility
    inactive.setAttribute('visible', 'true');
    active.setAttribute('visible', 'false');

    // Update state
    currentSkyId = inactive.id;
    console.log(`👁️ Revealed Skybox: ${currentSkyId}`);
}

// --- Integration Functions for map.js ---

// Core logic for changing location (loading, switching, restarting audio)
async function performLocationChange(index) {
    if (index === -1) return;
    if (index === appState.currentLocIndex) return;

    // NAVIGATION LOCK
    if (appState.isNavigating) {
        console.warn("⚠️ Navigation blocked: Already navigating.");
        return;
    }
    appState.isNavigating = true;

    const targetLoc = appState.locations[index];

    // User requested to remove loading page.
    // We use cursor feedback instead for the split-second wait.
    document.body.style.cursor = 'wait';

    appState.currentLocIndex = index;
    appState.currentIrIndex = 0;

    // Sync globals for map.js
    window.currentValue = targetLoc.Loc_name;
    ui.locSelect.value = targetLoc.Loc_name;

    // Stop audio immediately? 
    const wasPlaying = audio.isPlaying;
    if (wasPlaying) {
        audio.stop();
        ui.playBtn.disabled = false;
        ui.stopBtn.disabled = true;
    }

    // Parallel Load Phase:
    // 1. Preload Image into Browser Cache (using new Image)
    const imageLoad = loadImageAsync(targetLoc);

    // 2. Decode Audio (Background - Do NOT block visual transition)
    // We let this happen in parallel. If it finishes early, good. If late, audio updates when ready.
    // This restores the "Fast" feel of the visual transition.
    const irLoadPromise = loadCurrentIR();

    // Wait ONLY for Image
    await imageLoad;

    // ATOMIC SWAP STRATEGY:
    // 1. Prepare Skybox (Load texture on hidden sphere)
    await prepareSkybox(targetLoc);

    // 2. Reset Camera to Initial Angle (WHILE hidden sphere is ready but not shown)
    // This blocks the user from seeing the rotation happen on the old or new image.
    if (ui.camera) {
        const rotY = parseFloat(targetLoc.Photo_Rotation) || 0;
        // Convert to Radians for Three.js
        const rotRad = THREE.MathUtils.degToRad(rotY);

        // Reset A-Frame look-controls internal state if available
        const lookControls = ui.camera.components['look-controls'];
        if (lookControls) {
            lookControls.pitchObject.rotation.x = 0;
            lookControls.yawObject.rotation.y = rotRad; // Apply Initial Angle Here
        }
    }

    // 3. Reveal Skybox (Instant Switch)
    // Now that camera is rotated, we show the new image.
    revealSkybox();


    // 2. Update GUI Text
    updateUI();

    // 3. Restart Audio (if it was playing)
    // If IR is still loading, playBuffer/convolver update will wait or handle it?
    // loadCurrentIR updates 'currentIrBuffer'.
    // If we call handlePlay() before IR is done, it might play Dry or play old IR?
    // We should probably wait for IR *before* restarting playback, BUT not before showing image.

    if (wasPlaying) {
        // If IR is fast/cached, this is instant. If slow, we wait for it to finish before making sound.
        // This prevents playing with wrong IR.
        irLoadPromise.then(() => {
            handlePlay();
        });
    }

    document.body.style.cursor = 'default';
    appState.isNavigating = false; // RELEASE LOCK

    preloadAdjacentAssets(index);
}

// map.js expects this function to verify/trigger IR usage when map changes location
// map.js triggers this. We can delegate to our robust function.
window.changeIr = async () => {
    const pendingId = ui.locSelect.value;
    const index = appState.locations.findIndex(l => l.Loc_name === pendingId);
    if (index !== -1) {
        await performLocationChange(index);
    }
};

// map.js expects this to update the image
window.updateImage = () => {
    // Handled in updateUI(), so we can leave empty or ensure updateUI calls it.
    // updateUI() updates the a-sky src.
};


// --- Audio Engine Interactions ---

async function loadCurrentIR() {
    const loc = appState.locations[appState.currentLocIndex];
    if (!loc || !loc.IRs[appState.currentIrIndex]) return;

    const irData = loc.IRs[appState.currentIrIndex];
    const irsPath = config?.data?.irsPath || 'assets/irs/';
    const url = `${irsPath}${irData.file}`;
    await audio.loadIR(url, irData.rotation);
}

// --- UI Helpers ---

function setAudioLoading(isLoading) {
    const btn = ui.playBtn;
    if (isLoading) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...';
    } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-play-fill me-1"></i> Start Audio';
    }
}

async function handlePlay() {
    setAudioLoading(true);

    try {
        await audio.init();
        await loadCurrentIR();

        const type = appState.currentSourceType;
        if (type === 'sample') {
            const file = ui.sampleSelect.value;
            const audioPath = config?.data?.audioPath || 'assets/audio/';
            if (file) await audio.playSample(`${audioPath}${file}`);
        } else if (type === 'mic') {
            await audio.startMic();
        } else if (type === 'upload') {
            const files = ui.fileInput.files;
            if (files.length > 0) await audio.playFile(files[0]);
            else {
                alert("No file selected.");
                setAudioLoading(false);
                return;
            }
        }

        ui.playBtn.disabled = true;
        ui.stopBtn.disabled = false;
        // Restore button text but keep it disabled as "playing"
        ui.playBtn.innerHTML = '<i class="bi bi-play-fill me-1"></i> Playing...';

    } catch (e) {
        console.error("Audio playback failed:", e);
        setAudioLoading(false);
    }
}

function handleStop() {
    audio.stop();
    setAudioLoading(false); // Reset to "Start Audio" state
    ui.stopBtn.disabled = true;
}

// --- Main Animation Loop ---

function animate() {
    requestAnimationFrame(animate);

    if (audio.isPlaying && ui.camera) {
        const obj = ui.camera.object3D;

        // Convert A-Frame Rotation to Degrees
        const x = THREE.MathUtils.radToDeg(obj.rotation.x);
        const y = THREE.MathUtils.radToDeg(obj.rotation.y);
        const z = THREE.MathUtils.radToDeg(obj.rotation.z);

        // Update Ambisonic Rotator
        // Invert Y (Yaw) to match typical coordinate system expectations
        audio.updateRotation(-y, x, z);
    }
}

// --- Service Worker Registration ---

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').then(registration => {
                console.log('SW registered: ', registration);
            }).catch(registrationError => {
                console.log('SW registration failed: ', registrationError);
            });
        });
    }
}

// --- Background Loader ---

class BackgroundLoader {
    constructor(locations) {
        this.locations = locations;
        this.queue = [...locations]; // Copy
        // Remove current location (first one) if strictly needed, but browser cache handles duplicates
        this.total = this.queue.length;
        this.loadedCount = 0;
        this.isRunning = false;

        this.progressBar = document.getElementById('progress-bar');
        this.progressContainer = document.getElementById('progress-container');
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log("Starting Background Loader...");
        this.processQueue();
    }

    async processQueue() {
        if (this.queue.length === 0) {
            console.log("Background Loading Complete!");
            if (this.progressContainer) {
                setTimeout(() => {
                    this.progressContainer.style.opacity = '0';
                }, 1000);
            }
            this.isRunning = false;
            return;
        }

        const loc = this.queue.shift();

        // Load Image
        await loadImageAsync(loc);

        // Update Progress
        this.loadedCount++;
        this.updateUI();

        // Small delay to yield to main thread/render
        setTimeout(() => this.processQueue(), 50);
    }

    updateUI() {
        if (this.progressBar && this.total > 0) {
            const pct = (this.loadedCount / this.total) * 100;
            this.progressBar.style.width = `${pct}%`;
        }
    }
}
