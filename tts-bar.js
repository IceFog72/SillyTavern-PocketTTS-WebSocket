// tts-bar.js — TTS playback bar for PocketTTS extension

export function initTtsBar(extSettings) {
    const bar = createBarElements();
    const intervals = [];

    let audio = null;
    let seeking = false;
    let speedIndex = 3; // 1.0x
    const speeds = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5];
    let playlistVisible = false;

    // Bar visibility follows ST's TTS enabled state
    function updateBarVisibility() {
        const es = window.extension_settings || extSettings;
        const cb = document.getElementById('tts_enabled');
        const on = cb ? cb.checked : (es?.tts?.enabled ?? false);
        bar.el.style.display = on ? 'flex' : 'none';
        if (!on) {
            bar.playlistPanel.style.display = 'none';
            playlistVisible = false;
        }
        const icon = bar.toggleBtn.querySelector('i');
        icon.className = on ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off';
    }

    // Toggle button clicks ST's TTS checkbox
    bar.toggleBtn.addEventListener('click', () => {
        const el = document.querySelector('#tts_enabled');
        if (el) {
            el.checked = !el.checked;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setTimeout(updateBarVisibility, 200);
    });

    intervals.push(setInterval(() => { updateBarVisibility(); updateHighlightBtn(); }, 1000));
    updateBarVisibility();
    updateHighlightBtn();

    // Track whichever audio element is currently playing
    let boundElements = new Set();

    function bindAudio(el) {
        if (!el || boundElements.has(el)) return;
        boundElements.add(el);
        el.addEventListener('play', () => { switchTo(el); updateState(); });
        el.addEventListener('playing', () => { switchTo(el); updateState(); });
        el.addEventListener('pause', updateState);
        el.addEventListener('ended', updateState);
        el.addEventListener('timeupdate', updateTime);
        el.addEventListener('loadedmetadata', updateDuration);
        el.addEventListener('volumechange', updateVol);
    }

    function switchTo(el) {
        if (el === audio) return;
        audio = el;
        const savedVol = localStorage.getItem('ptts-bar-volume');
        if (savedVol !== null) audio.volume = parseFloat(savedVol);
        const savedSpeed = localStorage.getItem('ptts-bar-speed');
        if (savedSpeed !== null) {
            speedIndex = speeds.indexOf(parseFloat(savedSpeed));
            if (speedIndex < 0) speedIndex = 3;
            audio.playbackRate = speeds[speedIndex];
        }
        updateVol();
        bar.speed.textContent = formatSpeed(speeds[speedIndex]);
    }

    // Periodically scan for audio elements and bind them
    function scanAudioElements() {
        const pttsEl = window._pttsAudio;
        const stEl = document.getElementById('tts_audio');
        if (pttsEl) bindAudio(pttsEl);
        if (stEl) bindAudio(stEl);

        if (!audio) {
            audio = pttsEl || stEl;
            if (audio) {
                const savedVol = localStorage.getItem('ptts-bar-volume');
                if (savedVol !== null) audio.volume = parseFloat(savedVol);
                const savedSpeed = localStorage.getItem('ptts-bar-speed');
                if (savedSpeed !== null) {
                    speedIndex = speeds.indexOf(parseFloat(savedSpeed));
                    if (speedIndex < 0) speedIndex = 3;
                    audio.playbackRate = speeds[speedIndex];
                }
                updateVol();
                bar.speed.textContent = formatSpeed(speeds[speedIndex]);
            }
        }
    }

    intervals.push(setInterval(scanAudioElements, 1000));
    scanAudioElements();

    // ─── Playback state ──────────────────────────────────

    function updateState() {
        if (!audio) return;
        const icon = bar.playBtn.querySelector('i');
        icon.className = audio.paused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
    }

    // ─── Time display ────────────────────────────────────

    function updateTime() {
        if (!audio || seeking) return;
        bar.seeker.value = audio.currentTime;
        bar.time.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration || 0);
    }

    function updateDuration() {
        if (!audio) return;
        bar.seeker.max = audio.duration || 0;
        bar.seeker.value = audio.currentTime;
        bar.time.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration || 0);
    }

    // ─── Volume ──────────────────────────────────────────

    function updateVol() {
        if (!audio) return;
        bar.volSlider.value = audio.volume * 100;
        const icon = bar.volBtn.querySelector('i');
        if (audio.volume === 0) {
            icon.className = 'fa-solid fa-volume-xmark';
        } else if (audio.volume < 0.5) {
            icon.className = 'fa-solid fa-volume-low';
        } else {
            icon.className = 'fa-solid fa-volume-high';
        }
    }

    // ─── Event handlers ──────────────────────────────────

    bar.playBtn.addEventListener('click', () => {
        if (!audio) return;
        if (audio.paused) audio.play();
        else audio.pause();
    });

    bar.seeker.addEventListener('input', () => {
        if (!audio) return;
        seeking = true;
        audio.currentTime = parseFloat(bar.seeker.value);
        bar.time.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration || 0);
    });

    bar.seeker.addEventListener('change', () => { seeking = false; });

    bar.time.addEventListener('click', () => {
        if (!audio) return;
        const remaining = audio.duration - audio.currentTime;
        bar.time.textContent = '-' + formatTime(remaining);
    });

    bar.volSlider.addEventListener('input', () => {
        if (!audio) return;
        audio.volume = parseInt(bar.volSlider.value) / 100;
        localStorage.setItem('ptts-bar-volume', audio.volume);
    });

    bar.volBtn.addEventListener('click', () => {
        if (!audio) return;
        if (audio.volume > 0) {
            audio._savedVol = audio.volume;
            audio.volume = 0;
        } else {
            audio.volume = audio._savedVol || 0.5;
        }
        updateVol();
        localStorage.setItem('ptts-bar-volume', audio.volume);
    });

    bar.speed.addEventListener('click', () => {
        if (!audio) return;
        speedIndex = (speedIndex + 1) % speeds.length;
        audio.playbackRate = speeds[speedIndex];
        bar.speed.textContent = formatSpeed(speeds[speedIndex]);
        localStorage.setItem('ptts-bar-speed', speeds[speedIndex]);
    });

    // Skip track — next track in SAME message
    bar.skipBtn.addEventListener('click', () => {
        window._pttsSkipTrack?.();
    });

    // Stop — nuke current message album only
    bar.stopBtn.addEventListener('click', () => {
        const view = window._pttsGetPlaylist?.() || [];
        const playing = view.find(v => v.isPlaying);
        if (playing) {
            window._pttsNukeMsgTracks?.(playing.msgId);
        } else if (audio) {
            audio.pause();
            audio.currentTime = 0;
            audio.src = '';
        }
    });

    bar.dlBtn.addEventListener('click', () => {
        if (!audio || !audio.src) return;
        const es = window.extension_settings || extSettings;
        const fmt = es?.tts?.['PocketTTS WebSocket']?.format || 'mp3';
        const a = document.createElement('a');
        a.href = audio.src;
        a.download = 'tts-audio.' + fmt;
        a.click();
    });

    // Highlight toggle — only visible for PocketTTS provider
    function updateHighlightBtn() {
        const es = window.extension_settings || extSettings;
        const isPocketTts = es?.tts?.currentProvider === 'PocketTTS WebSocket';
        bar.highlightBtn.style.display = isPocketTts ? '' : 'none';
        const on = window._pttsHighlightEnabled?.() ?? false;
        const icon = bar.highlightBtn.querySelector('i');
        icon.style.opacity = on ? '1' : '0.4';
    }

    bar.highlightBtn.addEventListener('click', () => {
        window._pttsHighlightToggle?.();
        updateHighlightBtn();
    });
    updateHighlightBtn();

    // ─── Playlist Panel ──────────────────────────────────

    bar.playlistBtn.addEventListener('click', () => {
        playlistVisible = !playlistVisible;
        bar.playlistPanel.style.display = playlistVisible ? 'block' : 'none';
        bar.splitter.style.display = playlistVisible ? 'block' : 'none';
        if (playlistVisible) {
            renderPlaylist();
            // Set initial height if not set
            if (!bar.el.style.minHeight || bar.el.style.minHeight === '35px') bar.el.style.minHeight = '250px';
        } else {
            bar.el.style.minHeight = '35px';
        }
    });

    // ─── Splitter Drag ──────────────────────────────────

    let pointerId = null;
    let startClientY = 0;
    let startHeight = 0;

    bar.splitter.addEventListener('pointerdown', (e) => {
        if (e.button && e.button !== 0) return;
        e.preventDefault();
        pointerId = e.pointerId;
        startClientY = e.clientY;
        startHeight = bar.el.offsetHeight;
        try { bar.splitter.setPointerCapture(pointerId); } catch (e) { }
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    });

    function onPointerMove(e) {
        if (pointerId === null || e.pointerId !== pointerId) return;
        const delta = e.clientY - startClientY;
        bar.el.style.minHeight = Math.max(80, startHeight + delta) + 'px';
    }

    function onPointerUp(e) {
        if (pointerId !== null && e.pointerId === pointerId) {
            try { bar.splitter.releasePointerCapture(pointerId); } catch (e) { }
        }
        pointerId = null;
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
    }

    function renderPlaylist() {
        if (!playlistVisible) return;
        const view = window._pttsGetPlaylist?.() || [];
        const panel = bar.playlistPanel;

        if (view.length === 0) {
            panel.innerHTML = '<div class="ptts-pl-empty">No tracks queued</div>';
            return;
        }

        let html = '';
        for (const msg of view) {
            const msgClass = msg.isPlaying ? ' ptts-pl-msg-active' : '';
            html += `<div class="ptts-pl-message${msgClass}">`;
            html += `<div class="ptts-pl-header">#${msg.msgId} (${msg.tracks.length} track${msg.tracks.length > 1 ? 's' : ''})</div>`;

            for (const track of msg.tracks) {
                const trackClass = track.playing
                    ? ' ptts-pl-track-active'
                    : (track.error ? ' ptts-pl-track-error' : (track.pending ? ' ptts-pl-track-pending' : ''));
                const icon = track.playing ? '▶' : (track.error ? '✕' : (track.pending ? '◌' : '○'));
                const preview = track.text
                    ? track.text.substring(0, 50) + (track.text.length > 50 ? '...' : '')
                    : '(empty)';
                html += `<div class="ptts-pl-track${trackClass}">`;
                html += `<span class="ptts-pl-track-icon">${icon}</span>`;
                html += `<span class="ptts-pl-track-text">${escapeHtml(preview)}</span>`;
                html += '</div>';
            }

            html += '</div>';
        }
        panel.innerHTML = html;
    }

    // Event-driven: index.js calls this when playlist changes
    window._pttsRefreshPlaylist = renderPlaylist;

    console.debug('[tts-pl] Player bar initialized');

    // Return cleanup function
    return () => {
        for (const id of intervals) clearInterval(id);
    };
}

// ─── DOM creation ──────────────────────────────────────

function createBarElements() {
    const el = document.createElement('div');
    el.id = 'ptts-bar';

    el.innerHTML = `
        <div class="ptts-controls">
            <button class="ptts-btn" id="ptts-toggle" title="TTS On/Off"><i class="fa-solid fa-toggle-on"></i></button>
            <button class="ptts-btn" id="ptts-play" title="Play/Pause"><i class="fa-solid fa-play"></i></button>
            <button class="ptts-btn" id="ptts-skip" title="Skip track"><i class="fa-solid fa-forward-step"></i></button>
            <button class="ptts-btn" id="ptts-stop" title="Stop message"><i class="fa-solid fa-stop"></i></button>
            <div class="ptts-seek-wrap">
                <span class="ptts-time" id="ptts-time" title="Click to toggle remaining">0:00 / 0:00</span>
                <input type="range" id="ptts-seeker" min="0" max="0" step="0.1" value="0" />
            </div>
            <button class="ptts-btn" id="ptts-vol-btn" title="Mute/Unmute"><i class="fa-solid fa-volume-high"></i></button>
            <div class="ptts-vol-wrap">
                <input type="range" id="ptts-volume" min="0" max="100" value="100" />
            </div>
            <span class="ptts-speed" id="ptts-speed" title="Click to change speed">1.0x</span>
            <button class="ptts-btn" id="ptts-highlight" title="Highlight playing text"><i class="fa-solid fa-highlighter"></i></button>
            <button class="ptts-btn" id="ptts-playlist" title="Playlist"><i class="fa-solid fa-list"></i></button>
            <button class="ptts-btn" id="ptts-dl" title="Download" style="display:none"><i class="fa-solid fa-download"></i></button>
        </div>
        <div id="ptts-playlist-panel" style="display:none"></div>
    `;

    // Splitter — outside bar so it doesn't move when bar resizes
    const splitter = document.createElement('div');
    splitter.className = 'ptts-splitter';
    splitter.style.display = 'none';

    // Insert bar + splitter before #chat (bar above, splitter below)
    const chat = document.getElementById('chat');
    if (chat) {
        chat.before(el);
        chat.before(splitter);
    } else {
        const formSheld = document.getElementById('form_sheld');
        if (formSheld) {
            formSheld.before(el);
            formSheld.before(splitter);
        } else {
            document.body.appendChild(el);
            document.body.appendChild(splitter);
        }
    }

    return {
        el,
        toggleBtn: el.querySelector('#ptts-toggle'),
        playBtn: el.querySelector('#ptts-play'),
        skipBtn: el.querySelector('#ptts-skip'),
        stopBtn: el.querySelector('#ptts-stop'),
        seeker: el.querySelector('#ptts-seeker'),
        time: el.querySelector('#ptts-time'),
        volBtn: el.querySelector('#ptts-vol-btn'),
        volSlider: el.querySelector('#ptts-volume'),
        speed: el.querySelector('#ptts-speed'),
        highlightBtn: el.querySelector('#ptts-highlight'),
        playlistBtn: el.querySelector('#ptts-playlist'),
        dlBtn: el.querySelector('#ptts-dl'),
        splitter,
        playlistPanel: el.querySelector('#ptts-playlist-panel'),
    };
}

// ─── Helpers ──────────────────────────────────────────

function formatTime(sec) {
    if (!sec || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function formatSpeed(speed) {
    return speed.toFixed(1) + 'x';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
