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

        // Animation tuning (CSS uses --pulse and --z)
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

    function hexToRgb(hex) {
        var h = String(hex || "").replace("#", "");
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        var n = parseInt(h, 16);
        if (!isFinite(n) || h.length !== 6) return { r: 108, g: 240, b: 255 };
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
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
        pickImageBtnPanel: $("pickImageBtnPanel"),
        pickImageBtnVisual: $("pickImageBtnVisual"),
        clearImageBtn: $("clearImageBtn"),
        imageFit: $("imageFit"),
        visualEmpty: $("visualEmpty"),
        fullscreenBtn: $("fullscreenBtn"),

        playPauseBtn: $("playPauseBtn"),
        playPauseLabel: $("playPauseLabel"),
        stopBtn: $("stopBtn"),
        seekRange: $("seekRange"),
        timeCurrent: $("timeCurrent"),
        timeTotal: $("timeTotal"),
        volumeRange: $("volumeRange"),

        sensitivityRange: $("sensitivityRange"),
        smoothingRange: $("smoothingRange"),

        gradColorA: $("gradColorA"),
        gradColorB: $("gradColorB"),
        gradAlphaA: $("gradAlphaA"),
        gradAlphaB: $("gradAlphaB"),
        gradAngle: $("gradAngle"),
        gradIntensity: $("gradIntensity"),
        gradientEnabled: $("gradientEnabled"),

        eqEnabled: $("eqEnabled"),
        eqSize: $("eqSize"),
        eqColor: $("eqColor"),
        eqAlpha: $("eqAlpha"),
        eqCanvas: $("eqCanvas"),

        visual: $("visual"),
        visualImage: $("visualImage"),
        visualSurface: $("visualSurface"),
        fsControls: $("fsControls"),
        fsPlayPauseBtn: $("fsPlayPauseBtn"),
        fsPlayPauseLabel: $("fsPlayPauseLabel"),
        fsExitBtn: $("fsExitBtn"),
        fsTimeCurrent: $("fsTimeCurrent"),
        fsTimeTotal: $("fsTimeTotal"),

        trackTitle: $("trackTitle"),
        trackSubtitle: $("trackSubtitle"),
    };

    // If the expected UI isn't present, do nothing.
    if (!els.audio || !els.playPauseBtn || !els.visual) return;

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

    /** Call after getByteFrequencyData(freq). Updates envelopes; returns slow bass energy 0..1 */
    function computeBassFromFreq(dt) {
        if (!analyser || !freq || !ctx) return 0;

        var nyquist = ctx.sampleRate / 2;
        var binHz = nyquist / freq.length;

        var i0 = clamp(Math.floor(VIS.bassMinHz / binHz), 0, freq.length - 1);
        var i1 = clamp(Math.ceil(VIS.bassMaxHz / binHz), i0 + 1, freq.length);

        var sum = 0;
        var peak = 0;
        for (var i = i0; i < i1; i++) {
            var v = freq[i];
            sum += v;
            if (v > peak) peak = v;
        }
        var avg = sum / Math.max(1, i1 - i0);
        var x = (avg * 0.72 + peak * 0.28) / 255;

        var sens = VIS.sensitivityDefault;
        if (els.sensitivityRange) sens = Number(els.sensitivityRange.value);
        x = clamp(x * sens, 0, 1.35);

        var energy = clamp(Math.pow(x, 1.15), 0, 1);

        dt = clamp(dt || 1 / 60, 0.001, 0.2);
        var fastT = 1 - Math.exp(-dt * 28);
        var slowT = 1 - Math.exp(-dt * 6.5);
        envFast = lerp(envFast, energy, fastT);
        envSlow = lerp(envSlow, energy, slowT);

        return envSlow;
    }

    function decayBassMotion(dt) {
        dt = clamp(dt || 1 / 60, 0.001, 0.2);
        envFast = lerp(envFast, 0, 1 - Math.exp(-dt * 14));
        envSlow = lerp(envSlow, 0, 1 - Math.exp(-dt * 9));
        var k = 32;
        var damp = 0.82;
        zVel += (0 - z) * k * dt;
        zVel *= Math.pow(damp, dt * 60);
        z += zVel * dt;
        z = clamp(z, -1, 1);
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

    var eqEnabled = false;

    function setCssVars(bass, pulse, zNorm, glow) {
        var root = document.documentElement.style;
        root.setProperty("--bass", bass.toFixed(4));
        root.setProperty("--pulse", pulse.toFixed(4));
        root.setProperty("--z", zNorm.toFixed(4));
        root.setProperty("--glow", glow.toFixed(4));
    }

    function syncEqCanvasSize() {
        if (!els.eqCanvas || !els.visual) return;
        var r = els.visual.getBoundingClientRect();
        var w = Math.max(1, Math.floor(r.width));
        var h = Math.max(1, Math.floor(r.height));
        if (els.eqCanvas.width !== w || els.eqCanvas.height !== h) {
            els.eqCanvas.width = w;
            els.eqCanvas.height = h;
        }
    }

    function drawCircularEQ() {
        if (!els.eqCanvas || !freq || !analyser) return;
        var c = els.eqCanvas;
        var ctx2 = c.getContext("2d");
        if (!ctx2) return;
        var w = c.width;
        var h = c.height;
        var cx = w / 2;
        var cy = h / 2;
        var size = els.eqSize ? Number(els.eqSize.value) : 140;
        var baseR = Math.min(w, h) * 0.18 * (size / 140);
        var maxBar = Math.min(w, h) * 0.22 * (size / 140);
        var n = 72;
        var rgb = hexToRgb(els.eqColor && els.eqColor.value ? els.eqColor.value : "#6cf0ff");
        var alpha = els.eqAlpha ? clamp(Number(els.eqAlpha.value), 0, 1) : 0.9;

        ctx2.clearRect(0, 0, w, h);
        ctx2.lineCap = "round";
        ctx2.lineWidth = Math.max(1.5, Math.min(w, h) / 220);

        for (var i = 0; i < n; i++) {
            var t0 = Math.pow(i / n, 1.2);
            var t1 = Math.pow((i + 1) / n, 1.2);
            var b0 = Math.floor(t0 * freq.length);
            var b1 = Math.floor(t1 * freq.length);
            var sum = 0;
            var count = 0;
            for (var j = b0; j <= b1 && j < freq.length; j++) {
                sum += freq[j];
                count++;
            }
            var v = count ? sum / count / 255 : 0;
            v = Math.pow(v, 0.85);
            var ang = (i / n) * Math.PI * 2 - Math.PI / 2;
            var r0 = baseR;
            var r1 = baseR + v * maxBar;
            ctx2.strokeStyle = "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + "," + alpha + ")";
            ctx2.beginPath();
            ctx2.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
            ctx2.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
            ctx2.stroke();
        }
    }

    function tick(ts) {
        var dt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
        lastTs = ts;
        dt = clamp(dt, 0.001, 0.2);

        var playing = els.audio && !els.audio.paused && !els.audio.ended;
        var needSpectrum = analyser && freq && (playing || eqEnabled);

        if (needSpectrum) {
            analyser.getByteFrequencyData(freq);
        }

        var bassMetric = 0;
        var pulse = 0;
        var glow = 0;

        if (playing && analyser && freq) {
            bassMetric = computeBassFromFreq(dt);
            var transient = getTransient();
            var impulse = transient * 1.45;
            zVel += impulse * 11;
            var k = 30;
            var damp = 0.83;
            zVel += (0 - z) * k * dt;
            zVel *= Math.pow(damp, dt * 60);
            z += zVel * dt;
            z = clamp(z, -1, 1);
            pulse = clamp(Math.pow(bassMetric, 0.78), 0, 1);
            glow = clamp(Math.pow(bassMetric, 0.62) * VIS.glowMax, 0, 1);
        } else {
            decayBassMotion(dt);
            bassMetric = envSlow;
            pulse = clamp(Math.pow(envSlow, 0.78), 0, 1);
            glow = clamp(Math.pow(envSlow, 0.62) * VIS.glowMax, 0, 1);
        }

        setCssVars(bassMetric, pulse, z, glow);

        if (eqEnabled && els.eqCanvas) {
            syncEqCanvasSize();
            if (needSpectrum) {
                drawCircularEQ();
            } else {
                var ctx2 = els.eqCanvas.getContext("2d");
                if (ctx2) ctx2.clearRect(0, 0, els.eqCanvas.width, els.eqCanvas.height);
            }
        }

        var continueLoop =
            playing ||
            eqEnabled ||
            Math.abs(z) > 0.004 ||
            Math.abs(zVel) > 0.004 ||
            envSlow > 0.004 ||
            envFast > 0.004;

        if (continueLoop) {
            raf = requestAnimationFrame(tick);
        } else {
            raf = 0;
            lastTs = 0;
        }
    }

    function startTick() {
        if (raf) return;
        lastTs = 0;
        raf = requestAnimationFrame(tick);
    }

    function stopTickSmooth() {
        startTick();
    }

    // ============================================================
    // Player UI glue
    // ============================================================
    function setButtonsEnabled(canPlay) {
        els.playPauseBtn.disabled = !canPlay;
        if (els.stopBtn) els.stopBtn.disabled = !canPlay;
        if (els.fsPlayPauseBtn) els.fsPlayPauseBtn.disabled = !canPlay;
    }

    function setPlayUI(isPlaying) {
        var icon = els.playPauseBtn && els.playPauseBtn.querySelector(".btn__icon");
        if (icon) icon.textContent = isPlaying ? "⏸" : "▶";
        if (els.playPauseLabel) els.playPauseLabel.textContent = isPlaying ? "Pause" : "Play";

        var fsIcon = els.fsPlayPauseBtn && els.fsPlayPauseBtn.querySelector(".btn__icon");
        if (fsIcon) fsIcon.textContent = isPlaying ? "⏸" : "▶";
        if (els.fsPlayPauseLabel) els.fsPlayPauseLabel.textContent = isPlaying ? "Pause" : "Play";
    }

    function setNowPlaying(name) {
        if (!els.trackTitle || !els.trackSubtitle) return;
        els.trackTitle.textContent = name || "Unknown track";
        els.trackSubtitle.textContent = "Bass-synced visualizer running";
    }

    function updateTimes() {
        if (els.timeCurrent) els.timeCurrent.textContent = fmtTime(els.audio.currentTime);
        if (els.timeTotal) els.timeTotal.textContent = fmtTime(els.audio.duration);
        if (els.fsTimeCurrent) els.fsTimeCurrent.textContent = fmtTime(els.audio.currentTime);
        if (els.fsTimeTotal) els.fsTimeTotal.textContent = fmtTime(els.audio.duration);
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

    /** @type {string|null} */
    var imageObjectUrl = null;

    function revokeImageUrl() {
        if (imageObjectUrl) {
            URL.revokeObjectURL(imageObjectUrl);
            imageObjectUrl = null;
        }
    }

    function applyImageFit() {
        if (!els.visual) return;
        var mode = els.imageFit && els.imageFit.value === "contain" ? "contain" : "cover";
        els.visual.classList.toggle("image-fit-contain", mode === "contain");
        if (els.visualImage) els.visualImage.style.objectFit = mode;
    }

    function syncImageEmptyState() {
        if (!els.visualEmpty) return;
        var has = els.visual && els.visual.classList.contains("has-image");
        els.visualEmpty.setAttribute("aria-hidden", has ? "true" : "false");
    }

    function setImageFromFile(file) {
        if (!file || !els.visualImage || !els.visual) return;
        revokeImageUrl();
        imageObjectUrl = URL.createObjectURL(file);
        els.visualImage.src = imageObjectUrl;
        els.visualImage.classList.remove("visual__image--empty");
        els.visual.classList.add("has-image");
        if (els.clearImageBtn) els.clearImageBtn.disabled = false;
        applyImageFit();
        syncImageEmptyState();
    }

    function clearImage() {
        if (!els.visualImage || !els.visual) return;
        revokeImageUrl();
        els.visualImage.removeAttribute("src");
        els.visualImage.classList.add("visual__image--empty");
        els.visual.classList.remove("has-image");
        if (els.clearImageBtn) els.clearImageBtn.disabled = true;
        if (els.imageInput) els.imageInput.value = "";
        syncImageEmptyState();
    }

    function setGradientVars() {
        var root = document.documentElement.style;
        var ra = hexToRgb(els.gradColorA && els.gradColorA.value);
        var rb = hexToRgb(els.gradColorB && els.gradColorB.value);
        var blend = els.gradIntensity ? Number(els.gradIntensity.value) : 1;
        blend = clamp(blend, 0, 1);
        var aA = clamp((els.gradAlphaA ? Number(els.gradAlphaA.value) : 1) * blend, 0, 1);
        var aB = clamp((els.gradAlphaB ? Number(els.gradAlphaB.value) : 1) * blend, 0, 1);
        root.setProperty("--gradA-rgba", "rgba(" + ra.r + "," + ra.g + "," + ra.b + "," + aA + ")");
        root.setProperty("--gradB-rgba", "rgba(" + rb.r + "," + rb.g + "," + rb.b + "," + aB + ")");
        if (els.gradAngle) root.setProperty("--gradAngle", String(Number(els.gradAngle.value) || 0) + "deg");
        root.setProperty("--glow-a", "rgba(" + ra.r + "," + ra.g + "," + ra.b + ",0.35)");
        root.setProperty("--glow-b", "rgba(" + rb.r + "," + rb.g + "," + rb.b + ",0.28)");
        if (els.visual && els.gradientEnabled) {
            els.visual.classList.toggle("visual--gradient-off", !els.gradientEnabled.checked);
        }
    }

    function syncEqMode() {
        eqEnabled = !!(els.eqEnabled && els.eqEnabled.checked);
        if (els.visual) els.visual.classList.toggle("visual--eq-on", eqEnabled);
        if (eqEnabled && els.audio && els.audio.src) resumeAudioContext();
        if (eqEnabled) startTick();
    }

    // ============================================================
    // Events
    // ============================================================
    if (els.pickAudioBtn && els.audioInput) {
        els.pickAudioBtn.addEventListener("click", function () {
            els.audioInput.click();
        });
    }
    function openImagePicker() {
        if (els.imageInput) els.imageInput.click();
    }
    if (els.pickImageBtn) els.pickImageBtn.addEventListener("click", openImagePicker);
    if (els.pickImageBtnPanel) els.pickImageBtnPanel.addEventListener("click", openImagePicker);
    if (els.pickImageBtnVisual) els.pickImageBtnVisual.addEventListener("click", openImagePicker);
    if (els.visualEmpty) {
        els.visualEmpty.addEventListener("click", function (e) {
            if (els.visual && els.visual.classList.contains("has-image")) return;
            if (e.target && e.target.closest && e.target.closest("button")) return;
            openImagePicker();
        });
    }
    if (els.imageFit) els.imageFit.addEventListener("change", applyImageFit);
    if (els.clearImageBtn) {
        els.clearImageBtn.addEventListener("click", clearImage);
    }
    if (els.imageInput) {
        els.imageInput.addEventListener("change", function () {
            var file = els.imageInput.files && els.imageInput.files[0];
            if (!file) return;
            setImageFromFile(file);
        });
    }
    if (els.audioInput) {
        els.audioInput.addEventListener("change", function () {
            var file = els.audioInput.files && els.audioInput.files[0];
            if (!file) return;
            setAudioFromFile(file);
        });
    }

    if (els.gradColorA) els.gradColorA.addEventListener("input", setGradientVars);
    if (els.gradColorB) els.gradColorB.addEventListener("input", setGradientVars);
    if (els.gradAlphaA) els.gradAlphaA.addEventListener("input", setGradientVars);
    if (els.gradAlphaB) els.gradAlphaB.addEventListener("input", setGradientVars);
    if (els.gradAngle) els.gradAngle.addEventListener("input", setGradientVars);
    if (els.gradIntensity) els.gradIntensity.addEventListener("input", setGradientVars);
    if (els.gradientEnabled) els.gradientEnabled.addEventListener("change", setGradientVars);
    if (els.eqEnabled) els.eqEnabled.addEventListener("change", syncEqMode);
    if (els.eqSize) els.eqSize.addEventListener("input", function () {
        if (eqEnabled && els.eqCanvas) syncEqCanvasSize();
    });

    function togglePlayPause() {
        if (!els.audio.src) return;
        resumeAudioContext().then(function () {
            if (els.audio.paused || els.audio.ended) {
                els.audio.play();
            } else {
                els.audio.pause();
            }
        });
    }

    els.playPauseBtn.addEventListener("click", togglePlayPause);
    if (els.fsPlayPauseBtn) els.fsPlayPauseBtn.addEventListener("click", togglePlayPause);

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

    // Fullscreen controls (visual container)
    function isFullscreen() {
        return !!document.fullscreenElement;
    }

    function syncFullscreenUI() {
        if (!els.visual) return;
        els.visual.classList.toggle("is-fullscreen", isFullscreen());
        if (els.fullscreenBtn) els.fullscreenBtn.textContent = isFullscreen() ? "Exit fullscreen" : "Fullscreen";
    }

    function enterFullscreen() {
        if (!els.visual) return;
        if (els.visual.requestFullscreen) els.visual.requestFullscreen();
    }

    function exitFullscreen() {
        if (document.exitFullscreen) document.exitFullscreen();
    }

    function toggleFullscreen() {
        if (isFullscreen()) exitFullscreen();
        else enterFullscreen();
    }

    if (els.fullscreenBtn) els.fullscreenBtn.addEventListener("click", toggleFullscreen);
    if (els.fsExitBtn) els.fsExitBtn.addEventListener("click", exitFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreenUI);

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

    // Keyboard: Spacebar toggles play/pause (unless typing in inputs)
    document.addEventListener("keydown", function (e) {
        if (e.code !== "Space") return;
        var tag = (e.target && e.target.tagName) ? String(e.target.tagName).toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
        e.preventDefault();
        togglePlayPause();
    });

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

    // Drag & drop: drop audio anywhere
    function prevent(e) {
        e.preventDefault();
    }

    document.body.addEventListener("dragover", prevent);
    document.body.addEventListener("drop", function (e) {
        e.preventDefault();
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        if (file.type && file.type.indexOf("audio/") === 0) setAudioFromFile(file);
        else if (file.type && file.type.indexOf("image/") === 0) setImageFromFile(file);
    });
    if (els.visual) {
        els.visual.addEventListener("dragover", prevent);
        els.visual.addEventListener("drop", function (e) {
            e.stopPropagation();
            var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            if (file.type && file.type.indexOf("image/") === 0) setImageFromFile(file);
            else if (file.type && file.type.indexOf("audio/") === 0) setAudioFromFile(file);
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
    setGradientVars();
    syncEqMode();
    applyImageFit();
    syncImageEmptyState();
    syncFullscreenUI();
})();