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

        // Initial state, set directly before any source connects: a ramp from a new GainNode's
        // value 1 let the unconvolved source through on the first wet Start
        const initialGains = this.dryWetTargets();
        this.wetGainNode.gain.value = initialGains.wet;
        this.dryGainNode.gain.value = initialGains.dry;

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
        if (!this.ctx || !this.wetGainNode || !this.dryGainNode) return;
        const rampTime = 0.1;
        const t = this.ctx.currentTime;
        const g = this.dryWetTargets();

        // Smoothed only while a source plays in a running context; otherwise nothing is audible and
        // the requested state is set at once (an idle GainNode does not advance a ramp, which would
        // then start only with the next source and let the dry path through)
        if (this.ctx.state !== 'running' || !this.isPlaying) {
            this.setDryWetNow(g);
            return;
        }
        this.wetGainNode.gain.setTargetAtTime(g.wet, t, rampTime);
        this.dryGainNode.gain.setTargetAtTime(g.dry, t, rampTime);
    }

    // Set both gains to the requested state at once, dropping any scheduled ramp
    setDryWetNow(g) {
        [[this.wetGainNode, g.wet], [this.dryGainNode, g.dry]].forEach(([node, v]) => {
            node.gain.cancelScheduledValues(0);
            node.gain.value = v;
        });
    }

    // Requested gains: Ambisonic Mode on = wet 1, dry 0; off = wet 0, dry 1
    dryWetTargets() {
        return this.isWet ? { wet: 1.0, dry: 0.0 } : { wet: 0.0, dry: 1.0 };
    }

    setVolume(value) {
        if (!this.gainNode) return;
        // value is 0-100, convert to 0-1
        const gain = value / 100;
        const rampTime = 0.05;
        const t = this.ctx.currentTime;
        this.gainNode.gain.setTargetAtTime(gain, t, rampTime);
    }

    // Scale a decoded IR by (IR file rate / buffer rate). decodeAudioData resamples the IR to the
    // context rate and the convolvers run with normalize = false, so the convolution sum, and the
    // level, would otherwise grow with the device's rate (+0.74 dB at 48 kHz, +6.76 dB at 96 kHz for
    // a 44.1 kHz IR). fileRate is the rate in the file's WAV header (wavSampleRate); when it cannot
    // be read, config.audio.irSampleRate is used; with neither, the IR is not scaled.
    normaliseIrRate(buffer, fileRate) {
        let native = Number(fileRate);
        if (!Number.isFinite(native) || native <= 0) {
            const a = window.config && window.config.audio;
            native = a ? Number(a.irSampleRate) : NaN;
        }
        if (!Number.isFinite(native) || native <= 0 || buffer.sampleRate === native) return buffer;
        const k = native / buffer.sampleRate;
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const d = buffer.getChannelData(c);
            for (let i = 0; i < d.length; i++) d[i] *= k;
        }
        return buffer;
    }

    // The sample rate in a RIFF/WAVE header (the 'fmt ' chunk, also after other chunks and for
    // WAVE_FORMAT_EXTENSIBLE), or null for any other data. Read before decodeAudioData, which
    // detaches the ArrayBuffer.
    wavSampleRate(arrayBuffer) {
        try {
            const v = new DataView(arrayBuffer);
            const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
            if (v.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
            for (let o = 12; o + 8 <= v.byteLength;) {
                const size = v.getUint32(o + 4, true);
                if (tag(o) === 'fmt ') return o + 16 <= v.byteLength ? (v.getUint32(o + 12, true) || null) : null;
                o += 8 + size + (size % 2);
            }
        } catch (e) { }
        return null;
    }

    // Every call is a new request (generation number). Only the newest request may set the buffer
    // and rotation: an older, slower completion is discarded (its decoded buffer stays cached for its
    // own URL). Returns true when applied, false when a newer request superseded it. A failed or
    // missing load of the newest request throws (see failIR): the previous location's response is
    // never kept under the new label.
    async loadIR(url, rotationDegrees) {
        const gen = this.irGeneration = (this.irGeneration || 0) + 1;
        if (!this.ctx) await this.init();
        if (gen !== this.irGeneration) return false;
        if (!url) return this.failIR(url, new Error('no impulse response for this location and distance'));

        let buffer = this.irCache.get(url);
        if (!buffer) {
            console.log(`📥 Loading IR: ${url}`);
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`);
                }
                const arrayBuffer = await response.arrayBuffer();
                const fileRate = this.wavSampleRate(arrayBuffer);
                buffer = this.normaliseIrRate(await this.ctx.decodeAudioData(arrayBuffer), fileRate);
                this.irCache.set(url, buffer);
            } catch (e) {
                if (gen !== this.irGeneration) return false; // an obsolete failure changes nothing
                return this.failIR(url, e);
            }
            if (gen !== this.irGeneration) {
                console.log(`↩️ IR discarded, a newer request superseded it: ${url.split('/').pop()}`);
                return false;
            }
        }

        this.currentIrBuffer = buffer;
        this.currentIrUrl = url;
        this.irRotationOffset = rotationDegrees || 0;
        this.irAppliedGeneration = gen;

        // If already playing, we need to update the convolver
        if (this.isPlaying && this.sourceNode) {
            this.setupConvolver();
        }
        console.log(`✅ IR ready: ${url.split('/').pop()}`);
        return true;
    }

    // A failed IR load: stop playback, drop the previous response and its rotation, and throw an
    // error that names the file (main.js shows a message near the controls).
    failIR(url, cause) {
        this.stopSource();
        this.teardownConvolver();
        this.currentIrBuffer = null;
        this.currentIrUrl = null;
        this.irRotationOffset = 0;
        const name = url ? String(url).split('/').pop() : '(none)';
        const why = cause && cause.message ? cause.message : String(cause);
        console.error(`❌ Failed to load IR ${name}:`, cause);
        const err = new Error(`Impulse response not loaded: ${name} (${why})`);
        err.name = 'IrLoadError';
        err.irUrl = url || null;
        throw err;
    }

    // Disconnect the per-channel convolvers and their input node
    teardownConvolver() {
        if (this.foaConvolvers) {
            this.foaConvolvers.forEach(c => c.disconnect());
            this.foaConvolvers = null;
        }
        if (this.foaOut) {
            this.foaOut.disconnect();
            this.foaOut = null;
        }
        if (this.convolverNode) {
            this.convolverNode.disconnect();
            this.convolverNode = null;
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
                const fileRate = this.wavSampleRate(arrayBuffer);
                const decodedBuffer = this.normaliseIrRate(await this.ctx.decodeAudioData(arrayBuffer), fileRate);
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
            // Decoded samples are cached per URL: no new download and decode on every Start
            if (!this.sampleCache) this.sampleCache = new Map();
            if (this.sampleCache.has(url)) {
                this.currentAudioBuffer = this.sampleCache.get(url);
            } else {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const arrayBuffer = await response.arrayBuffer();
                this.currentAudioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
                this.sampleCache.set(url, this.currentAudioBuffer);
            }

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
        // A new source (called only after stopSource) starts at the requested gains: a ramp left
        // from an idle toggle or interrupted by Stop must not shape its first frames
        if (this.wetGainNode && this.dryGainNode) this.setDryWetNow(this.dryWetTargets());

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
