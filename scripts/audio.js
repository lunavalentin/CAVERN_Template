class AudioEngine {
    constructor() {
        this.ctx = null;
        this.rotator = null;
        this.decoder = null;

        // Nodes
        this.sourceNode = null;
        this.convolverNode = null;
        this.gainNode = null;
        this.dryGainNode = null;
        this.wetGainNode = null;

        // Buffers
        this.currentIrBuffer = null;
        this.currentAudioBuffer = null;

        // State
        this.isPlaying = false;
        this.isWet = true;
        this.micStream = null;

        // Constants (First Order Ambisonics)
        this.order = 1;

        // Cache
        this.irCache = new Map(); // Stores decoded AudioBuffers: url -> AudioBuffer
    }

    async init() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') {
                console.log('🔇 AudioContext suspended, resuming...');
                await this.ctx.resume();
                console.log(`▶️ AudioContext resumed. State: ${this.ctx.state}`);
            }
            return;
        }

        console.log('🎵 Initializing Audio Engine...');

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
            console.error('❌ Web Audio API not supported in this browser!');
            alert('Your browser does not support Web Audio API. Please use a modern browser.');
            return;
        }

        this.ctx = new AudioContext();
        console.log(`🔊 AudioContext created. State: ${this.ctx.state}`);

        // Initialize JSAmbisonics
        if (typeof ambisonics === 'undefined') {
            console.log("⏳ loading JSAmbisonics dynamically...");
            try {
                await this.loadScript('./JSAmbisonics/ambisonics.umd.js');
            } catch (e) {
                console.error("❌ Failed to load JSAmbisonics:", e);
                alert('Audio library failed to load. Please check internet connection or file paths.');
                return;
            }
        }

        try {
            this.rotator = new ambisonics.sceneRotator(this.ctx, this.order);
            this.decoder = new ambisonics.binDecoder(this.ctx, this.order);
            console.log('✅ JSAmbisonics initialized (Order:', this.order, ')');
        } catch (e) {
            console.error('❌ Failed to initialize JSAmbisonics:', e);
            alert('Audio processing initialization failed. Please refresh.');
            return;
        }

        // Output Gain
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = 1.0;
        this.gainNode.connect(this.ctx.destination);

        // Dry/Wet path setup
        this.dryGainNode = this.ctx.createGain();
        this.wetGainNode = this.ctx.createGain();

        // Initial state
        this.updateDryWet();

        // Connect Wet Path End
        // Rotator -> Decoder -> WetGain -> MasterGain
        this.rotator.out.connect(this.decoder.in);
        this.decoder.out.connect(this.wetGainNode);
        this.wetGainNode.connect(this.gainNode);

        // Dry path connects directly to master (mono/stereo)
        this.dryGainNode.connect(this.gainNode);

        console.log("✅ Audio Engine Initialized Successfully");
    }

    setDryWet(wet) {
        this.isWet = wet;
        this.updateDryWet();
    }

    updateDryWet() {
        if (!this.ctx) return;
        const rampTime = 0.1;
        const t = this.ctx.currentTime;

        if (this.isWet) {
            this.wetGainNode.gain.setTargetAtTime(1.0, t, rampTime);
            this.dryGainNode.gain.setTargetAtTime(0.0, t, rampTime);
        } else {
            this.wetGainNode.gain.setTargetAtTime(0.0, t, rampTime);
            this.dryGainNode.gain.setTargetAtTime(1.0, t, rampTime);
        }
    }

    setVolume(value) {
        if (!this.gainNode) return;
        // value is 0-100, convert to 0-1
        const gain = value / 100;
        const rampTime = 0.05;
        const t = this.ctx.currentTime;
        this.gainNode.gain.setTargetAtTime(gain, t, rampTime);
    }

    async loadIR(url, rotationDegrees) {
        if (!this.ctx) await this.init();

        // Prevent trying to load if url is missing
        if (!url) {
            console.warn("⚠️ No IR URL provided, skipping load.");
            return;
        }

        // Check Cache first
        if (this.irCache.has(url)) {
            // console.log(`⚡ Using cached IR: ${url.split('/').pop()}`);
            this.currentIrBuffer = this.irCache.get(url);

            // Set rotation offset for the IR if needed
            this.irRotationOffset = rotationDegrees || 0;

            // If already playing, we need to update the convolver
            if (this.isPlaying && this.sourceNode) {
                this.setupConvolver();
            }
            return;
        }

        console.log(`📥 Loading IR: ${url}`);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                // Determine if 404
                if (response.status === 404) {
                    console.warn(`⚠️ IR file not found: ${url}. Switching to DRY mode fallback.`);
                    return;
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);

            // Cache it!
            this.irCache.set(url, decodedBuffer);
            this.currentIrBuffer = decodedBuffer;

            // Set rotation offset for the IR if needed
            this.irRotationOffset = rotationDegrees || 0;

            // If already playing, we need to update the convolver
            if (this.isPlaying && this.sourceNode) {
                this.setupConvolver();
            }

            console.log(`✅ IR Loaded & Cached: ${url.split('/').pop()}`);
        } catch (e) {
            console.error(`❌ Failed to load IR from ${url}:`, e);
        }
    }

    async preloadIR(url) {
        if (!this.ctx) await this.init();
        if (!url || this.irCache.has(url)) return;

        try {
            // console.log(`🔄 Preloading IR: ${url}`);
            const response = await fetch(url);
            if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                const decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);
                this.irCache.set(url, decodedBuffer);
            }
        } catch (e) {
            // Silent fail for preload
        }
    }

    async playSample(url) {
        if (!this.ctx) await this.init();

        // Ensure context is running (it might be suspended if play was auto-triggered inside code)
        if (this.ctx.state === 'suspended') await this.ctx.resume();

        this.stopSource(); // Stop previous source

        console.log(`🎵 Playing sample: ${url}`);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            this.currentAudioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

            this.playBuffer(this.currentAudioBuffer);
            console.log(`✅ Sample playing: ${url.split('/').pop()}`);
        } catch (e) {
            console.error(`❌ Failed to play sample from ${url}:`, e);
            alert(`Failed to load audio file: ${url.split('/').pop()}. Check console for details.`);
        }
    }

    async playFile(fileBlob) {
        if (!this.ctx) await this.init();
        this.stopSource();

        const fileReader = new FileReader();
        fileReader.onload = async (e) => {
            const arrayBuffer = e.target.result;
            this.currentAudioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.playBuffer(this.currentAudioBuffer);
        };
        fileReader.readAsArrayBuffer(fileBlob);
    }

    async startMic() {
        if (!this.ctx) await this.init();
        this.stopSource();

        console.log('🎤 Requesting microphone access...');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.micStream = stream;
            this.sourceNode = this.ctx.createMediaStreamSource(stream);

            this.connectSourceGraph();
            this.isPlaying = true;
            console.log("✅ Microphone started");
        } catch (e) {
            console.error("❌ Microphone access denied:", e);
            alert('Microphone access denied. Please allow microphone access and try again.');
        }
    }

    playBuffer(buffer) {
        if (!buffer) {
            console.error('❌ Cannot play: buffer is null');
            return;
        }

        this.sourceNode = this.ctx.createBufferSource();
        this.sourceNode.buffer = buffer;
        this.sourceNode.loop = true;

        this.connectSourceGraph();

        this.sourceNode.start();
        this.isPlaying = true;
        console.log(`▶️ Playback started (Duration: ${buffer.duration.toFixed(2)}s, Channels: ${buffer.numberOfChannels})`);
    }

    connectSourceGraph() {
        // Disconnect old nodes if any
        if (this.convolverNode) {
            this.convolverNode.disconnect();
            this.convolverNode = null;
        }

        // Create Convolver for Wet Path
        this.setupConvolver();

        // Connect Source
        // 1. To Convolver (Wet Path)
        // 2. To Dry Gain (Dry Path)

        this.sourceNode.connect(this.convolverNode);
        this.sourceNode.connect(this.dryGainNode);
    }

    setupConvolver() {
        if (!this.currentIrBuffer) {
            console.warn('⚠️ No IR buffer loaded, cannot setup convolver');
            return;
        }

        // Re-create convolver node as buffer is immutable usually or just good practice
        if (this.convolverNode) {
            this.convolverNode.disconnect();
        }

        // Ambisonic Convolver
        // We convolve a Mono source with each channel of the N-channel IR separately (one mono
        // ConvolverNode per channel) and merge the results back into N channels for the rotator.
        // A single ConvolverNode with a 4-channel buffer is Web Audio "true stereo" (2-channel
        // output), which does not carry the ambisonic field.
        if (this.foaConvolvers) {
            this.foaConvolvers.forEach(c => c.disconnect());
            this.foaConvolvers = null;
        }
        if (this.foaOut) {
            this.foaOut.disconnect();
            this.foaOut = null;
        }
        const ir = this.currentIrBuffer;
        const nCh = ir.numberOfChannels;
        this.convolverNode = this.ctx.createGain();
        this.convolverNode.channelCount = 1;
        this.convolverNode.channelCountMode = 'explicit';
        this.convolverNode.channelInterpretation = 'speakers';
        this.foaOut = this.ctx.createChannelMerger(nCh);
        this.foaConvolvers = [];
        for (let c = 0; c < nCh; c++) {
            const mono = this.ctx.createBuffer(1, ir.length, ir.sampleRate);
            mono.getChannelData(0).set(ir.getChannelData(c));
            const conv = this.ctx.createConvolver();
            conv.normalize = false;
            conv.buffer = mono;
            this.convolverNode.connect(conv);
            conv.connect(this.foaOut, 0, c);
            this.foaConvolvers.push(conv);
        }

        // Connect to Rotator (Input of Wet Chain)
        this.foaOut.connect(this.rotator.in);
        // A source that is already playing is moved to the new input
        if (this.sourceNode) {
            this.sourceNode.connect(this.convolverNode);
        }
        console.log(`🔊 Convolver setup complete (IR channels: ${this.currentIrBuffer.numberOfChannels})`);
    }

    stopSource() {
        if (this.sourceNode) {
            try {
                this.sourceNode.stop();
            } catch (e) { } // ignore if already stopped
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
            console.log("Mic stream stopped");
        }

        this.isPlaying = false;
    }

    stop() {
        this.stopSource();
    }

    loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => {
                console.log(`✅ Script loaded: ${src}`);
                resolve();
            };
            script.onerror = () => reject(new Error(`Script load error: ${src}`));
            document.head.appendChild(script);
        });
    }

    updateRotation(yawDeg, pitchDeg, rollDeg) {
        if (!this.rotator) return;

        // Check if we need to apply the IR static offset
        // Assuming IR rotation offset means the IR was recorded at that angle, 
        // effectively rotating the sound field.
        // To correct it (align with North), we might need to subtract it or add it.
        // For now, let's just pass the camera rotation.

        // JSAmbisonics expects Yaw, Pitch, Roll in degrees.
        // Apply the static IR rotation offset (from CSV) to the dynamic camera yaw.
        this.rotator.yaw = yawDeg + (this.irRotationOffset || 0);
        this.rotator.pitch = pitchDeg;
        this.rotator.roll = rollDeg;
        this.rotator.updateRotMtx();
    }
}

window.AudioEngine = AudioEngine;
