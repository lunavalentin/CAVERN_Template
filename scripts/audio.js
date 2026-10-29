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

    // One engine creation at a time: a call made while the engine is being made gets that same
    // attempt (one library load, one AudioContext) and its result; once it has settled, the next call
    // starts again (a failed start is tried again). Once the engine exists, every call asks a
    // suspended context to run itself and returns at once: no call waits for a resume(), which the
    // browser may keep pending (WebKit, without a user gesture); playback waits in whenRunning()
    init() {
        if (this.ctx && !this.initRun) return this.startEngine();
        if (!this.initRun) this.initRun = this.startEngine().finally(() => { this.initRun = null; });
        return this.initRun;
    }

    // Called synchronously by the Start button's press, before anything is awaited: makes the
    // AudioContext if there is none yet (startEngine completes the engine with it) and asks a
    // suspended one to run, so the press's user gesture is used also when the library is still
    // loading or arrives later (WebKit lets a context run only after a resume() in a gesture).
    prime() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!this.ctx && !this.newCtx && AudioContext) this.newCtx = new AudioContext();
        const ctx = this.ctx || this.newCtx;
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { });
    }

    // Playback starts only in a running context. A context made or resumed in a press runs shortly
    // after it; one that stays suspended (WebKit, for a context made or resumed outside a user
    // gesture, or a resume() that never settles) is not waited for longer than 3 s: the Start then
    // fails with an AudioSuspendedError, which main.js shows below the Start/Stop buttons with
    // Start enabled again (the next press asks the context to run again, prime). Returns false
    // when the Start is or went stale: a newer Start, Stop, a location or distance change or a
    // failed response ends the wait at once (endStartWaits), and the caller then releases what it
    // holds (a microphone stream) in the same task. A true result holds only when it is returned:
    // a Stop, a source change or a newer Start may run before the caller resumes, so each caller
    // checks its own generation again right after its await, before it uses anything.
    async whenRunning(startGen) {
        if (startGen !== this.startGeneration) return false;
        const ctx = this.ctx;
        if (ctx.state !== 'running') {
            if (!this.startWaits) this.startWaits = new Set();
            await new Promise(resolve => {
                const done = () => {
                    ctx.removeEventListener('statechange', onState);
                    clearTimeout(timer);
                    this.startWaits.delete(done);
                    resolve();
                };
                const onState = () => { if (ctx.state === 'running') done(); };
                ctx.addEventListener('statechange', onState);
                const timer = setTimeout(done, 3000);
                this.startWaits.add(done);
            });
        }
        if (startGen !== this.startGeneration) return false;
        if (ctx.state === 'running') return true;
        const err = new Error('The browser has not let the sound start yet. Press Start Audio to play.');
        err.name = 'AudioSuspendedError';
        throw err;
    }

    // Ends every readiness wait at once (beginStart, cancelStart: each makes every waiting Start
    // stale), so each waiting Start returns false and releases what it holds
    endStartWaits() {
        if (this.startWaits) [...this.startWaits].forEach(done => done());
    }

    async startEngine() {
        if (this.ctx) {
            // asked to run, not waited for: a resume() that the browser keeps pending (WebKit,
            // outside a user gesture) or that never settles must not hold the Start
            if (this.ctx.state === 'suspended') {
                console.log('🔇 AudioContext suspended, resuming...');
                this.ctx.resume().catch(() => { });
            }
            return;
        }

        console.log('🎵 Initializing Audio Engine...');

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
            console.error('❌ Web Audio API not supported in this browser!');
            throw this.engineError('this browser has no Web Audio API');
        }

        // The AudioContext is made before JSAmbisonics loads, or is the one a Start's press made and
        // resumed (prime). Until the engine is complete it is this.newCtx, not this.ctx (nothing
        // connects to it before its rotator and decoder exist); a failure closes it and leaves the
        // engine as before init, and the next Start makes a new one. A constructor that throws is the
        // engine's failure as well, so also the response request at page load names the engine
        if (!this.newCtx) {
            try {
                this.newCtx = new AudioContext();
            } catch (e) {
                console.error('❌ AudioContext could not be made:', e);
                throw this.engineError(`the browser could not make an AudioContext: ${(e && e.name) || 'Error'}`);
            }
        }
        const ctx = this.newCtx;
        console.log(`🔊 AudioContext created. State: ${ctx.state}`);

        // Initialize JSAmbisonics
        if (typeof ambisonics === 'undefined') {
            console.log("⏳ loading JSAmbisonics dynamically...");
            try {
                await this.loadScript('./JSAmbisonics/ambisonics.umd.js');
            } catch (e) {
                console.error("❌ Failed to load JSAmbisonics:", e);
                if (this.newCtx === ctx) this.newCtx = null;
                ctx.close().catch(() => { });
                throw this.engineError('the audio library JSAmbisonics could not be loaded');
            }
        }
        this.newCtx = null;
        this.ctx = ctx;

        try {
            this.rotator = new ambisonics.sceneRotator(this.ctx, this.order);
            this.decoder = new ambisonics.binDecoder(this.ctx, this.order);
            console.log('✅ JSAmbisonics initialized (Order:', this.order, ')');
        } catch (e) {
            console.error('❌ Failed to initialize JSAmbisonics:', e);
            this.ctx.close().catch(() => { });
            this.ctx = null;
            this.rotator = null;
            this.decoder = null;
            throw this.engineError('the ambisonic rotator or decoder could not be made');
        }

        // Output Gain
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = 1.0;
        this.gainNode.connect(this.ctx.destination);

        // Dry/Wet path setup
        this.dryGainNode = this.ctx.createGain();
        this.wetGainNode = this.ctx.createGain();

        // The shared dry and wet gains stay at 1: each source has its own mode gains, made at the
        // requested state before it connects (connectSourceGraph)

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

    // A switch acts on the playing source's own mode gains (connectSourceGraph) only: a source that
    // still fades after a stop (a release, see stop) keeps its own, so the switch never changes that
    // release. With no source nothing is set; the next one starts at the requested state.
    updateDryWet() {
        if (!this.ctx || !this.voiceWetMode || !this.voiceDryMode) return;
        const rampTime = 0.1;
        const t = this.ctx.currentTime;
        const g = this.dryWetTargets();

        // Smoothed only while the source plays in a running context; otherwise nothing is audible and
        // the requested state is set at once (an idle GainNode does not advance a ramp)
        if (this.ctx.state !== 'running' || !this.isPlaying) {
            this.setDryWetNow(g);
            return;
        }
        this.voiceWetMode.gain.setTargetAtTime(g.wet, t, rampTime);
        this.voiceDryMode.gain.setTargetAtTime(g.dry, t, rampTime);
    }

    // Set the playing source's mode gains to the requested state at once, dropping any scheduled ramp
    setDryWetNow(g) {
        [[this.voiceWetMode, g.wet], [this.voiceDryMode, g.dry]].forEach(([node, v]) => {
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
        // a rejected initialization fails this request only while it is the newest: an obsolete
        // request's rejection changes nothing, as after its other waits
        if (!this.ctx) await this.init().catch((e) => { if (gen === this.irGeneration) throw e; });
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
        this.stop(); // a Start in flight is cancelled; what sounds ends within the release
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

    // Start request generation. playSample, playFile and startMic each begin one; stop() and a
    // failed response cancel it. A Start whose generation is no longer the newest is stale: it never
    // connects its source. Both end every readiness wait at once (endStartWaits), so a stale Start
    // releases what it holds without waiting.
    beginStart() {
        this.startGeneration = (this.startGeneration || 0) + 1;
        this.endStartWaits();
        return this.startGeneration;
    }

    cancelStart() {
        this.startGeneration = (this.startGeneration || 0) + 1;
        this.endStartWaits();
    }

    // A source connects only with the response of the newest IR request
    irReadyForStart() {
        const ok = !!this.currentIrBuffer && this.irAppliedGeneration === this.irGeneration;
        if (!ok) console.warn('⚠️ Start not connected: the response of the current location and distance is not loaded');
        return ok;
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
        // This Start's own generation (beginStart). It is checked right after each wait, before
        // anything is used, except that a sample's download and decoding run to their end first and
        // fill the per-URL cache (only this Start's local buffer holds the result). A stale Start
        // (a newer Start, Stop, a location or distance change, a failed response) returns false
        // without touching the playing source or connecting its own. Returns true once playing.
        const startGen = this.beginStart();
        if (!this.ctx) await this.init();
        if (startGen !== this.startGeneration) return false;

        this.stopSource(); // Stop previous source

        console.log(`🎵 Playing sample: ${url}`);

        // The sample stays this Start's own (buffer) until it plays: the download of a Start that
        // went stale meanwhile fills the cache, never currentAudioBuffer
        let buffer;
        try {
            // Decoded samples are cached per URL: no new download and decode on every Start
            if (!this.sampleCache) this.sampleCache = new Map();
            if (this.sampleCache.has(url)) {
                buffer = this.sampleCache.get(url);
            } else {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const arrayBuffer = await response.arrayBuffer();
                buffer = await this.ctx.decodeAudioData(arrayBuffer);
                this.sampleCache.set(url, buffer);
            }
        } catch (e) {
            // No alert(): a stale Start's failure changes nothing; otherwise main.js shows the cause
            // below the Start/Stop buttons. Only the download and the decoding are in this try, so
            // an error of the audio graph is never reported as a sample that could not be loaded.
            if (startGen !== this.startGeneration) return false;
            console.error(`❌ Failed to play sample from ${url}:`, e);
            const err = new Error(`Sample not loaded: ${url.split('/').pop()} (${e && e.message ? e.message : e})`);
            err.name = 'SampleLoadError';
            err.sampleName = url.split('/').pop();
            throw err;
        }

        // The sample may have arrived after the Start went stale: never connect it
        if (startGen !== this.startGeneration) {
            console.log(`↩️ Start superseded, sample not connected: ${url.split('/').pop()}`);
            return false;
        }
        // Playback is due: only in a running context, never waiting for a resume() that only a
        // user gesture could complete (whenRunning). The generation is checked again right after
        // this wait (also when it rejects): a Stop, a source change or a newer Start that ran after
        // whenRunning() returned makes this Start stale too, and its buffer is never connected
        let running;
        try {
            running = await this.whenRunning(startGen);
        } catch (e) {
            if (startGen !== this.startGeneration) return false; // stale: no message
            throw e;
        }
        if (!running || startGen !== this.startGeneration) return false;
        if (!this.irReadyForStart()) return false;
        this.currentAudioBuffer = buffer;
        this.playBuffer(buffer);
        console.log(`✅ Sample playing: ${url.split('/').pop()}`);
        return true;
    }

    // An uploaded file: same Start generation rule as playSample; resolves true once the source
    // plays, false when the Start went stale; a file that cannot be read or decoded throws
    // 'SampleLoadError' (no alert)
    async playFile(fileBlob) {
        const startGen = this.beginStart();
        if (!this.ctx) await this.init();
        if (startGen !== this.startGeneration) return false;
        this.stopSource();

        let buffer;
        try {
            buffer = await this.ctx.decodeAudioData(await fileBlob.arrayBuffer());
        } catch (e) {
            if (startGen !== this.startGeneration) return false;
            const name = fileBlob && fileBlob.name ? fileBlob.name : 'file';
            const err = new Error(`File not decoded: ${name} (${e && e.message ? e.message : e})`);
            err.name = 'SampleLoadError';
            err.sampleName = name;
            throw err;
        }
        // checked first after the reading and decoding (they run to their end first and only make
        // this local buffer): a stale Start's file is never used
        if (startGen !== this.startGeneration) return false;
        // and again right after the wait for a running context, as in playSample
        let running;
        try {
            running = await this.whenRunning(startGen);
        } catch (e) {
            if (startGen !== this.startGeneration) return false; // stale: no message
            throw e;
        }
        if (!running || startGen !== this.startGeneration || !this.irReadyForStart()) return false;
        this.currentAudioBuffer = buffer;
        this.playBuffer(this.currentAudioBuffer);
        return true;
    }

    async startMic() {
        const startGen = this.beginStart(); // see playSample
        if (!this.ctx) await this.init();
        if (startGen !== this.startGeneration) return false;
        this.stopSource();

        console.log('🎤 Requesting microphone access...');

        // Only the microphone request fails as a microphone error: its cause is named in an error
        // that main.js shows below the Start/Stop buttons (no alert), and main.js resets the Start
        // button. The audio graph is connected after the request; an error there releases the
        // stream and is reported as what it is.
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            if (startGen !== this.startGeneration) return false; // stale: no message
            const noDevice = e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError');
            const refused = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
            console.error(noDevice ? "❌ No microphone found:" : refused ? "❌ Microphone access denied:"
                : "❌ Microphone not available:", e);
            const err = new Error(`${this.micFailureReason(e)} Nothing is playing.`);
            err.name = 'MicStartError';
            err.cause = e;
            throw err;
        }
        // Checked first once access is granted: a Start that went stale while access was asked for
        // releases this stream at once and never connects it (no orphan microphone stream)
        if (startGen !== this.startGeneration) {
            stream.getTracks().forEach(track => track.stop());
            return false;
        }
        // Then the stream waits for a running context (whenRunning). It stays this Start's own: a
        // newer Start, Stop or a location or distance change ends the wait at once and the stream is
        // released in the same task, as when the context does not run within 3 s; it is never
        // connected then. The generation is checked again right after this wait, before the stream
        // is used: a Stop, a source change or a newer Start that ran after whenRunning() returned
        // releases the stream too
        let running;
        try {
            running = await this.whenRunning(startGen);
        } catch (e) {
            stream.getTracks().forEach(track => track.stop());
            if (startGen !== this.startGeneration) return false; // stale: no message
            throw e;
        }
        if (!running || startGen !== this.startGeneration || !this.irReadyForStart()) {
            stream.getTracks().forEach(track => track.stop());
            return false;
        }
        try {
            this.micStream = stream;
            this.sourceNode = this.ctx.createMediaStreamSource(stream);

            this.connectSourceGraph();
            this.isPlaying = true;
            console.log("✅ Microphone started");
            return true;
        } catch (e) {
            // Access was granted but the sound could not be connected: stop every track of the
            // stream and disconnect the source (stopSource), then say what failed
            console.error("❌ Microphone sound could not be connected:", e);
            stream.getTracks().forEach(track => track.stop());
            this.stopSource();
            const err = new Error('The microphone\'s sound could not be connected to the audio processing ' +
                `(${e && e.name ? e.name : 'Error'}), so nothing is playing; the microphone was released.`);
            err.name = 'MicStartError';
            err.cause = e;
            throw err;
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

        // This source's own gains, in front of the shared dry and wet gains: per path a mode gain,
        // made at the requested state (a ramp left from an earlier switch or source cannot shape its
        // first frames; a switch ramps only the playing source's, updateDryWet), then a release gain,
        // which stop() fades. A source that starts, or a switch made, while an earlier source still
        // fades leaves that source's gains alone: its release is not stepped, cut or restored.
        [this.voiceDryMode, this.voiceWetMode, this.voiceDry, this.voiceWet].forEach(node => {
            if (node) node.disconnect();
        });
        const g = this.dryWetTargets();
        this.voiceDryMode = this.ctx.createGain();
        this.voiceWetMode = this.ctx.createGain();
        this.voiceDryMode.gain.value = g.dry;
        this.voiceWetMode.gain.value = g.wet;
        this.voiceDry = this.ctx.createGain();
        this.voiceWet = this.ctx.createGain();
        this.voiceDryMode.connect(this.voiceDry);
        this.voiceWetMode.connect(this.voiceWet);
        this.voiceDry.connect(this.dryGainNode);
        this.voiceWet.connect(this.rotator.in);

        // Create Convolver for Wet Path
        this.setupConvolver();

        // Connect Source
        // 1. To Convolver (Wet Path)
        // 2. To Dry Gain (Dry Path), through this source's own dry gains

        this.sourceNode.connect(this.convolverNode);
        this.sourceNode.connect(this.voiceDryMode);
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

        // Connect to Rotator (Input of Wet Chain), through the source's own wet gains
        this.foaOut.connect(this.voiceWetMode || this.rotator.in);
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

    // Stop, a navigation hold and a failure end all output. The source's own release gains
    // (connectSourceGraph) fall to 0 in a 25 ms linear ramp, meant to avoid a click, and the source
    // stops at the end of the ramp. Once the context has rendered the ramp, the source, its
    // convolvers with the reverberation they still hold and its gains are disconnected and a
    // microphone's tracks are stopped (finishRelease), so no old tail can sound later. A source
    // started or a mode switch made meanwhile does not touch these gains (the new source has its
    // own gains and convolvers). A playing source is not cut otherwise.
    stop() {
        this.cancelStart(); // a Start in flight is cancelled too: its source never connects
        const source = this.sourceNode;
        const voice = [this.voiceDry, this.voiceWet].filter(Boolean);
        const release = {
            nodes: [source, this.convolverNode, this.foaOut, ...(this.foaConvolvers || []),
                this.voiceDryMode, this.voiceWetMode, ...voice].filter(Boolean),
            stream: this.micStream
        };
        this.sourceNode = null;
        this.convolverNode = null;
        this.foaOut = null;
        this.foaConvolvers = null;
        this.voiceDryMode = null;
        this.voiceWetMode = null;
        this.voiceDry = null;
        this.voiceWet = null;
        this.micStream = null;
        this.isPlaying = false;
        if (!release.nodes.length && !release.stream) return;
        if (!this.releases) this.releases = new Set();
        this.releases.add(release);
        const ctx = this.ctx;
        if (!ctx || !voice.length) {
            this.finishRelease(release); // nothing to fade
            return;
        }
        const t = ctx.currentTime;
        const end = t + 0.025; // seconds
        voice.forEach(node => {
            node.gain.cancelScheduledValues(t);
            node.gain.setValueAtTime(node.gain.value, t);
            node.gain.linearRampToValueAtTime(0, end);
        });
        if (source && source.stop) {
            try {
                source.stop(end);
            } catch (e) { } // ignore if already stopped
        }
        // The release ends by the context's clock, not the wall clock: an output that renders in
        // long periods renders the ramp later. It ends at once when the context does not run
        // (nothing is rendered), and after at most 1 s in any case.
        const until = Date.now() + 1000;
        const check = () => {
            const rendered = ctx.state !== 'running' || ctx.currentTime >= end + 128 / ctx.sampleRate;
            if (rendered || Date.now() > until) this.finishRelease(release);
            else release.timer = setTimeout(check, 10);
        };
        release.timer = setTimeout(check, 30);
    }

    // The end of a release: the stopped source, its convolvers and its gains are disconnected, their
    // tail with them, and a microphone's tracks are stopped
    finishRelease(release) {
        if (!this.releases || !this.releases.delete(release)) return;
        clearTimeout(release.timer);
        release.nodes.forEach(node => node.disconnect());
        if (release.stream) {
            release.stream.getTracks().forEach(track => track.stop());
            console.log("Mic stream stopped");
        }
    }

    // An error of the audio engine itself (no Web Audio, JSAmbisonics missing or failing), thrown
    // instead of an alert(): main.js shows its message below the Start/Stop buttons
    engineError(reason) {
        const err = new Error(`The audio engine could not start (${reason}), so nothing can play. ` +
            'Press Start Audio to try again.');
        err.name = 'AudioEngineError';
        return err;
    }

    // The visitor's words for a microphone that could not be started (getUserMedia's error names;
    // without navigator.mediaDevices the page is not a secure context)
    micFailureReason(e) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return 'This page cannot use a microphone: browsers allow it only on secure (https://) pages.';
        }
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            return 'Microphone access was refused. Allow microphone access for this page, then press Start Audio again.';
        }
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.';
        if (name === 'NotReadableError' || name === 'AbortError') {
            return 'The microphone could not be opened; another application may be using it.';
        }
        return `The microphone could not be started (${name || e}).`;
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
