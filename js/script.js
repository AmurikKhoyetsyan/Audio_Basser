(function () {
    "use strict";

    // ============================================================
    // CONFIG (edit these to quickly change colors & feel)
    // ============================================================
    var THEME = {
        accent: "#6cf0ff",
        accent2: "#ff4fd8",
        text: "#e9ecff",
        bg0: "#07090f",
        bg1: "#0c1020",
        panel: "#0f152c",
    };

    var VIS = {
        // Bass band (Hz). Widen this to make *more* low frequencies affect the animation.
        bassMinHz: 20,
        bassMaxHz: 260,

        // Audio analysis
        fftSize: 2048,

        // Default UI values
        sensitivityDefault: 1.6,
        smoothingDefault: 0.72,

        // Animation tuning (CSS uses --pulse and --z; these influence how strong it looks)
        pulseAmount: 0.085,
        zDepthPx: 28,
        glowMax: 1.0,
    };

    // ============================================================
    // Small utilities
    // ============================================================
    function clamp(v, min, max) {
        return Math.min(max, Math.max(min, v));
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function fmtTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return "0:00";
        var s = Math.floor(seconds);
        var m = Math.floor(s / 60);
        var r = s % 60;
        return m + ":" + String(r).padStart(2, "0");
    }

    // ============================================================
    // DOM
    // ============================================================
    function $(id) {
        return document.getElementById(id);
    }

    var els = {
        audio: $("audio"),
        audioInput: $("audioInput"),
        imageInput: $("imageInput"),
        pickAudioBtn: $("pickAudioBtn"),
        pickImageBtn: $("pickImageBtn"),
        playPauseBtn: $("playPauseBtn"),
        playPauseLabel: $("playPauseLabel"),
        stopBtn: $("stopBtn"),
        seekRange: $("seekRange"),
        timeCurrent: $("timeCurrent"),
        timeTotal: $("timeTotal"),
        volumeRange: $("volumeRange"),
        sensitivityRange: $("sensitivityRange"),
        smoothingRange: $("smoothingRange"),
        artwork: $("artwork"),
        artworkImage: $("artworkImage"),
        trackTitle: $("trackTitle"),
        trackSubtitle: $("trackSubtitle"),
    };

    // If the expected UI isn't present, do nothing.
    if (!els.audio || !els.playPauseBtn || !els.artworkImage) return;

    // Apply THEME into CSS variables (single place to change colors).
    (function applyTheme() {
        var root = document.documentElement.style;
        root.setProperty("--accent", THEME.accent);
        root.setProperty("--accent2", THEME.accent2);
        root.setProperty("--text", THEME.text);
        root.setProperty("--bg0", THEME.bg0);
        root.setProperty("--bg1", THEME.bg1);
        root.setProperty("--panel", THEME.panel);
    })();

    // ============================================================
    // Audio engine (plain JS)
    // ============================================================
    var ctx = null;
    var analyser = null;
    var source = null;
    var freq = null;

    // envelope follower (slow = stable, fast = transient)
    var envSlow = 0;
    var envFast = 0;

    function ensureAudioGraph() {
        if (ctx) return;
        var Ctx = window.AudioContext || window.webkitAudioContext;
        ctx = new Ctx();

        analyser = ctx.createAnalyser();
        analyser.fftSize = VIS.fftSize;
        analyser.smoothingTimeConstant = VIS.smoothingDefault;

        freq = new Uint8Array(analyser.frequencyBinCount);

        source = ctx.createMediaElementSource(els.audio);
        source.connect(analyser);
        analyser.connect(ctx.destination);
    }

    function resumeAudioContext() {
        ensureAudioGraph();
        if (ctx && ctx.state !== "running") return ctx.resume();
        return Promise.resolve();
    }

    function setSmoothing(v) {
        v = clamp(v, 0, 0.95);
        if (analyser) analyser.smoothingTimeConstant = v;
    }

    function getBassEnergy(dt) {
        if (!analyser || !freq || !ctx) return 0;

        analyser.getByteFrequencyData(freq);

        var nyquist = ctx.sampleRate / 2;
        var binHz = nyquist / freq.length;

        var i0 = clamp(Math.floor(VIS.bassMinHz / binHz), 0, freq.length - 1);
        var i1 = clamp(Math.ceil(VIS.bassMaxHz / binHz), i0 + 1, freq.length);

        // Avg + Peak inside bass band for more obvious bass response.
        var sum = 0;
        var peak = 0;
        for (var i = i0; i < i1; i++) {
            var v = freq[i];
            sum += v;
            if (v > peak) peak = v;
        }
        var avg = sum / Math.max(1, i1 - i0); // 0..255
        var x = (avg * 0.72 + peak * 0.28) / 255; // 0..1

        var sens = VIS.sensitivityDefault;
        if (els.sensitivityRange) sens = Number(els.sensitivityRange.value);
        x = clamp(x * sens, 0, 1.35);

        // Curve: emphasize hits, reduce noise
        var energy = clamp(Math.pow(x, 1.25), 0, 1);

        // Envelope follower
        dt = clamp(dt || 1 / 60, 0.001, 0.2);
        var fastT = 1 - Math.exp(-dt * 24);
        var slowT = 1 - Math.exp(-dt * 5.2);
        envFast = lerp(envFast, energy, fastT);
        envSlow = lerp(envSlow, energy, slowT);

        return envSlow;
    }

    function getTransient() {
        return clamp(envFast - envSlow, 0, 1);
    }

    // ============================================================
    // Visuals (CSS vars => GPU-friendly)
    // ============================================================
    var raf = 0;
    var lastTs = 0;
    var isSeeking = false;

    // forward/back spring
    var z = 0;
    var zVel = 0;

    function setCssVars(bass, pulse, zNorm, glow) {
        var root = document.documentElement.style;
        root.setProperty("--bass", bass.toFixed(4));
        root.setProperty("--pulse", pulse.toFixed(4));
        root.setProperty("--z", zNorm.toFixed(4));
        root.setProperty("--glow", glow.toFixed(4));
    }

    function tick(ts) {
        raf = requestAnimationFrame(tick);
        var dt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
        lastTs = ts;

        var playing = !els.audio.paused && !els.audio.ended;
        var bass = playing ? getBassEnergy(dt) : 0;
        var transient = playing ? getTransient() : 0;

        // forward/back: impulse on transients, then spring back
        var impulse = transient * 1.2;
        zVel += impulse * 9.2;

        var k = 28;
        var damp = 0.84;
        zVel += (0 - z) * k * dt;
        zVel *= Math.pow(damp, dt * 60);
        z += zVel * dt;

        // pulse + glow
        var pulse = clamp(Math.pow(bass, 0.82), 0, 1);
        var glow = clamp(Math.pow(bass, 0.68) * VIS.glowMax, 0, 1);

        setCssVars(bass, pulse, clamp(z, -1, 1), glow);
    }

    function startTick() {
        if (raf) return;
        lastTs = 0;
        raf = requestAnimationFrame(tick);
    }

    function stopTickSmooth() {
        if (!raf) return;
        var settleMs = 420;
        var start = performance.now();

        function settle() {
            var t = clamp((performance.now() - start) / settleMs, 0, 1);
            z = lerp(z, 0, t);
            zVel = lerp(zVel, 0, t);
            setCssVars(0, 0, z, 0);
            if (t < 1) requestAnimationFrame(settle);
            else {
                cancelAnimationFrame(raf);
                raf = 0;
                lastTs = 0;
            }
        }

        requestAnimationFrame(settle);
    }

    // ============================================================
    // Player UI glue
    // ============================================================
    function setButtonsEnabled(canPlay) {
        els.playPauseBtn.disabled = !canPlay;
        if (els.stopBtn) els.stopBtn.disabled = !canPlay;
    }

    function setPlayUI(isPlaying) {
        var icon = els.playPauseBtn.querySelector(".btn__icon");
        if (icon) icon.textContent = isPlaying ? "⏸" : "▶";
        if (els.playPauseLabel) els.playPauseLabel.textContent = isPlaying ? "Pause" : "Play";
    }

    function setNowPlaying(name) {
        if (!els.trackTitle || !els.trackSubtitle) return;
        els.trackTitle.textContent = name || "Unknown track";
        els.trackSubtitle.textContent = "Bass-synced visualizer running";
    }

    function updateTimes() {
        if (els.timeCurrent) els.timeCurrent.textContent = fmtTime(els.audio.currentTime);
        if (els.timeTotal) els.timeTotal.textContent = fmtTime(els.audio.duration);
    }

    function updateSeekFromAudio() {
        if (!els.seekRange || isSeeking) return;
        var d = els.audio.duration;
        if (!isFinite(d) || d <= 0) {
            els.seekRange.value = "0";
            return;
        }
        var p = clamp(els.audio.currentTime / d, 0, 1);
        els.seekRange.value = String(Math.round(p * 1000));
    }

    function setAudioFromFile(file) {
        var url = URL.createObjectURL(file);
        els.audio.src = url;
        els.audio.load();

        setNowPlaying(file && file.name);
        setButtonsEnabled(true);
        updateTimes();
        updateSeekFromAudio();
    }

    function setImageFromFile(file) {
        var url = URL.createObjectURL(file);
        els.artworkImage.src = url;
    }

    // ============================================================
    // Events
    // ============================================================
    if (els.pickAudioBtn && els.audioInput) {
        els.pickAudioBtn.addEventListener("click", function () {
            els.audioInput.click();
        });
    }
    if (els.pickImageBtn && els.imageInput) {
        els.pickImageBtn.addEventListener("click", function () {
            els.imageInput.click();
        });
    }

    if (els.audioInput) {
        els.audioInput.addEventListener("change", function () {
            var file = els.audioInput.files && els.audioInput.files[0];
            if (!file) return;
            setAudioFromFile(file);
        });
    }

    if (els.imageInput) {
        els.imageInput.addEventListener("change", function () {
            var file = els.imageInput.files && els.imageInput.files[0];
            if (!file) return;
            setImageFromFile(file);
        });
    }

    els.playPauseBtn.addEventListener("click", function () {
        if (!els.audio.src) return;

        resumeAudioContext().then(function () {
            if (els.audio.paused || els.audio.ended) {
                els.audio.play();
                setPlayUI(true);
                startTick();
            } else {
                els.audio.pause();
                setPlayUI(false);
            }
        });
    });

    if (els.stopBtn) {
        els.stopBtn.addEventListener("click", function () {
            els.audio.pause();
            els.audio.currentTime = 0;
            setPlayUI(false);
            updateSeekFromAudio();
            updateTimes();
            stopTickSmooth();
        });
    }

    if (els.seekRange) {
        els.seekRange.addEventListener("pointerdown", function () {
            isSeeking = true;
        });
        els.seekRange.addEventListener("pointerup", function () {
            isSeeking = false;
        });
        els.seekRange.addEventListener("input", function () {
            var d = els.audio.duration;
            if (!isFinite(d) || d <= 0) return;
            var p = clamp(Number(els.seekRange.value) / 1000, 0, 1);
            els.audio.currentTime = p * d;
            updateTimes();
        });
    }

    if (els.volumeRange) {
        els.volumeRange.addEventListener("input", function () {
            els.audio.volume = clamp(Number(els.volumeRange.value), 0, 1);
        });
    }

    if (els.smoothingRange) {
        els.smoothingRange.value = String(VIS.smoothingDefault);
        els.smoothingRange.addEventListener("input", function () {
            setSmoothing(Number(els.smoothingRange.value));
        });
    }
    if (els.sensitivityRange) {
        els.sensitivityRange.value = String(VIS.sensitivityDefault);
    }

    // Drag & drop: drop audio anywhere, drop image on artwork
    function prevent(e) {
        e.preventDefault();
    }

    document.body.addEventListener("dragover", prevent);
    document.body.addEventListener("drop", function (e) {
        e.preventDefault();
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        if (file.type && file.type.indexOf("audio/") === 0) setAudioFromFile(file);
    });
    if (els.artwork) {
        els.artwork.addEventListener("dragover", prevent);
        els.artwork.addEventListener("drop", function (e) {
            e.preventDefault();
            var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            if (file.type && file.type.indexOf("image/") === 0) setImageFromFile(file);
        });
    }

    // Audio element events
    els.audio.addEventListener("loadedmetadata", function () {
        updateTimes();
        updateSeekFromAudio();
    });
    els.audio.addEventListener("timeupdate", function () {
        updateSeekFromAudio();
        updateTimes();
    });
    els.audio.addEventListener("play", function () {
        setPlayUI(true);
        startTick();
    });
    els.audio.addEventListener("pause", function () {
        setPlayUI(false);
        stopTickSmooth();
    });
    els.audio.addEventListener("ended", function () {
        setPlayUI(false);
        updateSeekFromAudio();
        stopTickSmooth();
    });

    // Defaults
    setButtonsEnabled(false);
    setPlayUI(false);
    setCssVars(0, 0, 0, 0);
})();