
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
            // Start at the first location of DataSet.csv
            const startIdx = 0;
            await performLocationChange(startIdx);
        } else {
            updateUI();
            ui.locDisplay.textContent = 'No locations'; // none in DataSet.csv: not 'Loading...' for good
        }

        // 4. Mark as ready & Hide Overlay
        appState.isLoading = false;
        hideLoadingOverlay();
        console.log("✅ CAVERN Ready (First Content Paint)");

        // 5. Initialize Map System
        if (typeof window.loadMapImage === 'function') {
            window.loadMapImage();
        }



        // 5c. No start-up preload of every panorama (only the neighbours, after each location
        // change: preloadAdjacentAssets)

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
            project: { // neutral fallback: no other project's name, subtitle or About page
                name: "Virtual acoustics tour",
                title: "CAVERN",
                subtitle: "",
                aboutUrl: "#"
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

        // Hold the sound (a playing source or a Start in flight is cancelled; Loading while the
        // visitor wants sound) and load this distance's response; settleNavigation() restarts once,
        // when no location change is in progress and the newest response is in; a failure is
        // shown by loadCurrentIR()
        holdForResponse();
        requestIR();
    };

    // Source Type Radio
    ui.sourceRadios.forEach(radio => {
        radio.onchange = (e) => {
            if (e.target.checked) {
                // A new source type: before the label changes, a Start in flight is cancelled and what
                // plays is stopped (handleStop, audio.stop: its output fades out in 25 ms); a
                // microphone's tracks are released at the end of that fade. An explicit Start resumes
                const type = e.target.id.replace('src-', '');
                if (type !== appState.currentSourceType) handleStop();
                appState.currentSourceType = type;
                updateSourceUI();
            }
        };
    });

    // Audio Transport
    // The press makes and resumes the AudioContext before anything is awaited (audio.prime), so its
    // user gesture is used also when the audio library is still loading or arrives later. A context
    // that cannot be made (its constructor throws) ends this Start at once with the engine's failure
    // message below the Start/Stop buttons, Start enabled
    ui.playBtn.onclick = () => {
        try {
            // with no locations nothing starts (handlePlay says so), so no AudioContext is made
            if (appState.locations.length > 0) audio.prime();
        } catch (e) {
            console.error('❌ AudioContext could not be made:', e);
            showAudioMessage(audio.engineError(`the browser could not make an AudioContext: ${(e && e.name) || 'Error'}`).message);
            resetTransport();
            return;
        }
        return handlePlay();
    };
    ui.stopBtn.onclick = handleStop;

    // Wet/Dry Toggle
    ui.wetToggle.onchange = (e) => {
        const isWet = e.target.checked;
        audio.setDryWet(isWet);

        // Apply grayscale filter when dry (not wet), on both sky elements of the double buffer
        // (the visible one alternates between #sky and #sky-buffer)
        ['sky', 'sky-buffer'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.setAttribute('material', `shader: flat; color: ${isWet ? '#FFFFFF' : '#888888'}`);
        });
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
        img.crossOrigin = 'anonymous'; // the request mode of A-Frame's texture load, so its request can reuse this one
        img.onload = () => {
            console.log(`🖼️ Image preloaded: ${loc.Photo_Name}`);
            resolve(img); // the loaded image itself: prepareSkybox makes the sky's texture from it
        };
        img.onerror = () => {
            console.warn(`⚠️ Failed to preload image: ${url}`);
            resolve(null); // a failure, never a loaded image (the location change then fails)
        };
        img.src = url;
    });
}

function preloadAdjacentAssets(currentIndex) {
    // preload only the previous and next locations' panoramas, after a short pause
    const n = appState.locations.length;
    if (n < 2) return;
    setTimeout(() => {
        [currentIndex + 1, currentIndex - 1].forEach((i) => {
            const loc = appState.locations[(i + n) % n];
            if (loc) loadImageAsync(loc);
        });
    }, 1500);
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
    fillIrMenu(loc);

    // 5. Update Sky (360 Image) - Handled by swapSkybox (Double Buffering)
    // We do NOT touch the sky element here to prevent conflict with the swap logic.
    // const imagesPath = config?.data?.imagesPath || 'assets/images/';
    // const bgUrl = `${imagesPath}${loc.Photo_Name}`;
    // ui.sky.setAttribute('src', bgUrl); 

    // Logging for debug
    console.log(`ℹ️ UI Updated for ${loc.Loc_name}`);
}

// The Distance menu: the location's IRs, the chosen one selected (also called at the start of a
// location change, so the menu never lists the previous location's IRs)
function fillIrMenu(loc) {
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

// The camera's look-controls once A-Frame has initialised it (its yaw and pitch objects exist),
// else null
function lookControlsNow(camera) {
    const lc = camera && camera.components ? camera.components['look-controls'] : null;
    return lc && lc.yawObject && lc.pitchObject ? lc : null;
}

// Whether look-controls can still initialise on this camera: the camera entity has not loaded yet,
// or it declares look-controls. A loaded camera without it (a custom camera entity) never gets one.
function lookControlsCanCome(camera) {
    return !!camera && (!camera.hasLoaded || camera.hasAttribute('look-controls'));
}

// Resolves the camera's look-controls once it has initialised (the camera's componentinitialized
// or loaded event, or a 50 ms check), or null after ms or as soon as it cannot come any more. On a
// freshly opened page the first location's panorama can be ready before A-Frame has initialised the
// camera.
function lookControlsReady(camera, ms) {
    const now = lookControlsNow(camera);
    if (now || !camera) return Promise.resolve(now);
    return new Promise((resolve) => {
        let done = false, tick = 0, bound = 0;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(tick);
            clearTimeout(bound);
            camera.removeEventListener('componentinitialized', onEvent);
            camera.removeEventListener('loaded', onEvent);
            resolve(lookControlsNow(camera));
        };
        const onEvent = () => { if (lookControlsNow(camera) || !lookControlsCanCome(camera)) finish(); };
        const poll = () => {
            if (done) return;
            if (lookControlsNow(camera) || !lookControlsCanCome(camera)) return finish();
            tick = setTimeout(poll, 50);
        };
        camera.addEventListener('componentinitialized', onEvent);
        camera.addEventListener('loaded', onEvent);
        tick = setTimeout(poll, 50);
        bound = setTimeout(finish, ms);
    });
}

// A start view whose look-controls wait ran out: applied as soon as look-controls initialises
// (the newest such location's), unless a later location change has applied its own start view first
const startView = { pending: null, waiting: false };
function applyStartViewWhenReady(camera, rotRad) {
    startView.pending = rotRad;
    console.warn('look-controls not initialised yet: the start view is applied when it is');
    if (startView.waiting || !camera) return;
    startView.waiting = true;
    const onEvent = () => {
        const lc = lookControlsNow(camera);
        if (!lc) return;
        camera.removeEventListener('componentinitialized', onEvent);
        camera.removeEventListener('loaded', onEvent);
        startView.waiting = false;
        if (startView.pending === null) return;
        lc.pitchObject.rotation.x = 0;
        lc.yawObject.rotation.y = startView.pending;
        startView.pending = null;
    };
    camera.addEventListener('componentinitialized', onEvent);
    camera.addEventListener('loaded', onEvent);
}

// What the sky's THREE material map holds: 'ready' (the image of the resolved URL src, with positive
// dimensions), 'failed' (that URL as a video element, which A-Frame makes after a failed HEAD
// request, or a broken image) or 'pending' (another or no image yet). src is the preloaded image's
// own resolved URL, compared as a whole: a Photo_Name may contain folders, a query or characters
// that the URL encodes, and the map may hold another element of the same URL (A-Frame caches
// textures by URL).
function skyImageState(el, src) {
    const mesh = el && el.getObject3D && el.getObject3D('mesh');
    const map = mesh && mesh.material ? mesh.material.map : null;
    const img = map ? map.image : null;
    if (!img || !src || img.src !== src) return 'pending';
    if (typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement) return 'failed';
    if ((img.naturalWidth || img.width) > 0 && (img.naturalHeight || img.height) > 0 && img.complete !== false) return 'ready';
    return img.complete === true ? 'failed' : 'pending';
}

// Resolves the inactive sky once its material really holds this location's panorama (skyImageState
// 'ready'), checked at once, on materialtextureloaded and on every animation frame (a 200 ms timer
// too, for a hidden tab). imageLoad is loadImageAsync's promise: the sky's texture is made from the
// loaded image itself (material src = the <img> element), so A-Frame makes no request of its own (no
// HEAD check, no second GET) and keeps no texture promise for a URL that can stay unsettled after a
// failed GET (A-Frame 1.4.2 caches one per src, and setting the same src again makes no new request).
// Resolves null on a failed preload (imageLoad gives null), a failed texture, or 30 s after the image
// loaded (the preload itself stays unbounded). No event or timer alone means ready. superseded(): a
// newer location was chosen meanwhile; the wait then ends at once (null), also during the preload,
// and a late image is not put on the sky.
function prepareSkybox(loc, imageLoad, superseded) {
    return new Promise((resolve) => {
        const { active, inactive } = getSkyElements();
        let done = false, frame = 0, tick = 0, bound = 0, image = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            cancelAnimationFrame(frame);
            clearTimeout(tick);
            clearTimeout(bound);
            inactive.removeEventListener('materialtextureloaded', onEvent);
            resolve(ok ? inactive : null); // do NOT swap yet
        };
        const check = () => {
            if (done) return;
            cancelAnimationFrame(frame);
            clearTimeout(tick);
            if (superseded && superseded()) return finish(false);
            if (image) {
                const state = skyImageState(inactive, image.src);
                if (state === 'ready') return finish(true);
                if (state === 'failed') return finish(false);
            }
            frame = requestAnimationFrame(check);
            tick = setTimeout(check, 200);
        };
        const onEvent = () => check();
        inactive.addEventListener('materialtextureloaded', onEvent);
        Promise.resolve(imageLoad).then((loaded) => {
            if (done) return;
            if (!loaded || typeof loaded !== 'object') return finish(false);
            image = loaded;
            bound = setTimeout(() => finish(false), 30000);
            // 1. Setup the INACTIVE sky (Hidden): the texture from the loaded image element
            inactive.setAttribute('material', 'src', loaded);
            // We do NOT rotate the sky anymore. We rotate the camera instead.
            inactive.setAttribute('rotation', `0 0 0`);
            check();
        }, () => finish(false));
        check();
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
async function performLocationChange(index, again) { /* again: load the current location again */
    if (index === -1) return;

    // NAVIGATION LOCK
    if (appState.isNavigating) {
        // queue the newest request instead of dropping it, also when it names the location now
        // loading (the menu shows it; an older queued location is dropped); the sound is held at
        // once and plays only after the newest location's response is in (settleNavigation)
        appState.pendingNavIndex = index;
        holdForResponse();
        // the location being loaded is chosen again while its response failure is held (it failed
        // after another location had been queued, see loadCurrentIR): that failure now applies,
        // nothing plays
        if (index === appState.currentLocIndex && navState.irHeld) {
            navState.irHeld = false;
            transportState.want = false;
            transportState.starting = 0;
            resetTransport();
        }
        // the status names the newest chosen location; a location other than the one loading,
        // queued while a failure message of the loading location stands, replaces that message at
        // once with the status naming the queued location (showNavMessage)
        if (navState.locationLoading || (index !== appState.currentLocIndex && (navState.pictureMessage || navState.irMessage))) {
            navState.locationLoading = `Loading the picture for ${appState.locations[index].Loc_name} ...`;
        }
        if (navState.locationLoading || navState.pictureMessage || navState.irMessage) showNavMessage();
        return;
    }
    if (index === appState.currentLocIndex && !again) return;
    appState.isNavigating = true;
    navState.panoramaShown = false; // until this location's own panorama is displayed
    // a picture failure message belongs to its location: choosing another location clears it at
    // once, with that location's response failure; that location's own response and panorama
    // then write the message. While it loads no sky is shown, so a neutral status names the
    // location being loaded until its panorama is shown or fails
    if (index !== appState.currentLocIndex && (navState.pictureMessage || navState.locationLoading)) {
        navState.pictureMessage = false;
        navState.irMessage = false; // requestIR below starts this location's own request
        navState.locationLoading = `Loading the picture for ${appState.locations[index].Loc_name} ...`;
        showNavMessage();
    }

    const targetLoc = appState.locations[index];

    // User requested to remove loading page.
    // We use cursor feedback instead for the split-second wait.
    document.body.style.cursor = 'wait';

    // keep the chosen IR (Distance menu) when the new location offers it: the IR with the same
    // label, else the same entry, else the first. The menu lists the new location's IRs at once,
    // so an IR chosen while the change runs is one of the new location's.
    const prevIr = ((appState.locations[appState.currentLocIndex] || {}).IRs || [])[appState.currentIrIndex];
    appState.currentLocIndex = index;
    const irs = targetLoc.IRs || [];
    const sameLabel = prevIr ? irs.findIndex((ir) => ir.label === prevIr.label) : -1;
    const keepIr = appState.currentIrIndex;
    appState.currentIrIndex = sameLabel >= 0 ? sameLabel : ((keepIr >= 0 && keepIr < irs.length) ? keepIr : 0);
    fillIrMenu(targetLoc);

    // Sync globals for map.js
    window.currentValue = targetLoc.Loc_name;
    ui.locSelect.value = targetLoc.Loc_name;

    // Playing, or a Start in flight: cancel it (its source never connects) and show Loading
    // until this location is shown and its response is in (settleNavigation)
    holdForResponse();

    // Parallel Load Phase:
    // 1. Load the panorama (new Image, in A-Frame's CORS mode): the loaded image itself becomes
    // the sky's texture (prepareSkybox), so A-Frame makes no request of its own
    const imageLoad = loadImageAsync(targetLoc);

    // 2. Decode Audio (Background - Do NOT block visual transition)
    // We let this happen in parallel. If it finishes early, good; if late, the sound is held until
    // it is in. This restores the "Fast" feel of the visual transition.
    // Tracked request: settleNavigation waits for it (a failure is shown by loadCurrentIR, which
    // has stopped playback; a distance change during the load supersedes it)
    requestIR();

    // The image is awaited inside prepareSkybox's wait (null when the preload failed), which a
    // newer location ends at once

    // ATOMIC SWAP STRATEGY:
    // 1. Prepare Skybox (Load texture on hidden sphere)
    // shown: this location's own panorama is ready; superseded: a newer location was chosen
    // meanwhile (it runs next; this one is neither revealed, named, sounded nor reported)
    const newerLocation = () => {
        const queued = appState.pendingNavIndex;
        return queued !== undefined && queued !== null && queued !== index;
    };
    const shown = !!(await prepareSkybox(targetLoc, imageLoad, newerLocation));
    const superseded = newerLocation();

    // 2. Reset Camera to Initial Angle (WHILE hidden sphere is ready but not shown)
    // This blocks the user from seeing the rotation happen on the old or new image.
    if (ui.camera && shown && !superseded) {
        const rotY = parseFloat(targetLoc.Photo_Rotation) || 0;
        // Convert to Radians for Three.js
        const rotRad = THREE.MathUtils.degToRad(rotY);

        // Reset A-Frame look-controls internal state if available
        // On a freshly opened page this location's panorama (made from the preloaded image) can be
        // ready before A-Frame has initialised the camera's look-controls; skipping the start view
        // then left it at yaw 0. Wait for look-controls (lookControlsReady) before the reveal; if it
        // is still absent after the bound, apply the start view when it initialises, never skip it.
        // A camera that has loaded without declaring look-controls (a custom camera entity) gets no
        // start view and no wait, as before (lookControlsCanCome, checked again during the wait).
        let lookControls = lookControlsNow(ui.camera);
        if (!lookControls && lookControlsCanCome(ui.camera)) lookControls = await lookControlsReady(ui.camera, 10000);
        if (lookControls) {
            startView.pending = null; // this location's start view replaces any deferred one
            lookControls.pitchObject.rotation.x = 0;
            lookControls.yawObject.rotation.y = rotRad; // Apply Initial Angle Here
        } else if (lookControlsCanCome(ui.camera)) {
            applyStartViewWhenReady(ui.camera, rotRad);
        }
    }

    // 3. Reveal Skybox (Instant Switch)
    // Now that camera is rotated, we show the new image.
    // Reveal and name the location only with its own panorama; a failure hides both skies (no
    // other location's picture under this location's name), stops and says so. A location queued
    // meanwhile, also during the look-controls wait above, supersedes this one: checked again here.
    const supersededNow = superseded || newerLocation();
    if (shown && !supersededNow) {
        revealSkybox();
        navState.panoramaShown = true;
        if (navState.pictureMessage || navState.locationLoading) {
            navState.pictureMessage = false;
            navState.locationLoading = false;
            showNavMessage(); // a response failure stays shown
        }

        // 2. Update GUI Text
        updateUI();
    } else if (!supersededNow) {
        showPanoramaFailure(targetLoc);
    }

    // No restart here: settleNavigation (below, or the queued location change's own) restarts
    // once, when the newest location is shown and its response is in

    document.body.style.cursor = 'default';
    appState.isNavigating = false; // RELEASE LOCK

    preloadAdjacentAssets(index);

    // run a location change requested while this one was loading (it settles)
    if (appState.pendingNavIndex !== undefined && appState.pendingNavIndex !== null) {
        const next = appState.pendingNavIndex;
        appState.pendingNavIndex = null;
        if (next !== appState.currentLocIndex) return performLocationChange(next);
    }
    settleNavigation();
}

// Loads the location chosen in the location menu. map.js no longer calls it (a dot sets the menu
// and fires its change event); kept for scripts that do.
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

// Returns audio.loadIR's result (true: applied; false: a newer request superseded it; null: no
// location yet). A failure of the newest request (playback stopped, previous response cleared)
// resets the Start/Stop buttons, shows a message below them and rethrows. A location without an
// IR for the chosen distance is a failure too, never a silent keep of the previous response. A new
// request hides an older request's message at once.
async function loadCurrentIR() {
    const loc = appState.locations[appState.currentLocIndex];
    if (!loc) return null;

    const irData = loc.IRs ? loc.IRs[appState.currentIrIndex] : null;
    const irsPath = config?.data?.irsPath || 'assets/irs/';
    const url = irData ? `${irsPath}${irData.file}` : null;
    // an older request's failure named the location or distance chosen before this request (a
    // picture failure message or a loading status stays)
    if (navState.irMessage) {
        navState.irMessage = false;
        showNavMessage();
    }
    // this request's generation: audio.loadIR numbers every call when it is made
    const request = audio.loadIR(url, irData ? irData.rotation : 0);
    const requestGen = audio.irGeneration;
    try {
        const applied = await request;
        if (applied) { // a picture failure message or a loading status stays until the panorama is shown
            navState.irMessage = false;
            showNavMessage();
        }
        return applied;
    } catch (e) {
        // a request that a newer one has replaced (also by a late rejection of the initialization
        // it waited for) changes nothing: not the buttons, the wish to listen or the message
        if (requestGen !== audio.irGeneration) return false;
        // another location is queued: the visitor has left this one, so its failure neither ends
        // the wish to listen nor shows under the queued location (showNavMessage hides it); the stop
        // is held and applies only if this location is chosen again (the queue in
        // performLocationChange); the queued location's request clears it
        const queued = appState.pendingNavIndex;
        navState.irHeld = queued !== undefined && queued !== null && queued !== appState.currentLocIndex;
        if (!navState.irHeld) {
            transportState.want = false;
            transportState.starting = 0;
            resetTransport();
        }
        navState.irMessage = irFailureMessage(loc, irData, e);
        showNavMessage(); // while a picture failure stands, both reasons are shown
        throw e;
    }
}

// The message for a response that could not be applied. A location without an IR (a picture-only
// location) is told so, without an offer to try again; an audio engine that could not start
// (audio.js) names its cause.
function irFailureMessage(loc, irData, e) {
    if (e && e.name === 'AudioEngineError') return e.message;
    if (!irData) {
        if (loc.IRs && loc.IRs.length) {
            return `The chosen distance is not listed for ${loc.Loc_name}, so nothing is playing. Choose another distance.`;
        }
        return `No acoustic response (IR) is listed for ${loc.Loc_name} in ${config?.data?.csvPath || 'DataSet.csv'}, so nothing plays here.`;
    }
    return `The acoustic response for ${loc.Loc_name} (${irData.label || irData.file}) could not be loaded, so nothing is playing. ` +
        'Press Start Audio to try again, or choose another location or distance.';
}

// Transport state. want: the visitor pressed Start and has not pressed Stop since (playing,
// starting, or held during a navigation); starting: the generation of the Start in flight (0: none);
// resuming: the resume() of a suspended AudioContext that a press made (handlePlay), raced against a
// 3 s timer: set until the first of the two settles, else null.
const transportState = { want: false, starting: 0, last: 0, resuming: null };

// Navigation state: irGen counts the IR requests of location and distance changes, irSettled is the
// newest one that has finished (applied or failed); panoramaShown: the current location's own
// panorama is displayed (false during a location change and after its picture failed);
// pictureMessage: the picture failure message while it stands (until the location's panorama is
// shown or another location is chosen), else false; irMessage: the newest response request's
// failure message (hidden when a newer request starts), else false; locationLoading: the neutral
// status of a location chosen after a picture failure, until its panorama is shown or fails, else
// false; irHeld: the response failure of the location being loaded arrived while another location
// was queued (its stop is held), else false.
const navState = { irGen: 0, irSettled: 0, panoramaShown: false, pictureMessage: false, irMessage: false, locationLoading: false, irHeld: false };

// The message below the Start/Stop buttons from the navigation state: the standing picture and
// response failure messages (both when both stand), else the neutral status of a location loading
// after a picture failure, else none. While a location other than the one loading is queued, the
// queued location is the chosen one: the loading location's failures are not shown under its name
// (the queued location's change clears them; if the loading location is chosen again, they show
// again).
function showNavMessage() {
    const queued = appState.pendingNavIndex;
    const otherQueued = queued !== undefined && queued !== null && queued !== appState.currentLocIndex;
    const failure = otherQueued ? '' : [navState.pictureMessage, navState.irMessage].filter(Boolean).join(' ');
    if (failure) showAudioMessage(failure);
    else showAudioMessage(navState.locationLoading || null, true);
}

// The current location's panorama could not be shown: no other location's picture stands under
// its name (both skies hidden), nothing plays (as a failed response in loadCurrentIR), and a
// message says so; Start loads the location again (handlePlay)
function showPanoramaFailure(loc) {
    ['sky', 'sky-buffer'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('visible', 'false');
    });
    updateUI();
    transportState.want = false;
    transportState.starting = 0;
    audio.stop();
    resetTransport();
    navState.pictureMessage = `The picture for ${loc.Loc_name} could not be loaded, so nothing is shown or playing. ` +
        'Press Start Audio to try again, or choose another location.';
    navState.locationLoading = false; // this location's own outcome replaces its loading status
    showNavMessage(); // this location's response failure, if any, stays shown with it
}

// A location or distance change: when the visitor wants sound, cancel what plays or is starting
// (audio.stop makes a Start in flight stale) and show Loading until settleNavigation restarts.
// Returns whether the visitor wants sound.
function holdForResponse() {
    if (!transportState.want) return false;
    transportState.starting = 0;
    audio.stop();
    setTransport('loading');
    return true;
}

// Load the current location's and distance's response as a tracked request; when the newest
// tracked request finishes, settleNavigation decides
function requestIR() {
    const gen = ++navState.irGen;
    navState.irHeld = false; // a held failure belonged to the request this one replaces
    const done = () => {
        if (gen !== navState.irGen) return; // superseded by a newer location or distance change
        navState.irSettled = gen;
        settleNavigation();
    };
    loadCurrentIR().then(done, done);
}

// true while a location change runs (its panorama is not shown yet), the current location's
// panorama is not displayed (it failed), a queued location waits, or the newest location or
// distance change's response is still loading
function navigationBusy() {
    const pending = appState.pendingNavIndex;
    return appState.isNavigating || !navState.panoramaShown || navState.irSettled !== navState.irGen ||
        (pending !== undefined && pending !== null && pending !== appState.currentLocIndex);
}

// The one place that restarts after a navigation: once nothing is busy, when the visitor still
// wants sound and nothing plays or starts; location, distance, menus and display then agree. It runs
// outside a press, so it restarts only in a running AudioContext and never calls resume() itself
// (WebKit keeps a resume() made without a user gesture pending until the context runs): while a
// press's own resume() runs it waits for it, at most 3 s (handlePlay calls this again), otherwise
// Start is shown again and the next press resumes the context.
function settleNavigation() {
    if (navigationBusy()) return;
    if (!transportState.want || transportState.starting || audio.isPlaying) return;
    if (!audio.ctx || audio.ctx.state !== 'running') {
        if (transportState.resuming) return;
        transportState.want = false;
        resetTransport();
        if (audio.ctx) showAudioMessage('The browser has not let the sound start yet. Press Start Audio to play.');
        return;
    }
    startPlayback();
}

// --- UI Helpers ---

// Start/Stop buttons from the real state: 'stopped' (Start enabled), 'loading' (Start disabled,
// Stop enabled to cancel), 'playing' (Start disabled as "Playing...", Stop enabled)
function setTransport(state) {
    const btn = ui.playBtn;
    btn.disabled = state !== 'stopped';
    btn.innerHTML = state === 'loading'
        ? '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...'
        : `<i class="bi bi-play-fill me-1"></i> ${state === 'playing' ? 'Playing...' : 'Start Audio'}`;
    ui.stopBtn.disabled = state === 'stopped';
}

// Plain message right below the Start/Stop buttons (no alert() dialog); null hides it; neutral: a
// status (role "status", plain text), not an alert
function showAudioMessage(text, neutral) {
    let el = document.getElementById('audio-message');
    if (!text) {
        if (el) {
            el.hidden = true;
            el.textContent = '';
        }
        return;
    }
    if (!el) {
        el = document.createElement('p');
        el.id = 'audio-message';
        el.setAttribute('role', 'alert');
        el.style.fontSize = '0.8rem';
        el.style.lineHeight = '1.35';
        el.style.margin = '0 0 12px';
        el.style.color = '#ffd0c8';
        el.style.fontWeight = '600';
        const row = ui.playBtn && ui.playBtn.parentElement;
        if (row && row.parentElement) row.parentElement.insertBefore(el, row.nextSibling);
        else document.body.appendChild(el);
    }
    el.textContent = text;
    el.setAttribute('role', neutral ? 'status' : 'alert');
    el.style.color = neutral ? '' : '#ffd0c8';
    el.style.fontWeight = neutral ? '' : '600';
    el.hidden = false;
}

// Start enabled, Stop disabled (nothing is playing)
function resetTransport() {
    setTransport('stopped');
}

// Start button: one Start at a time; a press while a Start is in flight is ignored. During a
// navigation (navigationBusy) it only records the wish and shows Loading: settleNavigation then
// starts once, with the newest location's and distance's response, never the old one. When the
// current location's panorama is not displayed (it failed) and no location change runs, it loads
// that location again, picture and response. With no locations it says so and stays stopped.
async function handlePlay() {
    if (transportState.starting) return;
    if (appState.locations.length === 0) {
        showAudioMessage(`No locations are listed in ${config?.data?.csvPath || 'DataSet.csv'}, so there is nothing to play.`);
        return;
    }
    transportState.want = true;
    // the press itself resumes a suspended AudioContext (WebKit keeps a resume() made outside a
    // user gesture pending until the context runs); a Start held by a navigation is restarted later,
    // outside the press, by settleNavigation, which waits for this resume() at most 3 s (it runs
    // again when it has settled or 3 s have passed) and restarts only in a running context
    if (audio.ctx && audio.ctx.state !== 'running') {
        const resuming = transportState.resuming = Promise.race([
            audio.ctx.resume().catch(() => { }),
            new Promise(resolve => setTimeout(resolve, 3000)),
        ]).then(() => {
            if (transportState.resuming === resuming) transportState.resuming = null;
            settleNavigation();
        });
    }
    if (!navState.panoramaShown && !appState.isNavigating && appState.currentLocIndex >= 0) {
        setTransport('loading');
        // the retry replaces the picture failure with the neutral status until the panorama is shown
        // or fails again (loadCurrentIR hides an older response failure when the new request starts)
        if (navState.pictureMessage) {
            navState.pictureMessage = false;
            navState.locationLoading = `Loading the picture for ${appState.locations[appState.currentLocIndex].Loc_name} ...`;
            showNavMessage();
        }
        await performLocationChange(appState.currentLocIndex, true);
        return;
    }
    if (navigationBusy()) {
        setTransport('loading');
        return;
    }
    await startPlayback();
}

// One Start with its own generation. It plays only the current location's and distance's response:
// a load that a newer request superseded is repeated (a failure throws; loadCurrentIR shows it). A
// location or distance change, Stop or a failed response makes it stale: it then returns without
// touching the buttons (whoever cancelled it has set them), and audio.js never connects its source.
async function startPlayback() {
    const gen = transportState.starting = ++transportState.last;
    const current = () => transportState.starting === gen;
    setTransport('loading');

    try {
        await audio.init();
        // a Stop or a location or distance change during the engine start made this Start stale: it
        // requests no response
        if (!current()) return;
        for (let tries = 0; (await loadCurrentIR()) === false; tries++) {
            if (!current()) return;
            if (tries >= 3) {
                showAudioMessage('The location or distance changed while loading. Press Start Audio again.');
                throw Object.assign(new Error('IR request superseded 4 times'), { shown: true });
            }
        }
        if (!current()) return;

        let started = false;
        const type = appState.currentSourceType;
        if (type === 'sample') {
            const file = ui.sampleSelect.value;
            const audioPath = config?.data?.audioPath || 'assets/audio/';
            if (file) started = await audio.playSample(`${audioPath}${file}`);
            else showAudioMessage('No sound is listed in config.json (audio.samples), so nothing is playing. ' +
                'Choose Mic or Upload, or add a sample.');
        } else if (type === 'mic') {
            started = await audio.startMic();
        } else if (type === 'upload') {
            const files = ui.fileInput.files;
            if (files.length > 0) started = await audio.playFile(files[0]);
            else showAudioMessage('No file selected. Choose a sound file, then press Start Audio.');
        }
        if (!current()) return;
        if (started !== true) transportState.want = false;
        setTransport(started === true && audio.isPlaying ? 'playing' : 'stopped');
    } catch (e) {
        console.error("Audio playback failed:", e);
        if (!current()) return;
        transportState.want = false;
        if (e && e.name === 'SampleLoadError') {
            showAudioMessage(`The sound (${e.sampleName || 'sample'}) could not be loaded, so nothing is playing. ` +
                'Press Start Audio to try again, or choose another sound.');
        } else if (e && (e.name === 'MicStartError' || e.name === 'AudioEngineError' || e.name === 'AudioSuspendedError')) {
            showAudioMessage(e.message); // the cause, named by audio.js
        } else if (!(e && e.shown)) { // any other error (a failed call of the audio graph, for example)
            showAudioMessage(`Playback could not start (${(e && e.name) || 'error'}), so nothing is playing. ` +
                'Press Start Audio to try again.');
        }
        setTransport('stopped');
    } finally {
        if (current()) transportState.starting = 0;
    }
}

// Stop also cancels a Start in flight, a held restart and a Start pressed during a navigation; it
// stops every source and releases every microphone track (audio.stop)
function handleStop() {
    transportState.want = false;
    transportState.starting = 0;
    audio.stop();
    setTransport('stopped');
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
        // Turn the sound field with the picture. Yaw is passed as it is: inverting it turned the
        // field against the view. Pitch and roll are inverted: three.js pitches about +X (right)
        // and rolls about +Z (back), JSAmbisonics pitches about +Y (left) and rolls about +X (front).
        audio.updateRotation(y, -x, -z);
    }
}

// --- Service Worker Registration ---

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        const register = () => {
            navigator.serviceWorker.register('./sw.js').then(registration => {
                console.log('SW registered: ', registration);
            }).catch(registrationError => {
                console.log('SW registration failed: ', registrationError);
            });
        };
        // This runs after the asynchronous first-location load, often after the window 'load'
        // event: register at once then, else once on 'load'
        if (document.readyState === 'complete') register();
        else window.addEventListener('load', register, { once: true });
    }
}
